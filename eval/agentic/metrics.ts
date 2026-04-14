import type { Trajectory, AggregateMetrics, TrajectoryDelta, FixtureResult } from "./types.js";

export function computeAggregate(trajectories: Trajectory[]): AggregateMetrics {
  const n = trajectories.length;
  if (n === 0) return { fixtureCount: 0, accuracy: 0, avgSteps: 0, medianSteps: 0, avgTokens: 0, medianTokens: 0, totalTokens: 0 };

  const successes = trajectories.filter((t) => t.success).length;
  const steps = trajectories.map((t) => t.totalSteps);
  const tokens = trajectories.map((t) => t.totalTokens);

  return {
    fixtureCount: n,
    accuracy: successes / n,
    avgSteps: steps.reduce((a, b) => a + b, 0) / n,
    medianSteps: median(steps),
    avgTokens: tokens.reduce((a, b) => a + b, 0) / n,
    medianTokens: median(tokens),
    totalTokens: tokens.reduce((a, b) => a + b, 0),
  };
}

export function computeDelta(results: FixtureResult[]): TrajectoryDelta {
  const baselineAccuracy = results.filter((r) => r.baseline.success).length / results.length;
  const augmentedAccuracy = results.filter((r) => r.augmented.success).length / results.length;

  // Step and token saves — only where BOTH succeeded (fair comparison)
  const bothSucceeded = results.filter((r) => r.baseline.success && r.augmented.success);
  const stepSaves = bothSucceeded.map((r) => r.stepSave).filter((s): s is number => s !== null);
  const tokenSaves = bothSucceeded.map((r) => r.tokenSave).filter((s): s is number => s !== null);

  // Also count augmented-only successes for accuracy gain
  const recallHits = results.filter((r) => r.augmented.injected);

  return {
    accuracyDeltaPP: (augmentedAccuracy - baselineAccuracy) * 100,
    accuracyGainRelative: baselineAccuracy > 0
      ? ((augmentedAccuracy - baselineAccuracy) / baselineAccuracy) * 100
      : augmentedAccuracy > 0 ? 100 : 0,
    avgStepSave: stepSaves.length > 0 ? (stepSaves.reduce((a, b) => a + b, 0) / stepSaves.length) * 100 : 0,
    avgTokenSave: tokenSaves.length > 0 ? (tokenSaves.reduce((a, b) => a + b, 0) / tokenSaves.length) * 100 : 0,
    peakTokenSave: tokenSaves.length > 0 ? Math.max(...tokenSaves) * 100 : 0,
    peakStepSave: stepSaves.length > 0 ? Math.max(...stepSaves) * 100 : 0,
    recallHitRate: recallHits.length / results.length,
  };
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
