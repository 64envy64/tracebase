import type { TaskRun, ConditionMetrics, BenchmarkResults } from "./types.js";

/**
 * Compute aggregate metrics from a set of task runs.
 */
export function computeMetrics(runs: TaskRun[]): ConditionMetrics {
  const n = runs.length;
  if (n === 0) {
    return {
      totalTasks: 0, successCount: 0, successRate: 0,
      avgTokens: 0, medianTokens: 0, avgDurationMs: 0, totalTokens: 0,
    };
  }

  const successCount = runs.filter((r) => r.success).length;
  const tokens = runs.map((r) => r.tokensUsed);
  const sorted = [...tokens].sort((a, b) => a - b);
  const totalTokens = tokens.reduce((a, b) => a + b, 0);

  return {
    totalTasks: n,
    successCount,
    successRate: successCount / n,
    avgTokens: totalTokens / n,
    medianTokens: sorted[Math.floor(n / 2)]!,
    avgDurationMs: runs.reduce((a, r) => a + r.durationMs, 0) / n,
    totalTokens,
  };
}

/**
 * Compute delta metrics between baseline and augmented conditions.
 */
export function computeDelta(
  baseline: ConditionMetrics,
  augmented: ConditionMetrics,
  augmentedRuns: TaskRun[],
): BenchmarkResults["delta"] {
  const recallHits = augmentedRuns.filter((r) => r.recallHit);
  const avgConfidence = recallHits.length > 0
    ? recallHits.reduce((a, r) => a + (r.injectedScore ?? 0), 0) / recallHits.length
    : 0;

  return {
    successRateDelta: (augmented.successRate - baseline.successRate) * 100,
    tokenSavingsPercent: baseline.avgTokens > 0
      ? ((baseline.avgTokens - augmented.avgTokens) / baseline.avgTokens) * 100
      : 0,
    timeReductionPercent: baseline.avgDurationMs > 0
      ? ((baseline.avgDurationMs - augmented.avgDurationMs) / baseline.avgDurationMs) * 100
      : 0,
    recallHitRate: augmentedRuns.length > 0
      ? recallHits.length / augmentedRuns.length
      : 0,
    avgInjectionConfidence: avgConfidence,
  };
}
