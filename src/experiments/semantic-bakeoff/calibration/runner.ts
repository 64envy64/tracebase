/**
 * Deterministic, provider-neutral offline calibration runner.
 *
 * It freezes rows first, assigns families as indivisible train/validation units,
 * fits one threshold on TRAIN only, and emits row-level outcomes. The manifest
 * validator recomputes every derived metric from those frozen inputs.
 */
import { createHash } from "node:crypto";
import type { ApplicabilityVerdict } from "../../../core/applicability-reranker.js";
import { validateCalibrationRegistry, type CalibrationDatasetRegistry, type CalibrationDatasetRow } from "./registry.js";
import {
  buildCalibrationManifest,
  CALIBRATION_ALGORITHM_VERSION,
  CALIBRATION_RUNNER_VERSION,
  CALIBRATION_TRAIN_RATIO,
  computeCalibrationMetrics,
  type CalibrationManifest,
  type CalibrationModel,
  type PromotionGate,
  type CalibrationOutcome,
} from "./manifest.js";

export { CALIBRATION_ALGORITHM_VERSION, CALIBRATION_RUNNER_VERSION };

export interface CalibrationScore {
  verdict: ApplicabilityVerdict;
  confidence: number;
  latencyMs: number;
  cacheState: "fresh" | "stale" | "miss";
  warmCompleted: boolean;
  warmLatencyMs?: number;
  v4Action?: "inject" | "abstain";
}

export type CalibrationScorer = (row: CalibrationDatasetRow) => Promise<CalibrationScore>;

function stableUnit(text: string): number {
  const hex = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

export function assignCalibrationFamilies(
  registry: CalibrationDatasetRegistry,
  splitSeed: number,
  trainRatio = 0.7,
): Array<{ rowId: string; familyKey: string; cohort: "train" | "validation" | "adversarial-regression" }> {
  const eligibleFamilies = [...new Set(registry.rows.filter((r) => !r.adversarialFixture).map((r) => r.familyKey))]
    .sort((a, b) => stableUnit(`${splitSeed}\0${a}`) - stableUnit(`${splitSeed}\0${b}`));
  if (eligibleFamilies.length < 2) throw new Error("calibration requires at least two eligible families");
  const cut = Math.max(1, Math.min(eligibleFamilies.length - 1, Math.round(eligibleFamilies.length * trainRatio)));
  const train = new Set(eligibleFamilies.slice(0, cut));
  return registry.rows.map((row) => ({
    rowId: row.rowId,
    familyKey: row.familyKey,
    cohort: row.adversarialFixture ? "adversarial-regression" : train.has(row.familyKey) ? "train" : "validation",
  }));
}

function qualifies(outcome: CalibrationOutcome, threshold: number): boolean {
  return outcome.verdict === "applicable" && outcome.confidence >= threshold;
}

/** Select the highest-recall TRAIN threshold whose point precision clears the frozen floor. */
export function fitCalibrationThreshold(
  rows: readonly CalibrationDatasetRow[],
  outcomes: readonly CalibrationOutcome[],
  thresholds: readonly number[],
  minTrainPrecision: number,
): number {
  const byId = new Map(rows.map((r) => [r.rowId, r]));
  let best = thresholds[thresholds.length - 1] ?? 1;
  let bestRecall = -1;
  for (const threshold of [...thresholds].sort((a, b) => a - b)) {
    const fired = outcomes.filter((o) => qualifies(o, threshold));
    const tp = fired.filter((o) => byId.get(o.rowId)?.label === "applicable").length;
    const precision = fired.length === 0 ? 1 : tp / fired.length;
    const positives = rows.filter((r) => r.label === "applicable").length;
    const recall = positives === 0 ? 0 : tp / positives;
    if (precision >= minTrainPrecision && (recall > bestRecall || (recall === bestRecall && threshold > best))) {
      best = threshold;
      bestRecall = recall;
    }
  }
  return best;
}

export async function runOfflineCalibration(opts: {
  registry: CalibrationDatasetRegistry;
  preregText: string;
  model: CalibrationModel;
  gate: PromotionGate;
  gitSha: string;
  splitSeed: number;
  trainRatio?: number;
  thresholdCandidates: number[];
  minTrainPrecision: number;
  scorer: CalibrationScorer;
}): Promise<CalibrationManifest> {
  const checked = validateCalibrationRegistry(opts.registry);
  if (!checked.ok) throw new Error(`invalid calibration registry: ${checked.violations.join("; ")}`);
  if (opts.thresholdCandidates.length === 0 || opts.thresholdCandidates.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) {
    throw new Error("thresholdCandidates must be non-empty finite values in [0, 1]");
  }
  if (new Set(opts.thresholdCandidates).size !== opts.thresholdCandidates.length) throw new Error("thresholdCandidates must be unique");
  if (!Number.isFinite(opts.minTrainPrecision) || opts.minTrainPrecision <= 0 || opts.minTrainPrecision > 1) {
    throw new Error("minTrainPrecision must be in (0, 1]");
  }
  const trainRatio = opts.trainRatio ?? CALIBRATION_TRAIN_RATIO;
  const assignments = assignCalibrationFamilies(opts.registry, opts.splitSeed, trainRatio);
  const byCohort = new Map(assignments.map((a) => [a.rowId, a.cohort]));
  const outcomes: CalibrationOutcome[] = [];
  for (const row of opts.registry.rows) {
    const score = await opts.scorer(row);
    outcomes.push({ rowId: row.rowId, ...score });
  }
  const trainRows = opts.registry.rows.filter((r) => byCohort.get(r.rowId) === "train");
  const trainIds = new Set(trainRows.map((r) => r.rowId));
  const selectedThreshold = fitCalibrationThreshold(trainRows, outcomes.filter((o) => trainIds.has(o.rowId)), opts.thresholdCandidates, opts.minTrainPrecision);
  const manifest = buildCalibrationManifest({
    registry: opts.registry,
    preregText: opts.preregText,
    model: opts.model,
    gate: opts.gate,
    gitSha: opts.gitSha,
    splitSeed: opts.splitSeed,
    trainRatio,
    thresholdCandidates: opts.thresholdCandidates,
    selectedThreshold,
    minTrainPrecision: opts.minTrainPrecision,
    runnerVersion: CALIBRATION_RUNNER_VERSION,
    algorithmVersion: CALIBRATION_ALGORITHM_VERSION,
    assignments,
    outcomes,
  });
  manifest.metrics = computeCalibrationMetrics(manifest);
  return manifest;
}
