/**
 * Router V2 serving decision — ServingEvidenceV4 (experimental, Phase C.3).
 *
 * WHY V4 EXISTS
 *   V3's semantic-license lane (Phase C.2) licenses a body-only candidate on
 *   ABSOLUTE corroboration: ≥2 of {mechanism, unlock, invariants} overlap the
 *   query above a floor. The Phase C.2 adversarial eval proved this is not
 *   enough — a same-domain sibling (a display-rounding query vs the float-
 *   ACCUMULATION lesson) clears ≥2 fields because "floating point rounding"
 *   lives in BOTH the mechanism and the unlock text, so one shared phrase is
 *   double-counted as independent corroboration. Absolute match evidence cannot
 *   distinguish "this lesson applies" from "this lesson shares my domain's
 *   vocabulary."
 *
 * THE V4 CONTRACT (docs/PLAN.md §4.4 — compare families, not blocks)
 *   A semantic-only candidate is licensed ONLY when, in addition to V3's
 *   independent body corroboration, it is DISCRIMINATIVELY more applicable than
 *   the strongest competing sibling/family in the bounded slate:
 *
 *     discriminativeSupport = | query∩body(selected) \ body(competitor) |
 *                             / | query∩body(selected) |              ≥ 0.5
 *
 *   i.e. the MAJORITY of the body tokens that corroborate the chosen lesson must
 *   be tokens its nearest sibling does NOT also contain. A display-rounding query
 *   matches float-ACCUMULATION only on {floating, point} — tokens the float-
 *   EQUALITY sibling shares too — so its discriminative support is ~0 and it
 *   abstains; a true accumulation paraphrase matches on {accumulate, summation,
 *   low, order, bits, …}, tokens unique to that family, so it licenses.
 *
 *   MISSING or AMBIGUOUS sibling context is conservative: no competing family in
 *   the slate ⇒ abstain ("no-competitor"); a competitor exists but the gap is
 *   below the majority floor ⇒ abstain ("ambiguous-sibling"). Provider semantic
 *   RANK is never read — the gap is computed from privacy-scanned structured
 *   tokens only.
 *
 *   V4 is a strict TIGHTENING of V3: it only ever DOWNGRADES a license (never
 *   promotes), so precision is monotonic vs V3 and the decision still fails open
 *   to V2. Lexical (sparse-slate) candidates take the unchanged V2 lane.
 *
 * Gated behind TRACEBASE_REASONING_EVIDENCE=off|shadow — there is NO production
 * `on`. The BlockServer computes V4 in shadow only; serving stays V2/V1.
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
  type StructuredMemoryView,
} from "./serving-evidence-v2.js";
import { tokenizeInformative, isGenericToken } from "./serving-tokenizer.js";
import {
  aggregateFamilies,
  summarizeFamilyDecision,
  StructuredSignatureResolver,
  type FamilyResolver,
  type FamilyDecisionTelemetry,
  type ReasoningFamily,
} from "./reasoning-family.js";

export const SERVING_FEATURE_VERSION_V4 = 4 as const;

/** A structured body field must overlap at least this much to corroborate (mirrors V3). */
const CORROBORATION_FLOOR = 0.2;
/**
 * The MAJORITY of the corroborating body tokens must discriminate the chosen
 * lesson from its nearest sibling. 0.5 is the principled majority threshold —
 * chosen a priori, not fit to a fixture (docs/PLAN.md §7).
 */
const DISCRIMINATIVE_SUPPORT_MIN = 0.5;
/** A pitfall/harmful top family this severe never injects (mirrors V2/V3). */
const HARD_CONTRADICTION = 0.5;

export type EvidenceLane = "lexical" | "semantic-license";
export type SemanticLicenseReasonV4 =
  | "lexical" // candidate was in the sparse slate — plain V2 lane.
  | "structured-corroborated" // semantic-only, ≥2 body fields AND a discriminative contrastive gap.
  | "insufficient-corroboration" // semantic-only, <2 corroborating fields — denied (V3 base).
  | "no-competitor" // semantic-only, corroborated, but NO competing family to contrast — conservative abstain.
  | "ambiguous-sibling" // semantic-only, corroborated, competitor exists, gap below majority floor — abstain.
  | "no-family-separation"; // licensed by the gap but the family margin failed (set by the gate).

/**
 * Provider-neutral contrastive applicability features for the SELECTED candidate
 * vs the strongest competing sibling/family in the bounded slate. All bounded
 * numerics + a reason enum — safe for cloud telemetry; carries no raw tokens.
 */
