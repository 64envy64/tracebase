/**
 * BlockStore — v2 storage foundation (docs/DESIGN_v2.md §Phase 1).
 *
 * Holds four tables that make up v2's new substrate:
 *   • reasoning_blocks    (L2 procedural memory)
 *   • block_case_refs     (L3 evidence / linkage)
 *   • project_facts       (L4 semantic memory)
 *   • analytics_events    (L6 event sink)
 *
 * Additive only. Never touches the v1 `traces` table. Coexists with
 * `TraceStore` in the same SQLite file; both stores may be constructed
 * from the same path (separate connections) or share a Database handle
 * (useful for `:memory:` integration tests).
 *
 * Invariants enforced here, not at call sites:
 *   - A block can only become `active` when ≥ 1 BlockCaseRef with
 *     role = "origin" exists for it.
 *   - Block body is scanned by `detectLeakage` on every insert and on
 *     any update that touches body fields; leakage hard-rejects.
 *   - Case ref unique per (blockId, traceId, role).
 *   - Project fact dedupe key = sha256(scope + factType + norm(statement)).
 */
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type {
  ReasoningBlock,
  BlockCaseRef,
  BlockCaseRole,
  EvidenceQuality,
  BlockInvariants,
  ProjectFact,
  ProjectFactStatus,
  ProjectFactType,
  ProjectFactSource,
  StoreProjectFactInput,
  AnalyticsEvent,
} from "../types.js";
import { detectLeakage } from "./block.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const V2_SCHEMA_VERSION = 6;

const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS reasoning_blocks (
  id                  TEXT PRIMARY KEY,
  version             INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK(status IN ('candidate','active','demoted','merged','retired')),
  -- Discriminator between success-derived and failure-derived (pitfall)
  -- blocks. DEFAULT 'success' covers pre-failure-lane inserts when a row
  -- is materialized by unrelated paths that don't know about kind yet.
  kind                TEXT NOT NULL DEFAULT 'success' CHECK(kind IN ('success','pitfall')),

  -- Trigger
  trig_situation      TEXT NOT NULL,
  trig_fingerprint    TEXT NOT NULL,
  trig_keywords       TEXT NOT NULL DEFAULT '[]',
  trig_language       TEXT,
  trig_framework      TEXT,
  trig_error_type     TEXT,
  trig_api_surface    TEXT NOT NULL DEFAULT '[]',

  -- Body
  body_mechanism      TEXT NOT NULL,
  body_dead_ends      TEXT NOT NULL DEFAULT '[]',
  body_unlock         TEXT NOT NULL,
  body_verification   TEXT NOT NULL,
  -- Early-warning signals. JSON array of strings; at most 3 entries,
  -- each ≤ 20 words, leakage-scanned. Empty array on success blocks
  -- unless the distiller chose to populate them.
  body_guardrails     TEXT NOT NULL DEFAULT '[]',

  -- Provenance
  prov_source_task_id         TEXT NOT NULL,
  prov_source_agent           TEXT,
  prov_source_model           TEXT,
  prov_extracted_from         TEXT NOT NULL,
  prov_distilled_at           INTEGER NOT NULL,
  prov_distilled_by           TEXT NOT NULL,
  prov_distilled_with_model   TEXT,
  prov_parent_trace_id        TEXT,
  prov_distillation_confidence REAL,        -- Phase 4: distiller self-reported 0..1
  prov_validation_report      TEXT,         -- Phase 4: JSON ValidationReport at distill time

  -- Verification (Phase 4.5 writes; Phase 4 only leaves the hook)
  verification                TEXT,         -- JSON BlockVerification or NULL

  -- Stats
  stats_times_retrieved        INTEGER NOT NULL DEFAULT 0,
  stats_times_injected         INTEGER NOT NULL DEFAULT 0,
  stats_times_agent_used       INTEGER NOT NULL DEFAULT 0,
  stats_times_helpful          INTEGER NOT NULL DEFAULT 0,
  stats_times_counterproductive INTEGER NOT NULL DEFAULT 0,
  stats_last_used_at           INTEGER,
  stats_cum_tokens_saved       INTEGER NOT NULL DEFAULT 0,
  stats_cum_steps_saved        INTEGER NOT NULL DEFAULT 0,

  -- Quality (calibrated priors live here; raw counts in stats_*)
  qual_confidence          REAL NOT NULL DEFAULT 0.5,
  qual_wilson_lb           REAL NOT NULL DEFAULT 0,
  qual_calibration_cohort  TEXT,

  -- Embeddings (optional; Float32Array binary)
  embed_situation          BLOB,
  embed_unlock             BLOB,
  embed_model              TEXT
);

CREATE INDEX IF NOT EXISTS idx_blocks_fingerprint  ON reasoning_blocks(trig_fingerprint);
-- Dedupe is scoped by (fingerprint, kind) so a success block and a
-- pitfall block describing the same pattern can coexist. The composite
-- index accelerates the lookups in storeBlock and the distillation
-- pipeline.
CREATE INDEX IF NOT EXISTS idx_blocks_fp_kind      ON reasoning_blocks(trig_fingerprint, kind);
CREATE INDEX IF NOT EXISTS idx_blocks_status       ON reasoning_blocks(status);
CREATE INDEX IF NOT EXISTS idx_blocks_language     ON reasoning_blocks(trig_language);
CREATE INDEX IF NOT EXISTS idx_blocks_framework    ON reasoning_blocks(trig_framework);
CREATE INDEX IF NOT EXISTS idx_blocks_error_type   ON reasoning_blocks(trig_error_type);
CREATE INDEX IF NOT EXISTS idx_blocks_wilson       ON reasoning_blocks(qual_wilson_lb DESC);

