/**
 * Router V2 serving decision (family-aware).
 *
 * This is the V2 counterpart to `decideServing` (V1, in serving-confidence.ts).
 * It lives in its own module to keep the dependency graph acyclic:
 *
 *     serving-confidence  (V1 core: features, policy, reasons, types)
 *        ▲            ▲
 *        │            │
 *   serving-evidence-v2   reasoning-family
 *        ▲            ▲
 *        └──── serving-decision-v2 ────┘   (this file)
 *
 * It reuses every V1 safety guard (generic-only, weak-evidence, absolute
 * evidence floor, calibrated gate) UNCHANGED — the only thing V2 replaces is
 * (a) the per-candidate evidence (richer, structured, rarity-weighted) and
 * (b) the ambiguity margin: instead of comparing the top BLOCK with the runner-
 * up BLOCK, it compares the top FAMILY with the runner-up FAMILY, so near-
 * duplicate captures no longer collapse the margin and real siblings still trip
 * it.
 *
 * Two modes:
 *   • "v2-representation": structured evidence, but the ambiguity margin is
 *     still block-vs-block (no family aggregation). Isolates the lift from
 *     representation alone for the offline ablation.
 *   • "v2-family": structured evidence + family aggregation + family margin.
 *
 * The result is shape-compatible with `decideServing`: `decision` carries a
 * V1-shaped `features` (with `evidenceConfidence` = the V2 blended confidence
 * and `margin` = the chosen margin) and `perCandidate` is a V1-shaped slate, so
 * the existing `finalizeRecall` telemetry/holdout plumbing needs no change. The
 * rich V2 evidence + family telemetry ride alongside for the ablation and for
 * future feature-versioned calibration.
 */
import {
  computeFeatures,
  type ServingEvidenceV1,
  type ServingCandidate,
  type ServingQuery,
  type ServingPolicy,
  type ServingDecision,
  type ServingAction,
  type ServingReason,
  type EvidenceCalibrator,
  identityEvidenceCalibrator,
} from "./serving-confidence.js";
import {
  buildStructuredView,
  buildRarityModel,
  computeEvidenceV2,
  type ServingEvidenceV2,
} from "./serving-evidence-v2.js";
import {
  aggregateFamilies,
  summarizeFamilyDecision,
  StructuredSignatureResolver,
  type FamilyResolver,
  type FamilyDecisionTelemetry,
  type ReasoningFamily,
} from "./reasoning-family.js";

export type ServingModeV2 = "v2-representation" | "v2-family";

export interface DecideServingV2Options {
  mode: ServingModeV2;
  /** Family resolver (family mode only). Defaults to the structured-signature resolver. */
  resolver?: FamilyResolver;
}

export interface ServingDecisionV2Result {
  decision: ServingDecision;
  /** V1-shaped per-candidate slate (evidenceConfidence = V2 blend). */
  perCandidate: ServingEvidenceV1[];
  /** Rich per-candidate V2 evidence (telemetry / ablation / future calibration). */
  evidenceV2: ServingEvidenceV2[];
  /** Family decision telemetry (family mode only). */
  family?: FamilyDecisionTelemetry;
}

/** A pitfall/harmful family this severe never injects regardless of lexical fit. */
const HARD_CONTRADICTION = 0.5;

/**
 * The Router V2 serving decision. `candidates` MUST already be in rank order
 * (retrieval's job). Never throws on well-formed input; the caller
 * (`finalizeRecall`) additionally wraps it so any unexpected failure falls back
 * to the V1 decision — V2 can never break customer work.
 */