export interface ContrastiveFeaturesV4 {
  hasCompetitor: boolean;
  competitorBlockId?: string;
  competitorFamilyId?: string;
  /** Body tokens of the query matched by the selected candidate. */
  matchedBodyTokens: number;
  /** Fraction of matched body tokens the competitor does NOT also contain ∈ [0,1]. */
  discriminativeSupport: number;
  /** Per-field rarity-weighted overlap gap (selected − competitor) ∈ [-1,1]. */
  perFieldGap: { mechanism: number; unlock: number; invariants: number };
  /** Family-margin (top − runner-up family confidence) ∈ [0,1]. */
  familySeparation: number;
  /** Invariant-overlap gap (selected − competitor) ∈ [-1,1]. */
  invariantAgreement: number;
}

export interface ServingEvidenceV4 {
  featureVersion: typeof SERVING_FEATURE_VERSION_V4;
  blockId: string;
  base: ServingEvidenceV2;
  lane: EvidenceLane;
  licenseReason: SemanticLicenseReasonV4;
  /** # of {mechanism, unlock, invariants} fields overlapping >= the floor. */
  corroboratingFields: number;
  /** Contrastive features (present only for the SELECTED semantic-only candidate). */
  contrastive?: ContrastiveFeaturesV4;
  /** Confidence the V4 decision uses. */
  v4Confidence: number;
}

export interface DecideServingV4Options {
  resolver?: FamilyResolver;
  /**
   * Override the discriminative-support majority floor. Exposed ONLY for the
   * frozen sensitivity STUDY (scripts/reasoning-precision/adversarial-v4-eval.ts)
   * to show the 0.5 choice sits in a stable region. The production server NEVER
   * sets this — there is no env knob — so the shipped constant stays 0.5.
   */
  discriminativeSupportMin?: number;
}

export interface ServingDecisionV4Result {
  decision: ServingDecision;
  perCandidate: ServingEvidenceV1[];
  evidenceV4: ServingEvidenceV4[];
  family?: FamilyDecisionTelemetry;
}

/** Independent body corroboration (V3 base): which of {mech,unlock,inv} clear the floor. */
function baseLicense(ev2: ServingEvidenceV2, semanticOnly: boolean): {
  reason: SemanticLicenseReasonV4;
  corroboratingFields: number;
  corroboratingMean: number;
} {
  const fields = [ev2.fieldOverlap.mechanism, ev2.fieldOverlap.unlock, ev2.fieldOverlap.invariants];
  const corroborating = fields.filter((x) => x >= CORROBORATION_FLOOR);
  const corroboratingFields = corroborating.length;
  const corroboratingMean = corroborating.length ? corroborating.reduce((a, b) => a + b, 0) / corroborating.length : 0;
  if (!semanticOnly) return { reason: "lexical", corroboratingFields, corroboratingMean };
  if (corroboratingFields >= 2) return { reason: "structured-corroborated", corroboratingFields, corroboratingMean };
  return { reason: "insufficient-corroboration", corroboratingFields, corroboratingMean };
}

/** Meaningful query tokens matched by a candidate's privacy-scanned BODY (mech∪unlock∪inv). */
function matchedBodyTokens(view: StructuredMemoryView, queryMeaningful: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const t of queryMeaningful) {
    if (view.fieldTokens.mechanism.has(t) || view.fieldTokens.unlock.has(t) || view.memory.invariants.includes(t)) out.add(t);
  }
  return out;
}

function bodyUnion(view: StructuredMemoryView): Set<string> {
  return new Set<string>([...view.fieldTokens.mechanism, ...view.fieldTokens.unlock, ...view.memory.invariants]);
}

/**
 * V4 (family-aware, contrastive) serving decision. Shape-compatible with
 * decideServing/V2/V3. Never throws on well-formed input; the BlockServer wraps
 * it to fall open to V2.
 */
