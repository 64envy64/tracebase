import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  collectInjectedFromQuery,
  resolveUsedItems,
} from "../../src/server/mcp-v2-helpers.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

// ---------------------------------------------------------------------------
// collectInjectedFromQuery
// ---------------------------------------------------------------------------

describe("collectInjectedFromQuery", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("collects both block ids and fact ids injected for the query", () => {
    store.appendEvent({ ts: 1, queryId: "q1", event: "retrieval", candidates: [], shadow: false });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "B1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "q1", event: "fact_injection", factId: "F1", score: 0.9 });
    store.appendEvent({ ts: 4, queryId: "q1", event: "injection", blockId: "B2", score: 0.8 });

    const out = collectInjectedFromQuery(store, "q1");
    expect(out.blockIds).toEqual(["B1", "B2"]);
    expect(out.factIds).toEqual(["F1"]);
  });

  it("ignores events from other queries", () => {
    store.appendEvent({ ts: 1, queryId: "q1", event: "injection", blockId: "B1", score: 0.9 });
    store.appendEvent({ ts: 2, queryId: "q2", event: "injection", blockId: "B2", score: 0.9 });
    const out = collectInjectedFromQuery(store, "q1");
    expect(out.blockIds).toEqual(["B1"]);
  });

  it("dedupes repeat injections of the same id", () => {
    store.appendEvent({ ts: 1, queryId: "q1", event: "injection", blockId: "B1", score: 0.9 });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "B1", score: 0.85 });
    const out = collectInjectedFromQuery(store, "q1");
    expect(out.blockIds).toEqual(["B1"]);
  });

  it("returns empty arrays when no injection events exist", () => {
    const out = collectInjectedFromQuery(store, "unknown");
    expect(out.blockIds).toEqual([]);
    expect(out.factIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveUsedItems
// ---------------------------------------------------------------------------

describe("resolveUsedItems", () => {
  const injected = { blockIds: ["B1", "B2", "B3"], factIds: ["F1", "F2"] };

  it("usedPattern=true credits every injected item", () => {
    const r = resolveUsedItems(injected, { usedPattern: true });
    expect(r.usedBlockIds).toEqual(["B1", "B2", "B3"]);
    expect(r.usedFactIds).toEqual(["F1", "F2"]);
  });

  it("usedPattern=false credits nothing (neutral attribution)", () => {
    const r = resolveUsedItems(injected, { usedPattern: false });
    expect(r.usedBlockIds).toEqual([]);
    expect(r.usedFactIds).toEqual([]);
  });

  it("explicit usedBlocks overrides usedPattern and is intersected with injected set", () => {
    const r = resolveUsedItems(injected, {
      usedPattern: true,
      usedBlocks: ["B1", "B3", "nonexistent"],
    });
    expect(r.usedBlockIds).toEqual(["B1", "B3"]);
    // usedFacts not provided + override given → facts collapse to [].
    expect(r.usedFactIds).toEqual([]);
  });

  it("explicit usedBlocks + usedFacts together", () => {
    const r = resolveUsedItems(injected, {
      usedBlocks: ["B2"],
      usedFacts: ["F1", "F2"],
    });
    expect(r.usedBlockIds).toEqual(["B2"]);
    expect(r.usedFactIds).toEqual(["F1", "F2"]);
  });

  it("never credits ids that were never injected (prevents spoofed agent_used)", () => {
    const r = resolveUsedItems(injected, {
      usedBlocks: ["totally-made-up-id"],
      usedFacts: ["another-fake"],
    });
    expect(r.usedBlockIds).toEqual([]);
    expect(r.usedFactIds).toEqual([]);
  });

  it("missing all fields means no credit (no default assumption)", () => {
    const r = resolveUsedItems(injected, {});
    expect(r.usedBlockIds).toEqual([]);
    expect(r.usedFactIds).toEqual([]);
  });
});
