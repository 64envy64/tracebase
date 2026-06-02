/**
 * E.2.3 — FROZEN calibration manifest schema + gate (R&D scaffold; NO fitting here).
 *
 * This module encodes the calibration PRE-REGISTRATION as machine-checkable
 * invariants (see docs/semantic-calibration-prereg.md). It does NOT fit thresholds
 * and does NOT promote anything — it (1) defines the manifest a calibration run must
 * produce, (2) provides the Wilson lower-bound precision gate, and (3) validates a
 * manifest against the frozen protocol so an over-fit / leaky / fixture-contaminated
 * run is REJECTED before any promotion decision.
 *
 * Hard rules enforced (all must hold or the manifest is invalid):
 *   - Thresholds are NEVER fit on the 18 adversarial viability fixtures
 *     (`usesAdversarialFixturesForFitting` MUST be false). Those fixtures are
 *     regression/viability only; fitting on them overfits the known cases.
 *   - The split is FAMILY-GROUPED and LEAKAGE-SAFE: no family key may appear in both
 *     train and validation (otherwise val precision is inflated by memorisation).
 *   - Validation must include HARD NEGATIVES (near-miss candidates that must be
 *     judged inapplicable) — at least `MIN_HARD_NEGATIVES`.
 *   - The promotion gate is the Wilson 95% LOWER BOUND on validation precision, not
 *     the point estimate (small-sample honest).
 *   - Cache + warm metrics are reported (the overlay's value depends on hit-rate).
 *   - Explicit STOP conditions are declared and block promotion when tripped.
 */
import { createHash } from "node:crypto";

export const CALIBRATION_MANIFEST_VERSION = 1 as const;
/** Minimum hard negatives required in validation (leakage-safe near-misses). */
export const MIN_HARD_NEGATIVES = 20;
/** The viability fixture set is OFF-LIMITS for threshold fitting. */
export const ADVERSARIAL_FIXTURE_COUNT = 18;

export interface CalibrationModel {
  name: string;
  revision: string;
  featureVersion: number;
  backend: string;
}

/** Family-grouped, leakage-safe split descriptor (attested by the run). */
export interface CalibrationSplit {
  /** Distinct family keys assigned to TRAIN (threshold fitting). */
  trainFamilies: string[];
  /** Distinct family keys assigned to VALIDATION (gate evaluation). DISJOINT from train. */
  valFamilies: string[];
  /** # hard-negative (near-miss → must be inapplicable) examples in validation. */
  hardNegativeCount: number;
  /** MUST be false: the 18 adversarial viability fixtures are never used to FIT. */
  usesAdversarialFixturesForFitting: boolean;
  /** Deterministic split seed (so the family assignment is reproducible). */
  splitSeed: number;
}

/** Promotion gate + explicit stop conditions — frozen BEFORE results are seen. */
export interface PromotionGate {
  /** Promote only if Wilson-LB(validation precision) ≥ this. */
  minWilsonLbPrecision: number;
  /** STOP: harmful-apply rate on validation must stay ≤ this. */
  maxHarmfulApplyRate: number;
  /** STOP: the overlay is worthless if the cache hit-rate is below this. */
  minCacheHitRate: number;
  /** STOP: warm revalidation P95 latency must stay ≤ this (capacity guard). */
  maxWarmLatencyP95Ms: number;
  /** STOP: minimum validation sample size (no promotion on a thin val set). */
  minValidationN: number;
}

/** Measured outcomes — ABSENT in the pre-registered (frozen) manifest; filled post-run. */
export interface CalibrationMetrics {
  validation: {
    n: number;
    /** Applies the model judged `applicable` that were truly applicable. */
    truePositives: number;
    /** Applies the model judged `applicable` that were NOT applicable (harmful applies). */
    falsePositives: number;
    /** Wilson 95% lower bound on precision = TP/(TP+FP). Computed via wilsonLowerBound. */
    wilsonLbPrecision: number;
    harmfulApplyRate: number;
  };
  cache: { hitRate: number; warmCompletionRate: number; warmLatencyP95Ms: number };
  /** Fraction of shadow comparisons where the semantic verdict agreed with V4. */
  shadowAgreementRate: number;
}

export interface CalibrationManifest {
  manifestVersion: typeof CALIBRATION_MANIFEST_VERSION;
  /** ISO timestamp the protocol was FROZEN (pre-registration; before results). */
  frozenAt: string;
  /** Hash of the frozen pre-reg doc the run commits to (preregHashOf). */
  preregHash: string;
  model: CalibrationModel;
  split: CalibrationSplit;
  gate: PromotionGate;
  /** Filled AFTER the run; absent in the pre-registered manifest. */
  metrics?: CalibrationMetrics;
}

