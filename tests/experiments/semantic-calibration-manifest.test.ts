/**
 * E.2.3 — the FROZEN calibration manifest schema + gate. Verifies the pre-reg
 * invariants are machine-enforced: no fitting on the 18 adversarial fixtures, a
 * leakage-safe family-grouped split, hard negatives, a Wilson-LB precision gate, and
 * explicit stop conditions. No thresholds are fit and nothing is promoted here.
 */
import { describe, it, expect } from "vitest";
import {
  wilsonLowerBound,
  validateCalibrationManifest,
  evaluatePromotion,
  preregHashOf,
  CALIBRATION_MANIFEST_VERSION,
  type CalibrationManifest,
  type CalibrationMetrics,
} from "../../src/experiments/semantic-bakeoff/calibration/manifest.js";

const baseManifest = (): CalibrationManifest => ({
  manifestVersion: CALIBRATION_MANIFEST_VERSION,
  frozenAt: "2026-06-02T00:00:00.000Z",
  preregHash: preregHashOf("frozen pre-reg text"),
  model: { name: "Qwen/Qwen3-Reranker-0.6B", revision: "0.6b-local", featureVersion: 1, backend: "qwen-local" },
  split: {
    trainFamilies: ["fam-a", "fam-b", "fam-c"],
    valFamilies: ["fam-x", "fam-y"], // DISJOINT from train
    hardNegativeCount: 25,
    usesAdversarialFixturesForFitting: false,
    splitSeed: 42,
  },
  gate: { minWilsonLbPrecision: 0.85, maxHarmfulApplyRate: 0.05, minCacheHitRate: 0.6, maxWarmLatencyP95Ms: 5000, minValidationN: 100 },
});
// harmfulApplyRate is DECOUPLED from FP: a false positive (unhelpful apply) is not
// necessarily harmful, so the gate's precision bar and its harm stop are independent.
const withMetrics = (m: CalibrationManifest, tp: number, fp: number, over: Partial<CalibrationMetrics> = {}, harmfulApplyRate = 0.02): CalibrationManifest => ({
  ...m,
  metrics: {
    validation: { n: tp + fp, truePositives: tp, falsePositives: fp, wilsonLbPrecision: wilsonLowerBound(tp, tp + fp), harmfulApplyRate },
    cache: { hitRate: 0.8, warmCompletionRate: 0.95, warmLatencyP95Ms: 1200 },
    shadowAgreementRate: 0.7,
    ...over,
  },
});

describe("wilsonLowerBound", () => {
  it("is 0 for n=0 and strictly below the point estimate for finite n", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(100, 100)).toBeLessThan(1); // 100/100 → LB < 1 (honest)
    expect(wilsonLowerBound(100, 100)).toBeGreaterThan(0.95);
    expect(wilsonLowerBound(9, 10)).toBeLessThan(9 / 10); // LB below the 0.9 point estimate
  });
  it("a small sample yields a much lower bound than a large one at the same rate", () => {
    expect(wilsonLowerBound(9, 10)).toBeLessThan(wilsonLowerBound(90, 100)); // both 90% point
  });
});

describe("validateCalibrationManifest — frozen pre-reg invariants", () => {
  it("accepts a well-formed, leakage-safe, non-fixture manifest", () => {
    expect(validateCalibrationManifest(baseManifest())).toEqual({ ok: true, violations: [] });
  });
  it("REJECTS fitting on the adversarial viability fixtures", () => {
    const m = baseManifest();
    m.split.usesAdversarialFixturesForFitting = true;
    const r = validateCalibrationManifest(m);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("fixtures");
  });
  it("REJECTS family leakage between train and validation", () => {
    const m = baseManifest();
    m.split.valFamilies = ["fam-x", "fam-b"]; // fam-b also in train
    const r = validateCalibrationManifest(m);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("LEAKAGE");
  });
  it("REJECTS too few hard negatives", () => {
    const m = baseManifest();
    m.split.hardNegativeCount = 3;
    expect(validateCalibrationManifest(m).ok).toBe(false);
  });
  it("REJECTS a metrics manifest whose reported Wilson-LB does not match TP/FP", () => {
    const m = withMetrics(baseManifest(), 90, 10);
    m.metrics!.validation.wilsonLbPrecision = 0.99; // lie
    const r = validateCalibrationManifest(m);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("Wilson-LB");
  });
});

describe("evaluatePromotion — gate + stop conditions (conservative)", () => {
  it("a frozen pre-reg (no metrics) → HOLD, never promote", () => {
    expect(evaluatePromotion(baseManifest()).decision).toBe("hold");
  });
  it("an invalid manifest → REJECT", () => {
    const m = baseManifest();
    m.split.valFamilies = ["fam-a"]; // leakage
    expect(evaluatePromotion(m).decision).toBe("reject");
  });
  it("STOP condition (thin validation set) → REJECT even with perfect precision", () => {
    const m = withMetrics(baseManifest(), 30, 0); // n=30 < minValidationN=100
    expect(evaluatePromotion(m).decision).toBe("reject");
  });
  it("STOP condition (cache hit-rate too low) → REJECT", () => {
    const m = withMetrics(baseManifest(), 200, 5, { cache: { hitRate: 0.2, warmCompletionRate: 0.9, warmLatencyP95Ms: 1000 } });
    const r = evaluatePromotion(m);
    expect(r.decision).toBe("reject");
    expect(r.reasons.join(" ")).toContain("hitRate");
  });
  it("STOP condition (harmful-apply rate too high) → REJECT even with good precision", () => {
    const m = withMetrics(baseManifest(), 400, 8, {}, 0.2); // Wilson-LB fine, but harmful 0.2 > 0.05
    const r = evaluatePromotion(m);
    expect(r.decision).toBe("reject");
    expect(r.reasons.join(" ")).toContain("harmful");
  });
  it("gate not met (Wilson-LB below bar) but stops clear → HOLD, not promote", () => {
    const m = withMetrics(baseManifest(), 150, 40); // ~79% point, Wilson-LB < 0.85; harmful low (0.02)
    expect(m.metrics!.validation.wilsonLbPrecision).toBeLessThan(0.85);
    expect(evaluatePromotion(m).decision).toBe("hold");
  });
  it("gate met + all stop conditions clear → PROMOTE", () => {
    const m = withMetrics(baseManifest(), 400, 8); // ~98% point, large n → Wilson-LB ≥ 0.85
    expect(m.metrics!.validation.wilsonLbPrecision).toBeGreaterThanOrEqual(0.85);
    expect(evaluatePromotion(m).decision).toBe("promote");
  });
});
