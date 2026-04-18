import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { LifecycleRepair } from "../../src/lifecycle/repair.js";
import { createBlock } from "../../src/core/block.js";
import type { ReasoningBlock, StoreBlockInput } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function activeBlock(store: BlockStore, sample: StoreBlockInput): ReasoningBlock {
  const b = createBlock(sample);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id, traceId: `trace-${b.id}`, role: "origin", evidenceQuality: "strong",
  });
  return store.updateBlockStatus(b.id, "active")!;
}

const BLOCK_A: StoreBlockInput = {
  trigger: {
    situation: "metaclass iterates inspect isfunction missing properties",
    invariants: { language: "python", framework: "astropy" },
  },
  body: {
    mechanism: "property objects are descriptors not functions",
    deadEnds: [],
    unlock: "use inspect.isdatadescriptor",
    verification: "class inherits docstrings",
  },
  provenance: {
    sourceTaskId: "t-a", extractedFrom: "trajectory", distilledBy: "llm",
  },
};

const BLOCK_B: StoreBlockInput = {
  trigger: {
    situation: "react useEffect stale closure missing dep",
    invariants: { language: "typescript", framework: "react" },
  },
  body: {
    mechanism: "effect captures first render state",
    deadEnds: [],
    unlock: "list state in deps",
    verification: "handler reads latest state",
  },
  provenance: {
    sourceTaskId: "t-b", extractedFrom: "trajectory", distilledBy: "llm",
  },
};

function emitInjection(
  store: BlockStore, queryId: string, blockId: string, ts: number, shadow = false,
): void {
  // Every injection must have a preceding retrieval to be counted in coverage, etc.
  // syncStats uses perBlockMap which keys off injection/retrieval/agent_used/outcome.
  store.appendEvent({
    ts, queryId, event: "retrieval",
    candidates: [{ blockId, score: 0.9 }],
    shadow,
  });
  if (!shadow) {
    store.appendEvent({ ts: ts + 1, queryId, event: "injection", blockId, score: 0.9 });
  }
}

function emitAgentUsed(store: BlockStore, queryId: string, blockId: string, ts: number): void {
  store.appendEvent({
    ts, queryId, event: "agent_used", blockId,
    matchSignal: "jaccard", matchScore: 0.5,
  });
}

function emitOutcome(
  store: BlockStore, queryId: string, resolved: boolean, ts: number, control = false,
): void {
  store.appendEvent({ ts, queryId, event: "outcome", resolved, control });
}

// ---------------------------------------------------------------------------
// syncStats
// ---------------------------------------------------------------------------