export function decideServingV4(
  query: ServingQuery,
  candidates: readonly ServingCandidate[],
  policy: ServingPolicy,
  calibrate: EvidenceCalibrator = identityEvidenceCalibrator,
  opts: DecideServingV4Options = {},
): ServingDecisionV4Result {
  const base = { threshold: policy.gateThreshold, marginThreshold: policy.marginThreshold };
  if (candidates.length === 0) {
    return { decision: { action: "abstain", reason: "no_candidates", ...base }, perCandidate: [], evidenceV4: [] };
  }

  const views = candidates.map((c) => buildStructuredView(c.block));
  const rarity = buildRarityModel(views);
  const cores = candidates.map((c) => computeFeatures(query, c));
  const ev2 = candidates.map((c, i) => computeEvidenceV2(query, c, views[i]!, rarity, cores[i]!));
  const queryMeaningful = new Set(tokenizeInformative(query.text).filter((t) => !isGenericToken(t)));

  // V3-base license per candidate (independent corroboration only). The licensed
  // confidence feeds family aggregation so a corroborated semantic-only prototype
  // can still anchor + clear the family margin — exactly as V3.
  const baseLics = candidates.map((c, i) => baseLicense(ev2[i]!, c.provenance?.semanticOnly ?? false));
  const baseConf = (i: number): number =>
    baseLics[i]!.reason === "structured-corroborated"
      ? Math.max(ev2[i]!.evidenceConfidence, baseLics[i]!.corroboratingMean)
      : ev2[i]!.evidenceConfidence;

  const famCandidates = candidates.map((c, i) => ({
    block: c.block,
    evidence: { ...ev2[i]!, evidenceConfidence: baseConf(i) } as ServingEvidenceV2,
  }));
  const agg = aggregateFamilies(famCandidates, opts.resolver ?? new StructuredSignatureResolver());
  const familyTel = summarizeFamilyDecision(agg);
  const topFamily: ReasoningFamily | undefined = agg.families[0];

  const scored = candidates.map((c, i) => ({ c, i, core: cores[i]!, ev2: ev2[i]!, base: baseLics[i]!, conf: baseConf(i) }));
  const selected =
    scored.find((s) => s.c.block.id === topFamily?.prototypeBlockId) ??
    [...scored].sort((a, b) => b.conf - a.conf || a.i - b.i)[0]!;

  // ── Contrastive step (the V4 addition) ──────────────────────────────────
  // The discriminative gap is computed against the UNION of EVERY OTHER family's
  // body in the slate — NOT a single runner-up. A token corroborates the chosen
  // lesson discriminatively only if NO competing family shares it. This is
  // order-invariant (a set union, immune to candidate ordering / id tie-breaks)
  // and conservative. The license is DOWNGRADED (never promoted) when it fails.
  // The strongest runner-up family is still surfaced (deterministically) for the
  // per-field-gap / family-separation telemetry only.
  const selFamilyId = agg.familyByBlockId.get(selected.c.block.id);
  const otherFamilyIdx = scored.filter((s) => agg.familyByBlockId.get(s.c.block.id) !== selFamilyId);
  const competitorFamily = agg.families.find((f) => f.id !== selFamilyId);
  const competitor = competitorFamily ? scored.find((s) => s.c.block.id === competitorFamily.prototypeBlockId) : undefined;

  let contrastive: ContrastiveFeaturesV4 | undefined;
  let licenseReason: SemanticLicenseReasonV4 = selected.base.reason;
  if (selected.c.provenance?.semanticOnly) {
    const selMatched = matchedBodyTokens(views[selected.i]!, queryMeaningful);
    const otherUnion = new Set<string>();
    for (const s of otherFamilyIdx) for (const t of bodyUnion(views[s.i]!)) otherUnion.add(t);
    const discriminative = [...selMatched].filter((t) => !otherUnion.has(t));
    const discriminativeSupport = selMatched.size ? discriminative.length / selMatched.size : 0;
    const hasCompetitor = otherFamilyIdx.length > 0;
    contrastive = {
      hasCompetitor,
      ...(competitor ? { competitorBlockId: competitor.c.block.id, competitorFamilyId: competitorFamily!.id } : {}),
      matchedBodyTokens: selMatched.size,
      discriminativeSupport: round4(discriminativeSupport),
      perFieldGap: {
        mechanism: round4(selected.ev2.fieldOverlap.mechanism - (competitor?.ev2.fieldOverlap.mechanism ?? 0)),
        unlock: round4(selected.ev2.fieldOverlap.unlock - (competitor?.ev2.fieldOverlap.unlock ?? 0)),
        invariants: round4(selected.ev2.fieldOverlap.invariants - (competitor?.ev2.fieldOverlap.invariants ?? 0)),
      },
      familySeparation: familyTel.familyMargin,
      invariantAgreement: round4(selected.ev2.fieldOverlap.invariants - (competitor?.ev2.fieldOverlap.invariants ?? 0)),
    };
    if (selected.base.reason === "structured-corroborated") {
      // Tighten V3's license with the contrastive gap. The floor is the
      // principled 0.5 majority; the study-only override never reaches here in
      // production (the server passes no opts).
      const floor = opts.discriminativeSupportMin ?? DISCRIMINATIVE_SUPPORT_MIN;
      if (!hasCompetitor) licenseReason = "no-competitor";
      else if (discriminativeSupport < floor) licenseReason = "ambiguous-sibling";
      // else: stays "structured-corroborated" (licensed).
    }
  }

  // V4 confidence: licensed semantic-only uses the corroborating mean (never the
  // provider rank); everything else uses its V2/base confidence.
  const licensed = licenseReason === "structured-corroborated";
  const selV4Conf = selected.c.provenance?.semanticOnly && licensed
    ? Math.max(selected.ev2.evidenceConfidence, selected.base.corroboratingMean)
    : selected.conf;

  const gateProb = topFamily ? clamp01(calibrate(topFamily.confidence, selected.c.block)) : selV4Conf;
  const secondProb = familyTel.runnerUpFamilyConfidence;
  const marginValue = familyTel.familyMargin;
  const hasRunnerUp = agg.families.length >= 2;

  const selFeatures: ServingEvidenceV1 = {
    ...selected.ev2.base,
    evidenceConfidence: selV4Conf,
    secondBestEvidenceConfidence: round4(secondProb),
    margin: round4(marginValue),
  };
  const perCandidate: ServingEvidenceV1[] = scored.map((s) =>
    s.c.block.id === selected.c.block.id
      ? selFeatures
      : { ...s.ev2.base, evidenceConfidence: s.conf, secondBestEvidenceConfidence: 0, margin: 0 },
  );

  const evidenceV4 = (): ServingEvidenceV4[] =>
    scored.map((s) => {
      const isSel = s.c.block.id === selected.c.block.id;
      return {
        featureVersion: SERVING_FEATURE_VERSION_V4,
        blockId: s.c.block.id,
        base: s.ev2,
        lane: (s.c.provenance?.semanticOnly ? "semantic-license" : "lexical") as EvidenceLane,
        licenseReason: isSel ? licenseReason : s.base.reason,
        corroboratingFields: s.base.corroboratingFields,
        ...(isSel && contrastive ? { contrastive } : {}),
        v4Confidence: round4(isSel ? selV4Conf : s.conf),
      };
    });

  const decide = (action: ServingAction, reason: ServingReason, calibratedProb?: number): ServingDecisionV4Result => ({
    decision: {
      action,
      reason,
      topCandidateId: selected.c.block.id,
      features: selFeatures,
      ...(calibratedProb !== undefined ? { calibratedProb: round4(calibratedProb) } : {}),
      ...base,
    },
    perCandidate,
    evidenceV4: evidenceV4(),
    ...(familyTel ? { family: familyTel } : {}),
  });

  // ── Gates: V1 safety guards + family margin (mirror V2/V3-family) ──
  if (selected.ev2.base.genericOnly) return decide("abstain", "generic_only");
  // Only a contrastively-licensed semantic-only candidate is exempt from the
  // lexical meaningful-match floor. An ambiguous-sibling / no-competitor /
  // insufficient-corroboration candidate loses the exemption → abstains here.
  if (
    selected.core.meaningfulMatchCount < policy.minMeaningfulMatches &&
    !selected.core.hasExactStructured &&
    licenseReason !== "structured-corroborated"
  ) {
    return decide("abstain", "weak_evidence");
  }
  if (selV4Conf < policy.minEvidenceConfidence) {
    return decide("abstain", "weak_evidence");
  }
  if (topFamily && topFamily.contradictionPenalty >= HARD_CONTRADICTION) {
    return decide("abstain", "family_contradicted", gateProb);
  }
  if (hasRunnerUp && marginValue < policy.marginThreshold) {
    if (licenseReason === "structured-corroborated") licenseReason = "no-family-separation";
    return decide("abstain", "ambiguous_sibling_family", gateProb);
  }
  if (gateProb < policy.gateThreshold) {
    const reason: ServingReason = topFamily && topFamily.contradictionPenalty > 0 ? "family_contradicted" : "below_calibrated_threshold";
    return decide("abstain", reason, gateProb);
  }
  return decide("inject", "injected", gateProb);
}

/** Human-readable one-liner for doctor/report tooling (privacy-safe: numerics + enums). */
export function explainEvidenceV4(e: ServingEvidenceV4): string {
  const c = e.contrastive;
  const con = c
    ? ` contrastive[disc=${c.discriminativeSupport} sep=${c.familySeparation} gap(m/u/i)=${c.perFieldGap.mechanism}/${c.perFieldGap.unlock}/${c.perFieldGap.invariants} comp=${c.hasCompetitor ? "y" : "n"}]`
    : "";
  return `v4 lane=${e.lane} reason=${e.licenseReason} corr=${e.corroboratingFields} conf=${e.v4Confidence}${con}`;
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