export function decideServingV2(
  query: ServingQuery,
  candidates: readonly ServingCandidate[],
  policy: ServingPolicy,
  calibrate: EvidenceCalibrator = identityEvidenceCalibrator,
  opts: DecideServingV2Options = { mode: "v2-family" },
): ServingDecisionV2Result {
  const base = { threshold: policy.gateThreshold, marginThreshold: policy.marginThreshold };

  if (candidates.length === 0) {
    return {
      decision: { action: "abstain", reason: "no_candidates", ...base },
      perCandidate: [],
      evidenceV2: [],
    };
  }

  // ── Second-stage structured evidence ────────────────────────────────────
  // Candidate generation already happened (FTS over trigger). Now, and only
  // now, do we read the privacy-scanned structured body fields.
  const views = candidates.map((c) => buildStructuredView(c.block));
  const rarity = buildRarityModel(views);
  const cores = candidates.map((c) => computeFeatures(query, c));
  const evidenceV2 = candidates.map((c, i) => computeEvidenceV2(query, c, views[i]!, rarity, cores[i]!));

  const scored = candidates.map((c, i) => ({
    c,
    i,
    core: cores[i]!,
    ev2: evidenceV2[i]!,
    calibratedProb: clamp01(calibrate(evidenceV2[i]!.evidenceConfidence, c.block)),
  }));

  // ── Winner selection + ambiguity margin ─────────────────────────────────
  let familyTel: FamilyDecisionTelemetry | undefined;
  let topFamily: ReasoningFamily | undefined;
  let selected: (typeof scored)[number];
  let gateProb: number;
  let secondProb: number;
  let marginValue: number;
  let hasRunnerUp: boolean;

  if (opts.mode === "v2-family") {
    const agg = aggregateFamilies(
      candidates.map((c, i) => ({ block: c.block, evidence: evidenceV2[i]! })),
      opts.resolver ?? new StructuredSignatureResolver(),
    );
    familyTel = summarizeFamilyDecision(agg);
    topFamily = agg.families[0];

    // Stamp family signals back onto each candidate's V2 evidence (telemetry).
    for (const s of scored) {
      const fid = agg.familyByBlockId.get(s.c.block.id);
      const fam = fid ? agg.families.find((f) => f.id === fid) : undefined;
      if (fam) {
        s.ev2.family = {
          familyId: fam.id,
          support: fam.distinctCaseIds.length,
          contradiction: fam.contradictionPenalty,
          sourceDiversity: fam.sourceDiversity,
        };
      }
    }

    // Winner = the top family's prototype (its best-matching member).
    selected =
      scored.find((s) => s.c.block.id === topFamily!.prototypeBlockId) ??
      [...scored].sort((a, b) => b.calibratedProb - a.calibratedProb || a.i - b.i)[0]!;
    // Gate on the FAMILY confidence (support-boosted, contradiction-penalized).
    gateProb = clamp01(calibrate(topFamily!.confidence, selected.c.block));
    secondProb = familyTel.runnerUpFamilyConfidence;
    marginValue = familyTel.familyMargin;
    hasRunnerUp = agg.families.length >= 2;
  } else {
    // Representation-only: block-vs-block margin on the V2 blended confidence.
    const ordered = [...scored].sort((a, b) => b.calibratedProb - a.calibratedProb || a.i - b.i);
    selected = ordered[0]!;
    const runner = ordered[1];
    gateProb = selected.calibratedProb;
    secondProb = runner ? runner.calibratedProb : 0;
    marginValue = gateProb - secondProb;
    hasRunnerUp = !!runner;
  }

  // ── V1-shaped telemetry projection ──────────────────────────────────────
  const selFeatures: ServingEvidenceV1 = {
    ...selected.ev2.base,
    evidenceConfidence: selected.ev2.evidenceConfidence,
    secondBestEvidenceConfidence: round4(secondProb),
    margin: round4(marginValue),
  };
  const perCandidate: ServingEvidenceV1[] = scored.map((s) =>
    s.c.block.id === selected.c.block.id
      ? selFeatures
      : { ...s.ev2.base, evidenceConfidence: s.ev2.evidenceConfidence, secondBestEvidenceConfidence: 0, margin: 0 },
  );

  const decide = (action: ServingAction, reason: ServingReason, calibratedProb?: number): ServingDecisionV2Result => ({
    decision: {
      action,
      reason,
      topCandidateId: selected.c.block.id,
      features: selFeatures,
      ...(calibratedProb !== undefined ? { calibratedProb: round4(calibratedProb) } : {}),
      ...base,
    },
    perCandidate,
    evidenceV2,
    ...(familyTel ? { family: familyTel } : {}),
  });

  // ── Gates (V1 safety guards preserved; only the margin is family-aware) ──
  // 1. Generic-only overlap on the candidate we'd inject.
  if (selected.ev2.base.genericOnly) return decide("abstain", "generic_only");
  // 2. Weak evidence: too few meaningful matches AND no exact structured match.
  if (selected.core.meaningfulMatchCount < policy.minMeaningfulMatches && !selected.core.hasExactStructured) {
    return decide("abstain", "weak_evidence");
  }
  // 3. Absolute floor on the BEST SINGLE piece of evidence (the prototype). Family
  //    support can raise confidence but can never fabricate a floor pass from
  //    candidates that are each individually too weak.
  if (selected.ev2.evidenceConfidence < policy.minEvidenceConfidence) {
    return decide("abstain", "weak_evidence");
  }
  // 4. Hard contradiction: a top family carrying a pitfall / net-harmful history
  //    never injects, regardless of how well it matches lexically.
  if (opts.mode === "v2-family" && topFamily && topFamily.contradictionPenalty >= HARD_CONTRADICTION) {
    return decide("abstain", "family_contradicted", gateProb);
  }
  // 5. Ambiguity margin — family-level in family mode, block-level otherwise.
  if (hasRunnerUp && marginValue < policy.marginThreshold) {
    const reason: ServingReason = opts.mode === "v2-family" ? "ambiguous_sibling_family" : "ambiguous_margin";
    return decide("abstain", reason, gateProb);
  }
  // 6. Calibrated gate. When a (milder) family contradiction was the difference,
  //    report it as the reason for explainability.
  if (gateProb < policy.gateThreshold) {
    const reason: ServingReason =
      opts.mode === "v2-family" && topFamily && topFamily.contradictionPenalty > 0
        ? "family_contradicted"
        : "below_calibrated_threshold";
    return decide("abstain", reason, gateProb);
  }
  return decide("inject", "injected", gateProb);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
