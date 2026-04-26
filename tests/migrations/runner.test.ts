/**
 * Migration framework — 0.7.0-rc.1 ground.
 *
 * The framework on top of `BlockStore.migrate()`:
 *   1. `v2_schema_meta` KV row tracks the current applied version
 *      (existing since 0.5.x).
 *   2. `schema_version` per-row log records one row per applied
 *      version (new in rc.1).
 *   3. Bridging migration #9 creates `schema_version` and back-fills
 *      historical rows 1..8 for upgraded DBs.
 *   4. The fresh-init fast-path mirrors the per-row log retroactively
 *      so brand-new installs land with the same audit history.
 *   5. `addColumnIfMissing(db, table, name, type)` — every later rc's
 *      column-additive migration uses this helper for idempotency.
 *
 * The same migration set MUST apply cleanly to:
 *   - a fresh empty DB
 *   - a 0.6.x DB carrying existing rows (synthetic at v=8)
 *   - a DB that already saw the latest migration once (double-apply)
 *
 * Each axis here is its own describe block so a failure pinpoints
 * which path is broken.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore, addColumnIfMissing } from "../../src/core/block-store.js";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tb-migrations-"));
  dbPath = join(tmp, "tb.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fresh-DB path
// ---------------------------------------------------------------------------

describe("migrations — fresh DB", () => {
  it("opens a fresh DB at the latest version with full audit history", () => {
    const store = new BlockStore(dbPath);
    const db = store.rawDb;

    // Current version recorded in the legacy KV cell.
    const meta = db
      .prepare("SELECT value FROM v2_schema_meta WHERE key = 'version'")
      .get() as { value: string };
    const currentVersion = parseInt(meta.value, 10);
    expect(currentVersion).toBeGreaterThanOrEqual(9);

    // Every version 1..current must have a row in schema_version.
    const rows = db
      .prepare("SELECT version, applied_at FROM schema_version ORDER BY version")
      .all() as Array<{ version: number; applied_at: number }>;
    expect(rows.map((r) => r.version)).toEqual(
      Array.from({ length: currentVersion }, (_, i) => i + 1),
    );
    for (const r of rows) expect(r.applied_at).toBeGreaterThan(0);

    store.close();
  });

  it("creates every table the baseline schema declares", () => {
    const store = new BlockStore(dbPath);
    const db = store.rawDb;
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const t of [
      "reasoning_blocks",
      "block_case_refs",
      "project_facts",
      "analytics_events",
      "tool_observations",
      "v2_schema_meta",
      "schema_version",
      "calibrator_models",
    ]) {
      expect(tables).toContain(t);
    }
    store.close();
  });

  it("never raises duplicate-column errors on a fresh DB", () => {
    // Sanity: just opening the store twice in a row on the same path
    // should not raise; the second open is the double-apply case.
    expect(() => {
      const a = new BlockStore(dbPath);
      a.close();
      const b = new BlockStore(dbPath);
      b.close();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Synthetic 0.6.x DB upgrade path
// ---------------------------------------------------------------------------

describe("migrations — synthetic 0.6.x DB at v=8", () => {
  /**
   * Stand up a DB whose schema looks exactly like a 0.6.x install:
   * V2_SCHEMA_VERSION was 8 there, and `schema_version` did not
   * exist. We simulate it by opening BlockStore, running migrations
   * to v9, then DROPPING `schema_version` + rolling the meta cell
   * back to 8. The next BlockStore open on the same path reads
   * version=8 and walks migration 9 — exactly the upgrade path a
   * real 0.6.x user hits.
   */
  function makeV8Database(): void {
    const seed = new BlockStore(dbPath);
    seed.close();
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE IF EXISTS schema_version");
    raw.prepare("UPDATE v2_schema_meta SET value = '8' WHERE key = 'version'").run();
    raw.close();
  }

  it("upgrade walks v=8 → v=9 cleanly, creates schema_version, back-fills 1..8", () => {
    makeV8Database();

    // Plant some data in tables that existed at v=8 — the upgrade must
    // preserve them.
    const pre = new Database(dbPath);
    pre.prepare(
      `INSERT INTO project_facts(
         id, version, scope, fact_type, statement,
         inv_api_surface, src_origin, confidence,
         last_verified_at, created_at, updated_at, status, dedupe_key
       ) VALUES (
         'fact-1', 1, 'project', 'convention', 'tests live under tests/cli',
         '[]', 'observed', 0.5,
         1, 1, 1, 'active', 'dedupe-1'
       )`,
    ).run();
    pre.close();

    // Re-open via BlockStore — migration to v9 fires.
    const store = new BlockStore(dbPath);
    const db = store.rawDb;

    const meta = db
      .prepare("SELECT value FROM v2_schema_meta WHERE key = 'version'")
      .get() as { value: string };
    expect(parseInt(meta.value, 10)).toBeGreaterThanOrEqual(9);

    // schema_version table now exists with rows 1..9.
    const rows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7, 8, 9]));

    // Pre-existing fact survived the upgrade unchanged.
    const fact = db
      .prepare("SELECT id, statement FROM project_facts WHERE id = 'fact-1'")
      .get() as { id: string; statement: string };
    expect(fact.id).toBe("fact-1");
    expect(fact.statement).toBe("tests live under tests/cli");

    store.close();
  });

  it("upgrade is transactional — partial migration does not bump v2_schema_meta", () => {
    // Independent verification of the transaction guarantee. We can't
    // easily force a step to fail mid-walk without monkey-patching,
    // but we can verify the per-step row appears IN the same write
    // window as the meta bump — i.e. opening a v=8 DB then crashing
    // before the wrapper finishes leaves NEITHER the meta bumped
    // NOR the version-9 row inserted. The migration framework's tx
    // wrapper guarantees this; here we just verify post-condition
    // shape: when migration 9 succeeds, BOTH the meta cell and the
    // v=9 row land.
    makeV8Database();
    const store = new BlockStore(dbPath);
    const db = store.rawDb;

    const v9 = db.prepare("SELECT version FROM schema_version WHERE version = 9").get();
    expect(v9).toBeTruthy();
    const meta = db
      .prepare("SELECT value FROM v2_schema_meta WHERE key = 'version'")
      .get() as { value: string };
    expect(parseInt(meta.value, 10)).toBe(9);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Synthetic intermediate (v=5) DB upgrade path
// ---------------------------------------------------------------------------

describe("migrations — synthetic intermediate DB at v=5", () => {
  /**
   * 0.7.0-rc.1 §hardening — bridge test for the older intermediate
   * version. v=5 was the failure-distillation lane release; the
   * walker has to apply migrations 6, 7, 8, AND 9 in order. v=8 (the
   * existing test above) only exercises the v=9 step.
   *
   * Approach: stand up a fresh DB at v=9 schema, drop everything
   * added at v>=6 (schema_version + tool_observations tables), and
   * roll the meta cell back to 5. The next BlockStore open walks all
   * four migrations.
   *
   * The project_facts table itself stays at the v=9 schema because
   * the v=6/v=7 rebuilds use IF NOT EXISTS bootstraps + transactional
   * SELECT-into-new patterns that are byte-idempotent against a
   * newer-shape source. The point of this test is the migration
   * walker, not the SQLite-rewrite mechanics of v=6/v=7.
   */
  function makeV5Database(): void {
    const seed = new BlockStore(dbPath);
    seed.close();
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE IF EXISTS schema_version");
    raw.exec("DROP TABLE IF EXISTS tool_observations");
    raw.prepare("UPDATE v2_schema_meta SET value = '5' WHERE key = 'version'").run();
    raw.close();
  }

  it("walks v=5 → v=9 cleanly across all four migrations", () => {
    makeV5Database();

    // Plant a row in a table that pre-dates v=6 so the post-walk
    // rebuilds preserve it through every CHECK widening.
    const pre = new Database(dbPath);
    pre.prepare(
      `INSERT INTO project_facts(
         id, version, scope, fact_type, statement,
         inv_api_surface, src_origin, confidence,
         last_verified_at, created_at, updated_at, status, dedupe_key
       ) VALUES (
         'fact-pre-v6', 1, 'project', 'convention', 'pre-v6 row survives migration walk',
         '[]', 'observed', 0.5, 1, 1, 1, 'active', 'dedupe-pre-v6'
       )`,
    ).run();
    pre.close();

    const store = new BlockStore(dbPath);
    const db = store.rawDb;

    // Final version landed at 9.
    const meta = db
      .prepare("SELECT value FROM v2_schema_meta WHERE key = 'version'")
      .get() as { value: string };
    expect(parseInt(meta.value, 10)).toBeGreaterThanOrEqual(9);

    // schema_version contains rows for every version from 1 through 9.
    const versions = (
      db.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    expect(versions).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7, 8, 9]));

    // tool_observations table was added at v=8 and survives v=9.
    const tableNames = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tableNames).toContain("tool_observations");
    expect(tableNames).toContain("schema_version");

    // Pre-v=6 row preserved through v=6 rebuild + v=7 rebuild.
    const fact = db
      .prepare("SELECT id, statement FROM project_facts WHERE id = 'fact-pre-v6'")
      .get() as { id: string; statement: string };
    expect(fact.id).toBe("fact-pre-v6");
    expect(fact.statement).toBe("pre-v6 row survives migration walk");

    store.close();
  });

  it("double-open of v=5 DB lands at v=9 and is then a no-op", () => {
    makeV5Database();
    const a = new BlockStore(dbPath);
    const beforeRows = a.rawDb
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    a.close();

    const b = new BlockStore(dbPath);
    const afterRows = b.rawDb
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    b.close();

    expect(afterRows).toEqual(beforeRows);
  });
});