describe("LifecycleRepair — syncStats", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("writes per-block counts back from the event log", () => {
    const a = activeBlock(store, BLOCK_A);

    // 3 queries with this block injected; 2 helpful, 1 counter.
    emitInjection(store, "q1", a.id, 100);
    emitAgentUsed(store, "q1", a.id, 102);
    emitOutcome(store, "q1", true, 103);

    emitInjection(store, "q2", a.id, 200);
    emitAgentUsed(store, "q2", a.id, 202);
    emitOutcome(store, "q2", true, 203);

    emitInjection(store, "q3", a.id, 300);
    emitAgentUsed(store, "q3", a.id, 302);
    emitOutcome(store, "q3", false, 303);

    const repair = new LifecycleRepair({ store });
    const report = repair.syncStats();
    expect(report.blocksUpdated).toBe(1);

    const updated = store.getBlock(a.id)!;
    expect(updated.stats.timesRetrieved).toBe(3);
    expect(updated.stats.timesInjected).toBe(3);
    expect(updated.stats.timesAgentUsed).toBe(3);
    expect(updated.stats.timesHelpful).toBe(2);
    expect(updated.stats.timesCounterproductive).toBe(1);
  });

  it("refreshes Wilson lower bound after syncing stats", () => {
    const a = activeBlock(store, BLOCK_A);
    // Pre-sync Wilson LB is 0 (no trials).
    expect(a.quality.wilsonLowerBound).toBe(0);

    // 10 injections, 8 helpful → should give a Wilson LB well above 0.
    for (let i = 0; i < 10; i++) {
      emitInjection(store, `q${i}`, a.id, 100 + i * 10);
      emitAgentUsed(store, `q${i}`, a.id, 101 + i * 10);
      emitOutcome(store, `q${i}`, i < 8, 102 + i * 10);
    }

    new LifecycleRepair({ store }).syncStats();
    const after = store.getBlock(a.id)!;
    expect(after.quality.wilsonLowerBound).toBeGreaterThan(0.4);
    expect(after.stats.timesHelpful).toBe(8);
    expect(after.stats.timesInjected).toBe(10);
  });

  it("records latestUsageTs from the most recent injection/agent_used event", () => {
    const a = activeBlock(store, BLOCK_A);
    emitInjection(store, "q1", a.id, 1000);
    emitAgentUsed(store, "q1", a.id, 1050);
    emitInjection(store, "q2", a.id, 2000);

    new LifecycleRepair({ store }).syncStats();
    expect(store.getBlock(a.id)!.stats.lastUsedAt).toBe(2001); // +1 from emitInjection offset
  });

  it("is idempotent — running twice does not double-count", () => {
    const a = activeBlock(store, BLOCK_A);
    emitInjection(store, "q1", a.id, 100);
    emitAgentUsed(store, "q1", a.id, 102);
    emitOutcome(store, "q1", true, 103);

    const repair = new LifecycleRepair({ store });
    repair.syncStats();
    const first = { ...store.getBlock(a.id)!.stats };
    repair.syncStats();
    const second = { ...store.getBlock(a.id)!.stats };
    expect(second).toEqual(first);
  });

  it("counts orphan event blocks (events reference a deleted block)", () => {
    const a = activeBlock(store, BLOCK_A);
    emitInjection(store, "q1", a.id, 100);
    emitAgentUsed(store, "q1", a.id, 102);
    emitOutcome(store, "q1", true, 103);

    // Events exist but block was deleted.
    store.deleteBlock(a.id);
    const report = new LifecycleRepair({ store }).syncStats();
    expect(report.blocksUpdated).toBe(0);
    expect(report.orphanEventBlocks).toBeGreaterThan(0);
  });

  it("ignores shadow retrieval events from per-block injected counts", () => {
    const a = activeBlock(store, BLOCK_A);
    // Shadow retrieval — block appears in candidates but no injection fires.
    emitInjection(store, "q-shadow", a.id, 100, true);
    new LifecycleRepair({ store }).syncStats();
    const b = store.getBlock(a.id)!;
    expect(b.stats.timesRetrieved).toBe(1);
    expect(b.stats.timesInjected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyDemotionRules
// ---------------------------------------------------------------------------

describe("LifecycleRepair — applyDemotionRules", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("demotes blocks whose verification.status is disproved regardless of sample", () => {
    const a = activeBlock(store, BLOCK_A);
    // No events, no stats — but disproved is authoritative.
    a.verification = {
      status: "disproved",
      verifier: "held-out",
      verifiedAt: 12345,
      reason: "regressed",
    };
    store.replaceBlock(a);

    const report = new LifecycleRepair({ store }).applyDemotionRules();
    expect(report.demoted.length).toBe(1);
    expect(report.demoted[0].reason).toBe("verification:disproved");
    expect(store.getBlock(a.id)!.status).toBe("demoted");
  });

  it("demotes blocks with Wilson LB below threshold once sample threshold is met", () => {
    const a = activeBlock(store, BLOCK_A);
    // 10 injections, 1 helpful → Wilson LB very low.
    for (let i = 0; i < 10; i++) {
      emitInjection(store, `q${i}`, a.id, 100 + i * 10);
      emitAgentUsed(store, `q${i}`, a.id, 101 + i * 10);
      emitOutcome(store, `q${i}`, i === 0, 102 + i * 10);
    }
    const repair = new LifecycleRepair({
      store, wilsonDemoteThreshold: 0.3, minInjectionSample: 5,
    });
    repair.syncStats();
    const report = repair.applyDemotionRules();
    expect(report.demoted.length).toBe(1);
    expect(report.demoted[0].reason.startsWith("wilson-lb:")).toBe(true);
    expect(store.getBlock(a.id)!.status).toBe("demoted");
  });

  it("leaves blocks alone when the injection sample is below minInjectionSample", () => {
    const a = activeBlock(store, BLOCK_A);
    // 2 injections, both counter — but sample too small.
    for (let i = 0; i < 2; i++) {
      emitInjection(store, `q${i}`, a.id, 100 + i * 10);
      emitAgentUsed(store, `q${i}`, a.id, 101 + i * 10);
      emitOutcome(store, `q${i}`, false, 102 + i * 10);
    }
    const repair = new LifecycleRepair({ store, minInjectionSample: 5 });
    repair.syncStats();
    const report = repair.applyDemotionRules();
    expect(report.demoted.length).toBe(0);
    expect(report.kept.length).toBe(1);
    expect(store.getBlock(a.id)!.status).toBe("active");
  });

  it("demotes when counterproductive:helpful ratio exceeds threshold and sample is large", () => {
    const a = activeBlock(store, BLOCK_A);
    // 6 injections, 1 helpful, 5 counter → ratio = 5.0 (well above 2.0).
    for (let i = 0; i < 6; i++) {
      emitInjection(store, `q${i}`, a.id, 100 + i * 10);
      emitAgentUsed(store, `q${i}`, a.id, 101 + i * 10);
      emitOutcome(store, `q${i}`, i === 0, 102 + i * 10);
    }
    const repair = new LifecycleRepair({
      store, minInjectionSample: 5, wilsonDemoteThreshold: 0, counterToHelpfulRatio: 2.0,
    });
    repair.syncStats();
    const report = repair.applyDemotionRules();
    expect(report.demoted.length).toBe(1);
    expect(
      report.demoted[0].reason.startsWith("counter-ratio:") ||
      report.demoted[0].reason.startsWith("wilson-lb:"),
    ).toBe(true);
  });

  it("keeps high-performing blocks active", () => {
    const a = activeBlock(store, BLOCK_A);
    // 10 injections, 9 helpful → Wilson LB comfortably above 0.3.
    for (let i = 0; i < 10; i++) {
      emitInjection(store, `q${i}`, a.id, 100 + i * 10);
      emitAgentUsed(store, `q${i}`, a.id, 101 + i * 10);
      emitOutcome(store, `q${i}`, i < 9, 102 + i * 10);
    }
    const repair = new LifecycleRepair({ store });
    repair.syncStats();
    const report = repair.applyDemotionRules();
    expect(report.demoted.length).toBe(0);
    expect(report.kept.length).toBe(1);
    expect(store.getBlock(a.id)!.status).toBe("active");
  });

  it("never re-demotes already-demoted blocks (they aren't in the active set)", () => {
    const a = activeBlock(store, BLOCK_A);
    store.updateBlockStatus(a.id, "demoted");
    // Reload so we don't overwrite the demoted status with a stale
    // local copy in replaceBlock.
    const fresh = store.getBlock(a.id)!;
    fresh.verification = { status: "disproved", verifier: "x", verifiedAt: 1 };
    store.replaceBlock(fresh);
    expect(store.getBlock(a.id)!.status).toBe("demoted");
    const report = new LifecycleRepair({ store }).applyDemotionRules();
    expect(report.demoted.length).toBe(0);
  });

  it("disproved rule fires even if the block has zero stats", () => {
    const a = activeBlock(store, BLOCK_A);
    a.verification = { status: "disproved", verifier: "x", verifiedAt: 1 };
    store.replaceBlock(a);
    // minInjectionSample would normally gate; disproved bypasses it.
    const report = new LifecycleRepair({
      store, minInjectionSample: 1000,
    }).applyDemotionRules();
    expect(report.demoted.length).toBe(1);
    expect(report.demoted[0].reason).toBe("verification:disproved");
  });

  it("processes multiple blocks independently", () => {
    const a = activeBlock(store, BLOCK_A);
    const b = activeBlock(store, BLOCK_B);
    // A: disproved → demote. B: healthy → keep.
    a.verification = { status: "disproved", verifier: "x", verifiedAt: 1 };
    store.replaceBlock(a);

    const report = new LifecycleRepair({ store }).applyDemotionRules();
    expect(report.demoted.map((d) => d.blockId)).toContain(a.id);
    expect(report.kept.map((k) => k.blockId)).toContain(b.id);
    expect(store.getBlock(a.id)!.status).toBe("demoted");
    expect(store.getBlock(b.id)!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// runAll
// ---------------------------------------------------------------------------

describe("LifecycleRepair — runAll", () => {
  it("runs syncStats before applyDemotionRules in one pass", () => {
    const store = makeStore();
    const a = activeBlock(store, BLOCK_A);
    // 10 injections, all counter → large sample + low Wilson LB.
    for (let i = 0; i < 10; i++) {
      emitInjection(store, `q${i}`, a.id, 100 + i * 10);
      emitAgentUsed(store, `q${i}`, a.id, 101 + i * 10);
      emitOutcome(store, `q${i}`, false, 102 + i * 10);
    }
    const report = new LifecycleRepair({ store }).runAll();
    expect(report.sync.blocksUpdated).toBe(1);
    expect(report.actions.demoted.length).toBe(1);
    expect(store.getBlock(a.id)!.status).toBe("demoted");
  });
});

// ---------------------------------------------------------------------------
// Serving integration (sanity check — demoted blocks excluded)
// ---------------------------------------------------------------------------

describe("LifecycleRepair — serving integration sanity", () => {
  it("a block demoted by the repair loop no longer surfaces in BlockServer.recall", async () => {
    const { BlockServer } = await import("../../src/core/block-serving.js");
    const store = makeStore();
    const a = activeBlock(store, BLOCK_A);
    a.verification = { status: "disproved", verifier: "x", verifiedAt: 1 };
    store.replaceBlock(a);

    new LifecycleRepair({ store }).applyDemotionRules();

    const server = new BlockServer(store, { emitEvents: false });
    const result = server.recall({ text: "metaclass inspect" });
    expect(result.blocks.length).toBe(0); // demoted — filtered out.
  });
});

// ---------------------------------------------------------------------------
// Scoping safety: syncStats is always global.
//
// Regression guard against the pre-fix behaviour where passing runId /
// afterTs / beforeTs into LifecycleRepairOptions would make syncStats
// write partial aggregates into the persistent block.stats materialized
// view, silently corrupting global quality state. Phase 5.1 (post-fix)
// removes those options entirely; scoped analysis belongs to the
// read-only computeAggregates(store, window) from core/analytics.
// ---------------------------------------------------------------------------

describe("LifecycleRepair — scoping safety", () => {
  it("syncStats always integrates over the full log, across run ids", () => {
    const store = makeStore();
    const b = activeBlock(store, BLOCK_A);

    // Events across two different run ids. In the old (broken) API,
    // constructing with runId="run-a" would drop the run-b events.
    const emitAcross = (qid: string, runId: string, ts: number, resolved: boolean): void => {
      store.appendEvent(
        { ts, queryId: qid, event: "retrieval",
          candidates: [{ blockId: b.id, score: 0.9 }], shadow: false },
        { runId },
      );
      store.appendEvent(
        { ts: ts + 1, queryId: qid, event: "injection", blockId: b.id, score: 0.9 },
        { runId },
      );
      store.appendEvent(
        { ts: ts + 2, queryId: qid, event: "agent_used", blockId: b.id,
          matchSignal: "jaccard", matchScore: 0.5 },
        { runId },
      );
      store.appendEvent(
        { ts: ts + 3, queryId: qid, event: "outcome", resolved, control: false },
        { runId },
      );
    };

    emitAcross("q1", "run-a", 100, true);
    emitAcross("q2", "run-b", 200, false);

    new LifecycleRepair({ store }).syncStats();
    const after = store.getBlock(b.id)!;
    // Both runs' events must be counted.
    expect(after.stats.timesInjected).toBe(2);
    expect(after.stats.timesHelpful).toBe(1);
    expect(after.stats.timesCounterproductive).toBe(1);
  });

  it("LifecycleRepairOptions does NOT accept runId / afterTs / beforeTs", () => {
    // Type-level regression: the following should fail to compile if
    // anyone re-introduces window options on LifecycleRepair. We can't
    // assert "does not compile" at runtime, but we can assert that the
    // options the caller might try to pass are silently ignored by
    // TypeScript (no runtime effect) and that the result matches a
    // construction with no extra options.
    const store = makeStore();
    const b = activeBlock(store, BLOCK_A);
    // Two runs, opposite outcomes.
    const emitAcross = (qid: string, runId: string, ts: number, resolved: boolean): void => {
      store.appendEvent(
        { ts, queryId: qid, event: "retrieval",
          candidates: [{ blockId: b.id, score: 0.9 }], shadow: false },
        { runId },
      );
      store.appendEvent(
        { ts: ts + 1, queryId: qid, event: "injection", blockId: b.id, score: 0.9 },
        { runId },
      );
      store.appendEvent(
        { ts: ts + 2, queryId: qid, event: "agent_used", blockId: b.id,
          matchSignal: "jaccard", matchScore: 0.5 },
        { runId },
      );
      store.appendEvent(
        { ts: ts + 3, queryId: qid, event: "outcome", resolved, control: false },
        { runId },
      );
    };
    emitAcross("q1", "run-a", 100, true);
    emitAcross("q2", "run-b", 200, false);

    // Passing an extra property that doesn't exist on the options type
    // is rejected at compile time by TS. At runtime, the fallback is
    // that the constructor ignores unknown keys and produces a global
    // sync. We sanity-check via `as unknown as LifecycleRepairOptions`
    // to simulate what a stale caller might have written before the
    // API was tightened; the RESULT must still match the plain call.
    const taint = new LifecycleRepair({
      store,
      ...({ runId: "run-a" } as Record<string, unknown>),
    } as unknown as ConstructorParameters<typeof LifecycleRepair>[0]);
    taint.syncStats();
    const taintStats = { ...store.getBlock(b.id)!.stats };

    // Re-sync with the plain API.
    new LifecycleRepair({ store }).syncStats();
    const plainStats = { ...store.getBlock(b.id)!.stats };

    // They must agree: the stale caller's runId is silently dropped,
    // and BOTH passes integrate the full log.
    expect(taintStats.timesInjected).toBe(plainStats.timesInjected);
    expect(taintStats.timesHelpful).toBe(plainStats.timesHelpful);
    expect(taintStats.timesCounterproductive).toBe(plainStats.timesCounterproductive);
    expect(plainStats.timesInjected).toBe(2);
  });

  it("applyDemotionRules reads block.stats which reflects the full log", () => {
    const store = makeStore();
    const b = activeBlock(store, BLOCK_A);
    // Mix helpful (run-a) and unhelpful (run-b); if either run were
    // dropped, the demote decision would flip.
    for (let i = 0; i < 3; i++) {
      store.appendEvent(
        { ts: 100 + i, queryId: `a-${i}`, event: "retrieval",
          candidates: [{ blockId: b.id, score: 0.9 }], shadow: false },
        { runId: "run-a" },
      );
      store.appendEvent(
        { ts: 101 + i, queryId: `a-${i}`, event: "injection", blockId: b.id, score: 0.9 },
        { runId: "run-a" },
      );
      store.appendEvent(
        { ts: 102 + i, queryId: `a-${i}`, event: "agent_used", blockId: b.id,
          matchSignal: "jaccard", matchScore: 0.5 },
        { runId: "run-a" },
      );
      store.appendEvent(
        { ts: 103 + i, queryId: `a-${i}`, event: "outcome", resolved: true, control: false },
        { runId: "run-a" },
      );
    }
    for (let i = 0; i < 7; i++) {
      store.appendEvent(
        { ts: 200 + i, queryId: `b-${i}`, event: "retrieval",
          candidates: [{ blockId: b.id, score: 0.9 }], shadow: false },
        { runId: "run-b" },
      );
      store.appendEvent(
        { ts: 201 + i, queryId: `b-${i}`, event: "injection", blockId: b.id, score: 0.9 },
        { runId: "run-b" },
      );
      store.appendEvent(
        { ts: 202 + i, queryId: `b-${i}`, event: "agent_used", blockId: b.id,
          matchSignal: "jaccard", matchScore: 0.5 },
        { runId: "run-b" },
      );
      store.appendEvent(
        { ts: 203 + i, queryId: `b-${i}`, event: "outcome", resolved: false, control: false },
        { runId: "run-b" },
      );
    }
    const repair = new LifecycleRepair({ store });
    repair.syncStats();
    const stats = store.getBlock(b.id)!.stats;
    // Global counts: 3 helpful + 7 counter.
    expect(stats.timesHelpful).toBe(3);
    expect(stats.timesCounterproductive).toBe(7);
    const { demoted } = repair.applyDemotionRules();
    expect(demoted.length).toBe(1); // decision is driven by full log, not any subset.
  });
});
