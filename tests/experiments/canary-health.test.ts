/**
 * Phase D.4.2 — the pure CanaryHealthEvaluator encodes the FROZEN pre-reg kill
 * rules. One test per rule: precision floor (after 30), harm rate, attribution
 * diagnostics, privacy, latency p95. Plus the percentile helper + ring cap.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateCanaryHealth,
  emptyHealthCounters,
  railLatencyP95,
  pushLatencySample,
  LATENCY_RING_CAP,
  HEALTH_THRESHOLDS,
  type CanaryHealthCounters,
} from "../../src/experiments/canary-health.js";

const counters = (o: Partial<CanaryHealthCounters> = {}): CanaryHealthCounters => ({ ...emptyHealthCounters(), ...o });

describe("evaluateCanaryHealth — frozen kill rules", () => {
  it("a clean, low-volume state does NOT trip", () => {
    const v = evaluateCanaryHealth(counters({ treatmentExposed: 10, treatmentObservedOutcomes: 10, treatmentHelpful: 10, trials: 50 }));
    expect(v.tripped).toBe(false);
    expect(v.reasons).toEqual([]);
    expect(v.metrics.precision).toBe(1);
  });

  it("§7.1 precision floor only bites AFTER the 30-outcome minimum", () => {
    // 29 observed, precision 0 → below floor but under the minimum → NO trip.
    const under = evaluateCanaryHealth(counters({ treatmentObservedOutcomes: 29, treatmentHelpful: 0, treatmentHarmful: 0 }));
    expect(under.reasons).not.toContain("precision_below_floor");
    // 30 observed, precision 0.5 (< 0.70) → trips.
    const at = evaluateCanaryHealth(counters({ treatmentObservedOutcomes: 30, treatmentHelpful: 15, treatmentHarmful: 0 }));
    expect(at.reasons).toContain("precision_below_floor");
    expect(at.tripped).toBe(true);
    // 30 observed, precision 0.9 (>= 0.70) → does NOT trip on precision.
    const ok = evaluateCanaryHealth(counters({ treatmentObservedOutcomes: 30, treatmentHelpful: 27, treatmentHarmful: 0 }));
    expect(ok.reasons).not.toContain("precision_below_floor");
  });

  it("§7.2 harm rate > 5% trips (no minimum-sample grace — harm is dominant)", () => {
    // 1 harmful of 10 = 10% > 5% → trips.
    const v = evaluateCanaryHealth(counters({ treatmentObservedOutcomes: 10, treatmentHelpful: 9, treatmentHarmful: 1 }));
    expect(v.reasons).toContain("harm_rate_exceeded");
    // exactly 5% (1 of 20) is NOT over the ceiling.
    const edge = evaluateCanaryHealth(counters({ treatmentObservedOutcomes: 20, treatmentHelpful: 19, treatmentHarmful: 1 }));
    expect(edge.reasons).not.toContain("harm_rate_exceeded");
  });

  it("§5/§7.3 attribution diagnostics > 1% of trials trips; exactly 1% does not", () => {
    const over = evaluateCanaryHealth(counters({ trials: 100, crossRun: 2 })); // 2% > 1%
    expect(over.reasons).toContain("attribution_unreliable");
    const edge = evaluateCanaryHealth(counters({ trials: 100, crossRun: 1, ambiguous: 0 })); // exactly 1%
    expect(edge.reasons).not.toContain("attribution_unreliable");
    const mixed = evaluateCanaryHealth(counters({ trials: 100, crossRun: 1, ambiguous: 1 })); // 2% > 1%
    expect(mixed.reasons).toContain("attribution_unreliable");
  });

  it("§6 any privacy violation trips immediately", () => {
    const v = evaluateCanaryHealth(counters({ privacyViolations: 1 }));
    expect(v.reasons).toContain("privacy_violation");
    expect(v.tripped).toBe(true);
  });

  it("§7.4 rail latency p95 > 50ms trips; <= 50ms does not", () => {
    const slow = evaluateCanaryHealth(counters({ railLatencyMs: [10, 10, 10, 10, 10, 10, 10, 10, 10, 80] })); // p95 ~ 80
    expect(slow.reasons).toContain("latency_regression");
    const fast = evaluateCanaryHealth(counters({ railLatencyMs: [10, 12, 15, 20, 25, 30, 35, 40, 45, 50] })); // p95 = 50
    expect(fast.reasons).not.toContain("latency_regression");
  });

  it("accumulates MULTIPLE reasons in stable rule order", () => {
    const v = evaluateCanaryHealth(counters({
      treatmentObservedOutcomes: 40, treatmentHelpful: 10, treatmentHarmful: 10, // precision 0.25 + harm 25%
      trials: 100, crossRun: 5, // 5%
      privacyViolations: 1,
      railLatencyMs: [60, 60, 60],
    }));
    expect(v.tripped).toBe(true);
    expect(v.reasons).toEqual(["precision_below_floor", "harm_rate_exceeded", "attribution_unreliable", "privacy_violation", "latency_regression"]);
  });

  it("thresholds are the frozen pre-reg values", () => {
    expect(HEALTH_THRESHOLDS).toEqual({ minTreatmentOutcomesForPrecision: 30, precisionFloor: 0.7, maxHarmfulRate: 0.05, maxAttributionDiagnosticRate: 0.01, maxRailLatencyP95Ms: 50 });
  });
});

describe("railLatencyP95 + ring", () => {
  it("nearest-rank percentile; null when empty", () => {
    expect(railLatencyP95([])).toBeNull();
    expect(railLatencyP95([42])).toBe(42);
    // 100 samples 1..100 → p95 nearest-rank = ceil(0.95*100)=95th → value 95.
    expect(railLatencyP95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });

  it("pushLatencySample caps the ring at LATENCY_RING_CAP, dropping oldest", () => {
    let ring: number[] = [];
    for (let i = 0; i < LATENCY_RING_CAP + 50; i++) ring = pushLatencySample(ring, i);
    expect(ring.length).toBe(LATENCY_RING_CAP);
    expect(ring[0]).toBe(50); // first 50 dropped
    // negatives / non-finite ignored.
    const before = ring.length;
    pushLatencySample(ring, -5);
    pushLatencySample(ring, Number.NaN);
    expect(ring.length).toBe(before);
  });
});
