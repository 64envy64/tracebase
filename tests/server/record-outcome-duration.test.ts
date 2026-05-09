/**
 * 0.7.1 Contextual Runtime — durationMs round-trip
 *
 * The headline integration metric is "time-to-resolution for
 * recurring failure classes". That's surfaced through the causal
 * latency lift in `computeUsageMetrics`, which only fires when the
 * outcome ledger carries `durationMs`. This test proves the path
 * end-to-end:
 *
 *   1. emitOutcome(durationMs) persists the field on disk.
 *   2. computeAggregates surfaces the value in the causal cohort.
 *   3. computeUsageMetrics derives a latency lift between the
 *      treatment and holdout cohorts.
 *
 * If any of these regressed, the headline metric would silently
 * degrade to "N/A" without an obvious symptom.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { computeAggregates, emitOutcome, EventEmitter } from "../../src/core/analytics.js";
import { computeUsageMetrics } from "../../src/analytics/usage-metrics.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

describe("emitOutcome.durationMs round-trip", () => {
  it("persists durationMs on the outcome event", () => {
    const store = makeStore();
    emitOutcome(store, {
      queryId: "q-dur-1",
      resolved: true,
      control: false,
      durationMs: 1234,
    });
    const events = store.readEvents({ queryId: "q-dur-1", limit: 10 });
    const out = events.find((e) => e.event === "outcome") as
      | { event: "outcome"; durationMs?: number }
      | undefined;
    expect(out).toBeDefined();
    expect(out!.durationMs).toBe(1234);
  });

  it("omits durationMs when not supplied (back-compat)", () => {
    const store = makeStore();
    emitOutcome(store, { queryId: "q-dur-2", resolved: true, control: false });
    const events = store.readEvents({ queryId: "q-dur-2", limit: 10 });
    const out = events.find((e) => e.event === "outcome") as
      | { event: "outcome"; durationMs?: number }
      | undefined;
    expect(out).toBeDefined();
    expect(out!.durationMs).toBeUndefined();
  });
});

describe("computeAggregates surfaces durationMs in causal cohorts", () => {
  it("adds durations to the assisted cohort when a non-shadow outcome carries one", () => {
    const store = makeStore();
    // Stage one assisted run: a retrieval + injection + outcome.
    store.appendEvent({
      ts: 1, queryId: "q-asst-1", event: "retrieval",
      candidates: [{ blockId: "b1", score: 0.9 }],
      shadow: false,
    });
    store.appendEvent({
      ts: 2, queryId: "q-asst-1", event: "injection", blockId: "b1", score: 0.9,
    });
    emitOutcome(store, {
      queryId: "q-asst-1",
      resolved: true,
      control: false,
      durationMs: 4000,
    });
    const agg = computeAggregates(store);
    expect(agg.causal.assisted.durations).toContain(4000);
  });

  it("adds durations to the holdout cohort when a shadow outcome carries one", () => {
    const store = makeStore();
    store.appendEvent({
      ts: 1, queryId: "q-hold-1", event: "retrieval",
      candidates: [{ blockId: "b1", score: 0.5 }],
      shadow: true,
      controlReason: "holdout",
    });
    emitOutcome(store, {
      queryId: "q-hold-1",
      resolved: false,
      control: true,
      durationMs: 8000,
    });
    const agg = computeAggregates(store);
    expect(agg.causal.holdout.durations).toContain(8000);
  });
});

describe("computeUsageMetrics — causal latency lift consumes durationMs", () => {
  it("computes a non-null latency lift once both cohorts have enough samples", () => {
    const store = makeStore();
    const emitter = new EventEmitter(store);
    // 30 assisted runs at 1000ms, 30 holdout runs at 3000ms.
    for (let i = 0; i < 30; i++) {
      const qa = `q-asst-${i}`;
      store.appendEvent({
        ts: 1, queryId: qa, event: "retrieval",
        candidates: [{ blockId: "b1", score: 0.9 }],
        shadow: false,
      });
      store.appendEvent({
        ts: 2, queryId: qa, event: "injection", blockId: "b1", score: 0.9,
      });
      emitOutcome(emitter, {
        queryId: qa,
        resolved: true,
        control: false,
        durationMs: 1000,
      });
      const qh = `q-hold-${i}`;
      store.appendEvent({
        ts: 1, queryId: qh, event: "retrieval",
        candidates: [{ blockId: "b1", score: 0.5 }],
        shadow: true,
        controlReason: "holdout",
      });
      emitOutcome(emitter, {
        queryId: qh,
        resolved: false,
        control: true,
        durationMs: 3000,
      });
    }
    const agg = computeAggregates(store);
    const usage = computeUsageMetrics(agg);
    expect(usage.causal).toBeDefined();
    expect(usage.causal!.assisted.n).toBe(30);
    expect(usage.causal!.holdout.n).toBe(30);
    expect(usage.causal!.latencyLift.value).not.toBeNull();
    // Assisted is faster — lift should be positive (ms saved).
    expect(usage.causal!.latencyLift.value!).toBeGreaterThan(0);
  });

  it("returns latency lift = null when either cohort is below minCohortSize", () => {
    const store = makeStore();
    // 5 of each — below default minCausalCohort of 30.
    for (let i = 0; i < 5; i++) {
      const qa = `q-asst-${i}`;
      store.appendEvent({
        ts: 1, queryId: qa, event: "retrieval",
        candidates: [{ blockId: "b1", score: 0.9 }],
        shadow: false,
      });
      store.appendEvent({
        ts: 2, queryId: qa, event: "injection", blockId: "b1", score: 0.9,
      });
      emitOutcome(store, { queryId: qa, resolved: true, control: false, durationMs: 1000 });
      const qh = `q-hold-${i}`;
      store.appendEvent({
        ts: 1, queryId: qh, event: "retrieval",
        candidates: [{ blockId: "b1", score: 0.5 }],
        shadow: true,
        controlReason: "holdout",
      });
      emitOutcome(store, { queryId: qh, resolved: false, control: true, durationMs: 3000 });
    }
    const agg = computeAggregates(store);
    const usage = computeUsageMetrics(agg);
    expect(usage.causal!.latencyLift.value).toBeNull();
  });
});
