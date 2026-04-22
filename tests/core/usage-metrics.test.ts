import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { computeAggregates } from "../../src/core/analytics.js";
import { computeUsageMetrics } from "../../src/analytics/usage-metrics.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

describe("computeUsageMetrics — funnel invariants", () => {
  it("returns zeros on an empty store and marks estimates as null", () => {
    const store = makeStore();
    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.observed.eligibleRuns).toBe(0);
    expect(usage.observed.recalledRuns).toBe(0);
    expect(usage.observed.injectedRuns).toBe(0);
    expect(usage.observed.usedRuns).toBe(0);
    expect(usage.observed.helpfulRuns).toBe(0);
    expect(usage.observed.resolvedRateWithMemory).toBeNull();
    expect(usage.estimated.tokensSaved.value).toBeNull();
    expect(usage.estimated.latencySavedMs.value).toBeNull();
  });

  it("funnel counts are queryId-deduplicated and monotonically non-increasing", () => {
    const store = makeStore();
    // q1: full funnel — eligible → recalled → injected → used → helpful
    store.appendEvent({ ts: 1, queryId: "q1", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "q1", event: "agent_used", blockId: "b1", matchSignal: "jaccard", matchScore: 0.8 });
    store.appendEvent({ ts: 4, queryId: "q1", event: "outcome", resolved: true, control: false });

    // q2: recalled but not injected (e.g. threshold gate failed) — stays at "recalled"
    store.appendEvent({ ts: 5, queryId: "q2", event: "retrieval", candidates: [{ blockId: "b1", score: 0.2 }], shadow: false });
    store.appendEvent({ ts: 6, queryId: "q2", event: "outcome", resolved: true, control: false });

    // q3: injected but not used — "injected" but not "used" or "helpful"
    store.appendEvent({ ts: 7, queryId: "q3", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 8, queryId: "q3", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 9, queryId: "q3", event: "outcome", resolved: true, control: false });

    // q4: injected AND used but NOT resolved — "used" but not "helpful"
    store.appendEvent({ ts: 10, queryId: "q4", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 11, queryId: "q4", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 12, queryId: "q4", event: "agent_used", blockId: "b1", matchSignal: "explicit", matchScore: 1 });
    store.appendEvent({ ts: 13, queryId: "q4", event: "outcome", resolved: false, control: false });

    // q5: retrieval with NO candidates — eligible only
    store.appendEvent({ ts: 14, queryId: "q5", event: "retrieval", candidates: [], shadow: false });

    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.observed.eligibleRuns).toBe(5);   // q1..q5
    expect(usage.observed.recalledRuns).toBe(4);   // q1, q2, q3, q4
    expect(usage.observed.injectedRuns).toBe(3);   // q1, q3, q4
    expect(usage.observed.usedRuns).toBe(2);       // q1, q4
    expect(usage.observed.helpfulRuns).toBe(1);    // q1 only

    // Monotonic invariant.
    const o = usage.observed;
    expect(o.eligibleRuns).toBeGreaterThanOrEqual(o.recalledRuns);
    expect(o.recalledRuns).toBeGreaterThanOrEqual(o.injectedRuns);
    expect(o.injectedRuns).toBeGreaterThanOrEqual(o.usedRuns);
    expect(o.usedRuns).toBeGreaterThanOrEqual(o.helpfulRuns);

    // resolvedRateWithMemory = helpfulRuns / injectedRuns = 1/3.
    expect(usage.observed.resolvedRateWithMemory).toBeCloseTo(1 / 3);
  });

  it("estimated tokensSaved becomes non-null only when both arms have tokens", () => {
    const store = makeStore();
    // Treatment query with tokens.
    store.appendEvent({ ts: 1, queryId: "qT", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 2, queryId: "qT", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "qT", event: "agent_used", blockId: "b1", matchSignal: "jaccard", matchScore: 1 });
    store.appendEvent({ ts: 4, queryId: "qT", event: "outcome", resolved: true, control: false, tokens: 500, durationMs: 1000 });

    // Shadow query with tokens.
    store.appendEvent({ ts: 5, queryId: "qS", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: true });
    store.appendEvent({ ts: 6, queryId: "qS", event: "outcome", resolved: true, control: true, tokens: 700, durationMs: 1800 });

    const usage = computeUsageMetrics(computeAggregates(store));
    // Per-run delta = 700 - 500 = 200, × injectedRuns (1) = 200.
    expect(usage.estimated.tokensSaved.value).toBe(200);
    expect(usage.estimated.tokensSaved.sampleSize).toBe(1);
    // Duration delta = 1800 - 1000 = 800ms × 1 injected run.
    expect(usage.estimated.latencySavedMs.value).toBe(800);
  });

  it("estimate stays null when the shadow arm is absent", () => {
    const store = makeStore();
    store.appendEvent({ ts: 1, queryId: "q1", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "q1", event: "agent_used", blockId: "b1", matchSignal: "jaccard", matchScore: 1 });
    store.appendEvent({ ts: 4, queryId: "q1", event: "outcome", resolved: true, control: false, tokens: 400, durationMs: 900 });

    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.estimated.tokensSaved.value).toBeNull();
    expect(usage.estimated.latencySavedMs.value).toBeNull();
    expect(usage.estimated.tokensSaved.formula).toMatch(/needs shadow arm/);
  });

  it("carries integrity diagnostics through unchanged", () => {
    const store = makeStore();
    // Outcome with no matching retrieval.
    store.appendEvent({ ts: 1, queryId: "orphan", event: "outcome", resolved: true, control: false });
    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.integrity.outcomesWithoutRetrieval).toBe(1);
  });

  it('defaults scope to "workspace" — Phase 1 refuses to split an un-tagged event log', () => {
    const store = makeStore();
    store.appendEvent({ ts: 1, queryId: "q1", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    const usage = computeUsageMetrics(computeAggregates(store));
    // scope must be workspace: local events carry no agent dimension.
    expect(usage.scope).toBe("workspace");
  });

  it('accepts scope override, preparing for Phase 2 per-agent samples', () => {
    const store = makeStore();
    store.appendEvent({ ts: 1, queryId: "q1", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    const usage = computeUsageMetrics(computeAggregates(store), { scope: "agent" });
    expect(usage.scope).toBe("agent");
  });
});