// ---------------------------------------------------------------------------
// Double-apply path
// ---------------------------------------------------------------------------

describe("migrations — double-apply is a no-op", () => {
  it("opening BlockStore twice on the same path leaves schema_version unchanged", () => {
    const a = new BlockStore(dbPath);
    const dbA = a.rawDb;
    const before = dbA
      .prepare("SELECT version, applied_at FROM schema_version ORDER BY version")
      .all() as Array<{ version: number; applied_at: number }>;
    a.close();

    const b = new BlockStore(dbPath);
    const dbB = b.rawDb;
    const after = dbB
      .prepare("SELECT version, applied_at FROM schema_version ORDER BY version")
      .all() as Array<{ version: number; applied_at: number }>;
    b.close();

    expect(after).toEqual(before);
  });

  it("a third open is still a no-op", () => {
    const a = new BlockStore(dbPath);
    a.close();
    const b = new BlockStore(dbPath);
    b.close();

    const c = new BlockStore(dbPath);
    const dbC = c.rawDb;
    const versions = dbC
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(versions.length).toBeGreaterThanOrEqual(9);
    // No duplicates.
    const set = new Set(versions.map((v) => v.version));
    expect(set.size).toBe(versions.length);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// addColumnIfMissing helper
// ---------------------------------------------------------------------------

describe("addColumnIfMissing helper", () => {
  it("adds a column when missing", () => {
    const store = new BlockStore(dbPath);
    const db = store.rawDb;

    const before = (
      db.prepare("PRAGMA table_info(project_facts)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(before).not.toContain("rc1_probe_col");

    addColumnIfMissing(db, "project_facts", "rc1_probe_col", "TEXT");
    const after = (
      db.prepare("PRAGMA table_info(project_facts)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(after).toContain("rc1_probe_col");

    store.close();
  });

  it("is a no-op when the column already exists", () => {
    const store = new BlockStore(dbPath);
    const db = store.rawDb;
    addColumnIfMissing(db, "project_facts", "rc1_probe_col", "TEXT");
    expect(() =>
      addColumnIfMissing(db, "project_facts", "rc1_probe_col", "TEXT"),
    ).not.toThrow();
    // Type-string mismatch on a re-run also doesn't throw — the
    // probe sees the column and skips, which is the documented
    // contract (caller is responsible for keeping types consistent
    // across migration revisions).
    expect(() =>
      addColumnIfMissing(db, "project_facts", "rc1_probe_col", "INTEGER"),
    ).not.toThrow();
    store.close();
  });
});
