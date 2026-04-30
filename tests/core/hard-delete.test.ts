/**
 * Hard-delete + audit-trail behaviour for GDPR Art. 17 compliance.
 *
 * Covers four invariants the design-partner brief commits to:
 *   1. The block is gone from active reads after delete.
 *   2. The audit row persists (id, timestamp, reason, principal).
 *   3. CASCADE sweeps all attached case refs.
 *   4. The (fingerprint, kind) dedupe slot is freed for re-capture.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { storeReasoningPattern } from "../../src/server/mcp-v2-helpers.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

const validInput = {
  situation: "hard-delete test — distinct trigger phrase for fingerprint",
  mechanism: "the deletion path must remove the row and write an audit tombstone",
  unlock: "wrap delete + audit insert in a single transaction so partial fail rolls back",
  verification: "after delete, getBlock returns null and audit_deletes contains a row",
};

describe("BlockStore.hardDeleteBlock", () => {
  it("removes the block from active reads and writes an audit row", () => {
    const store = makeStore();
    const stored = storeReasoningPattern(store, validInput);
    expect(store.getBlock(stored.blockId)).not.toBeNull();

    const ok = store.hardDeleteBlock(stored.blockId, "user requested erasure", "user-123");
    expect(ok).toBe(true);
    expect(store.getBlock(stored.blockId)).toBeNull();

    const audit = store.rawDb
      .prepare(
        "SELECT block_id, reason, requesting_principal, deleted_at FROM audit_deletes WHERE block_id = ?",
      )
      .get(stored.blockId) as
      | { block_id: string; reason: string; requesting_principal: string | null; deleted_at: number }
      | undefined;
    expect(audit).toBeDefined();
    expect(audit!.block_id).toBe(stored.blockId);
    expect(audit!.reason).toBe("user requested erasure");
    expect(audit!.requesting_principal).toBe("user-123");
    expect(typeof audit!.deleted_at).toBe("number");
  });

  it("permits a null requesting_principal (system-initiated erasure)", () => {
    const store = makeStore();
    const stored = storeReasoningPattern(store, validInput);
    store.hardDeleteBlock(stored.blockId, "automated retention sweep");
    const row = store.rawDb
      .prepare("SELECT requesting_principal FROM audit_deletes WHERE block_id = ?")
      .get(stored.blockId) as { requesting_principal: string | null };
    expect(row.requesting_principal).toBeNull();
  });

  it("cascades the case-ref delete so refs do not orphan", () => {
    const store = makeStore();
    const stored = storeReasoningPattern(store, validInput);
    const refsBefore = store.listCaseRefs(stored.blockId);
    expect(refsBefore.length).toBe(1);

    store.hardDeleteBlock(stored.blockId, "test cascade");
    const refRows = store.rawDb
      .prepare("SELECT id FROM block_case_refs WHERE block_id = ?")
      .all(stored.blockId);
    expect(refRows.length).toBe(0);
  });

  it("is idempotent on a missing block (returns false, writes no audit row)", () => {
    const store = makeStore();
    const ok = store.hardDeleteBlock("nonexistent-id", "test idempotency");
    expect(ok).toBe(false);
    const auditRows = store.rawDb.prepare("SELECT id FROM audit_deletes").all();
    expect(auditRows.length).toBe(0);
  });

  it("frees the (fingerprint, kind) dedupe slot for re-capture", () => {
    const store = makeStore();
    const first = storeReasoningPattern(store, validInput);
    expect(first.isNew).toBe(true);

    // Without hard-delete, a re-capture would dedupe to the original
    // and attach a `supporting` ref instead of inserting fresh.
    const dupe = storeReasoningPattern(store, validInput);
    expect(dupe.isNew).toBe(false);
    expect(dupe.blockId).toBe(first.blockId);

    store.hardDeleteBlock(first.blockId, "test re-capture path");

    const second = storeReasoningPattern(store, validInput);
    expect(second.isNew).toBe(true);
    expect(second.blockId).not.toBe(first.blockId);
  });
});
