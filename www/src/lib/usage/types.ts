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
  integrity: UsageIntegrity;
}
