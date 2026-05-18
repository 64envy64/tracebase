/**
 * `delete_pattern` MCP-tool helper — capture-side erasure.
 *
 * The tool itself is registered in src/server/mcp.ts and is covered
 * by the doctor `serve --mcp --selftest` probe (full tool-registration
 * sweep) in the CLI tests. This file unit-tests the
 * `deletePattern(store, args)` helper that the tool delegates to,
 * plus the round-trip with retrieval to confirm a deleted pattern
 * is genuinely gone (not just hidden behind a status filter).
 *
 * Privacy invariant verified here: the audit row never persists block
 * body content — only id / block_id / deleted_at / reason /
 * requesting_principal. The schema enforces this at the column level;
 * the tests assert column names and absence of body strings in row
 * values for defence in depth.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import {
  deletePattern,
  storeReasoningPattern,
  StorePatternValidationError,
} from "../../src/server/mcp-v2-helpers.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

const validInput = {
  situation: "flaky pytest run due to import order pollution from a prior test",
  mechanism: "sys.path pollution leaves a stale module cached across tests",
  unlock: "isolate tests in a fresh subprocess, or clear sys.modules in conftest",
  verification: "pytest -p no:cacheprovider reproduces a clean collection",
  language: "python",
};

describe("deletePattern — primary contract", () => {
  it("hard-deletes the block and reports deleted=true", async () => {
    const store = makeStore();
    const stored = storeReasoningPattern(store, validInput);
    expect(store.getBlock(stored.blockId)).not.toBeNull();

    const result = deletePattern(store, {
      id: stored.blockId,
      reason: "user requested erasure",
      requestingPrincipal: "mcp:delete_pattern",
    });
    expect(result).toEqual({ ok: true, deleted: true, id: stored.blockId });
    expect(store.getBlock(stored.blockId)).toBeNull();
  });

  it("writes an audit row carrying id / reason / timestamp / principal", async () => {
    const store = makeStore();
    const stored = storeReasoningPattern(store, validInput);
    deletePattern(store, {
      id: stored.blockId,
      reason: "user requested erasure",
      requestingPrincipal: "mcp:delete_pattern",
    });
    const audit = store.rawDb
      .prepare(
        "SELECT block_id, reason, requesting_principal, deleted_at FROM audit_deletes WHERE block_id = ?",
      )
      .get(stored.blockId) as
      | {
          block_id: string;
          reason: string;
          requesting_principal: string | null;
          deleted_at: number;
        }
      | undefined;
    expect(audit).toBeDefined();
    expect(audit!.block_id).toBe(stored.blockId);
    expect(audit!.reason).toBe("user requested erasure");
    expect(audit!.requesting_principal).toBe("mcp:delete_pattern");
    expect(audit!.deleted_at).toBeGreaterThan(0);
  });

  it("returns deleted=false on a missing id (idempotent, no audit row)", async () => {
    const store = makeStore();
    const result = deletePattern(store, {
      id: "this-id-does-not-exist",
      reason: "test idempotency",
    });
    expect(result).toEqual({
      ok: true,
      deleted: false,
      id: "this-id-does-not-exist",
    });
    const auditCount = (
      store.rawDb.prepare("SELECT COUNT(*) AS c FROM audit_deletes").get() as {
        c: number;
      }
    ).c;
    expect(auditCount).toBe(0);
  });
});

describe("deletePattern — privacy: audit log carries no block body content", () => {
  it("audit_deletes table exposes only the five compliance columns", async () => {
    const store = makeStore();
    const cols = store.rawDb
      .prepare("PRAGMA table_info(audit_deletes)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ["block_id", "deleted_at", "id", "reason", "requesting_principal"].sort(),
    );
  });

  it("no body field (situation / mechanism / unlock / verification) appears in any audit row value", async () => {
    const store = makeStore();
    const stored = storeReasoningPattern(store, validInput);
    const blockBefore = store.getBlock(stored.blockId)!;
    deletePattern(store, {
      id: stored.blockId,
      reason: "user requested erasure",
      requestingPrincipal: "mcp:delete_pattern",
    });
    const audit = store.rawDb
      .prepare("SELECT * FROM audit_deletes WHERE block_id = ?")
      .get(stored.blockId) as Record<string, unknown>;

    // Take ten characters from each body field as a probe — the audit
    // row should contain NONE of these strings.
    const probes = [
      blockBefore.trigger.situation.slice(0, 20),
      blockBefore.body.mechanism.slice(0, 20),
      blockBefore.body.unlock.slice(0, 20),
      blockBefore.body.verification.slice(0, 20),
    ];
    for (const value of Object.values(audit)) {
      if (typeof value !== "string") continue;
      for (const probe of probes) {
        expect(value).not.toContain(probe);
      }
    }
  });
});

describe("deletePattern — input validation", () => {
  it("rejects an empty id", async () => {
    const store = makeStore();
    expect(() => deletePattern(store, { id: "", reason: "test reason here" })).toThrow(
      StorePatternValidationError,
    );
    expect(() => deletePattern(store, { id: "   ", reason: "test reason here" })).toThrow(
      /id.*required/i,
    );
  });

  it("rejects a too-short reason (<4 chars after trim)", async () => {
    const store = makeStore();
    expect(() => deletePattern(store, { id: "x", reason: "no" })).toThrow(
      /reason.*too short/i,
    );
    expect(() => deletePattern(store, { id: "x", reason: "    " })).toThrow(
      /reason.*too short/i,
    );
  });

  it("rejects an over-long reason (>500 chars)", async () => {
    const store = makeStore();
    const tooLong = "x".repeat(501);
    expect(() => deletePattern(store, { id: "x", reason: tooLong })).toThrow(
      /reason.*too long/i,
    );
  });

  it("accepts a 500-char reason exactly (boundary)", async () => {
    const store = makeStore();
    const stored = storeReasoningPattern(store, validInput);
    const exactly500 = "x".repeat(500);
    expect(() =>
      deletePattern(store, { id: stored.blockId, reason: exactly500 }),
    ).not.toThrow();
  });
});

describe("deletePattern — round-trip with get_reasoning_patterns", () => {
  it("a deleted pattern does not surface in subsequent recall", async () => {
    const store = makeStore();
    const server = new BlockServer(store);

    const stored = storeReasoningPattern(store, validInput);

    const before = await runReasoningPatternsRecall(
      server,
      { problem: "flaky pytest run due to import order" },
      { readHoldoutConfig: () => null },
    );
    expect(before.blocks.length).toBeGreaterThan(0);
    expect(before.blocks[0]!.block.id).toBe(stored.blockId);

    deletePattern(store, {
      id: stored.blockId,
      reason: "user requested erasure",
      requestingPrincipal: "mcp:delete_pattern",
    });

    const after = await runReasoningPatternsRecall(
      server,
      { problem: "flaky pytest run due to import order" },
      { readHoldoutConfig: () => null },
    );
    expect(after.blocks.find((b) => b.block.id === stored.blockId)).toBeUndefined();
  });

  it("the audit row persists after the block disappears from recall", async () => {
    const store = makeStore();
    const server = new BlockServer(store);
    const stored = storeReasoningPattern(store, validInput);
    deletePattern(store, {
      id: stored.blockId,
      reason: "test audit persistence after recall sweep",
    });

    // Recall sees nothing — block is gone.
    const recall = await runReasoningPatternsRecall(
      server,
      { problem: "flaky pytest run due to import order" },
      { readHoldoutConfig: () => null },
    );
    expect(recall.blocks.find((b) => b.block.id === stored.blockId)).toBeUndefined();

    // Audit row still there.
    const auditCount = (
      store.rawDb
        .prepare("SELECT COUNT(*) AS c FROM audit_deletes WHERE block_id = ?")
        .get(stored.blockId) as { c: number }
    ).c;
    expect(auditCount).toBe(1);
  });
});
