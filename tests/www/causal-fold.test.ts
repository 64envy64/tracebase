/**
 * Phase 3.5 — dashboard-side fold for `UsageMetrics.causal`.
 *
 * Cohort sums are additive across daily buckets, lifts are gated
 * at window level against `minCohortSize`, and the whole `causal`
 * block is omitted from the window totals when no bucket carried
 * causal data (so the UI can render "no causal data yet" without
 * rendering a misleading empty shell).
 */
import { describe, it, expect } from "vitest";
import { foldImpactWindow } from "../../www/src/lib/control-plane/usage.ts";
import type { UsageCausal, UsageMetrics } from "../../www/src/lib/usage/types.ts";

function observedZero(): UsageMetrics["observed"] {
  return {
    eligibleRuns: 0,
    recalledRuns: 0,
    injectedRuns: 0,
    usedRuns: 0,
    helpfulRuns: 0,
    resolvedRateWithMemory: null,
  };
}

function estimatedNull(): UsageMetrics["estimated"] {
  return {
    tokensSaved: { value: null, sampleSize: 0, formula: "n/a" },
    latencySavedMs: { value: null, sampleSize: 0, formula: "n/a" },
  };
}

function metricsWithCausal(causal: UsageCausal): UsageMetrics {
  return {
    scope: "workspace",
    window: {},
    observed: observedZero(),
    estimated: estimatedNull(),
    causal,
    integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
  };
}

function metricsWithoutCausal(): UsageMetrics {
  return {
    scope: "workspace",
    window: {},
    observed: observedZero(),
    estimated: estimatedNull(),
    integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
  };
}

function causalBucket(input: {
  assisted: { n: number; resolved: number };
  holdout: { n: number; resolved: number };
  tokensLiftValue?: number | null;
  tokensSampleSize?: number;
  latencyLiftValue?: number | null;
  latencySampleSize?: number;
  minCohortSize?: number;
}): UsageCausal {
  const a = input.assisted;
  const h = input.holdout;
  return {
    assisted: {
      n: a.n,
      resolved: a.resolved,
      resolvedRate: a.n > 0 ? a.resolved / a.n : null,
    },
    holdout: {
      n: h.n,
      resolved: h.resolved,
      resolvedRate: h.n > 0 ? h.resolved / h.n : null,
    },
    resolvedLift: null, // bucket-level; window fold recomputes
    tokensLift: {
      value: input.tokensLiftValue ?? null,
      sampleSize: input.tokensSampleSize ?? 0,
      formula: "f",
    },
    latencyLift: {
      value: input.latencyLiftValue ?? null,
      sampleSize: input.latencySampleSize ?? 0,
      formula: "f",
    },
    minCohortSize: input.minCohortSize ?? 30,
  };
}

