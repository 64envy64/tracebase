/**
 * E.2.4 auditable semantic-calibration manifest.
 *
 * A manifest is self-contained: frozen rows, row-level split assignments,
 * provider outcomes, model attestation, threshold grid and runner identity are
 * all content-addressed. Validation recomputes hashes, counts and metrics from
 * rows instead of trusting report fields.
 */
import { createHash } from "node:crypto";
import { attestationHash, type ModelAttestation } from "../service/protocol.js";
import {
  datasetHashOf,
  provenanceHashOf,
  validateCalibrationRegistry,
  type CalibrationDatasetRegistry,
} from "./registry.js";

export const CALIBRATION_MANIFEST_VERSION = 2 as const;
export const MIN_HARD_NEGATIVES = 20;
export const ADVERSARIAL_FIXTURE_COUNT = 18;
export const CALIBRATION_RUNNER_VERSION = "semantic-calibration-runner.v1";
export const CALIBRATION_ALGORITHM_VERSION = "train-precision-then-recall.v1";
export const CALIBRATION_TRAIN_RATIO = 0.7;

export interface CalibrationModel extends ModelAttestation {}

export interface CalibrationAssignment {
  rowId: string;
  familyKey: string;
  cohort: "train" | "validation" | "adversarial-regression";
}

export interface CalibrationSplit {
  trainFamilies: string[];
  valFamilies: string[];
  hardNegativeCount: number;
  usesAdversarialFixturesForFitting: boolean;
  splitSeed: number;
  trainRatio: number;
  assignments: CalibrationAssignment[];
  splitHash: string;
}

export interface PromotionGate {
  minWilsonLbPrecision: number;
  maxHarmfulApplyRate: number;
  minCacheHitRate: number;
  maxWarmLatencyP95Ms: number;
  minValidationN: number;
}

export interface CalibrationOutcome {
  rowId: string;
  verdict: "applicable" | "uncertain" | "inapplicable";
  confidence: number;
  latencyMs: number;
  cacheState: "fresh" | "stale" | "miss";
  warmCompleted: boolean;
  warmLatencyMs?: number;
  v4Action?: "inject" | "abstain";
}

export interface CalibrationMetrics {
  validation: {
    n: number;
    truePositives: number;
    falsePositives: number;
    wilsonLbPrecision: number;
    harmfulApplyRate: number;
  };
  cache: { hitRate: number; warmCompletionRate: number; warmLatencyP95Ms: number };
  shadowAgreementRate: number;
  adversarialRegression: { n: number; fired: number; passed: boolean };
}

export interface CalibrationRun {
  runnerVersion: string;
  algorithmVersion: string;
  gitSha: string;
  thresholdCandidates: number[];
  selectedThreshold: number;
  minTrainPrecision: number;
  modelAttestationHash: string;
  outcomes: CalibrationOutcome[];
}

export interface CalibrationManifest {
  manifestVersion: typeof CALIBRATION_MANIFEST_VERSION;
  frozenAt: string;
  preregHash: string;
  datasetHash: string;
  provenanceHash: string;
  registry: CalibrationDatasetRegistry;
  model: CalibrationModel;
  split: CalibrationSplit;
  gate: PromotionGate;
  /** Filled after scoring. A pre-registration may omit this whole block. */
  run?: CalibrationRun;
  metrics?: CalibrationMetrics;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function preregHashOf(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

export function splitHashOf(assignments: readonly CalibrationAssignment[], splitSeed: number, trainRatio: number): string {
  return hashJson([splitSeed, trainRatio, [...assignments].sort((a, b) => a.rowId.localeCompare(b.rowId))]);
}

export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, center - margin);
}

