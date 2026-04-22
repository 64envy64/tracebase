/**
 * Phase 3.3 — analytics causal aggregation.
 *
 * Tests the single contract: `UsageMetrics.causal` classifies arms
 * strictly by `retrieval.controlReason`, never leaks legacy /
 * manual shadow into the causal numbers, and gates lift behind a
 * minimum cohort size.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { computeAggregates } from "../../src/core/analytics.js";
import { computeUsageMetrics } from "../../src/analytics/usage-metrics.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

/**
 * Seed an assisted-arm outcome: non-shadow retrieval + injection +
 * outcome. Token / duration are optional.
 */
function assistedRun(
  store: BlockStore,
  queryId: string,
  opts: { resolved: boolean; ts?: number; tokens?: number; durationMs?: number } = {
    resolved: true,
  },
) {
  const ts = opts.ts ?? 1;
  store.appendEvent({
    ts, queryId, event: "retrieval",
    candidates: [{ blockId: "b1", score: 0.9 }],
    shadow: false,
  });
  store.appendEvent({ ts: ts + 1, queryId, event: "injection", blockId: "b1", score: 0.9 });
  store.appendEvent({
    ts: ts + 2, queryId, event: "outcome",
    resolved: opts.resolved,
    control: false,
    ...(typeof opts.tokens === "number" ? { tokens: opts.tokens } : {}),
    ...(typeof opts.durationMs === "number" ? { durationMs: opts.durationMs } : {}),
  });
}

/**
 * Seed a holdout-arm outcome: shadow retrieval with
 * controlReason="holdout" + outcome (no injection per 3.2 contract).
 */
function holdoutRun(
  store: BlockStore,
  queryId: string,
  opts: { resolved: boolean; ts?: number; tokens?: number; durationMs?: number } = {
    resolved: true,
  },
) {
  const ts = opts.ts ?? 1;
  store.appendEvent({
    ts, queryId, event: "retrieval",
    candidates: [{ blockId: "b1", score: 0.9 }],
    shadow: true,
    controlReason: "holdout",
  });
  store.appendEvent({
    ts: ts + 1, queryId, event: "outcome",
    resolved: opts.resolved,
    control: true,
    ...(typeof opts.tokens === "number" ? { tokens: opts.tokens } : {}),
    ...(typeof opts.durationMs === "number" ? { durationMs: opts.durationMs } : {}),
  });
}

/**
 * Seed a legacy / manual shadow outcome: shadow retrieval WITHOUT
 * controlReason. Per Phase 3.1 contract this is diagnostic-only and
 * must never enter causal numbers.
 */
function manualShadowRun(
  store: BlockStore,
  queryId: string,
  opts: { resolved: boolean; ts?: number; tokens?: number; durationMs?: number } = {
    resolved: true,
  },
) {
  const ts = opts.ts ?? 1;
  store.appendEvent({
    ts, queryId, event: "retrieval",
    candidates: [{ blockId: "b1", score: 0.9 }],
    shadow: true,
    // Intentionally no controlReason.
  });
  store.appendEvent({
    ts: ts + 1, queryId, event: "outcome",
    resolved: opts.resolved,
    control: true,
    ...(typeof opts.tokens === "number" ? { tokens: opts.tokens } : {}),
    ...(typeof opts.durationMs === "number" ? { durationMs: opts.durationMs } : {}),
  });
}

describe("UsageMetrics.causal — presence + absence", () => {
  it("omits the `causal` block entirely on an empty event log", () => {
    const store = makeStore();
    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.causal).toBeUndefined();
  });

  it("omits `causal` when only legacy / manual shadow is present", () => {
    // Manual shadow is diagnostic-only. Having N of them does not
    // mean an experiment is running and must not conjure a causal
    // block with half of the comparison missing.
    const store = makeStore();
    for (let i = 0; i < 10; i++) {
      manualShadowRun(store, `ms${i}`, { resolved: i % 2 === 0 });
    }
    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.causal).toBeUndefined();
  });

  it("includes `causal` as soon as at least one holdout outcome is on record", () => {
    const store = makeStore();
    holdoutRun(store, "h1", { resolved: true });
    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.causal).toBeDefined();
    expect(usage.causal?.holdout.n).toBe(1);
    expect(usage.causal?.assisted.n).toBe(0);
  });
});

