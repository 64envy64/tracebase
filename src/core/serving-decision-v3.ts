/**
 * Router V2 serving decision — ServingEvidenceV3 (experimental, Phase C.2).
 *
 * V3 is V2-family plus a SEMANTIC-LICENSE lane. The problem it solves: hybrid
 * retrieval (Phase C) surfaces a lesson whose TRIGGER the query didn't match
 * (semanticOnly), but V2's confidence is lexical-conditional — it won't score a
 * body-only candidate, so the candidate-recall lift never becomes decision
 * recall. V3 grants such a candidate a license to inject ONLY when:
 *
 *   1. INDEPENDENT structured corroboration: at least two of {mechanism, unlock,
 *      invariants} overlap the query above a meaningful floor (not one body-token
 *      collision); AND
 *   2. FAMILY SEPARATION: its reasoning family clears the family-margin gate.
 *
 * Semantic RANK alone NEVER authorizes an inject — the provider's native score
 * is not read here at all; the licensed confidence is the structured
 * applicability (the body-field match), never the rank. A lexical candidate
 * (in the sparse slate) takes the plain V2 lane. Any error fails open to V2.
 *
 * Gated behind TRACEBASE_REASONING_EVIDENCE=off|shadow — there is NO production
 * `on`. The BlockServer computes V3 in shadow only, serving V2/V1 unchanged.
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

export const SERVING_FEATURE_VERSION_V3 = 3 as const;

/** A structured body field must overlap at least this much to corroborate. */
const CORROBORATION_FLOOR = 0.2;
/** A pitfall/harmful top family this severe never injects (mirrors V2). */
const HARD_CONTRADICTION = 0.5;

export type EvidenceLane = "lexical" | "semantic-license";
export type SemanticLicenseReason =
  | "lexical" // candidate was in the sparse slate — plain V2 lane.
  | "structured-corroborated" // semantic-only, licensed by >=2 body fields.
  | "insufficient-corroboration" // semantic-only, <2 corroborating fields — denied.
  | "no-family-separation"; // licensed by corroboration but the family margin failed.

export interface ServingEvidenceV3 {
  featureVersion: typeof SERVING_FEATURE_VERSION_V3;
  blockId: string;
  base: ServingEvidenceV2;
  lane: EvidenceLane;
  licenseReason: SemanticLicenseReason;
  /** # of {mechanism, unlock, invariants} fields overlapping >= the floor. */
  corroboratingFields: number;
  /** Confidence the V3 decision uses (V2 conf, or the licensed structured applicability). */
  v3Confidence: number;
}

export interface DecideServingV3Options {
  resolver?: FamilyResolver;
}

export interface ServingDecisionV3Result {
  decision: ServingDecision;
  perCandidate: ServingEvidenceV1[];
  evidenceV3: ServingEvidenceV3[];
  family?: FamilyDecisionTelemetry;
}

/** Compute the per-candidate license (lane + reason + V3 confidence). */
function licenseFor(ev2: ServingEvidenceV2, semanticOnly: boolean): {
  lane: EvidenceLane;
  reason: SemanticLicenseReason;
  corroboratingFields: number;
  v3Confidence: number;
} {
  // Independent BODY corroboration — situation is the trigger/lexical signal V2
  // already uses, so it is NOT counted toward the license.
  const fields = [ev2.fieldOverlap.mechanism, ev2.fieldOverlap.unlock, ev2.fieldOverlap.invariants];
  const corroborating = fields.filter((x) => x >= CORROBORATION_FLOOR);
  const corroboratingFields = corroborating.length;
  if (!semanticOnly) {
    return { lane: "lexical", reason: "lexical", corroboratingFields, v3Confidence: ev2.evidenceConfidence };
  }
  if (corroboratingFields >= 2) {
    // Licensed: the confidence is the MEAN STRENGTH of the independent
    // corroborating body fields — never the provider's semantic rank/score.
    const licensedConfidence = corroborating.reduce((a, b) => a + b, 0) / corroborating.length;
    return {
      lane: "semantic-license",
      reason: "structured-corroborated",
      corroboratingFields,
      v3Confidence: Math.max(ev2.evidenceConfidence, licensedConfidence),
    };
  }
  return { lane: "semantic-license", reason: "insufficient-corroboration", corroboratingFields, v3Confidence: ev2.evidenceConfidence };
}

/**
 * V3 (family-aware) serving decision with the semantic-license lane. Shape-
 * compatible with `decideServing`/`decideServingV2`. Never throws on well-formed
 * input; the BlockServer additionally wraps it to fall open to V2.
 */