function percentile(xs: number[], fraction: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function computeCalibrationMetrics(m: CalibrationManifest): CalibrationMetrics {
  if (!m.run) throw new Error("run outcomes required");
  const rows = new Map(m.registry.rows.map((row) => [row.rowId, row]));
  const cohorts = new Map(m.split.assignments.map((a) => [a.rowId, a.cohort]));
  const validation = m.run.outcomes.filter((o) => cohorts.get(o.rowId) === "validation");
  const fired = validation.filter((o) => o.verdict === "applicable" && o.confidence >= m.run!.selectedThreshold);
  const tp = fired.filter((o) => rows.get(o.rowId)?.label === "applicable").length;
  const fp = fired.filter((o) => rows.get(o.rowId)?.label === "inapplicable").length;
  const hit = validation.filter((o) => o.cacheState !== "miss").length;
  const warm = validation.filter((o) => o.warmCompleted);
  const comparable = validation.filter((o) => o.v4Action !== undefined);
  const agreement = comparable.filter((o) => (o.v4Action === "inject") === (o.verdict === "applicable" && o.confidence >= m.run!.selectedThreshold)).length;
  const adversarial = m.run.outcomes.filter((o) => cohorts.get(o.rowId) === "adversarial-regression");
  const adversarialFired = adversarial.filter((o) => o.verdict === "applicable" && o.confidence >= m.run!.selectedThreshold).length;
  return {
    validation: {
      n: validation.length,
      truePositives: tp,
      falsePositives: fp,
      wilsonLbPrecision: wilsonLowerBound(tp, tp + fp),
      harmfulApplyRate: validation.length === 0 ? 0 : fp / validation.length,
    },
    cache: {
      hitRate: validation.length === 0 ? 0 : hit / validation.length,
      warmCompletionRate: validation.length === 0 ? 0 : warm.length / validation.length,
      warmLatencyP95Ms: percentile(warm.map((o) => o.warmLatencyMs ?? 0), 0.95),
    },
    shadowAgreementRate: comparable.length === 0 ? 0 : agreement / comparable.length,
    adversarialRegression: { n: adversarial.length, fired: adversarialFired, passed: adversarialFired === 0 },
  };
}

export function buildCalibrationManifest(opts: {
  registry: CalibrationDatasetRegistry;
  preregText: string;
  model: CalibrationModel;
  gate: PromotionGate;
  gitSha: string;
  splitSeed: number;
  trainRatio: number;
  thresholdCandidates: number[];
  selectedThreshold: number;
  minTrainPrecision: number;
  runnerVersion: string;
  algorithmVersion: string;
  assignments: CalibrationAssignment[];
  outcomes: CalibrationOutcome[];
}): CalibrationManifest {
  const trainFamilies = [...new Set(opts.assignments.filter((a) => a.cohort === "train").map((a) => a.familyKey))].sort();
  const valFamilies = [...new Set(opts.assignments.filter((a) => a.cohort === "validation").map((a) => a.familyKey))].sort();
  const byId = new Map(opts.registry.rows.map((row) => [row.rowId, row]));
  const hardNegativeCount = opts.assignments.filter((a) => a.cohort === "validation" && byId.get(a.rowId)?.hardNegative).length;
  return {
    manifestVersion: CALIBRATION_MANIFEST_VERSION,
    frozenAt: opts.registry.frozenAt,
    preregHash: preregHashOf(opts.preregText),
    datasetHash: datasetHashOf(opts.registry),
    provenanceHash: provenanceHashOf(opts.registry),
    registry: opts.registry,
    model: opts.model,
    split: {
      trainFamilies,
      valFamilies,
      hardNegativeCount,
      usesAdversarialFixturesForFitting: false,
      splitSeed: opts.splitSeed,
      trainRatio: opts.trainRatio,
      assignments: opts.assignments,
      splitHash: splitHashOf(opts.assignments, opts.splitSeed, opts.trainRatio),
    },
    gate: opts.gate,
    run: {
      runnerVersion: opts.runnerVersion,
      algorithmVersion: opts.algorithmVersion,
      gitSha: opts.gitSha,
      thresholdCandidates: [...opts.thresholdCandidates],
      selectedThreshold: opts.selectedThreshold,
      minTrainPrecision: opts.minTrainPrecision,
      modelAttestationHash: attestationHash(opts.model),
      outcomes: opts.outcomes,
    },
  };
}

function sameMetrics(a: CalibrationMetrics, b: CalibrationMetrics): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validateCalibrationManifest(m: CalibrationManifest): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  if (m.manifestVersion !== CALIBRATION_MANIFEST_VERSION) v.push(`manifestVersion must be ${CALIBRATION_MANIFEST_VERSION}`);
  if (!m.preregHash || m.preregHash.length !== 64) v.push("preregHash must be a sha256 digest");
  const registry = validateCalibrationRegistry(m.registry);
  v.push(...registry.violations.map((x) => `registry: ${x}`));
  if (datasetHashOf(m.registry) !== m.datasetHash) v.push("datasetHash does not match frozen rows");
  if (provenanceHashOf(m.registry) !== m.provenanceHash) v.push("provenanceHash does not match frozen rows");
  if (m.frozenAt !== m.registry.frozenAt) v.push("frozenAt does not match registry");
  if (splitHashOf(m.split.assignments, m.split.splitSeed, m.split.trainRatio) !== m.split.splitHash) v.push("splitHash does not match row assignments, seed and ratio");
  if (m.split.usesAdversarialFixturesForFitting) v.push("split.usesAdversarialFixturesForFitting must be false");
  if (!Number.isInteger(m.split.splitSeed)) v.push("split.splitSeed must be an integer");
  if (!Number.isFinite(m.split.trainRatio) || m.split.trainRatio <= 0 || m.split.trainRatio >= 1) v.push("split.trainRatio must be in (0, 1)");
  if (
    !m.model.model || !m.model.revision || !m.model.backend ||
    !Number.isInteger(m.model.featureVersion) || m.model.featureVersion < 1
  ) v.push("model attestation is incomplete or invalid");
  const rows = new Map(m.registry.rows.map((row) => [row.rowId, row]));
  const assigned = new Set<string>();
  const familyCohort = new Map<string, "train" | "validation">();
  for (const a of m.split.assignments) {
    const row = rows.get(a.rowId);
    if (!["train", "validation", "adversarial-regression"].includes(a.cohort)) v.push(`invalid split cohort for row ${a.rowId}`);
    if (!row) v.push(`split assignment references unknown row ${a.rowId}`);
    if (assigned.has(a.rowId)) v.push(`duplicate split assignment for row ${a.rowId}`);
    assigned.add(a.rowId);
    if (row && row.familyKey !== a.familyKey) v.push(`split family mismatch for row ${a.rowId}`);
    if (a.cohort !== "adversarial-regression") {
      const prior = familyCohort.get(a.familyKey);
      if (prior && prior !== a.cohort) v.push(`family LEAKAGE: ${a.familyKey} appears in train and validation`);
      familyCohort.set(a.familyKey, a.cohort);
    }
    if (row?.adversarialFixture && a.cohort !== "adversarial-regression") v.push(`adversarial fixture ${a.rowId} used for fitting`);
    if (a.cohort === "adversarial-regression" && !row?.adversarialFixture) v.push(`non-adversarial row ${a.rowId} assigned to adversarial regression`);
  }
  if (assigned.size !== m.registry.rows.length) v.push("not every frozen row has exactly one split assignment");
  const trainFamilies = [...familyCohort.entries()].filter(([, c]) => c === "train").map(([f]) => f).sort();
  const valFamilies = [...familyCohort.entries()].filter(([, c]) => c === "validation").map(([f]) => f).sort();
  if (JSON.stringify(trainFamilies) !== JSON.stringify([...m.split.trainFamilies].sort())) v.push("split.trainFamilies does not match row assignments");
  if (JSON.stringify(valFamilies) !== JSON.stringify([...m.split.valFamilies].sort())) v.push("split.valFamilies does not match row assignments");
  if (trainFamilies.length === 0) v.push("split.trainFamilies is empty");
  if (valFamilies.length === 0) v.push("split.valFamilies is empty");
  const hardNegativeCount = m.split.assignments.filter((a) => a.cohort === "validation" && rows.get(a.rowId)?.hardNegative).length;
  if (hardNegativeCount !== m.split.hardNegativeCount) v.push("split.hardNegativeCount does not match frozen validation rows");
  if (hardNegativeCount < MIN_HARD_NEGATIVES) v.push(`split.hardNegativeCount ${hardNegativeCount} < ${MIN_HARD_NEGATIVES}`);
  const adversarialCount = m.registry.rows.filter((row) => row.adversarialFixture).length;
  if (m.registry.kind === "organic-calibration" && adversarialCount !== ADVERSARIAL_FIXTURE_COUNT) {
    v.push(`organic calibration requires exactly ${ADVERSARIAL_FIXTURE_COUNT} adversarial fixtures`);
  }
  const g = m.gate;
  if (!(g.minWilsonLbPrecision > 0 && g.minWilsonLbPrecision <= 1)) v.push("gate.minWilsonLbPrecision must be in (0, 1]");
  if (!(g.maxHarmfulApplyRate >= 0 && g.maxHarmfulApplyRate < 1)) v.push("gate.maxHarmfulApplyRate must be in [0, 1)");
  if (!(g.minCacheHitRate >= 0 && g.minCacheHitRate <= 1)) v.push("gate.minCacheHitRate must be in [0, 1]");
  if (!(g.maxWarmLatencyP95Ms > 0)) v.push("gate.maxWarmLatencyP95Ms must be > 0");
  if (!(g.minValidationN > 0)) v.push("gate.minValidationN must be > 0");
  if (m.run) {
    if (!m.run.gitSha) v.push("run.gitSha missing");
    if (m.run.runnerVersion !== CALIBRATION_RUNNER_VERSION) v.push(`run.runnerVersion must be ${CALIBRATION_RUNNER_VERSION}`);
    if (m.run.algorithmVersion !== CALIBRATION_ALGORITHM_VERSION) v.push(`run.algorithmVersion must be ${CALIBRATION_ALGORITHM_VERSION}`);
    if (m.run.modelAttestationHash !== attestationHash(m.model)) v.push("run.modelAttestationHash does not match model");
    if (m.run.thresholdCandidates.length === 0) v.push("run.thresholdCandidates is empty");
    if (new Set(m.run.thresholdCandidates).size !== m.run.thresholdCandidates.length) v.push("run.thresholdCandidates contains duplicates");
    if (m.run.thresholdCandidates.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) v.push("run.thresholdCandidates must be finite values in [0, 1]");
    if (!Number.isFinite(m.run.minTrainPrecision) || m.run.minTrainPrecision <= 0 || m.run.minTrainPrecision > 1) v.push("run.minTrainPrecision must be in (0, 1]");
    if (!m.run.thresholdCandidates.includes(m.run.selectedThreshold)) v.push("run.selectedThreshold is outside the frozen threshold grid");
    for (const outcome of m.run.outcomes) {
      if (!["applicable", "uncertain", "inapplicable"].includes(outcome.verdict)) v.push(`run outcome ${outcome.rowId}: invalid verdict`);
      if (!Number.isFinite(outcome.confidence) || outcome.confidence < 0 || outcome.confidence > 1) v.push(`run outcome ${outcome.rowId}: confidence must be in [0, 1]`);
      if (!Number.isFinite(outcome.latencyMs) || outcome.latencyMs < 0) v.push(`run outcome ${outcome.rowId}: latencyMs must be >= 0`);
      if (!["fresh", "stale", "miss"].includes(outcome.cacheState)) v.push(`run outcome ${outcome.rowId}: invalid cacheState`);
      if (typeof outcome.warmCompleted !== "boolean") v.push(`run outcome ${outcome.rowId}: warmCompleted must be boolean`);
      if (outcome.warmLatencyMs !== undefined && (!Number.isFinite(outcome.warmLatencyMs) || outcome.warmLatencyMs < 0)) v.push(`run outcome ${outcome.rowId}: warmLatencyMs must be >= 0`);
    }
    const outcomeIds = new Set(m.run.outcomes.map((o) => o.rowId));
    if (outcomeIds.size !== m.run.outcomes.length) v.push("duplicate run outcome rowId");
    if (outcomeIds.size !== m.registry.rows.length || [...rows.keys()].some((id) => !outcomeIds.has(id))) v.push("run outcomes do not cover every frozen row exactly once");
    if (!m.metrics) v.push("metrics missing for scored run");
    else if (!sameMetrics(computeCalibrationMetrics(m), m.metrics)) v.push("metrics do not match row-level recomputation");
  } else if (m.metrics) {
    v.push("metrics present without run outcomes");
  }
  return { ok: v.length === 0, violations: v };
}