describe("UsageMetrics.causal — cohort rules are strict", () => {
  it("legacy / manual shadow events never enter the holdout cohort", () => {
    const store = makeStore();
    holdoutRun(store, "h1", { resolved: true });
    // 100 manual shadow runs at resolved=false. If they leaked in,
    // holdout.resolvedRate would crash toward 0. If the strict rule
    // holds, holdout stays `{ n: 1, resolved: 1 }`.
    for (let i = 0; i < 100; i++) {
      manualShadowRun(store, `ms${i}`, { resolved: false });
    }
    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.causal?.holdout).toEqual({
      n: 1,
      resolved: 1,
      resolvedRate: 1,
    });
  });

  it("a non-shadow run without any injection is NOT counted as assisted", () => {
    // Gate filtered every candidate — the agent never got memory,
    // so this run cannot be a fair comparison against the holdout
    // cohort and must be excluded from the assisted arm.
    const store = makeStore();
    store.appendEvent({
      ts: 1, queryId: "tGate", event: "retrieval",
      candidates: [{ blockId: "b1", score: 0.9 }],
      shadow: false,
    });
    store.appendEvent({
      ts: 2, queryId: "tGate", event: "outcome",
      resolved: true, control: false,
    });
    // Plus one holdout so the causal block materialises.
    holdoutRun(store, "h1", { resolved: false });

    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.causal?.assisted.n).toBe(0);
    expect(usage.causal?.holdout.n).toBe(1);
  });

  it("a non-shadow run with at least one fact_injection counts as assisted", () => {
    // Parallel to the block injection — fact injection is also
    // "the agent received memory". Both qualify the run as
    // assisted.
    const store = makeStore();
    store.appendEvent({
      ts: 1, queryId: "aFact", event: "retrieval",
      candidates: [],
      factCandidates: [{ factId: "f1", score: 0.8 }],
      shadow: false,
    });
    store.appendEvent({
      ts: 2, queryId: "aFact", event: "fact_injection", factId: "f1", score: 0.8,
    });
    store.appendEvent({
      ts: 3, queryId: "aFact", event: "outcome",
      resolved: true, control: false,
    });
    holdoutRun(store, "h1", { resolved: false });

    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.causal?.assisted.n).toBe(1);
  });
});

describe("UsageMetrics.causal — min-cohort gate", () => {
  it("keeps lift fields null when either cohort is below minCausalCohort", () => {
    const store = makeStore();
    // Seed at threshold=3 just on one side; other side is 2.
    for (let i = 0; i < 3; i++) assistedRun(store, `a${i}`, { resolved: true, ts: i * 10 });
    holdoutRun(store, "h1", { resolved: false, ts: 1000 });
    holdoutRun(store, "h2", { resolved: false, ts: 1010 });

    const usage = computeUsageMetrics(computeAggregates(store), {
      minCausalCohort: 3,
    });
    expect(usage.causal?.assisted.n).toBe(3);
    expect(usage.causal?.holdout.n).toBe(2);
    expect(usage.causal?.resolvedLift).toBeNull();
    expect(usage.causal?.tokensLift.value).toBeNull();
    expect(usage.causal?.latencyLift.value).toBeNull();
    // Raw rates still visible so UI can say "waiting for 1 more
    // holdout outcome".
    expect(usage.causal?.assisted.resolvedRate).toBeCloseTo(1);
    expect(usage.causal?.holdout.resolvedRate).toBeCloseTo(0);
  });

  it("computes resolvedLift when both cohorts reach minCausalCohort", () => {
    const store = makeStore();
    // Assisted arm: 3 runs, 3 resolved → rate = 1.
    for (let i = 0; i < 3; i++) assistedRun(store, `a${i}`, { resolved: true, ts: i * 10 });
    // Holdout arm: 3 runs, 1 resolved → rate = 1/3.
    holdoutRun(store, "h0", { resolved: true,  ts: 1000 });
    holdoutRun(store, "h1", { resolved: false, ts: 1010 });
    holdoutRun(store, "h2", { resolved: false, ts: 1020 });

    const usage = computeUsageMetrics(computeAggregates(store), {
      minCausalCohort: 3,
    });
    // assisted(1) − holdout(1/3) = 2/3.
    expect(usage.causal?.resolvedLift).toBeCloseTo(2 / 3);
  });

  it("surfaces the threshold that was applied to the computation", () => {
    const store = makeStore();
    holdoutRun(store, "h1", { resolved: true });
    const usage = computeUsageMetrics(computeAggregates(store), {
      minCausalCohort: 5,
    });
    expect(usage.causal?.minCohortSize).toBe(5);
  });
});

