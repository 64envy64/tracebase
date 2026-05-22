/**
 * C5 — runtime arbiter decision-stream metrics.
 *
 * Pins the contract the C4.5 review named:
 *   • `arbitration_decision` events feed a CLOSED-VOCAB
 *     decision-stream aggregate (capability × action, reason
 *     histogram, token sums).
 *   • A ground-truth cross-check compares the arbiter's
 *     reasoning_reuse `inject` count to the payload builder's
 *     actual `injection` + `fact_injection` event count.
 *     Divergence is zero by construction in C4.5's unified
 *     finaliser; a non-zero value is a regression signal the
 *     dashboard surfaces.
 *   • The aggregate is back-compat by construction: a store
 *     with no arbiter activity returns a zeroed block, not
 *     `undefined`.
 *   • Payload-builder remains the last instance of visibility;
 *     `arbitration` is NOT the right surface for "what reached
 *     the prompt". Existing `injection` / `fact_injection` /
 *     `retrieval.injectedItemCounts` keep that role.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { computeAggregates, emitArbitrationDecision } from "../../src/core/analytics.js";
import { computeUsageMetrics } from "../../src/analytics/usage-metrics.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function seedArbiterInject(
  store: BlockStore,
  args: {
    queryId: string;
    candidateId: string;
    capability?: "reasoning_reuse" | "file_memory";
    expectedNetTokens?: number;
    injectionTokens?: number;
  },
): void {
  emitArbitrationDecision(store, {
    queryId: args.queryId,
    capability: args.capability ?? "reasoning_reuse",
    candidateId: args.candidateId,
    action: "inject",
    reason: "positive_roi",
    expectedNetTokens: args.expectedNetTokens ?? 50,
    calibratedProb: 0.9,
    relevanceScore: 0.8,
    injectionTokens: args.injectionTokens ?? 30,
  });
}

function seedArbiterSuppress(
  store: BlockStore,
  args: {
    queryId: string;
    candidateId: string;
    reason: "budget" | "profile_cap" | "low_confidence" | "stale" | "duplicate" | "holdout";
    capability?: "reasoning_reuse" | "file_memory";
    expectedNetTokens?: number;
    injectionTokens?: number;
  },
): void {
  emitArbitrationDecision(store, {
    queryId: args.queryId,
    capability: args.capability ?? "reasoning_reuse",
    candidateId: args.candidateId,
    action: "suppress",
    reason: args.reason,
    expectedNetTokens: args.expectedNetTokens ?? 20,
    calibratedProb: 0.5,
    relevanceScore: 0.5,
    injectionTokens: args.injectionTokens ?? 30,
  });
}

// ---------------------------------------------------------------------------
// Backward-compatibility: stores with no arbiter activity
// ---------------------------------------------------------------------------

describe("ArbitrationAggregates — back-compat default", () => {
  it("returns a zeroed arbitration block on an empty store", () => {
    const store = makeStore();
    const agg = computeAggregates(store);
    expect(agg.arbitration).toBeDefined();
    expect(agg.arbitration.totalDecisions).toBe(0);
    expect(agg.arbitration.injectedTokensSum).toBe(0);
    expect(agg.arbitration.suppressedTokensSum).toBe(0);
    expect(agg.arbitration.injectedNetExpectedSum).toBe(0);
    expect(agg.arbitration.groundTruth).toEqual({
      queriesWithDecisions: 0,
      injectDecisions: 0,
      promptVisibleItems: 0,
      divergence: 0,
    });
    // Every capability bucket is zeroed (closed-enum contract).
    expect(agg.arbitration.byCapability.reasoning_reuse).toEqual({
      inject: 0, suppress: 0, shadow: 0,
    });
    expect(agg.arbitration.byCapability.context_pruning).toEqual({
      inject: 0, suppress: 0, shadow: 0,
    });
    // Reason histogram is zeroed across the closed enum.
    expect(agg.arbitration.byReason.positive_roi).toBe(0);
    expect(agg.arbitration.byReason.profile_cap).toBe(0);
  });

  it("usage-metrics surfaces the arbitration block (zeroed when no events)", () => {
    const store = makeStore();
    const usage = computeUsageMetrics(computeAggregates(store));
    expect(usage.arbitration).toBeDefined();
    expect(usage.arbitration!.totalDecisions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Decision-stream tallies
// ---------------------------------------------------------------------------

describe("ArbitrationAggregates — decision-stream tallies", () => {
  it("byCapability counts inject/suppress/shadow correctly per capability", () => {
    const store = makeStore();
    // q-a: 2 reasoning_reuse injects + 1 suppress (budget).
    seedArbiterInject(store, { queryId: "q-a", candidateId: "block:1" });
    seedArbiterInject(store, { queryId: "q-a", candidateId: "block:2" });
    seedArbiterSuppress(store, { queryId: "q-a", candidateId: "block:3", reason: "budget" });
    // q-b: 1 file_memory inject + 1 reasoning_reuse profile_cap suppress.
    seedArbiterInject(store, { queryId: "q-b", candidateId: "file:1", capability: "file_memory" });
    seedArbiterSuppress(store, { queryId: "q-b", candidateId: "block:4", reason: "profile_cap" });
    // q-c: 1 shadow decision.
    emitArbitrationDecision(store, {
      queryId: "q-c",
      capability: "reasoning_reuse",
      candidateId: "block:5",
      action: "shadow",
      reason: "holdout",
      expectedNetTokens: 0,
      calibratedProb: 0.9,
      relevanceScore: 0.8,
      injectionTokens: 30,
    });

    const agg = computeAggregates(store);
    expect(agg.arbitration.totalDecisions).toBe(6);
    expect(agg.arbitration.byCapability.reasoning_reuse).toEqual({
      inject: 2, suppress: 2, shadow: 1,
    });
    expect(agg.arbitration.byCapability.file_memory).toEqual({
      inject: 1, suppress: 0, shadow: 0,
    });
  });

  it("byReason tallies the closed-enum reasons across all capabilities", () => {
    const store = makeStore();
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:1" });   // positive_roi
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:2" });   // positive_roi
    seedArbiterSuppress(store, { queryId: "q1", candidateId: "block:3", reason: "budget" });
    seedArbiterSuppress(store, { queryId: "q1", candidateId: "block:4", reason: "profile_cap" });
    seedArbiterSuppress(store, { queryId: "q1", candidateId: "block:5", reason: "low_confidence" });

    const agg = computeAggregates(store);
    expect(agg.arbitration.byReason.positive_roi).toBe(2);
    expect(agg.arbitration.byReason.budget).toBe(1);
    expect(agg.arbitration.byReason.profile_cap).toBe(1);
    expect(agg.arbitration.byReason.low_confidence).toBe(1);
    // Other reasons stay at 0.
    expect(agg.arbitration.byReason.stale).toBe(0);
    expect(agg.arbitration.byReason.duplicate).toBe(0);
    expect(agg.arbitration.byReason.holdout).toBe(0);
  });

  it("injectedTokensSum + suppressedTokensSum + injectedNetExpectedSum partition cleanly", () => {
    const store = makeStore();
    // Two injects (30 + 50 tokens, net 100 + 200) and two
    // suppresses (40 + 25 tokens, doesn't matter what reason).
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:1", injectionTokens: 30, expectedNetTokens: 100 });
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:2", injectionTokens: 50, expectedNetTokens: 200 });
    seedArbiterSuppress(store, { queryId: "q1", candidateId: "block:3", reason: "budget", injectionTokens: 40 });
    seedArbiterSuppress(store, { queryId: "q1", candidateId: "block:4", reason: "profile_cap", injectionTokens: 25 });

    const agg = computeAggregates(store);
    expect(agg.arbitration.injectedTokensSum).toBe(80);
    expect(agg.arbitration.suppressedTokensSum).toBe(65);
    expect(agg.arbitration.injectedNetExpectedSum).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Ground-truth cross-check vs payload-builder
// ---------------------------------------------------------------------------

describe("ArbitrationAggregates — ground-truth cross-check", () => {
  it("divergence === 0 when every arbiter inject is mirrored by an injection event (C4.5 normal flow)", () => {
    const store = makeStore();
    // q1: arbiter injects 2 blocks; payload builder emits 2 injection events.
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:a" });
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:b" });
    store.appendEvent({
      ts: Date.now(), queryId: "q1", event: "retrieval",
      candidates: [{ blockId: "a", score: 0.9 }, { blockId: "b", score: 0.8 }],
      shadow: false,
    });
    store.appendEvent({ ts: Date.now(), queryId: "q1", event: "injection", blockId: "a", score: 0.9 });
    store.appendEvent({ ts: Date.now(), queryId: "q1", event: "injection", blockId: "b", score: 0.8 });

    const agg = computeAggregates(store);
    expect(agg.arbitration.groundTruth).toEqual({
      queriesWithDecisions: 1,
      injectDecisions: 2,
      promptVisibleItems: 2,
      divergence: 0,
    });
  });

  it("divergence is POSITIVE when the payload builder trimmed items the arbiter approved", () => {
    // Simulates a future drift: arbiter says inject 3, builder
    // renders 1 (because of a downstream cap we forgot to mirror
    // back into the arbiter). The dashboard sees divergence=2 and
    // can flag it as a regression signal.
    const store = makeStore();
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:a" });
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:b" });
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:c" });
    store.appendEvent({
      ts: Date.now(), queryId: "q1", event: "retrieval",
      candidates: [{ blockId: "a", score: 0.9 }],
      shadow: false,
    });
    // Only ONE injection event lands (builder dropped two).
    store.appendEvent({ ts: Date.now(), queryId: "q1", event: "injection", blockId: "a", score: 0.9 });

    const agg = computeAggregates(store);
    expect(agg.arbitration.groundTruth.injectDecisions).toBe(3);
    expect(agg.arbitration.groundTruth.promptVisibleItems).toBe(1);
    expect(agg.arbitration.groundTruth.divergence).toBe(2);
  });

  it("ground-truth count includes facts via fact_injection events", () => {
    const store = makeStore();
    seedArbiterInject(store, { queryId: "q1", candidateId: "block:a" });
    seedArbiterInject(store, { queryId: "q1", candidateId: "fact:f1" });
    store.appendEvent({
      ts: Date.now(), queryId: "q1", event: "retrieval",
      candidates: [{ blockId: "a", score: 0.9 }],
      shadow: false,
    });
    store.appendEvent({ ts: Date.now(), queryId: "q1", event: "injection", blockId: "a", score: 0.9 });
    store.appendEvent({ ts: Date.now(), queryId: "q1", event: "fact_injection", factId: "f1", score: 0.8 });

    const agg = computeAggregates(store);
    expect(agg.arbitration.groundTruth.injectDecisions).toBe(2);
    expect(agg.arbitration.groundTruth.promptVisibleItems).toBe(2);
    expect(agg.arbitration.groundTruth.divergence).toBe(0);
  });

  it("C5.1.C — NEGATIVE divergence: arbiter suppresses but payload-builder still injects", () => {
    // Pre-C5.1.C the cross-check iterated only queries with at
    // least one `inject` decision. So this case (arbiter says
    // suppress, builder still emits an injection event for the
    // same query) left `promptVisibleItems` at 0 and divergence
    // at 0 — a silent miss. Post-fix the iteration covers every
    // reasoning_reuse queryId regardless of action, so we now
    // see `injectDecisions=0`, `promptVisibleItems=1`,
    // `divergence=-1`. The signal is "builder rendered an item
    // the arbiter rejected" — a real drift the dashboard should
    // flag.
    const store = makeStore();
    seedArbiterSuppress(store, {
      queryId: "q-neg",
      candidateId: "block:a",
      reason: "budget",
    });
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-neg",
      event: "retrieval",
      candidates: [{ blockId: "a", score: 0.9 }],
      shadow: false,
    });
    // Builder injected anyway (simulated drift).
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-neg",
      event: "injection",
      blockId: "a",
      score: 0.9,
    });

    const agg = computeAggregates(store);
    expect(agg.arbitration.groundTruth.queriesWithDecisions).toBe(1);
    expect(agg.arbitration.groundTruth.injectDecisions).toBe(0);
    expect(agg.arbitration.groundTruth.promptVisibleItems).toBe(1);
    expect(agg.arbitration.groundTruth.divergence).toBe(-1);
  });

  it("C5.1.C — shadow decisions also count toward the cross-check denominator", () => {
    // A shadow-arm query never injects, so prompt-visible=0 and
    // divergence stays 0. But the queryId DOES participate in the
    // cross-check denominator so the dashboard can show "we ran
    // the arbiter on N queries, here's the divergence over that
    // set" honestly.
    const store = makeStore();
    emitArbitrationDecision(store, {
      queryId: "q-shadow",
      capability: "reasoning_reuse",
      candidateId: "block:s",
      action: "shadow",
      reason: "holdout",
      expectedNetTokens: 0,
      calibratedProb: 0.9,
      relevanceScore: 0.8,
      injectionTokens: 30,
    });

    const agg = computeAggregates(store);
    expect(agg.arbitration.groundTruth.queriesWithDecisions).toBe(1);
    expect(agg.arbitration.groundTruth.injectDecisions).toBe(0);
    expect(agg.arbitration.groundTruth.promptVisibleItems).toBe(0);
    expect(agg.arbitration.groundTruth.divergence).toBe(0);
  });

  it("non-reasoning_reuse capabilities are EXCLUDED from the ground-truth check (file_memory has its own surface)", () => {
    // Boundary check: file_memory inject decisions count toward
    // byCapability.file_memory.inject but NOT toward
    // groundTruth.injectDecisions, because the payload builder's
    // file_memory section emits a SEPARATE event
    // (`file_memory.recalled`) on a different schema. The C5
    // ground-truth surface is scoped to reasoning_reuse for now;
    // expanding to other capabilities is a deliberate later step.
    const store = makeStore();
    seedArbiterInject(store, { queryId: "q1", candidateId: "file:1", capability: "file_memory" });
    const agg = computeAggregates(store);
    expect(agg.arbitration.byCapability.file_memory.inject).toBe(1);
    expect(agg.arbitration.groundTruth.injectDecisions).toBe(0);
    // The query is still counted (it had at least one decision).
    expect(agg.arbitration.groundTruth.queriesWithDecisions).toBe(1);
  });
});
