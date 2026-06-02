/**
 * E.2.4 auditable calibration: hashes bind frozen rows, split and provenance;
 * validation recomputes metrics; fixtures can prove plumbing but never promote.
 */
import { describe, it, expect } from "vitest";
import {
  buildCalibrationManifest,
  CALIBRATION_ALGORITHM_VERSION,
  CALIBRATION_RUNNER_VERSION,
  computeCalibrationMetrics,
  evaluatePromotion,
  validateCalibrationManifest,
  wilsonLowerBound,
  type CalibrationAssignment,
  type CalibrationManifest,
  type CalibrationOutcome,
} from "../../src/experiments/semantic-bakeoff/calibration/manifest.js";
import {
  datasetHashOf,
  validateCalibrationRegistry,
  type CalibrationDatasetRegistry,
  type CalibrationDatasetRow,
} from "../../src/experiments/semantic-bakeoff/calibration/registry.js";
import { assignCalibrationFamilies, runOfflineCalibration } from "../../src/experiments/semantic-bakeoff/calibration/runner.js";

const candidate = (id: string) => ({
  blockId: id,
  tokens: { situation: ["balance"], mechanism: ["rounding"], unlock: ["kahan"], invariants: [] },
  signals: { isPitfall: false, helpful: 1, harmful: 0, unresolved: 0, familySupport: 1, sourceDiversity: 1 },
});
const row = (rowId: string, familyKey: string, label: "applicable" | "inapplicable", hardNegative = false): CalibrationDatasetRow => ({
  rowId,
  familyKey,
  query: { literalText: `query ${rowId}` },
  candidate: candidate(`block-${rowId}`),
  label,
  hardNegative,
  provenance: { sourceType: "runtime", sourceRef: `case:${rowId}` },
});
const adversarialRows = (): CalibrationDatasetRow[] => Array.from({ length: 18 }, (_, i) => ({
  ...row(`adversarial-${i}`, `adversarial-${i}`, "inapplicable", true),
  adversarialFixture: true,
  provenance: { sourceType: "fixture", sourceRef: `fixture:adversarial-${i}` },
}));
const registry = (kind: CalibrationDatasetRegistry["kind"] = "organic-calibration"): CalibrationDatasetRegistry => ({
  datasetVersion: 1,
  kind,
  frozenAt: "2026-06-02T00:00:00.000Z",
  rows: [
    row("train-pos", "fam-train", "applicable"),
    row("val-pos", "fam-val", "applicable"),
    ...Array.from({ length: 20 }, (_, i) => row(`val-hard-${i}`, "fam-val", "inapplicable", true)),
    ...adversarialRows(),
  ],
});
const assignments = (): CalibrationAssignment[] => [
  { rowId: "train-pos", familyKey: "fam-train", cohort: "train" },
  { rowId: "val-pos", familyKey: "fam-val", cohort: "validation" },
  ...Array.from({ length: 20 }, (_, i) => ({ rowId: `val-hard-${i}`, familyKey: "fam-val", cohort: "validation" as const })),
  ...Array.from({ length: 18 }, (_, i) => ({ rowId: `adversarial-${i}`, familyKey: `adversarial-${i}`, cohort: "adversarial-regression" as const })),
];
const outcomes = (reg = registry()): CalibrationOutcome[] => reg.rows.map((r) => ({
  rowId: r.rowId,
  verdict: r.label,
  confidence: r.label === "applicable" ? 0.95 : 0.1,
  latencyMs: 2,
  cacheState: "fresh",
  warmCompleted: true,
  warmLatencyMs: 3,
  v4Action: r.label === "applicable" ? "inject" : "abstain",
}));
const build = (kind: CalibrationDatasetRegistry["kind"] = "organic-calibration"): CalibrationManifest => {
  const reg = registry(kind);
  const m = buildCalibrationManifest({
    registry: reg,
    preregText: "frozen pre-reg",
    model: { model: "fake", revision: "rev", backend: "fake", featureVersion: 1 },
    gate: { minWilsonLbPrecision: 0.1, maxHarmfulApplyRate: 0.05, minCacheHitRate: 0.6, maxWarmLatencyP95Ms: 100, minValidationN: 20 },
    gitSha: "abc123",
    splitSeed: 42,
    trainRatio: 0.7,
    thresholdCandidates: [0.4, 0.8],
    selectedThreshold: 0.8,
    minTrainPrecision: 0.9,
    runnerVersion: CALIBRATION_RUNNER_VERSION,
    algorithmVersion: CALIBRATION_ALGORITHM_VERSION,
    assignments: assignments(),
    outcomes: outcomes(reg),
  });
  m.metrics = computeCalibrationMetrics(m);
  return m;
};