describe("UsageMetrics.causal — token / latency lift", () => {
  it("computes total tokensLift = (mean(holdout) − mean(assisted)) × assisted.n", () => {
    const store = makeStore();
    // Assisted: 2 runs, 500 tokens each → mean 500, n=2.
    assistedRun(store, "a0", { resolved: true, ts: 10, tokens: 500 });
    assistedRun(store, "a1", { resolved: true, ts: 20, tokens: 500 });
    // Holdout:  2 runs, 700 tokens each → mean 700.
    holdoutRun(store, "h0", { resolved: true, ts: 1000, tokens: 700 });
    holdoutRun(store, "h1", { resolved: true, ts: 1010, tokens: 700 });
    // Delta 200/run × assisted.n=2 = 400.
    const usage = computeUsageMetrics(computeAggregates(store), {
      minCausalCohort: 2,
    });
    expect(usage.causal?.tokensLift.value).toBe(400);
    expect(usage.causal?.tokensLift.sampleSize).toBe(2);
  });

  it("computes total latencyLift symmetrically to tokens", () => {
    const store = makeStore();
    assistedRun(store, "a0", { resolved: true, ts: 10, durationMs: 800 });
    assistedRun(store, "a1", { resolved: true, ts: 20, durationMs: 1000 });
    holdoutRun(store, "h0", { resolved: true, ts: 1000, durationMs: 1400 });
    holdoutRun(store, "h1", { resolved: true, ts: 1010, durationMs: 1600 });
    const usage = computeUsageMetrics(computeAggregates(store), {
      minCausalCohort: 2,
    });
    // assisted mean 900, holdout mean 1500, delta 600, × 2 = 1200.
    expect(usage.causal?.latencyLift.value).toBe(1200);
    expect(usage.causal?.latencyLift.sampleSize).toBe(2);
  });

  it("leaves tokens / latency lift null when only one arm recorded the metric", () => {
    const store = makeStore();
    assistedRun(store, "a0", { resolved: true, ts: 10, tokens: 500 });
    assistedRun(store, "a1", { resolved: true, ts: 20, tokens: 500 });
    holdoutRun(store, "h0", { resolved: true, ts: 1000 }); // no tokens
    holdoutRun(store, "h1", { resolved: true, ts: 1010 }); // no tokens
    const usage = computeUsageMetrics(computeAggregates(store), {
      minCausalCohort: 2,
    });
    expect(usage.causal?.tokensLift.value).toBeNull();
    expect(usage.causal?.latencyLift.value).toBeNull();
  });
});

describe("UsageMetrics.estimated stays independent of the causal cohort", () => {
  it("legacy shadow continues to drive `estimated` even when a causal block is present", () => {
    // Phase 1 contract — `estimated.tokensSaved` is the diagnostic
    // shadow-based signal. Phase 3.3 does not rewire it.
    const store = makeStore();
    manualShadowRun(store, "ms0", { resolved: true, ts: 10, tokens: 900 });
    manualShadowRun(store, "ms1", { resolved: true, ts: 20, tokens: 900 });
    // A single injected run so estimated has a non-null value via
    // the treatment arm. Assisted cohort n=1; keep minCausalCohort
    // at 3 so causal lift stays null — this isolates the estimated
    // signal from the causal one.
    assistedRun(store, "a0", { resolved: true, ts: 30, tokens: 500 });
    holdoutRun(store, "h0", { resolved: true, ts: 40, tokens: 700 });

    const usage = computeUsageMetrics(computeAggregates(store), {
      minCausalCohort: 3,
    });
    // estimated.tokensSaved uses ALL shadow data (including holdout)
    // per the Phase 1 contract. We don't assert a specific number
    // here — the invariant under test is that the causal block
    // doesn't short-circuit the estimated computation.
    expect(usage.estimated.tokensSaved.value).not.toBeNull();
    // Causal lift stays null because n=1 < 3.
    expect(usage.causal?.resolvedLift).toBeNull();
  });
});