describe("foldImpactWindow — causal aggregation", () => {
  it("omits `totals.causal` when no bucket carries causal data", () => {
    const w = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets: [
        { date: "2026-04-20", metrics: metricsWithoutCausal() },
        { date: "2026-04-21", metrics: metricsWithoutCausal() },
      ],
    });
    expect(w.totals.causal).toBeUndefined();
  });

  it("carries `totals.causal` forward once any bucket has causal data", () => {
    const w = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets: [
        {
          date: "2026-04-20",
          metrics: metricsWithCausal(
            causalBucket({ assisted: { n: 3, resolved: 2 }, holdout: { n: 2, resolved: 1 } }),
          ),
        },
      ],
      minCausalCohort: 10, // irrelevant for presence — just shapes the lift gate
    });
    expect(w.totals.causal).toBeDefined();
    expect(w.totals.causal?.assisted.n).toBe(3);
    expect(w.totals.causal?.holdout.n).toBe(2);
  });

  it("sums n and resolved across buckets, recomputes resolvedRate from the totals", () => {
    const w = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets: [
        {
          date: "2026-04-20",
          metrics: metricsWithCausal(
            causalBucket({ assisted: { n: 4, resolved: 3 }, holdout: { n: 4, resolved: 1 } }),
          ),
        },
        {
          date: "2026-04-21",
          metrics: metricsWithCausal(
            causalBucket({ assisted: { n: 6, resolved: 3 }, holdout: { n: 6, resolved: 2 } }),
          ),
        },
      ],
      minCausalCohort: 5,
    });
    expect(w.totals.causal?.assisted.n).toBe(10);
    expect(w.totals.causal?.assisted.resolved).toBe(6);
    expect(w.totals.causal?.assisted.resolvedRate).toBeCloseTo(0.6);
    expect(w.totals.causal?.holdout.n).toBe(10);
    expect(w.totals.causal?.holdout.resolvedRate).toBeCloseTo(0.3);
  });

  it("computes resolvedLift at window level when BOTH arms clear minCohortSize", () => {
    const w = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets: [
        {
          date: "2026-04-20",
          metrics: metricsWithCausal(
            causalBucket({ assisted: { n: 10, resolved: 8 }, holdout: { n: 10, resolved: 4 } }),
          ),
        },
      ],
      minCausalCohort: 5, // lower to exercise the ready-state branch
    });
    // assisted 0.8 − holdout 0.4 = 0.4.
    expect(w.totals.causal?.resolvedLift).toBeCloseTo(0.4);
  });

  it("forces window-level lift to null when either arm is below minCohortSize", () => {
    const w = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets: [
        {
          date: "2026-04-20",
          metrics: metricsWithCausal(
            causalBucket({
              assisted: { n: 50, resolved: 40 },
              // holdout below minCohortSize
              holdout: { n: 2, resolved: 1 },
              tokensLiftValue: 200,
              tokensSampleSize: 2,
              latencyLiftValue: 500,
              latencySampleSize: 2,
            }),
          ),
        },
      ],
      minCausalCohort: 5,
    });
    expect(w.totals.causal?.resolvedLift).toBeNull();
    // Token and latency lift also gated — no fabricated number
    // from a tiny sample.
    expect(w.totals.causal?.tokensLift.value).toBeNull();
    expect(w.totals.causal?.latencyLift.value).toBeNull();
    // Sample sizes are still reported — the UI uses them to show
    // "N more outcomes needed".
    expect(w.totals.causal?.tokensLift.sampleSize).toBe(2);
  });

  it("sums tokens / latency lift values across buckets once the gate passes", () => {
    const w = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets: [
        {
          date: "2026-04-20",
          metrics: metricsWithCausal(
            causalBucket({
              assisted: { n: 5, resolved: 4 },
              holdout: { n: 5, resolved: 2 },
              tokensLiftValue: 400,
              tokensSampleSize: 5,
              latencyLiftValue: 1500,
              latencySampleSize: 5,
            }),
          ),
        },
        {
          date: "2026-04-21",
          metrics: metricsWithCausal(
            causalBucket({
              assisted: { n: 5, resolved: 3 },
              holdout: { n: 5, resolved: 3 },
              tokensLiftValue: 200,
              tokensSampleSize: 5,
              latencyLiftValue: 800,
              latencySampleSize: 5,
            }),
          ),
        },
      ],
      minCausalCohort: 5,
    });
    expect(w.totals.causal?.tokensLift.value).toBe(600);
    expect(w.totals.causal?.tokensLift.sampleSize).toBe(10);
    expect(w.totals.causal?.latencyLift.value).toBe(2300);
  });

  it("reports sampleSize but null value when no bucket produced a numeric lift even if cohort is large", () => {
    // Edge: cohort is fine, but every bucket tokensLift was null
    // (e.g. one arm consistently missing tokens). Window gate
    // passes but the summed value stays null.
    const w = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets: [
        {
          date: "2026-04-20",
          metrics: metricsWithCausal(
            causalBucket({
              assisted: { n: 10, resolved: 7 },
              holdout: { n: 10, resolved: 3 },
              tokensLiftValue: null,
              tokensSampleSize: 0,
            }),
          ),
        },
      ],
      minCausalCohort: 5,
    });
    expect(w.totals.causal?.resolvedLift).toBeCloseTo(0.4);
    expect(w.totals.causal?.tokensLift.value).toBeNull();
    expect(w.totals.causal?.tokensLift.sampleSize).toBe(0);
  });

  it("keeps buckets-without-causal interleaved with buckets-with-causal contributing to the totals", () => {
    const w = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-23T00:00:00.000Z",
      buckets: [
        { date: "2026-04-20", metrics: metricsWithoutCausal() },
        {
          date: "2026-04-21",
          metrics: metricsWithCausal(
            causalBucket({ assisted: { n: 3, resolved: 2 }, holdout: { n: 3, resolved: 1 } }),
          ),
        },
        { date: "2026-04-22", metrics: metricsWithoutCausal() },
      ],
      minCausalCohort: 2,
    });
    expect(w.totals.causal).toBeDefined();
    expect(w.totals.causal?.assisted.n).toBe(3);
    expect(w.totals.causal?.holdout.n).toBe(3);
  });
});