describe("auditable calibration registry + manifest", () => {
  it("accepts a self-contained scored manifest and promotes only organic data", () => {
    const m = build();
    expect(validateCalibrationManifest(m)).toEqual({ ok: true, violations: [] });
    expect(evaluatePromotion(m).decision).toBe("promote");
    expect(evaluatePromotion(build("fixture-smoke"))).toEqual({
      decision: "hold",
      reasons: ["fixture-smoke datasets validate plumbing only; never promote"],
    });
  });

  it("rejects row tampering, split tampering and metric tampering", () => {
    const a = build();
    a.registry.rows[0]!.query.literalText = "mutated after freeze";
    expect(validateCalibrationManifest(a).violations.join(" ")).toContain("datasetHash");
    const b = build();
    b.split.assignments[0]!.cohort = "validation";
    expect(validateCalibrationManifest(b).violations.join(" ")).toContain("splitHash");
    const c = build();
    c.metrics!.validation.truePositives = 999;
    expect(validateCalibrationManifest(c).violations.join(" ")).toContain("recomputation");
    const d = build();
    d.run!.minTrainPrecision = 0;
    expect(validateCalibrationManifest(d).violations.join(" ")).toContain("minTrainPrecision");
  });

  it("treats an adversarial regression as a promotion stop", () => {
    const m = build();
    const outcome = m.run!.outcomes.find((o) => o.rowId === "adversarial-0")!;
    outcome.verdict = "applicable";
    outcome.confidence = 1;
    m.metrics = computeCalibrationMetrics(m);
    expect(validateCalibrationManifest(m)).toEqual({ ok: true, violations: [] });
    expect(evaluatePromotion(m)).toEqual({
      decision: "reject",
      reasons: ["STOP: adversarial regression fired=1"],
    });
  });

  it("registry rejects duplicate rows and leakage before scoring", () => {
    const r = registry();
    r.rows.push({ ...r.rows[0]!, provenance: { sourceType: "runtime", sourceRef: "/Users/alice/private" } });
    const violations = validateCalibrationRegistry(r).violations.join(" ");
    expect(violations).toContain("duplicate rowId");
    expect(violations).toContain("leakage");
    expect(datasetHashOf(registry())).toBe(datasetHashOf(registry()));
  });
});
describe("deterministic offline runner", () => {
  it("keeps families indivisible and emits a validator-clean manifest", async () => {
    const reg: CalibrationDatasetRegistry = {
      datasetVersion: 1,
      kind: "fixture-smoke",
      frozenAt: "2026-06-02T00:00:00.000Z",
      rows: Array.from({ length: 8 }, (_, f) => [
        row(`f${f}-pos`, `fam-${f}`, "applicable"),
        ...Array.from({ length: 10 }, (_x, i) => row(`f${f}-neg-${i}`, `fam-${f}`, "inapplicable", true)),
      ]).flat(),
    };
    const split = assignCalibrationFamilies(reg, 42);
    const familyCohorts = new Map<string, Set<string>>();
    for (const a of split) {
      const set = familyCohorts.get(a.familyKey) ?? new Set<string>();
      set.add(a.cohort);
      familyCohorts.set(a.familyKey, set);
    }
    expect([...familyCohorts.values()].every((set) => set.size === 1)).toBe(true);
    const m = await runOfflineCalibration({
      registry: reg,
      preregText: "frozen pre-reg",
      model: { model: "fixture", revision: "v1", backend: "fixture", featureVersion: 1 },
      gate: { minWilsonLbPrecision: 0.8, maxHarmfulApplyRate: 0.05, minCacheHitRate: 0.5, maxWarmLatencyP95Ms: 100, minValidationN: 20 },
      gitSha: "abc123",
      splitSeed: 42,
      thresholdCandidates: [0.4, 0.8],
      minTrainPrecision: 0.9,
      scorer: async (r) => ({ verdict: r.label, confidence: r.label === "applicable" ? 0.95 : 0.1, latencyMs: 1, cacheState: "fresh", warmCompleted: true, warmLatencyMs: 2 }),
    });
    expect(validateCalibrationManifest(m)).toEqual({ ok: true, violations: [] });
    expect(m.split.hardNegativeCount).toBeGreaterThanOrEqual(20);
    expect(evaluatePromotion(m).decision).toBe("hold"); // fixture smoke never promotes
  });
});

describe("wilsonLowerBound", () => {
  it("is conservative on finite samples", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(9, 10)).toBeLessThan(0.9);
    expect(wilsonLowerBound(90, 100)).toBeGreaterThan(wilsonLowerBound(9, 10));
  });
});