export type PromotionDecision = "promote" | "hold" | "reject";

export function evaluatePromotion(m: CalibrationManifest): { decision: PromotionDecision; reasons: string[] } {
  const valid = validateCalibrationManifest(m);
  if (!valid.ok) return { decision: "reject", reasons: ["manifest invalid:", ...valid.violations] };
  if (!m.run || !m.metrics) return { decision: "hold", reasons: ["no measured metrics yet"] };
  if (m.registry.kind !== "organic-calibration") return { decision: "hold", reasons: ["fixture-smoke datasets validate plumbing only; never promote"] };
  const reasons: string[] = [];
  const { validation: val, cache } = m.metrics;
  const g = m.gate;
  if (val.n < g.minValidationN) reasons.push(`STOP: validation n=${val.n} < minValidationN=${g.minValidationN}`);
  if (val.harmfulApplyRate > g.maxHarmfulApplyRate) reasons.push(`STOP: harmfulApplyRate ${val.harmfulApplyRate} > ${g.maxHarmfulApplyRate}`);
  if (cache.hitRate < g.minCacheHitRate) reasons.push(`STOP: cache hitRate ${cache.hitRate} < ${g.minCacheHitRate}`);
  if (cache.warmLatencyP95Ms > g.maxWarmLatencyP95Ms) reasons.push(`STOP: warm P95 ${cache.warmLatencyP95Ms}ms > ${g.maxWarmLatencyP95Ms}ms`);
  if (m.metrics.adversarialRegression.n !== ADVERSARIAL_FIXTURE_COUNT) reasons.push(`STOP: adversarial regression n=${m.metrics.adversarialRegression.n} != ${ADVERSARIAL_FIXTURE_COUNT}`);
  if (!m.metrics.adversarialRegression.passed) reasons.push(`STOP: adversarial regression fired=${m.metrics.adversarialRegression.fired}`);
  if (reasons.length > 0) return { decision: "reject", reasons };
  if (val.wilsonLbPrecision < g.minWilsonLbPrecision) {
    return { decision: "hold", reasons: [`Wilson-LB precision ${val.wilsonLbPrecision.toFixed(3)} < gate ${g.minWilsonLbPrecision}`] };
  }
  return { decision: "promote", reasons: [`Wilson-LB precision ${val.wilsonLbPrecision.toFixed(3)} >= gate ${g.minWilsonLbPrecision}; all stop conditions clear`] };
}