-- FTS5 over trigger-only fields (never body — §L5 serving rule).
CREATE VIRTUAL TABLE IF NOT EXISTS reasoning_blocks_fts USING fts5(
  trig_situation,
  trig_keywords,
  content='reasoning_blocks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS blocks_fts_insert AFTER INSERT ON reasoning_blocks BEGIN
  INSERT INTO reasoning_blocks_fts(rowid, trig_situation, trig_keywords)
  VALUES (new.rowid, new.trig_situation, new.trig_keywords);
END;

CREATE TRIGGER IF NOT EXISTS blocks_fts_delete AFTER DELETE ON reasoning_blocks BEGIN
  INSERT INTO reasoning_blocks_fts(reasoning_blocks_fts, rowid, trig_situation, trig_keywords)
  VALUES ('delete', old.rowid, old.trig_situation, old.trig_keywords);
END;

CREATE TRIGGER IF NOT EXISTS blocks_fts_update
  AFTER UPDATE OF trig_situation, trig_keywords ON reasoning_blocks
BEGIN
  INSERT INTO reasoning_blocks_fts(reasoning_blocks_fts, rowid, trig_situation, trig_keywords)
  VALUES ('delete', old.rowid, old.trig_situation, old.trig_keywords);
  INSERT INTO reasoning_blocks_fts(rowid, trig_situation, trig_keywords)
  VALUES (new.rowid, new.trig_situation, new.trig_keywords);
END;

-- Case refs (L3). CASCADE on block delete so ref rows never outlive blocks.
-- trace_id is NOT a FK (traces live in v1 store; we check orphan status
-- via the repair loop, not via DB constraint).
CREATE TABLE IF NOT EXISTS block_case_refs (
  id                TEXT PRIMARY KEY,
  block_id          TEXT NOT NULL,
  trace_id          TEXT NOT NULL,
  role              TEXT NOT NULL CHECK(role IN ('origin','supporting','counter','orphan')),
  evidence_quality  TEXT NOT NULL CHECK(evidence_quality IN ('strong','moderate','weak')),
  locator           TEXT,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (block_id) REFERENCES reasoning_blocks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refs_block ON block_case_refs(block_id);
CREATE INDEX IF NOT EXISTS idx_refs_trace ON block_case_refs(trace_id);
CREATE INDEX IF NOT EXISTS idx_refs_role  ON block_case_refs(role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_unique ON block_case_refs(block_id, trace_id, role);

-- Project facts (L4)
CREATE TABLE IF NOT EXISTS project_facts (
  id                TEXT PRIMARY KEY,
  version           INTEGER NOT NULL,
  scope             TEXT NOT NULL,
  fact_type         TEXT NOT NULL CHECK(fact_type IN ('convention','schema','repo_fact','architecture','preference','file_semantic')),
  statement         TEXT NOT NULL,

  inv_language      TEXT,
  inv_framework     TEXT,
  inv_error_type    TEXT,
  inv_api_surface   TEXT NOT NULL DEFAULT '[]',

  src_origin        TEXT NOT NULL CHECK(src_origin IN ('observed','declared','imported')),
  src_trace_id      TEXT,
  src_author        TEXT,
  src_reference     TEXT,

  confidence        REAL NOT NULL DEFAULT 0.5,
  last_verified_at  INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('active','stale','retired')),

  dedupe_key        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_scope     ON project_facts(scope);
CREATE INDEX IF NOT EXISTS idx_facts_type      ON project_facts(fact_type);
CREATE INDEX IF NOT EXISTS idx_facts_language  ON project_facts(inv_language);
CREATE INDEX IF NOT EXISTS idx_facts_status    ON project_facts(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_dedupe ON project_facts(dedupe_key);

CREATE VIRTUAL TABLE IF NOT EXISTS project_facts_fts USING fts5(
  statement,
  content='project_facts',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS facts_fts_insert AFTER INSERT ON project_facts BEGIN
  INSERT INTO project_facts_fts(rowid, statement) VALUES (new.rowid, new.statement);
END;

CREATE TRIGGER IF NOT EXISTS facts_fts_delete AFTER DELETE ON project_facts BEGIN
  INSERT INTO project_facts_fts(project_facts_fts, rowid, statement)
  VALUES ('delete', old.rowid, old.statement);
END;

CREATE TRIGGER IF NOT EXISTS facts_fts_update
  AFTER UPDATE OF statement ON project_facts
BEGIN
  INSERT INTO project_facts_fts(project_facts_fts, rowid, statement)
  VALUES ('delete', old.rowid, old.statement);
  INSERT INTO project_facts_fts(rowid, statement) VALUES (new.rowid, new.statement);
END;

-- Analytics events (L6). Append-only. Supports block-level events
-- (retrieval / injection / agent_used / outcome) and parallel fact-
-- level events (fact_injection / fact_agent_used) for §L4 semantic
-- memory attribution. event_type is intentionally un-CHECKed so the
-- schema can evolve without table rebuilds as new event types land.
CREATE TABLE IF NOT EXISTS analytics_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  event_type  TEXT NOT NULL,
  query_id    TEXT NOT NULL,
  block_id    TEXT,
  fact_id     TEXT,
  run_id      TEXT,
  shadow      INTEGER,                -- nullable boolean, only meaningful for retrieval/outcome
  payload     TEXT NOT NULL           -- full event as JSON (forward-compat)
);

CREATE INDEX IF NOT EXISTS idx_events_ts     ON analytics_events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type   ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_query  ON analytics_events(query_id);
CREATE INDEX IF NOT EXISTS idx_events_block  ON analytics_events(block_id);
CREATE INDEX IF NOT EXISTS idx_events_fact   ON analytics_events(fact_id);
CREATE INDEX IF NOT EXISTS idx_events_run    ON analytics_events(run_id);

CREATE TABLE IF NOT EXISTS v2_schema_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Calibrator models (Phase 5.2). Named JSON blobs so multiple named
-- calibrators can coexist (e.g. per-cohort, per-deployment). Phase 5
-- ships a single canonical name; future calibrators reuse the table.
CREATE TABLE IF NOT EXISTS calibrator_models (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fitted_at  INTEGER NOT NULL
);
`;

/**
 * Incremental migrations for existing v2 databases. Fresh installs run
 * the full V2_SCHEMA above; existing databases walk this map step-by-step
 * from their current version to V2_SCHEMA_VERSION.
 */
const V2_MIGRATIONS: Record<number, string[]> = {
  // v1 → v2: add `fact_id` column + index and relax event_type CHECK
  // so fact_injection / fact_agent_used can be written. SQLite cannot
  // alter CHECK in place, so this rebuilds the table.
  2: [
    `CREATE TABLE analytics_events_v2 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      event_type  TEXT NOT NULL,
      query_id    TEXT NOT NULL,
      block_id    TEXT,
      fact_id     TEXT,
      run_id      TEXT,
      shadow      INTEGER,
      payload     TEXT NOT NULL
    )`,
    `INSERT INTO analytics_events_v2 (id, ts, event_type, query_id, block_id, run_id, shadow, payload)
       SELECT id, ts, event_type, query_id, block_id, run_id, shadow, payload FROM analytics_events`,
    `DROP TABLE analytics_events`,
    `ALTER TABLE analytics_events_v2 RENAME TO analytics_events`,
    `CREATE INDEX IF NOT EXISTS idx_events_ts    ON analytics_events(ts)`,
    `CREATE INDEX IF NOT EXISTS idx_events_type  ON analytics_events(event_type)`,
    `CREATE INDEX IF NOT EXISTS idx_events_query ON analytics_events(query_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_block ON analytics_events(block_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_fact  ON analytics_events(fact_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_run   ON analytics_events(run_id)`,
  ],
  // v2 → v3: add distillation-confidence / validation-report / verification
  // hooks to reasoning_blocks. ALTER TABLE ADD COLUMN is safe (SQLite
  // sets NULL for existing rows, which is the "unknown / Phase 3" semantic).
  3: [
    `ALTER TABLE reasoning_blocks ADD COLUMN prov_distillation_confidence REAL`,
    `ALTER TABLE reasoning_blocks ADD COLUMN prov_validation_report TEXT`,
    `ALTER TABLE reasoning_blocks ADD COLUMN verification TEXT`,
  ],
  // v3 → v4: add calibrator_models table for persisted isotonic (etc.)
  // models. Additive; existing rows untouched.
  4: [
    `CREATE TABLE IF NOT EXISTS calibrator_models (
      name       TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      fitted_at  INTEGER NOT NULL
    )`,
  ],
  // v4 → v5: failure-distillation lane. Adds `kind` (success/pitfall)
  // plus `body_guardrails` JSON array. Both columns are additive with
  // DEFAULTs so existing rows are rehydrated as success blocks with no
  // guardrails — byte-identical to the pre-failure-lane behaviour.
  // Composite (fingerprint, kind) index is created so the distillation
  // pipeline can look up dedupe candidates scoped by kind without a
  // table scan.
  5: [
    `ALTER TABLE reasoning_blocks ADD COLUMN kind TEXT NOT NULL DEFAULT 'success'`,
    `ALTER TABLE reasoning_blocks ADD COLUMN body_guardrails TEXT NOT NULL DEFAULT '[]'`,
    `CREATE INDEX IF NOT EXISTS idx_blocks_fp_kind ON reasoning_blocks(trig_fingerprint, kind)`,
  ],
  // v5 → v6: widen project_facts.fact_type CHECK to include
  // 'file_semantic' (0.5.0 TB MEMORY bucket). SQLite cannot ALTER a
  // CHECK constraint in place, so this rebuilds the table + its
  // indexes + the FTS virtual mirror.
  //
  // Idempotent for legacy DBs that never had project_facts: the first
  // step creates the old-CHECK table with IF NOT EXISTS, so the rebuild
  // has a source to SELECT from even on pre-L4 databases that went
  // v1 → v2 without ever landing project_facts. For current DBs, the
  // IF NOT EXISTS is a no-op and the rebuild does the real work.
  6: [
    // Bootstrap (no-op when the table already exists in its v5 shape).
    // Full column set + old CHECK matches the baseline V2_SCHEMA circa
    // v5 so a real v5 DB's rows transfer cleanly to the v6 layout.
    `CREATE TABLE IF NOT EXISTS project_facts (
      id                TEXT PRIMARY KEY,
      version           INTEGER NOT NULL,
      scope             TEXT NOT NULL,
      fact_type         TEXT NOT NULL CHECK(fact_type IN ('convention','schema','repo_fact','architecture','preference')),
      statement         TEXT NOT NULL,
      inv_language      TEXT,
      inv_framework     TEXT,
      inv_error_type    TEXT,
      inv_api_surface   TEXT NOT NULL DEFAULT '[]',
      src_origin        TEXT NOT NULL CHECK(src_origin IN ('observed','declared','imported')),
      src_trace_id      TEXT,
      src_author        TEXT,
      src_reference     TEXT,
      confidence        REAL NOT NULL DEFAULT 0.5,
      last_verified_at  INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      status            TEXT NOT NULL CHECK(status IN ('active','stale','retired')),
      dedupe_key        TEXT NOT NULL
    )`,
    // Rebuild with the widened CHECK.
    `CREATE TABLE project_facts_v6 (
      id                TEXT PRIMARY KEY,
      version           INTEGER NOT NULL,
      scope             TEXT NOT NULL,
      fact_type         TEXT NOT NULL CHECK(fact_type IN ('convention','schema','repo_fact','architecture','preference','file_semantic')),
      statement         TEXT NOT NULL,
      inv_language      TEXT,
      inv_framework     TEXT,
      inv_error_type    TEXT,
      inv_api_surface   TEXT NOT NULL DEFAULT '[]',
      src_origin        TEXT NOT NULL CHECK(src_origin IN ('observed','declared','imported')),
      src_trace_id      TEXT,
      src_author        TEXT,
      src_reference     TEXT,
      confidence        REAL NOT NULL DEFAULT 0.5,
      last_verified_at  INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      status            TEXT NOT NULL CHECK(status IN ('active','stale','retired')),
      dedupe_key        TEXT NOT NULL
    )`,
    `INSERT INTO project_facts_v6
       SELECT id, version, scope, fact_type, statement,
              inv_language, inv_framework, inv_error_type, inv_api_surface,
              src_origin, src_trace_id, src_author, src_reference,
              confidence, last_verified_at, created_at, updated_at, status,
              dedupe_key
         FROM project_facts`,
    // FTS virtual + its triggers are tied to the base table by name;
    // drop them in the right order so the rename doesn't orphan them.
    `DROP TABLE IF EXISTS project_facts_fts`,
    `DROP TABLE project_facts`,
    `ALTER TABLE project_facts_v6 RENAME TO project_facts`,
    `CREATE INDEX IF NOT EXISTS idx_facts_scope     ON project_facts(scope)`,
    `CREATE INDEX IF NOT EXISTS idx_facts_type      ON project_facts(fact_type)`,
    `CREATE INDEX IF NOT EXISTS idx_facts_language  ON project_facts(inv_language)`,
    `CREATE INDEX IF NOT EXISTS idx_facts_status    ON project_facts(status)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_dedupe ON project_facts(dedupe_key)`,
    // Recreate FTS + triggers so storeFact/searchFacts stay indexed.
    // Trigger names must match the baseline V2_SCHEMA so the base
    // CREATE TRIGGER IF NOT EXISTS statements the fresh-init path
    // runs don't end up creating parallel duplicates on top of ours.
    `CREATE VIRTUAL TABLE IF NOT EXISTS project_facts_fts USING fts5(
       statement,
       content='project_facts',
       content_rowid='rowid',
       tokenize='porter unicode61'
     )`,
    `CREATE TRIGGER IF NOT EXISTS facts_fts_insert AFTER INSERT ON project_facts BEGIN
       INSERT INTO project_facts_fts(rowid, statement) VALUES (new.rowid, new.statement);
     END`,
    `CREATE TRIGGER IF NOT EXISTS facts_fts_delete AFTER DELETE ON project_facts BEGIN
       INSERT INTO project_facts_fts(project_facts_fts, rowid, statement) VALUES('delete', old.rowid, old.statement);
     END`,
    `CREATE TRIGGER IF NOT EXISTS facts_fts_update AFTER UPDATE OF statement ON project_facts BEGIN
       INSERT INTO project_facts_fts(project_facts_fts, rowid, statement) VALUES('delete', old.rowid, old.statement);
       INSERT INTO project_facts_fts(rowid, statement) VALUES (new.rowid, new.statement);
     END`,
    // Rebuild FTS content from the now-renamed table so existing rows
    // are searchable after migration.
    `INSERT INTO project_facts_fts(project_facts_fts) VALUES('rebuild')`,
  ],
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LeakageError extends Error {
  constructor(public readonly pattern: string) {
    super(`block content leaks gold-truth material: ${pattern}`);
    this.name = "LeakageError";
  }
}

export class BlockIntegrityError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BlockIntegrityError";
  }
}

// ---------------------------------------------------------------------------
// BlockStore
// ---------------------------------------------------------------------------

export interface BlockStoreOptions {
  /** Override `Date.now()` — used by tests for deterministic timestamps. */
  now?: () => number;
  /** If true, do not run migrations (caller handles them). Default false. */
  skipMigrate?: boolean;
}

export interface ListBlocksOptions {
  status?: ReasoningBlock["status"] | ReasoningBlock["status"][];
  limit?: number;
  offset?: number;
  /** Order by a column. Default: created_at DESC. */
  orderBy?: "created_at" | "updated_at" | "wilson_lb" | "confidence";
}

export interface FactSearchQuery {
  scope?: string;
  factType?: ProjectFactType | ProjectFactType[];
  invariants?: BlockInvariants;
  status?: ProjectFactStatus | ProjectFactStatus[];
  /** Free-text against statement (FTS5). */
  text?: string;
  limit?: number;
}

export interface EventReadOptions {
  afterTs?: number;
  beforeTs?: number;
  eventType?: AnalyticsEvent["event"] | AnalyticsEvent["event"][];
  queryId?: string;
  blockId?: string;
  /** Filter to events referencing a specific ProjectFact (L4). */
  factId?: string;
  runId?: string;
  limit?: number;
}

export class BlockStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: Database.Database | string, opts: BlockStoreOptions = {}) {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
      this.configure();
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.now = opts.now ?? Date.now;
    if (!opts.skipMigrate) this.migrate();
  }

  private configure(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  private migrate(): void {
    // Ensure foreign_keys is on for this connection (separate connections have their own).
    this.db.pragma("foreign_keys = ON");
    const current = this.getSchemaVersion();
    if (current >= V2_SCHEMA_VERSION) return;

    if (current === 0) {
      // Fresh DB — run full current schema.
      this.db.exec(V2_SCHEMA);
      this.setSchemaVersion(V2_SCHEMA_VERSION);
      return;
    }

    // Existing DB at an older v2 version — walk incremental migrations.
    for (let v = current + 1; v <= V2_SCHEMA_VERSION; v++) {
      const steps = V2_MIGRATIONS[v];
      if (!steps) continue;
      const tx = this.db.transaction(() => {
        for (const sql of steps) {
          this.db.exec(sql);
        }
        this.setSchemaVersion(v);
      });
      tx();
    }
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM v2_schema_meta WHERE key = 'version'")
        .get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  }

  private setSchemaVersion(v: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO v2_schema_meta(key, value) VALUES ('version', ?)")
      .run(String(v));
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  get rawDb(): Database.Database {
    return this.db;
  }

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  /**
   * Insert a block. Runs leakage guards. Rejects on fingerprint collision
   * — callers must resolve duplicates via `findBlockByFingerprint` +
   * `mergeBlockStats` before re-inserting.
   *
   * Enforces: a freshly-stored block defaults to `candidate` unless the
   * caller supplied a status AND the caller is going through
   * `updateBlockStatus` (which enforces the origin-ref rule). If the
   * caller inserts with status="active" but no origin ref exists, this
   * is an integrity violation and we throw.
   */
  storeBlock(block: ReasoningBlock): void {
    const leak = detectLeakage(block);
    if (leak) throw new LeakageError(leak);

    // Active requires: (1) an origin ref exists, (2) no counter refs.
    // Canonical flow is: insert candidate → attach origin → promote.
    if (block.status === "active") {
      if (!this.hasOriginRef(block.id)) {
        throw new BlockIntegrityError(
          `cannot insert block ${block.id} as active: no origin ref exists`,
        );
      }
      if (this.hasCounterRef(block.id)) {
        throw new BlockIntegrityError(
          `cannot insert block ${block.id} as active: unresolved counter evidence`,
        );
      }
    }

    // Dedupe is scoped by (fingerprint, kind): a success block and a
    // pitfall block with the same trigger fingerprint describe opposite
    // sides of the same pattern and are allowed to coexist. Collision
    // within the same kind remains a hard integrity error — the caller
    // must resolve it via mergeBlocks or attach a supporting ref instead.
    const existingByFp = this.findBlockByFingerprintAndKind(
      block.trigger.fingerprint,
      block.kind,
    );
    if (existingByFp && existingByFp.id !== block.id) {
      throw new BlockIntegrityError(
        `duplicate trigger fingerprint ${block.trigger.fingerprint} (kind=${block.kind}, existing id=${existingByFp.id})`,
      );
    }

    const stmt = this.db.prepare(`
      INSERT INTO reasoning_blocks (
        id, version, created_at, updated_at, status, kind,
        trig_situation, trig_fingerprint, trig_keywords,
        trig_language, trig_framework, trig_error_type, trig_api_surface,
        body_mechanism, body_dead_ends, body_unlock, body_verification,
        body_guardrails,
        prov_source_task_id, prov_source_agent, prov_source_model,
        prov_extracted_from, prov_distilled_at, prov_distilled_by,
        prov_distilled_with_model, prov_parent_trace_id,
        prov_distillation_confidence, prov_validation_report,
        verification,
        stats_times_retrieved, stats_times_injected, stats_times_agent_used,
        stats_times_helpful, stats_times_counterproductive,
        stats_last_used_at, stats_cum_tokens_saved, stats_cum_steps_saved,
        qual_confidence, qual_wilson_lb, qual_calibration_cohort,
        embed_situation, embed_unlock, embed_model
      ) VALUES (
        @id, @version, @created_at, @updated_at, @status, @kind,
        @trig_situation, @trig_fingerprint, @trig_keywords,
        @trig_language, @trig_framework, @trig_error_type, @trig_api_surface,
        @body_mechanism, @body_dead_ends, @body_unlock, @body_verification,
        @body_guardrails,
        @prov_source_task_id, @prov_source_agent, @prov_source_model,
        @prov_extracted_from, @prov_distilled_at, @prov_distilled_by,
        @prov_distilled_with_model, @prov_parent_trace_id,
        @prov_distillation_confidence, @prov_validation_report,
        @verification,
        @stats_times_retrieved, @stats_times_injected, @stats_times_agent_used,
        @stats_times_helpful, @stats_times_counterproductive,
        @stats_last_used_at, @stats_cum_tokens_saved, @stats_cum_steps_saved,
        @qual_confidence, @qual_wilson_lb, @qual_calibration_cohort,
        @embed_situation, @embed_unlock, @embed_model
      )
    `);
    stmt.run(this.blockToRow(block));
  }

  getBlock(id: string): ReasoningBlock | null {
    const row = this.db
      .prepare("SELECT * FROM reasoning_blocks WHERE id = ?")
      .get(id) as BlockRow | undefined;
    return row ? this.rowToBlock(row) : null;
  }

  findBlockByFingerprint(fingerprint: string): ReasoningBlock | null {
    const row = this.db
      .prepare("SELECT * FROM reasoning_blocks WHERE trig_fingerprint = ? LIMIT 1")
      .get(fingerprint) as BlockRow | undefined;
    return row ? this.rowToBlock(row) : null;
  }

  /**
   * Kind-scoped lookup used by the distillation pipeline for dedupe:
   * a failure-derived pitfall block and a success-derived block with
   * the same trigger fingerprint are complementary, not duplicates, and
   * must be resolved independently. Callers that don't care about kind
   * can still use {@link findBlockByFingerprint}.
   */
  findBlockByFingerprintAndKind(
    fingerprint: string,
    kind: ReasoningBlock["kind"],
  ): ReasoningBlock | null {
    const row = this.db
      .prepare(
        "SELECT * FROM reasoning_blocks WHERE trig_fingerprint = ? AND kind = ? LIMIT 1",
      )
      .get(fingerprint, kind) as BlockRow | undefined;
    return row ? this.rowToBlock(row) : null;
  }

  listBlocks(opts: ListBlocksOptions = {}): ReasoningBlock[] {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const statuses = opts.status
      ? Array.isArray(opts.status) ? opts.status : [opts.status]
      : null;

    const orderCol =
      opts.orderBy === "updated_at" ? "updated_at"
      : opts.orderBy === "wilson_lb" ? "qual_wilson_lb"
      : opts.orderBy === "confidence" ? "qual_confidence"
      : "created_at";

    let sql = `SELECT * FROM reasoning_blocks`;
    const params: unknown[] = [];
    if (statuses && statuses.length > 0) {
      sql += ` WHERE status IN (${statuses.map(() => "?").join(",")})`;
      params.push(...statuses);
    }
    sql += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as BlockRow[];
    return rows.map((r) => this.rowToBlock(r));
  }

  /**
   * Transition a block's status. Enforces:
   *   - `active` requires ≥ 1 origin case ref.
   *   - `merged` / `retired` are terminal: not transitioning out of them
   *     here (the repair loop handles re-promotion via full reinsert).
   * Returns the updated block, or null if id not found.
   */
  updateBlockStatus(
    id: string,
    status: ReasoningBlock["status"],
  ): ReasoningBlock | null {
    const existing = this.getBlock(id);
    if (!existing) return null;

    if (status === "active") {
      if (!this.hasOriginRef(id)) {
        throw new BlockIntegrityError(
          `cannot promote block ${id} to active: no origin case ref`,
        );
      }
      if (this.hasCounterRef(id)) {
        throw new BlockIntegrityError(
          `cannot promote block ${id} to active: unresolved counter evidence`,
        );
      }
    }

    const now = this.now();
    this.db
      .prepare(
        "UPDATE reasoning_blocks SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, id);
    return { ...existing, status, updatedAt: now };
  }

  /**
   * Write the full block back. Runs leakage guards. Used by the
   * analytics pipeline when bumping stats or refreshing Wilson. Not a
   * general "patch any field" — callers should rebuild the block with
   * `bumpStat` / `refreshWilson` helpers and then pass the result here.
   */
  replaceBlock(block: ReasoningBlock): void {
    const leak = detectLeakage(block);
    if (leak) throw new LeakageError(leak);

    // Active requires: origin ref present, no counter refs.
    if (block.status === "active") {
      if (!this.hasOriginRef(block.id)) {
        throw new BlockIntegrityError(
          `cannot replace block ${block.id} with active status: no origin ref`,
        );
      }
      if (this.hasCounterRef(block.id)) {
        throw new BlockIntegrityError(
          `cannot replace block ${block.id} with active status: unresolved counter evidence`,
        );
      }
    }

    const stmt = this.db.prepare(`
      UPDATE reasoning_blocks SET
        version = @version,
        updated_at = @updated_at,
        status = @status,
        kind = @kind,
        trig_situation = @trig_situation,
        trig_fingerprint = @trig_fingerprint,
        trig_keywords = @trig_keywords,
        trig_language = @trig_language,
        trig_framework = @trig_framework,
        trig_error_type = @trig_error_type,
        trig_api_surface = @trig_api_surface,
        body_mechanism = @body_mechanism,
        body_dead_ends = @body_dead_ends,
        body_unlock = @body_unlock,
        body_verification = @body_verification,
        body_guardrails = @body_guardrails,
        prov_source_task_id = @prov_source_task_id,
        prov_source_agent = @prov_source_agent,
        prov_source_model = @prov_source_model,
        prov_extracted_from = @prov_extracted_from,
        prov_distilled_at = @prov_distilled_at,
        prov_distilled_by = @prov_distilled_by,
        prov_distilled_with_model = @prov_distilled_with_model,
        prov_parent_trace_id = @prov_parent_trace_id,
        prov_distillation_confidence = @prov_distillation_confidence,
        prov_validation_report = @prov_validation_report,
        verification = @verification,
        stats_times_retrieved = @stats_times_retrieved,
        stats_times_injected = @stats_times_injected,
        stats_times_agent_used = @stats_times_agent_used,
        stats_times_helpful = @stats_times_helpful,
        stats_times_counterproductive = @stats_times_counterproductive,
        stats_last_used_at = @stats_last_used_at,
        stats_cum_tokens_saved = @stats_cum_tokens_saved,
        stats_cum_steps_saved = @stats_cum_steps_saved,
        qual_confidence = @qual_confidence,
        qual_wilson_lb = @qual_wilson_lb,
        qual_calibration_cohort = @qual_calibration_cohort,
        embed_situation = @embed_situation,
        embed_unlock = @embed_unlock,
        embed_model = @embed_model
      WHERE id = @id
    `);
    const row = this.blockToRow(block);
    row.updated_at = this.now();
    stmt.run(row);
  }

  /**
   * Merge two blocks with the same trigger fingerprint: the loser's
   * stats are summed into the winner; the loser's status is set to
   * `merged`. Case refs from the loser are re-pointed to the winner
   * (unique constraint may drop exact duplicates).
   */
  mergeBlocks(
    winnerId: string,
    loserId: string,
  ): { winner: ReasoningBlock; loser: ReasoningBlock } {
    if (winnerId === loserId) {
      throw new BlockIntegrityError("cannot merge a block into itself");
    }
    const winner = this.getBlock(winnerId);
    const loser = this.getBlock(loserId);
    if (!winner) throw new BlockIntegrityError(`winner ${winnerId} not found`);
    if (!loser) throw new BlockIntegrityError(`loser ${loserId} not found`);
    if (winner.trigger.fingerprint !== loser.trigger.fingerprint) {
      throw new BlockIntegrityError(
        "cannot merge blocks with different trigger fingerprints",
      );
    }
    if (winner.kind !== loser.kind) {
      // A success block and a pitfall block describing the same pattern
      // are complementary, not duplicate — merging them would lose the
      // anti-pattern half of the signal. Refuse explicitly.
      throw new BlockIntegrityError(
        `cannot merge blocks of different kinds (winner=${winner.kind}, loser=${loser.kind})`,
      );
    }

    const now = this.now();
    const tx = this.db.transaction(() => {
      // Sum stats into winner.
      const mergedStats = {
        timesRetrieved: winner.stats.timesRetrieved + loser.stats.timesRetrieved,
        timesInjected: winner.stats.timesInjected + loser.stats.timesInjected,
        timesAgentUsed: winner.stats.timesAgentUsed + loser.stats.timesAgentUsed,
        timesHelpful: winner.stats.timesHelpful + loser.stats.timesHelpful,
        timesCounterproductive:
          winner.stats.timesCounterproductive + loser.stats.timesCounterproductive,
        lastUsedAt: maxOptional(winner.stats.lastUsedAt, loser.stats.lastUsedAt),
        cumulativeTokensSaved:
          winner.stats.cumulativeTokensSaved + loser.stats.cumulativeTokensSaved,
        cumulativeStepsSaved:
          winner.stats.cumulativeStepsSaved + loser.stats.cumulativeStepsSaved,
      };
      const mergedWinner: ReasoningBlock = {
        ...winner,
        stats: mergedStats,
        updatedAt: now,
      };
      this.replaceBlock(mergedWinner);

      // Re-point loser's refs to winner. The unique (block_id, trace_id,
      // role) index may raise on duplicates — handled with INSERT OR
      // IGNORE equivalent: we update where possible, delete the rest.
      const updateRefs = this.db.prepare(
        "UPDATE OR IGNORE block_case_refs SET block_id = ? WHERE block_id = ?",
      );
      updateRefs.run(winnerId, loserId);
      // Remaining refs (failed OR IGNORE due to dup) are redundant — delete.
      this.db
        .prepare("DELETE FROM block_case_refs WHERE block_id = ?")
        .run(loserId);

      this.db
        .prepare(
          "UPDATE reasoning_blocks SET status = 'merged', updated_at = ? WHERE id = ?",
        )
        .run(now, loserId);
    });
    tx();

    return {
      winner: this.getBlock(winnerId)!,
      loser: this.getBlock(loserId)!,
    };
  }

  deleteBlock(id: string): boolean {
    const res = this.db
      .prepare("DELETE FROM reasoning_blocks WHERE id = ?")
      .run(id);
    return res.changes > 0;
  }

  countBlocks(status?: ReasoningBlock["status"]): number {
    if (status) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS c FROM reasoning_blocks WHERE status = ?")
        .get(status) as { c: number };
      return row.c;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM reasoning_blocks")
      .get() as { c: number };
    return row.c;
  }

  // -------------------------------------------------------------------------
  // Case refs
  // -------------------------------------------------------------------------

  hasOriginRef(blockId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM block_case_refs WHERE block_id = ? AND role = 'origin' LIMIT 1",
      )
      .get(blockId);
    return !!row;
  }

  /**
   * Does this block carry any unresolved counter evidence? Per design
   * doc §L3: "A block with any role='counter' ref cannot be active
   * until the conflict is resolved (typically by split or demote)."
   */
  hasCounterRef(blockId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM block_case_refs WHERE block_id = ? AND role = 'counter' LIMIT 1",
      )
      .get(blockId);
    return !!row;
  }

  attachCaseRef(
    input: Omit<BlockCaseRef, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): BlockCaseRef {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? this.now();
    // Ensure block exists.
    const block = this.getBlock(input.blockId);
    if (!block) {
      throw new BlockIntegrityError(`block ${input.blockId} does not exist`);
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO block_case_refs (id, block_id, trace_id, role, evidence_quality, locator, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.blockId,
          input.traceId,
          input.role,
          input.evidenceQuality,
          input.locator ?? null,
          createdAt,
        );

      // Counter evidence on an active block auto-demotes it. This matches
      // the design: conflicting evidence is a strict bar to `active`.
      // We choose `demoted` (not `candidate`) because the block WAS proven
      // out before the conflict appeared; repair loop decides split vs.
      // permanent demote.
      if (input.role === "counter" && block.status === "active") {
        this.db
          .prepare(
            "UPDATE reasoning_blocks SET status = 'demoted', updated_at = ? WHERE id = ?",
          )
          .run(this.now(), input.blockId);
      }
    });
    tx();

    return {
      id,
      blockId: input.blockId,
      traceId: input.traceId,
      role: input.role,
      evidenceQuality: input.evidenceQuality,
      locator: input.locator,
      createdAt,
    };
  }

  listCaseRefs(blockId: string, role?: BlockCaseRole): BlockCaseRef[] {
    const rows = role
      ? (this.db
          .prepare(
            "SELECT * FROM block_case_refs WHERE block_id = ? AND role = ? ORDER BY created_at ASC",
          )
          .all(blockId, role) as CaseRefRow[])
      : (this.db
          .prepare(
            "SELECT * FROM block_case_refs WHERE block_id = ? ORDER BY created_at ASC",
          )
          .all(blockId) as CaseRefRow[]);
    return rows.map((r) => this.rowToCaseRef(r));
  }

  detachCaseRef(id: string): boolean {
    const ref = this.db
      .prepare("SELECT * FROM block_case_refs WHERE id = ?")
      .get(id) as CaseRefRow | undefined;
    if (!ref) return false;
    // If removing the last origin ref from an active block, quarantine it
    // (block is not self-verifiable anymore). We demote to `candidate`;
    // repair loop can re-promote when a new origin ref is attached.
    const res = this.db
      .prepare("DELETE FROM block_case_refs WHERE id = ?")
      .run(id);
    if (res.changes === 0) return false;

    if (ref.role === "origin") {
      const stillHas = this.hasOriginRef(ref.block_id);
      if (!stillHas) {
        const now = this.now();
        this.db
          .prepare(
            "UPDATE reasoning_blocks SET status = 'candidate', updated_at = ? WHERE id = ? AND status = 'active'",
          )
          .run(now, ref.block_id);
      }
    }
    return true;
  }

  /**
   * Sweep: mark case refs as `orphan` when their trace_id is not in
   * the provided set (caller supplies known trace ids from v1 store).
   * Returns the number of refs orphaned.
   */
  orphanMissingRefs(knownTraceIds: Set<string>): number {
    const allRefs = this.db
      .prepare(
        "SELECT id, block_id, trace_id, role FROM block_case_refs WHERE role != 'orphan'",
      )
      .all() as Array<{ id: string; block_id: string; trace_id: string; role: string }>;
    let n = 0;
    const now = this.now();
    const update = this.db.prepare(
      "UPDATE block_case_refs SET role = 'orphan' WHERE id = ?",
    );
    const demote = this.db.prepare(
      "UPDATE reasoning_blocks SET status = 'candidate', updated_at = ? WHERE id = ? AND status = 'active'",
    );
    for (const r of allRefs) {
      if (!knownTraceIds.has(r.trace_id)) {
        update.run(r.id);
        n++;
        if (r.role === "origin" && !this.hasOriginRef(r.block_id)) {
          demote.run(now, r.block_id);
        }
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Project facts
  // -------------------------------------------------------------------------

  /** Key used for dedupe. Deterministic over (scope, factType, normalized statement). */
  static factDedupeKey(scope: string, factType: ProjectFactType, statement: string): string {
    const norm = statement.trim().toLowerCase().replace(/\s+/g, " ");
    return createHash("sha256")
      .update(`${scope}|${factType}|${norm}`)
      .digest("hex");
  }

  storeFact(input: StoreProjectFactInput): ProjectFact {
    // Facts must not carry diffs / pytest IDs either.
    const bodyLike = {
      trigger: { situation: "" },
      body: {
        mechanism: input.statement,
        deadEnds: [],
        unlock: input.statement,
        verification: "",
      },
    };
    const leak = detectLeakage(bodyLike as unknown as Parameters<typeof detectLeakage>[0]);
    if (leak) throw new LeakageError(leak);

    const now = this.now();
    const id = randomUUID();
    const dedupeKey = BlockStore.factDedupeKey(input.scope, input.factType, input.statement);

    // Dedupe: if a fact with same key exists, merge sources (authors/references)
    // instead of inserting. Keep the older createdAt; bump lastVerifiedAt.
    const existing = this.db
      .prepare("SELECT * FROM project_facts WHERE dedupe_key = ?")
      .get(dedupeKey) as FactRow | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE project_facts SET
             last_verified_at = ?,
             confidence = MIN(1.0, confidence + 0.05),
             updated_at = ?,
             status = CASE WHEN status = 'retired' THEN 'retired' ELSE 'active' END
           WHERE id = ?`,
        )
        .run(now, now, existing.id);
      return this.rowToFact(
        this.db.prepare("SELECT * FROM project_facts WHERE id = ?").get(existing.id) as FactRow,
      );
    }

    this.db
      .prepare(
        `INSERT INTO project_facts (
           id, version, scope, fact_type, statement,
           inv_language, inv_framework, inv_error_type, inv_api_surface,
           src_origin, src_trace_id, src_author, src_reference,
           confidence, last_verified_at, created_at, updated_at, status, dedupe_key
         ) VALUES (
           @id, @version, @scope, @fact_type, @statement,
           @inv_language, @inv_framework, @inv_error_type, @inv_api_surface,
           @src_origin, @src_trace_id, @src_author, @src_reference,
           @confidence, @last_verified_at, @created_at, @updated_at, @status, @dedupe_key
         )`,
      )
      .run({
        id,
        version: 1,
        scope: input.scope,
        fact_type: input.factType,
        statement: input.statement,
        inv_language: input.invariants.language ?? null,
        inv_framework: input.invariants.framework ?? null,
        inv_error_type: input.invariants.errorType ?? null,
        inv_api_surface: JSON.stringify(input.invariants.apiSurface ?? []),
        src_origin: input.source.origin,
        src_trace_id: input.source.traceId ?? null,
        src_author: input.source.author ?? null,
        src_reference: input.source.reference ?? null,
        confidence: input.confidence ?? 0.5,
        last_verified_at: now,
        created_at: now,
        updated_at: now,
        status: "active",
        dedupe_key: dedupeKey,
      });

    return this.getFact(id)!;
  }

  getFact(id: string): ProjectFact | null {
    const row = this.db
      .prepare("SELECT * FROM project_facts WHERE id = ?")
      .get(id) as FactRow | undefined;
    return row ? this.rowToFact(row) : null;
  }

  searchFacts(query: FactSearchQuery): ProjectFact[] {
    const limit = query.limit ?? 50;
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit };

    // Hierarchical scope resolution (design doc §L4):
    //   A fact at scope S matches a query at scope Q iff
    //     S === "global"  OR
    //     Q === S  OR
    //     Q has S as a namespace-aligned prefix (next char after S in Q
    //     is a separator "." or "/", or S is the full Q).
    //   Results are re-ordered so that more specific scopes precede less
    //   specific ones (specificity = count of segments; "global" = 0).
    if (query.scope) {
      const scopes = expandScopeHierarchy(query.scope);
      clauses.push(`scope IN (${scopes.map((_, i) => `@sc${i}`).join(",")})`);
      scopes.forEach((s, i) => { params[`sc${i}`] = s; });
    }
    if (query.factType) {
      const types = Array.isArray(query.factType) ? query.factType : [query.factType];
      clauses.push(`fact_type IN (${types.map((_, i) => `@ft${i}`).join(",")})`);
      types.forEach((t, i) => { params[`ft${i}`] = t; });
    }
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      clauses.push(`status IN (${statuses.map((_, i) => `@st${i}`).join(",")})`);
      statuses.forEach((s, i) => { params[`st${i}`] = s; });
    } else {
      // Default: only active facts.
      clauses.push("status = 'active'");
    }
    if (query.invariants?.language) {
      clauses.push("(inv_language IS NULL OR inv_language = @inv_lang)");
      params.inv_lang = query.invariants.language;
    }
    if (query.invariants?.framework) {
      clauses.push("(inv_framework IS NULL OR inv_framework = @inv_fw)");
      params.inv_fw = query.invariants.framework;
    }
    if (query.invariants?.errorType) {
      clauses.push("(inv_error_type IS NULL OR inv_error_type = @inv_err)");
      params.inv_err = query.invariants.errorType;
    }

    // apiSurface is JSON; overlap is enforced post-query in JS (same
    // policy as BlockServer.searchBlocks). Over-fetch for headroom.
    const queryApi = query.invariants?.apiSurface ?? [];
    params.limit = queryApi.length > 0 ? limit * 4 : limit;

    let rawRows: FactRow[];

    if (query.text && query.text.trim()) {
      const fts = this.sanitizeFtsQuery(query.text);
      if (fts) {
        const sql = `
          SELECT project_facts.* FROM project_facts
          JOIN project_facts_fts ON project_facts.rowid = project_facts_fts.rowid
          WHERE project_facts_fts MATCH @fts
          ${clauses.length ? " AND " + clauses.join(" AND ") : ""}
          ORDER BY bm25(project_facts_fts)
          LIMIT @limit
        `;
        params.fts = fts;
        rawRows = this.db.prepare(sql).all(params) as FactRow[];
      } else {
        rawRows = [];
      }
    } else {
      const sql = `
        SELECT * FROM project_facts
        ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
        ORDER BY confidence DESC, last_verified_at DESC
        LIMIT @limit
      `;
      rawRows = this.db.prepare(sql).all(params) as FactRow[];
    }

    // apiSurface overlap filter (if query supplies one).
    const filtered = queryApi.length > 0
      ? rawRows.filter((r) => {
          let factApi: string[] = [];
          try {
            factApi = JSON.parse(r.inv_api_surface) as string[];
          } catch {
            factApi = [];
          }
          if (factApi.length === 0) return true; // fact doesn't constrain
          const qSet = new Set(queryApi);
          return factApi.some((a) => qSet.has(a));
        })
      : rawRows;

    let facts = filtered.map((r) => this.rowToFact(r));

    // Re-order by scope specificity (most specific first). Preserves
    // existing confidence/recency order within the same specificity
    // bucket thanks to stable-sort semantics of Array.prototype.sort on
    // ECMAScript 2019+ engines.
    if (query.scope) {
      facts = facts
        .map((f, i) => ({ f, i, spec: scopeSpecificity(f.scope) }))
        .sort((a, b) => (b.spec - a.spec) || (a.i - b.i))
        .map((x) => x.f);
    }

    return facts.slice(0, limit);
  }

  updateFactStatus(id: string, status: ProjectFactStatus): ProjectFact | null {
    const now = this.now();
    const res = this.db
      .prepare(
        "UPDATE project_facts SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, id);
    if (res.changes === 0) return null;
    return this.getFact(id);
  }

  /** Bump confidence + `lastVerifiedAt`. Used by repair loop. */
  verifyFact(id: string, now?: number): ProjectFact | null {
    const t = now ?? this.now();
    this.db
      .prepare(
        `UPDATE project_facts SET
           last_verified_at = ?,
           confidence = MIN(1.0, confidence + 0.05),
           updated_at = ?,
           status = 'active'
         WHERE id = ?`,
      )
      .run(t, t, id);
    return this.getFact(id);
  }

  deleteFact(id: string): boolean {
    const res = this.db.prepare("DELETE FROM project_facts WHERE id = ?").run(id);
    return res.changes > 0;
  }

  countFacts(status?: ProjectFactStatus): number {
    const row = status
      ? (this.db
          .prepare("SELECT COUNT(*) AS c FROM project_facts WHERE status = ?")
          .get(status) as { c: number })
      : (this.db
          .prepare("SELECT COUNT(*) AS c FROM project_facts")
          .get() as { c: number });
    return row.c;
  }

  // -------------------------------------------------------------------------
  // Analytics events
  // -------------------------------------------------------------------------

  appendEvent(event: AnalyticsEvent, extra?: { runId?: string }): number {
    // Resolve the effective runId: `extra` wins (so explicit emit-site
    // overrides whatever happens to be on the event), else fall back to
    // the event's own runId (for imports / JSONL read-back).
    const effectiveRunId = extra?.runId ?? event.runId ?? null;

    // Embed runId in the stored payload so `readEvents` round-trips it
    // without an extra SELECT column join. Previously the `run_id`
    // column was written but readEvents returned only the payload JSON,
    // which silently dropped runId on JSONL export.
    const payload = effectiveRunId !== null
      ? { ...event, runId: effectiveRunId }
      : event;

    const blockId =
      event.event === "injection" || event.event === "agent_used" ? event.blockId : null;
    const factId =
      event.event === "fact_injection" || event.event === "fact_agent_used" ? event.factId : null;
    const shadow =
      event.event === "retrieval" ? (event.shadow ? 1 : 0)
      : event.event === "outcome" ? (event.control ? 1 : 0)
      : null;

    const res = this.db
      .prepare(
        `INSERT INTO analytics_events (ts, event_type, query_id, block_id, fact_id, run_id, shadow, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.ts,
        event.event,
        event.queryId,
        blockId,
        factId,
        effectiveRunId,
        shadow,
        JSON.stringify(payload),
      );
    return Number(res.lastInsertRowid);
  }

  readEvents(opts: EventReadOptions = {}): AnalyticsEvent[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: opts.limit ?? 1000 };

    if (opts.afterTs !== undefined) {
      clauses.push("ts > @afterTs");
      params.afterTs = opts.afterTs;
    }
    if (opts.beforeTs !== undefined) {
      clauses.push("ts < @beforeTs");
      params.beforeTs = opts.beforeTs;
    }
    if (opts.eventType) {
      const types = Array.isArray(opts.eventType) ? opts.eventType : [opts.eventType];
      clauses.push(`event_type IN (${types.map((_, i) => `@et${i}`).join(",")})`);
      types.forEach((t, i) => { params[`et${i}`] = t; });
    }
    if (opts.queryId) { clauses.push("query_id = @queryId"); params.queryId = opts.queryId; }
    if (opts.blockId) { clauses.push("block_id = @blockId"); params.blockId = opts.blockId; }
    if (opts.factId)  { clauses.push("fact_id = @factId"); params.factId = opts.factId; }
    if (opts.runId)   { clauses.push("run_id = @runId"); params.runId = opts.runId; }

    // Also select `run_id` so that legacy rows (written before runId
    // was embedded in the payload) still round-trip correctly.
    const sql = `
      SELECT payload, run_id FROM analytics_events
      ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
      ORDER BY ts ASC, id ASC
      LIMIT @limit
    `;
    const rows = this.db.prepare(sql).all(params) as Array<{ payload: string; run_id: string | null }>;
    return rows.map((r) => {
      const ev = JSON.parse(r.payload) as AnalyticsEvent;
      if (r.run_id && ev.runId === undefined) {
        ev.runId = r.run_id;
      }
      return ev;
    });
  }

  countEvents(eventType?: AnalyticsEvent["event"]): number {
    if (eventType) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE event_type = ?")
        .get(eventType) as { c: number };
      return row.c;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM analytics_events")
      .get() as { c: number };
    return row.c;
  }

  // -------------------------------------------------------------------------
  // Calibrator models (Phase 5.2)
  //
  // Named JSON blobs keyed by `name`. The store does not interpret the
  // payload — it just persists whatever the caller serializes. The
  // calibrator module (src/lifecycle/calibrator.ts) owns the concrete
  // schema of each named model.
  // -------------------------------------------------------------------------

  /**
   * Persist a calibrator model. `fittedAt` is pulled off the payload
   * so callers can query by recency without deserializing the full
   * JSON. Overwrites any existing model with the same name.
   */
  saveCalibrator<T extends { fittedAt: number }>(
    name: string,
    model: T,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calibrator_models(name, payload, fitted_at)
         VALUES (?, ?, ?)`,
      )
      .run(name, JSON.stringify(model), model.fittedAt);
  }

  /**
   * Load a named calibrator model. Returns null if no model exists
   * under this name, or if the stored payload is malformed JSON.
   */
  loadCalibrator<T = unknown>(name: string): T | null {
    const row = this.db
      .prepare("SELECT payload FROM calibrator_models WHERE name = ?")
      .get(name) as { payload: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as T;
    } catch {
      return null;
    }
  }

  /** Delete a named calibrator model. Returns true iff a row was removed. */
  deleteCalibrator(name: string): boolean {
    const res = this.db
      .prepare("DELETE FROM calibrator_models WHERE name = ?")
      .run(name);
    return res.changes > 0;
  }

  /** List all stored calibrator model names (for diagnostics / audit). */
  listCalibratorNames(): Array<{ name: string; fittedAt: number }> {
    return this.db
      .prepare("SELECT name, fitted_at AS fittedAt FROM calibrator_models ORDER BY fitted_at DESC")
      .all() as Array<{ name: string; fittedAt: number }>;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private sanitizeFtsQuery(query: string): string {
    const cleaned = query.replace(/[*"():^~{}[\]\\]/g, " ").trim();
    if (!cleaned) return "";
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    const joiner = words.length <= 3 ? " " : " OR ";
    return words.map((w) => `"${w}"`).join(joiner);
  }

  private blockToRow(b: ReasoningBlock): Record<string, unknown> {
    return {
      id: b.id,
      version: b.version,
      created_at: b.createdAt,
      updated_at: b.updatedAt,
      status: b.status,
      kind: b.kind,
      trig_situation: b.trigger.situation,
      trig_fingerprint: b.trigger.fingerprint,
      trig_keywords: JSON.stringify(b.trigger.keywords),
      trig_language: b.trigger.invariants.language ?? null,
      trig_framework: b.trigger.invariants.framework ?? null,
      trig_error_type: b.trigger.invariants.errorType ?? null,
      trig_api_surface: JSON.stringify(b.trigger.invariants.apiSurface ?? []),
      body_mechanism: b.body.mechanism,
      body_dead_ends: JSON.stringify(b.body.deadEnds),
      body_unlock: b.body.unlock,
      body_verification: b.body.verification,
      body_guardrails: JSON.stringify(b.body.guardrails ?? []),
      prov_source_task_id: b.provenance.sourceTaskId,
      prov_source_agent: b.provenance.sourceAgent ?? null,
      prov_source_model: b.provenance.sourceModel ?? null,
      prov_extracted_from: b.provenance.extractedFrom,
      prov_distilled_at: b.provenance.distilledAt,
      prov_distilled_by: b.provenance.distilledBy,
      prov_distilled_with_model: b.provenance.distilledWithModel ?? null,
      prov_parent_trace_id: b.provenance.parentTraceId ?? null,
      prov_distillation_confidence: b.provenance.distillationConfidence ?? null,
      prov_validation_report: b.provenance.validationReport
        ? JSON.stringify(b.provenance.validationReport)
        : null,
      verification: b.verification ? JSON.stringify(b.verification) : null,
      stats_times_retrieved: b.stats.timesRetrieved,
      stats_times_injected: b.stats.timesInjected,
      stats_times_agent_used: b.stats.timesAgentUsed,
      stats_times_helpful: b.stats.timesHelpful,
      stats_times_counterproductive: b.stats.timesCounterproductive,
      stats_last_used_at: b.stats.lastUsedAt ?? null,
      stats_cum_tokens_saved: b.stats.cumulativeTokensSaved,
      stats_cum_steps_saved: b.stats.cumulativeStepsSaved,
      qual_confidence: b.quality.confidence,
      qual_wilson_lb: b.quality.wilsonLowerBound,
      qual_calibration_cohort: b.quality.calibrationCohort ?? null,
      embed_situation: b.embeddings?.situationVec
        ? Buffer.from(b.embeddings.situationVec.buffer)
        : null,
      embed_unlock: b.embeddings?.unlockVec
        ? Buffer.from(b.embeddings.unlockVec.buffer)
        : null,
      embed_model: b.embeddings?.model ?? null,
    };
  }

  private rowToBlock(r: BlockRow): ReasoningBlock {
    // Pre-v5 rows materialized before the failure-distillation lane
    // lack both `kind` and `body_guardrails`. SQLite's column DEFAULTs
    // already backfill them for any post-migration read, but we guard
    // defensively against unexpected NULLs coming from hand-rolled
    // inserts or older fixtures so the reader can never produce an
    // invalid block.
    const guardrailsRaw = r.body_guardrails ?? "[]";
    let guardrails: string[];
    try {
      const parsed = JSON.parse(guardrailsRaw) as unknown;
      guardrails = Array.isArray(parsed)
        ? parsed.filter((g): g is string => typeof g === "string")
        : [];
    } catch {
      guardrails = [];
    }
    return {
      id: r.id,
      version: r.version,
      kind: (r.kind ?? "success") as ReasoningBlock["kind"],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      status: r.status as ReasoningBlock["status"],
      trigger: {
        situation: r.trig_situation,
        fingerprint: r.trig_fingerprint,
        keywords: JSON.parse(r.trig_keywords) as string[],
        invariants: {
          language: r.trig_language ?? undefined,
          framework: r.trig_framework ?? undefined,
          errorType: r.trig_error_type ?? undefined,
          apiSurface: JSON.parse(r.trig_api_surface) as string[],
        },
      },
      body: {
        mechanism: r.body_mechanism,
        deadEnds: JSON.parse(r.body_dead_ends) as string[],
        unlock: r.body_unlock,
        verification: r.body_verification,
        ...(guardrails.length > 0 ? { guardrails } : {}),
      },
      provenance: {
        sourceTaskId: r.prov_source_task_id,
        sourceAgent: r.prov_source_agent ?? undefined,
        sourceModel: r.prov_source_model ?? undefined,
        extractedFrom: r.prov_extracted_from as ReasoningBlock["provenance"]["extractedFrom"],
        distilledAt: r.prov_distilled_at,
        distilledBy: r.prov_distilled_by as ReasoningBlock["provenance"]["distilledBy"],
        distilledWithModel: r.prov_distilled_with_model ?? undefined,
        parentTraceId: r.prov_parent_trace_id ?? undefined,
        distillationConfidence: r.prov_distillation_confidence ?? undefined,
        validationReport: r.prov_validation_report
          ? (JSON.parse(r.prov_validation_report) as ReasoningBlock["provenance"]["validationReport"])
          : undefined,
      },
      verification: r.verification
        ? (JSON.parse(r.verification) as ReasoningBlock["verification"])
        : undefined,
      stats: {
        timesRetrieved: r.stats_times_retrieved,
        timesInjected: r.stats_times_injected,
        timesAgentUsed: r.stats_times_agent_used,
        timesHelpful: r.stats_times_helpful,
        timesCounterproductive: r.stats_times_counterproductive,
        lastUsedAt: r.stats_last_used_at ?? undefined,
        cumulativeTokensSaved: r.stats_cum_tokens_saved,
        cumulativeStepsSaved: r.stats_cum_steps_saved,
      },
      quality: {
        confidence: r.qual_confidence,
        wilsonLowerBound: r.qual_wilson_lb,
        calibrationCohort: r.qual_calibration_cohort ?? undefined,
      },
      embeddings: r.embed_situation || r.embed_unlock
        ? {
            situationVec: r.embed_situation
              ? new Float32Array(r.embed_situation.buffer, r.embed_situation.byteOffset, r.embed_situation.byteLength / 4)
              : undefined,
            unlockVec: r.embed_unlock
              ? new Float32Array(r.embed_unlock.buffer, r.embed_unlock.byteOffset, r.embed_unlock.byteLength / 4)
              : undefined,
            model: r.embed_model ?? "",
          }
        : undefined,
    };
  }

  private rowToCaseRef(r: CaseRefRow): BlockCaseRef {
    return {
      id: r.id,
      blockId: r.block_id,
      traceId: r.trace_id,
      role: r.role as BlockCaseRole,
      evidenceQuality: r.evidence_quality as EvidenceQuality,
      locator: r.locator ?? undefined,
      createdAt: r.created_at,
    };
  }

  private rowToFact(r: FactRow): ProjectFact {
    const src: ProjectFactSource = {
      origin: r.src_origin as ProjectFactSource["origin"],
      traceId: r.src_trace_id ?? undefined,
      author: r.src_author ?? undefined,
      reference: r.src_reference ?? undefined,
    };
    return {
      id: r.id,
      version: r.version,
      scope: r.scope,
      factType: r.fact_type as ProjectFactType,
      statement: r.statement,
      invariants: {
        language: r.inv_language ?? undefined,
        framework: r.inv_framework ?? undefined,
        errorType: r.inv_error_type ?? undefined,
        apiSurface: JSON.parse(r.inv_api_surface) as string[],
      },
      source: src,
      confidence: r.confidence,
      lastVerifiedAt: r.last_verified_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      status: r.status as ProjectFactStatus,
    };
  }
}

// ---------------------------------------------------------------------------
// Small helpers + row types
// ---------------------------------------------------------------------------

function maxOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Return the set of fact scopes that match a query scope under the
 * namespace-prefix rule (§L4 in docs/DESIGN_v2.md):
 *
 *   • "global" always matches.
 *   • S matches Q iff S === Q, or S is a namespace-aligned prefix of Q
 *     (i.e. Q[|S|] is a "." or "/" separator).
 *
 * Returns Q itself + all prefix-scopes terminated at a separator + "global".
 * "myorg/app" and "myorgapp" are NOT related; the separator check prevents
 * false-positive prefix matches.
 */
export function expandScopeHierarchy(queryScope: string): string[] {
  const out = new Set<string>(["global"]);
  if (!queryScope || queryScope === "global") return [...out];
  out.add(queryScope);
  for (let i = 0; i < queryScope.length; i++) {
    const c = queryScope[i];
    if (c === "." || c === "/") {
      const prefix = queryScope.slice(0, i);
      if (prefix) out.add(prefix);
    }
  }
  return [...out];
}

/**
 * Rank a scope by specificity. "global" = 0; every further separator adds
 * one to the count (starting at 1 for the first segment). Used as the
 * primary sort key for hierarchical fact retrieval.
 */
export function scopeSpecificity(scope: string): number {
  if (!scope || scope === "global") return 0;
  let n = 1;
  for (let i = 0; i < scope.length; i++) {
    const c = scope[i];
    if (c === "." || c === "/") n++;
  }
  return n;
}

interface BlockRow {
  id: string;
  version: number;
  created_at: number;
  updated_at: number;
  status: string;
  /** Failure-distillation discriminator; NULL only on legacy rows. */
  kind: string | null;
  trig_situation: string;
  trig_fingerprint: string;
  trig_keywords: string;
  trig_language: string | null;
  trig_framework: string | null;
  trig_error_type: string | null;
  trig_api_surface: string;
  body_mechanism: string;
  body_dead_ends: string;
  body_unlock: string;
  body_verification: string;
  /** JSON array of guardrail strings; NULL only on legacy rows. */
  body_guardrails: string | null;
  prov_source_task_id: string;
  prov_source_agent: string | null;
  prov_source_model: string | null;
  prov_extracted_from: string;
  prov_distilled_at: number;
  prov_distilled_by: string;
  prov_distilled_with_model: string | null;
  prov_parent_trace_id: string | null;
  prov_distillation_confidence: number | null;
  prov_validation_report: string | null;
  verification: string | null;
  stats_times_retrieved: number;
  stats_times_injected: number;
  stats_times_agent_used: number;
  stats_times_helpful: number;
  stats_times_counterproductive: number;
  stats_last_used_at: number | null;
  stats_cum_tokens_saved: number;
  stats_cum_steps_saved: number;
  qual_confidence: number;
  qual_wilson_lb: number;
  qual_calibration_cohort: string | null;
  embed_situation: Buffer | null;
  embed_unlock: Buffer | null;
  embed_model: string | null;
}

interface CaseRefRow {
  id: string;
  block_id: string;
  trace_id: string;
  role: string;
  evidence_quality: string;
  locator: string | null;
  created_at: number;
}

interface FactRow {
  id: string;
  version: number;
  scope: string;
  fact_type: string;
  statement: string;
  inv_language: string | null;
  inv_framework: string | null;
  inv_error_type: string | null;
  inv_api_surface: string;
  src_origin: string;
  src_trace_id: string | null;
  src_author: string | null;
  src_reference: string | null;
  confidence: number;
  last_verified_at: number;
  created_at: number;
  updated_at: number;
  status: string;
  dedupe_key: string;
}
