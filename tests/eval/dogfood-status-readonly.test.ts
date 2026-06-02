/**
 * Regression: `dogfood-status` must read an EXISTING store read-only without
 * attempting a migration.
 *
 * The defect (caught during the Phase-5 capture-run preflight): the status
 * command opened the DB `{ readonly: true }`, but `BlockStore`'s constructor
 * migrates by default — and `migrate()` only early-returns when the recorded
 * schema is already current. A store written by an older build (e.g. the
 * published package) sits below the local `V2_SCHEMA_VERSION`, so the
 * read-only open tried to ALTER/CREATE on a readonly connection and crashed
 * with SQLITE_READONLY. The documented success-criterion command therefore
 * never ran against a real store.
 *
 * Fix: the status path opens read-only AND passes `{ skipMigrate: true }`.
 * This test forces the schema-drift scenario (so a fresh, already-current DB
 * can't mask the bug) and asserts both halves: the un-fixed open throws, the
 * fixed open reads cleanly.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../src/core/block-store.js";
import { captureTurnFromTexts } from "../../src/runtime/capture-turn.js";
import { buildDogfoodManifest } from "../../src/eval/dogfood-manifest.js";

// Verbatim from dogfood-manifest.test.ts — this root-cause + fix shape is what
// the capture heuristic distills into a block; shortening it drops below the
// structural threshold and capture returns null.
const USER =
  "The pytest suite fails to collect the right package on a fresh clone because an " +
  "earlier sys.path entry shadows the intended namespace package, so imports resolve " +
  "to the wrong module and the tests error out during collection.";
const ASSISTANT =
  "The root cause is that an earlier sys.path entry exposes a namespace package that " +
  "shadows the intended one, so the pytest collector imports the wrong module during " +
  "collection. The first matching entry wins, which is why the intended package is " +
  "never reached.\n\n" +
  "Rename the shadowing module or remove its directory from sys.path before invoking " +
  "pytest, then run pytest collect-only to confirm the intended package is collected.";

describe("dogfood-status read-only open (regression)", () => {
  it("reads an existing migrated store read-only without attempting a migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-dogfood-ro-"));
    const dbPath = join(dir, "memory.db");
    try {
      // 1. Create + migrate + populate a real on-disk store, then close.
      {
        const store = new BlockStore(new Database(dbPath));
        const cap = captureTurnFromTexts(store, { userText: USER, assistantText: ASSISTANT });
        expect(cap.blockId).not.toBeNull();
        store.close();
      }

      // 2. Simulate schema drift: a store written by an older build records a
      //    version below the local target, so the next open WANTS to migrate.
      {
        const raw = new Database(dbPath);
        raw.prepare("UPDATE v2_schema_meta SET value = '1' WHERE key = 'version'").run();
        raw.close();
      }

      // 3. The defect: readonly open WITHOUT skipMigrate attempts the migration
      //    write on a readonly connection and throws. Hold the connection so we
      //    can close it — BlockStore's constructor throws mid-migrate, before it
      //    can own/close the handle, which would otherwise leak (EBUSY on rm).
      const roConn = new Database(dbPath, { readonly: true });
      try {
        expect(() => new BlockStore(roConn)).toThrow(/readonly/i);
      } finally {
        roConn.close();
      }

      // 4. The fix: readonly + skipMigrate reads cleanly and the manifest builds.
      const store = new BlockStore(new Database(dbPath, { readonly: true }), { skipMigrate: true });
      const m = buildDogfoodManifest(store);
      expect(m.summary.captured).toBe(1);
      expect(m.summary.runtimeCaptured).toBe(1);
      store.close();
    } finally {
      // Best-effort temp cleanup. Windows can hold the SQLite file handle a
      // beat past close(); the temp dir is disposable and not part of the
      // test's contract, so a transient EBUSY here must not fail the run.
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch { /* OS will reclaim the temp dir */ }
    }
  });
});
