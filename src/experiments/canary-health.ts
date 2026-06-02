/**
 * Canary health evaluator (Phase D.4.2).
 *
 * A PURE function from a bounded, content-free counter struct to a trip verdict,
 * encoding the FROZEN pre-registration kill conditions verbatim (no tuning):
 *
 *   §7.1  treatment precision@observed-fire < 0.70 AFTER the first 30 served
 *         outcomes (early-stop for imprecision)
 *   §7.2  any `regressed` (harmful) treatment outcome rate > 5%
 *   §5/§7.3  attribution diagnostics (crossRun + ambiguous) > 1% of trials
 *   §6    any privacy violation
 *   §7.4  rail serving-latency p95 > 50 ms
 *
 * The thresholds are the pre-reg's, frozen here as constants — this module
 * decides WHETHER a kill condition fired, never re-tunes one. It has no clock, no
 * IO, no randomness: same counters in → same verdict out. The breaker (separate
 * module) owns persistence + latching; this owns only the rule.
 */

export const CANARY_HEALTH_VERSION = 1 as const;

/** Frozen pre-registration kill thresholds. Do NOT tune — change the pre-reg + version. */
export const HEALTH_THRESHOLDS = {
  /** §7.1 — precision is only judged once this many treatment outcomes are observed. */
  minTreatmentOutcomesForPrecision: 30,
  /** §7.1 — Wilson-target-adjacent point-estimate floor for early-stop. */
  precisionFloor: 0.7,
  /** §7.2 — harmful (regressed) treatment outcome rate ceiling. */
  maxHarmfulRate: 0.05,
  /** §5 / §7.3 — crossRun+ambiguous as a fraction of trials. */
  maxAttributionDiagnosticRate: 0.01,
  /** §7.4 — rail serving-latency p95 ceiling, ms. */
  maxRailLatencyP95Ms: 50,
} as const;

/** Bounded recency window for latency samples — an impl memory bound, not a policy threshold. */
export const LATENCY_RING_CAP = 256;

/** Closed enum: every way the breaker can trip maps to exactly one frozen rule. */
export type CanaryHealthTripReason =
  | "precision_below_floor" // §7.1
  | "harm_rate_exceeded" // §7.2
  | "attribution_unreliable" // §5 / §7.3
  | "privacy_violation" // §6
  | "latency_regression"; // §7.4

/**
 * Bounded, content-free counters the breaker accumulates incrementally on
 * exposure/outcome ingestion. Integers + a capped latency ring — never text.
 */
export interface CanaryHealthCounters {
  /** Treatment exposures emitted (served the reranker block). */
  treatmentExposed: number;
  /** Treatment exposures that have since produced a resolved/regressed outcome. */
  treatmentObservedOutcomes: number;
  /** Observed treatment outcomes labelled helpful. */
  treatmentHelpful: number;
  /** Observed treatment outcomes labelled harmful (regressed). */
  treatmentHarmful: number;
  /** Control exposures emitted (baseline abstain preserved). */
  controlExposed: number;
  /** Total joined trials — denominator for the attribution-diagnostic rate. */
  trials: number;
  /** Comparison events whose outcome/injection lived under a DIFFERENT runId. */
  crossRun: number;
  /** queryIds with more than one same-run outcome. */
  ambiguous: number;
  /** Count of privacy violations observed on the canary stream (any → halt). */
  privacyViolations: number;
  /** Capped recency ring of rail-latency samples (ms). p95 computed over it. */
  railLatencyMs: number[];
}

export interface CanaryHealthMetrics {
  treatmentObservedOutcomes: number;
  /** Helpful ÷ observed; null until any outcome is observed. */
  precision: number | null;
  /** Harmful ÷ observed; null until any outcome is observed. */
  harmfulRate: number | null;
  /** (crossRun + ambiguous) ÷ trials; null until any trial exists. */
  attributionDiagnosticRate: number | null;
  /** p95 over the latency ring; null until any sample exists. */
  railLatencyP95Ms: number | null;
}

export interface CanaryHealthVerdict {
  healthVersion: typeof CANARY_HEALTH_VERSION;
  tripped: boolean;
  /** Sorted, de-duplicated closed reasons (stable order for digests/snapshots). */
  reasons: CanaryHealthTripReason[];
  metrics: CanaryHealthMetrics;
}

/** A zeroed counter struct. */
export function emptyHealthCounters(): CanaryHealthCounters {
  return {
    treatmentExposed: 0,
    treatmentObservedOutcomes: 0,
    treatmentHelpful: 0,
    treatmentHarmful: 0,
    controlExposed: 0,
    trials: 0,
    crossRun: 0,
    ambiguous: 0,
    privacyViolations: 0,
    railLatencyMs: [],
  };
}

/** Push a latency sample into a capped ring (drops oldest past LATENCY_RING_CAP). */
export function pushLatencySample(ring: number[], sampleMs: number): number[] {
  if (!Number.isFinite(sampleMs) || sampleMs < 0) return ring;
  ring.push(sampleMs);
  if (ring.length > LATENCY_RING_CAP) ring.splice(0, ring.length - LATENCY_RING_CAP);
  return ring;
}

/** Deterministic nearest-rank p95 over the samples; null when empty. Pure. */
export function railLatencyP95(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank: ceil(0.95 * n), 1-indexed → clamp into bounds.
  const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/**
 * Evaluate the frozen kill rules against accumulated counters. Pure. The order of
 * reasons is fixed (rule order) so two equal counter sets always yield an equal
 * verdict — important for the breaker's persisted snapshot + any digest.
 */
export function evaluateCanaryHealth(
  c: CanaryHealthCounters,
  thresholds: typeof HEALTH_THRESHOLDS = HEALTH_THRESHOLDS,
): CanaryHealthVerdict {
  const observed = c.treatmentObservedOutcomes;
  const precision = observed > 0 ? c.treatmentHelpful / observed : null;
  const harmfulRate = observed > 0 ? c.treatmentHarmful / observed : null;
  const attributionDiagnosticRate = c.trials > 0 ? (c.crossRun + c.ambiguous) / c.trials : null;
  const railLatencyP95Ms = railLatencyP95(c.railLatencyMs);

  const reasons: CanaryHealthTripReason[] = [];
  // §7.1 — only judge precision once the minimum served outcomes are in.
  if (observed >= thresholds.minTreatmentOutcomesForPrecision && precision !== null && precision < thresholds.precisionFloor) {
    reasons.push("precision_below_floor");
  }
  // §7.2 — harm trips with no minimum-sample grace: a regression is the dominant risk.
  if (harmfulRate !== null && harmfulRate > thresholds.maxHarmfulRate) {
    reasons.push("harm_rate_exceeded");
  }
  // §5 / §7.3 — attribution plumbing untrustworthy.
  if (attributionDiagnosticRate !== null && attributionDiagnosticRate > thresholds.maxAttributionDiagnosticRate) {
    reasons.push("attribution_unreliable");
  }
  // §6 — any privacy violation is an immediate halt.
  if (c.privacyViolations > 0) {
    reasons.push("privacy_violation");
  }
  // §7.4 — rail latency regression.
  if (railLatencyP95Ms !== null && railLatencyP95Ms > thresholds.maxRailLatencyP95Ms) {
    reasons.push("latency_regression");
  }

  return {
    healthVersion: CANARY_HEALTH_VERSION,
    tripped: reasons.length > 0,
    reasons,
    metrics: { treatmentObservedOutcomes: observed, precision, harmfulRate, attributionDiagnosticRate, railLatencyP95Ms },
  };
}
