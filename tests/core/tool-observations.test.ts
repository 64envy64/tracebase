/**
 * `BlockStore.recordToolObservations` + `recentToolObservations`
 * coverage for the 0.5.3 TB TOOL substrate (V2_MIGRATIONS[8]).
 *
 * The store accepts the per-tool sanitiser's output verbatim — it
 * doesn't inspect arg content. These tests pin the round-trip
 * shape, the (session_id, ts) ordering contract `inject-context`
 * relies on, and the empty-batch no-op.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";

function freshStore(): { store: BlockStore; close: () => void } {
  const db = new Database(":memory:");
  const store = new BlockStore(db);
  return { store, close: () => store.close() };
}

describe("BlockStore.recordToolObservations", () => {
  it("inserts a batch in one transaction and returns ids in order", () => {
    const { store, close } = freshStore();
    try {
      const ids = store.recordToolObservations([
        {
          sessionId: "s1",
          batchOrder: 0,
          toolName: "Read",
          argSummary: "Read(src/foo.ts)",
          argKey: "ak0",
        },
        {
          sessionId: "s1",
          batchOrder: 1,
          toolName: "Grep",
          argSummary: 'Grep("foo")',
          argKey: "ak1",
        },
      ]);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      expect(store.countToolObservations("s1")).toBe(2);
    } finally {
      close();
    }
  });

  it("empty input is a no-op — returns []", () => {
    const { store, close } = freshStore();
    try {
      expect(store.recordToolObservations([])).toEqual([]);
      expect(store.countToolObservations("s1")).toBe(0);
    } finally {
      close();
    }
  });

  it("default outcome is `unknown` when not provided (live PostToolBatch lacks outcome)", () => {
    const { store, close } = freshStore();
    try {
      store.recordToolObservations([
        { sessionId: "s1", batchOrder: 0, toolName: "Read", argSummary: "Read(x)", argKey: "k" },
      ]);
      const recent = store.recentToolObservations("s1", 1);
      expect(recent[0]?.outcome).toBe("unknown");
    } finally {
      close();
    }
  });
});

describe("BlockStore.recentToolObservations", () => {
  it("returns rows oldest-first within a session, capped to limit", () => {
    const { store, close } = freshStore();
    try {
      // Two writes back-to-back. recordToolObservations stamps every
      // row in a single batch with the same `ts`, so the secondary
      // (rowid DESC) key wins — newer batch's rows sort after the
      // older batch.
      store.recordToolObservations([
        { sessionId: "s1", batchOrder: 0, toolName: "Read", argSummary: "Read(a)", argKey: "ka" },
        { sessionId: "s1", batchOrder: 1, toolName: "Read", argSummary: "Read(b)", argKey: "kb" },
      ]);
      store.recordToolObservations([
        { sessionId: "s1", batchOrder: 0, toolName: "Read", argSummary: "Read(c)", argKey: "kc" },
      ]);
      const recent = store.recentToolObservations("s1", 5);
      expect(recent.map((o) => o.argKey)).toEqual(["ka", "kb", "kc"]);
    } finally {
      close();
    }
  });

  it("isolates rows by session_id", () => {
    const { store, close } = freshStore();
    try {
      store.recordToolObservations([
        { sessionId: "s1", batchOrder: 0, toolName: "Read", argSummary: "Read(a)", argKey: "ka" },
      ]);
      store.recordToolObservations([
        { sessionId: "s2", batchOrder: 0, toolName: "Read", argSummary: "Read(b)", argKey: "kb" },
      ]);
      expect(store.recentToolObservations("s1", 5)).toHaveLength(1);
      expect(store.recentToolObservations("s2", 5)).toHaveLength(1);
      expect(store.recentToolObservations("s1", 5)[0]?.argKey).toBe("ka");
    } finally {
      close();
    }
  });

  it("limit ≤ 0 returns []", () => {
    const { store, close } = freshStore();
    try {
      store.recordToolObservations([
        { sessionId: "s1", batchOrder: 0, toolName: "Read", argSummary: "x", argKey: "k" },
      ]);
      expect(store.recentToolObservations("s1", 0)).toEqual([]);
      expect(store.recentToolObservations("s1", -1)).toEqual([]);
    } finally {
      close();
    }
  });
});
