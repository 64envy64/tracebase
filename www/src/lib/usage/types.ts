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
  integrity: UsageIntegrity;
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