export function decideServingV3(
  query: ServingQuery,
  candidates: readonly ServingCandidate[],
  policy: ServingPolicy,
  calibrate: EvidenceCalibrator = identityEvidenceCalibrator,
  opts: DecideServingV3Options = {},
): ServingDecisionV3Result {
  const base = { threshold: policy.gateThreshold, marginThreshold: policy.marginThreshold };
  if (candidates.length === 0) {
    return { decision: { action: "abstain", reason: "no_candidates", ...base }, perCandidate: [], evidenceV3: [] };
  }

  const views = candidates.map((c) => buildStructuredView(c.block));
  const rarity = buildRarityModel(views);
  const cores = candidates.map((c) => computeFeatures(query, c));
  const ev2 = candidates.map((c, i) => computeEvidenceV2(query, c, views[i]!, rarity, cores[i]!));

  // Per-candidate license → V3 confidence. Mutable license reason so the gate
  // can refine it to "no-family-separation".
  const licenses = candidates.map((c, i) => licenseFor(ev2[i]!, c.provenance?.semanticOnly ?? false));

  // Family aggregation runs on the V3 confidences (so a licensed semantic-only
  // prototype can anchor + clear the family margin).
  const famCandidates = candidates.map((c, i) => ({
    block: c.block,
    evidence: { ...ev2[i]!, evidenceConfidence: licenses[i]!.v3Confidence } as ServingEvidenceV2,
  }));
  const agg = aggregateFamilies(famCandidates, opts.resolver ?? new StructuredSignatureResolver());
  const familyTel = summarizeFamilyDecision(agg);
  const topFamily: ReasoningFamily | undefined = agg.families[0];

  const scored = candidates.map((c, i) => ({ c, i, core: cores[i]!, ev2: ev2[i]!, lic: licenses[i]!, v3: licenses[i]!.v3Confidence }));
  const selected =
    scored.find((s) => s.c.block.id === topFamily?.prototypeBlockId) ??
    [...scored].sort((a, b) => b.v3 - a.v3 || a.i - b.i)[0]!;
  const gateProb = topFamily ? clamp01(calibrate(topFamily.confidence, selected.c.block)) : selected.v3;
  const secondProb = familyTel.runnerUpFamilyConfidence;
  const marginValue = familyTel.familyMargin;
  const hasRunnerUp = agg.families.length >= 2;

  const selFeatures: ServingEvidenceV1 = {
    ...selected.ev2.base,
    evidenceConfidence: selected.v3,
    secondBestEvidenceConfidence: round4(secondProb),
    margin: round4(marginValue),
  };
  const perCandidate: ServingEvidenceV1[] = scored.map((s) =>
    s.c.block.id === selected.c.block.id
      ? selFeatures
      : { ...s.ev2.base, evidenceConfidence: s.v3, secondBestEvidenceConfidence: 0, margin: 0 },
  );

  const evidenceV3 = (): ServingEvidenceV3[] =>
    scored.map((s) => ({
      featureVersion: SERVING_FEATURE_VERSION_V3,
      blockId: s.c.block.id,
      base: s.ev2,
      lane: s.lic.lane,
      licenseReason: s.lic.reason,
      corroboratingFields: s.lic.corroboratingFields,
      v3Confidence: round4(s.v3),
    }));

  const decide = (action: ServingAction, reason: ServingReason, calibratedProb?: number): ServingDecisionV3Result => ({
    decision: {
      action,
      reason,
      topCandidateId: selected.c.block.id,
      features: selFeatures,
      ...(calibratedProb !== undefined ? { calibratedProb: round4(calibratedProb) } : {}),
      ...base,
    },
    perCandidate,
    evidenceV3: evidenceV3(),
    ...(familyTel ? { family: familyTel } : {}),
  });

  // ── Gates: V1 safety guards + family margin (mirror V2-family) ──
  if (selected.ev2.base.genericOnly) return decide("abstain", "generic_only");
  if (selected.core.meaningfulMatchCount < policy.minMeaningfulMatches && !selected.core.hasExactStructured && selected.lic.reason !== "structured-corroborated") {
    // A structured-corroborated semantic-only candidate is exempt from the
    // lexical meaningful-match floor (that is the whole point of the license);
    // everything else still needs lexical meaningful matches or exact structure.
    return decide("abstain", "weak_evidence");
  }
  if (selected.v3 < policy.minEvidenceConfidence) {
    return decide("abstain", "weak_evidence");
  }
  if (topFamily && topFamily.contradictionPenalty >= HARD_CONTRADICTION) {
    return decide("abstain", "family_contradicted", gateProb);
  }
  if (hasRunnerUp && marginValue < policy.marginThreshold) {
    // A licensed candidate that fails family separation is denied — record it.
    if (selected.lic.reason === "structured-corroborated") selected.lic.reason = "no-family-separation";
    return decide("abstain", "ambiguous_sibling_family", gateProb);
  }
  if (gateProb < policy.gateThreshold) {
    const reason: ServingReason = topFamily && topFamily.contradictionPenalty > 0 ? "family_contradicted" : "below_calibrated_threshold";
    return decide("abstain", reason, gateProb);
  }
  return decide("inject", "injected", gateProb);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