/** Stable hash of the frozen pre-reg text — the manifest commits to an exact doc. */
export function preregHashOf(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

/**
 * Wilson score interval LOWER bound for a binomial proportion. Honest on small
 * samples (unlike the naive p ± z·√(p(1-p)/n)). z defaults to 1.96 (95%).
 * Returns 0 for n=0.
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, center - margin);
}

/**
 * Validate a manifest against the FROZEN pre-reg invariants. Returns every violation
 * (does not throw). A manifest with any violation MUST NOT be used to promote.
 */
export function validateCalibrationManifest(m: CalibrationManifest): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  if (m.manifestVersion !== CALIBRATION_MANIFEST_VERSION) v.push(`manifestVersion must be ${CALIBRATION_MANIFEST_VERSION}`);
  if (!m.preregHash || m.preregHash.length < 8) v.push("preregHash missing (must commit to a frozen pre-reg doc)");
  // Hard rule: never fit on the adversarial viability fixtures.
  if (m.split.usesAdversarialFixturesForFitting) v.push("split.usesAdversarialFixturesForFitting must be false (the 18 fixtures are viability-only; fitting on them overfits)");
  // Leakage-safe: train/val families must be DISJOINT and both non-empty.
  if (m.split.trainFamilies.length === 0) v.push("split.trainFamilies is empty");
  if (m.split.valFamilies.length === 0) v.push("split.valFamilies is empty");
  const trainSet = new Set(m.split.trainFamilies);
  const overlap = m.split.valFamilies.filter((f) => trainSet.has(f));
  if (overlap.length > 0) v.push(`family LEAKAGE: ${overlap.length} family/families in both train and validation (e.g. ${overlap.slice(0, 3).join(", ")})`);
  // Hard negatives required.
  if (m.split.hardNegativeCount < MIN_HARD_NEGATIVES) v.push(`split.hardNegativeCount ${m.split.hardNegativeCount} < ${MIN_HARD_NEGATIVES} required hard negatives`);
  // Gate must be Wilson-LB based + have explicit stop conditions in range.
  const g = m.gate;
  if (!(g.minWilsonLbPrecision > 0 && g.minWilsonLbPrecision <= 1)) v.push("gate.minWilsonLbPrecision must be in (0, 1]");
  if (!(g.maxHarmfulApplyRate >= 0 && g.maxHarmfulApplyRate < 1)) v.push("gate.maxHarmfulApplyRate must be in [0, 1)");
  if (!(g.minCacheHitRate >= 0 && g.minCacheHitRate <= 1)) v.push("gate.minCacheHitRate must be in [0, 1]");
  if (!(g.maxWarmLatencyP95Ms > 0)) v.push("gate.maxWarmLatencyP95Ms must be > 0");
  if (!(g.minValidationN > 0)) v.push("gate.minValidationN must be > 0");
  // If metrics are present, the reported Wilson-LB must match the reported TP/FP.
  if (m.metrics) {
    const { truePositives: tp, falsePositives: fp, wilsonLbPrecision } = m.metrics.validation;
    const recomputed = wilsonLowerBound(tp, tp + fp);
    if (Math.abs(recomputed - wilsonLbPrecision) > 1e-6) v.push(`metrics.validation.wilsonLbPrecision (${wilsonLbPrecision}) != recomputed Wilson-LB (${recomputed.toFixed(6)})`);
  }
  return { ok: v.length === 0, violations: v };
}

export type PromotionDecision = "promote" | "hold" | "reject";

/**
 * Apply the frozen gate + stop conditions to a manifest's measured metrics. Returns
 * a conservative decision + the reasons. NEVER promotes a manifest that fails
 * validation or whose metrics are absent (a pre-reg has no results yet → "hold").
 */
export function evaluatePromotion(m: CalibrationManifest): { decision: PromotionDecision; reasons: string[] } {
  const valid = validateCalibrationManifest(m);
  if (!valid.ok) return { decision: "reject", reasons: ["manifest invalid:", ...valid.violations] };
  if (!m.metrics) return { decision: "hold", reasons: ["no measured metrics yet (frozen pre-registration only)"] };
  const reasons: string[] = [];
  const { validation: val, cache } = m.metrics;
  const g = m.gate;
  // STOP conditions first (any trip → reject).
  if (val.n < g.minValidationN) reasons.push(`STOP: validation n=${val.n} < minValidationN=${g.minValidationN}`);
  if (val.harmfulApplyRate > g.maxHarmfulApplyRate) reasons.push(`STOP: harmfulApplyRate ${val.harmfulApplyRate} > ${g.maxHarmfulApplyRate}`);
  if (cache.hitRate < g.minCacheHitRate) reasons.push(`STOP: cache hitRate ${cache.hitRate} < ${g.minCacheHitRate}`);
  if (cache.warmLatencyP95Ms > g.maxWarmLatencyP95Ms) reasons.push(`STOP: warm P95 ${cache.warmLatencyP95Ms}ms > ${g.maxWarmLatencyP95Ms}ms`);
  if (reasons.length > 0) return { decision: "reject", reasons };
  // The promotion gate: Wilson-LB precision must clear the bar.
  if (val.wilsonLbPrecision < g.minWilsonLbPrecision) {
    return { decision: "hold", reasons: [`Wilson-LB precision ${val.wilsonLbPrecision.toFixed(3)} < gate ${g.minWilsonLbPrecision} — collect more validation or improve the model`] };
  }
  return { decision: "promote", reasons: [`Wilson-LB precision ${val.wilsonLbPrecision.toFixed(3)} ≥ gate ${g.minWilsonLbPrecision}; all stop conditions clear`] };
}
