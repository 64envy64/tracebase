/**
 * Mirror of the UsageMetrics surface declared in the tracebase-ai
 * CLI (`src/analytics/usage-metrics.ts`). Cloud Build uploads only
 * the `www/` directory as source, so we cannot reach the sibling
 * package by relative path at build time — the types live here
 * verbatim.
 *
 * Keep the two files in sync manually. Any drift fails the
 * Phase 1C.1 regression tests, which exercise the CLI-side shape
 * via `computeUsageMetrics` and this file via the Impact fold.
 */

export type UsageScope = "workspace" | "agent";

export interface UsageWindow {
  afterTs?: number;
  beforeTs?: number;
}

export interface UsageObserved {
  eligibleRuns: number;
  recalledRuns: number;
  injectedRuns: number;
  usedRuns: number;
  helpfulRuns: number;
  resolvedRateWithMemory: number | null;
}

export interface UsageEstimate {
  value: number | null;
  sampleSize: number;
  formula: string;
}

export interface UsageEstimated {
  tokensSaved: UsageEstimate;
  latencySavedMs: UsageEstimate;
}

export interface UsageIntegrity {
  shadowControlMismatches: number;
  outcomesWithoutRetrieval: number;
}

export interface UsageCalibration {
  brierScore: number | null;
  auc: number | null;
  scoredInjections: number;
  refitCount: number;
  lastRefitAt: number | null;
  candidatesSeen: number;
  candidatesShown: number;
  candidatesFiltered: number;
  candidateFilterRate: number | null;
  driftInjectionCount: number;
  driftPatternsInjected: number;
}

export interface UsageMetrics {
  scope: UsageScope;
  window: UsageWindow;
  observed: UsageObserved;
  estimated: UsageEstimated;
  /**
   * Phase 3.3 — assisted vs deterministic-holdout causal block.
   * Present only when the holdout arm has at least one outcome on
   * record. Absence is the honest "experiment not running / no
   * data yet" signal.
   */
  causal?: UsageCausal;
  calibration?: UsageCalibration;
  integrity: UsageIntegrity;
  /**
   * May-2026 C5 — runtime arbiter decision-stream aggregates.
   * Mirror of the CLI-side `ArbitrationAggregates` in
   * `src/core/analytics.ts`. Counts and closed-enum histograms
   * only — no candidate ids, source ids, queryIds, or raw
   * trigger/situation text. Optional for back-compat with
   * payloads synced before C5 landed.
   *
   * Boundary contract (same as CLI side): this is the DECISION
   * stream. For "what actually reached the prompt" the
   * dashboard should keep reading existing
   * `mechanisms.fileMemory.*` and per-block / per-fact surfaces;
   * `arbitration.groundTruth.divergence` is the health check
   * between the two.
   */
  arbitration?: UsageArbitration;
}

export type ArbitrationCapability =
  | "reasoning_reuse"
  | "file_memory"
  | "loop_redirect"
  | "tool_supervision"
  | "context_fold"
  | "context_pruning";

export type ArbitrationAction = "inject" | "suppress" | "shadow";

export type ArbitrationReason =
  | "positive_roi"
  | "budget"
  | "low_confidence"
  | "stale"
  | "duplicate"
  | "profile_cap"
  | "holdout";

export interface ArbitrationCapabilityCounts {
  inject: number;
  suppress: number;
  shadow: number;
}

export interface ArbitrationGroundTruth {
  queriesWithDecisions: number;
  injectDecisions: number;
  promptVisibleItems: number;
  divergence: number;
}

export interface UsageArbitration {
  totalDecisions: number;
  byCapability: Record<ArbitrationCapability, ArbitrationCapabilityCounts>;
  byReason: Record<ArbitrationReason, number>;
  injectedTokensSum: number;
  suppressedTokensSum: number;
  injectedNetExpectedSum: number;
  groundTruth: ArbitrationGroundTruth;
}

export interface UsageCohort {
  n: number;
  resolved: number;
  resolvedRate: number | null;
}

export interface UsageCausal {
  assisted: UsageCohort;
  holdout: UsageCohort;
  resolvedLift: number | null;
  tokensLift: UsageEstimate;
  latencyLift: UsageEstimate;
  minCohortSize: number;
}

/**
 * Mirror of the CLI-side `DEFAULT_MIN_CAUSAL_COHORT`. Kept here so
 * the dashboard-side window fold uses the same default threshold as
 * the CLI — a manual copy that stays honest via the Phase 1E.5
 * compile-time drift guard (both sides' UsageMetrics must be
 * bidirectionally assignable).
 */
export const DEFAULT_MIN_CAUSAL_COHORT = 30;
