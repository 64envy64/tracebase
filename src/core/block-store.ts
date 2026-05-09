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
  RecordToolObservationInput,
  ToolObservation,
  ToolObservationOutcome,
} from "../types.js";
import { detectLeakage } from "./block.js";
import { detectPromptInjectionPatterns } from "./guard.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// 0.7.1 bumps to 14 — GDPR Art. 17 hard-delete audit trail. Adds
// `audit_deletes(id, block_id, deleted_at, reason,
// requesting_principal)` so BlockStore.hardDeleteBlock can both
// remove a reasoning_blocks row (CASCADE sweeping its case refs)
// and write an immutable tombstone for compliance audit.
const V2_SCHEMA_VERSION = 15;

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
  fact_type         TEXT NOT NULL CHECK(fact_type IN ('convention','schema','repo_fact','architecture','preference','file_semantic','session_digest')),
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

  -- Optional absolute expiry timestamp (epoch ms). NULL = no TTL.
  -- 0.5.2 TB CONTEXT digests set this via StoreProjectFactInput.ttlDays.
  -- doctor's sweepExpiredFacts() retires rows where ttl_until_at is
  -- non-null and already past Date.now().
  ttl_until_at      INTEGER,

  -- 0.7.0-rc.2 rc.2 — orthogonal-to-src_origin provenance dimension
  -- so the rc.3 badge counters can distinguish indexer-derived facts
  -- from chat-derived ones. Default 'chat-derived' covers every
  -- existing row and every fact extracted from a transcript; the
  -- file indexer (when it eventually writes to project_facts for
  -- non-file semantic facts) sets 'indexer'; explicit SDK calls
  -- can set 'manual'.
  provenance_kind   TEXT DEFAULT 'chat-derived',

  dedupe_key        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_scope     ON project_facts(scope);
CREATE INDEX IF NOT EXISTS idx_facts_type      ON project_facts(fact_type);
CREATE INDEX IF NOT EXISTS idx_facts_language  ON project_facts(inv_language);
CREATE INDEX IF NOT EXISTS idx_facts_status    ON project_facts(status);
CREATE INDEX IF NOT EXISTS idx_facts_ttl       ON project_facts(ttl_until_at) WHERE ttl_until_at IS NOT NULL;
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

-- Tool observations (L6, 0.5.3 TB TOOL substrate).
--
-- One row per completed tool call seen via Claude Code's
-- PostToolBatch hook. Bodies are NEVER stored — tool_input is
-- pre-sanitised at the hook into an allowlisted-fields-only
-- arg_summary + an HMAC arg_key; tool_response is ignored.
-- The next UserPromptSubmit reads the recent rows to detect
-- duplicate / ping-pong / straight-loop tool sequences and
-- surface a TB TOOL / TB LOOP badge alongside TB TRACE.
--
-- Privacy invariant: rows here NEVER ship to the cloud allowlist.
-- Only aggregates (duplicate_count / loop_count / family_counts)
-- are eligible — and even those need an explicit nested allowlist
-- spec before they reach the wire.
CREATE TABLE IF NOT EXISTS tool_observations (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  session_id    TEXT NOT NULL,
  batch_id      TEXT,
  batch_order   INTEGER NOT NULL DEFAULT 0,
  tool_use_id   TEXT,
  tool_name     TEXT NOT NULL,
  arg_summary   TEXT NOT NULL,
  arg_key       TEXT NOT NULL,
  outcome       TEXT NOT NULL DEFAULT 'unknown' CHECK(outcome IN ('ok','error','unknown')),
  redundant_of  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_obs_session_ts ON tool_observations(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_tool_obs_argkey_ts  ON tool_observations(arg_key, ts);
CREATE INDEX IF NOT EXISTS idx_tool_obs_use_id     ON tool_observations(tool_use_id);

CREATE TABLE IF NOT EXISTS v2_schema_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- 0.7.0-rc.1: per-step migration log. One row per applied migration
-- version, populated either incrementally by the migrate() walker or
-- by the fresh-init fast-path which inserts rows 1..V2_SCHEMA_VERSION
-- in one shot. Coexists with v2_schema_meta — the KV row stays the
-- single source of truth for "current version", the per-row log is
-- there for audit + future migration runners that want richer history.
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- 0.7.0-rc.2 §rc.2 — file indexer.
--
-- One row per file the heuristic walker successfully summarized.
-- Body fields (summary, symbols) are leakage-scanned + prompt-
-- injection-scanned before write — a positive match emits
-- file_index.skipped and the row never lands.
--
-- Privacy invariants:
--   - rel_path is repo-relative via toRepoRelative. Absolute or
--     escape-relative paths fail at the indexer boundary, never reach
--     this table.
--   - summary <= 600 chars, symbols <= 256 chars (JSON). Bodies
--     never carry full file content; the heuristic extracts header /
--     symbols only.
--   - cloud allowlist drops every column-name except aggregates;
--     rel_path / hash / summary / symbols never reach the wire
--     (see USAGE_FILE_INDEX_SPEC in src/cli/cloud-allowlist.ts).
CREATE TABLE IF NOT EXISTS indexed_files (
  id            TEXT PRIMARY KEY,
  rel_path      TEXT NOT NULL UNIQUE,
  hash          TEXT NOT NULL,
  language      TEXT,
  size_bytes    INTEGER NOT NULL,
  summary       TEXT NOT NULL,
  symbols       TEXT,
  summarizer    TEXT NOT NULL,
  indexed_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_indexed_files_hash ON indexed_files(hash);
CREATE INDEX IF NOT EXISTS idx_indexed_files_lang ON indexed_files(language);

-- 0.7.0-rc.3 rc.3 — FTS5 mirror over (summary, symbols).
--
-- Same shape as reasoning_blocks_fts / project_facts_fts. The
-- recall path queries this virtual table by prompt-term overlap;
-- ranking is FTS5 bm25, the same default we use elsewhere.
--
-- Privacy: the FTS index is content-addressable to indexed_files
-- by rowid (content='indexed_files', content_rowid='rowid').
-- Cloud allowlist already drops every column from indexed_files
-- (USAGE_FILE_INDEX_SPEC ships only counts), so the FTS rows
-- never reach the wire either.
CREATE VIRTUAL TABLE IF NOT EXISTS indexed_files_fts USING fts5(
  summary,
  symbols,
  content='indexed_files',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS indexed_files_fts_insert AFTER INSERT ON indexed_files BEGIN
  INSERT INTO indexed_files_fts(rowid, summary, symbols)
  VALUES (new.rowid, new.summary, new.symbols);
END;

CREATE TRIGGER IF NOT EXISTS indexed_files_fts_delete AFTER DELETE ON indexed_files BEGIN
  INSERT INTO indexed_files_fts(indexed_files_fts, rowid, summary, symbols)
  VALUES ('delete', old.rowid, old.summary, old.symbols);
END;

CREATE TRIGGER IF NOT EXISTS indexed_files_fts_update
  AFTER UPDATE OF summary, symbols ON indexed_files
BEGIN
  INSERT INTO indexed_files_fts(indexed_files_fts, rowid, summary, symbols)
  VALUES ('delete', old.rowid, old.summary, old.symbols);
  INSERT INTO indexed_files_fts(rowid, summary, symbols)
  VALUES (new.rowid, new.summary, new.symbols);
END;

-- 0.7.0-rc.2 §rc.2 — indexer pending queue.
--
-- Two row kinds:
--   * 'file' — a specific file the walker visited but could not
--             summarize within the budget; the next opportunistic
--             drain summarizes it directly.
--   * 'dir'  — a directory prefix the walker NEVER ENTERED because
--             the budget hit zero before it descended; the next
--             drain re-walks that prefix and either summarizes new
--             files within slice-budget or re-enqueues them.
--
-- Composite primary key on (rel_path, kind) — a path can be queued as
-- both a file and a dir if it appears in both contexts (rare). The
-- (kind, enqueued_at) index supports the dir-preferential drain order.
CREATE TABLE IF NOT EXISTS indexer_pending (
  rel_path     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
  enqueued_at  INTEGER NOT NULL,
  last_attempt INTEGER,
  PRIMARY KEY (rel_path, kind)
);

CREATE INDEX IF NOT EXISTS idx_indexer_pending_kind ON indexer_pending(kind, enqueued_at);

-- 0.7.0-rc.5 rc.5 — loop redirect anti-self-loop guard.
--
-- One row per (session_id, anchor_id, arg_key) the redirect
-- resolver has already pointed the agent at. The next loop hit
-- on the same arg_key in the same session checks this table; if
-- the anchor is present, the resolver falls back to the static
-- "widen scope" message instead of pointing at the same anchor
-- twice in a row.
--
-- Privacy: anchor_id is either a block UUID or a repo-relative
-- file path (the rc.3 indexed_files.rel_path). Both are local-
-- only — the cloud allowlist drops every column.
CREATE TABLE IF NOT EXISTS loop_redirect_dedupe (
  session_id  TEXT NOT NULL,
  anchor_id   TEXT NOT NULL,
  arg_key     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (session_id, anchor_id, arg_key)
);

CREATE INDEX IF NOT EXISTS idx_loop_redirect_dedupe_ts ON loop_redirect_dedupe(ts);

-- 0.7.0-rc.6 rc.6 — chunk-based context compression.
--
-- One row per folded chunk of a session's transcript. PreCompact
-- writes new rows; the next UserPromptSubmit in the SAME session
-- queries the latest rows by chunk_start_turn DESC and injects
-- the top-K under <context_fold>...</context_fold>.
--
-- Privacy: summary <= 1200 chars, leakage- and injection-scanned
-- at write. Cloud allowlist drops every column from session_chunks
-- (USAGE_CONTEXT_FOLD_SPEC ships only counts).
--
-- Idempotency: (session_id, turn_hash) is UNIQUE so a re-fold of
-- the same content on the next PreCompact no-ops; expires_at
-- carries the spec'd 14-day TTL so old chunks age out.
CREATE TABLE IF NOT EXISTS session_chunks (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  chunk_start_turn  INTEGER NOT NULL,
  chunk_end_turn    INTEGER NOT NULL,
  turn_hash         TEXT NOT NULL,
  summary           TEXT NOT NULL,
  tokens_before     INTEGER NOT NULL,
  tokens_after      INTEGER NOT NULL,
  summarizer        TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_chunks_session
  ON session_chunks(session_id, chunk_start_turn);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chunks_dedupe
  ON session_chunks(session_id, turn_hash);

-- Calibrator models (Phase 5.2). Named JSON blobs so multiple named
-- calibrators can coexist (e.g. per-cohort, per-deployment). Phase 5
-- ships a single canonical name; future calibrators reuse the table.
CREATE TABLE IF NOT EXISTS calibrator_models (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fitted_at  INTEGER NOT NULL
);

-- 0.7.1 — GDPR Art. 17 hard-delete audit trail. Append-only ledger
-- of every hardDeleteBlock call. Body of the deleted block is
-- intentionally NOT preserved (that would defeat erasure); we keep
-- block_id, timestamp, reason, and an optional requesting_principal
-- so the deletion remains auditable while the content itself is
-- gone. Reconciliation against prior analytics_events references
-- the same block_id.
CREATE TABLE IF NOT EXISTS audit_deletes (
  id                    TEXT PRIMARY KEY,
  block_id              TEXT NOT NULL,
  deleted_at            INTEGER NOT NULL,
  reason                TEXT NOT NULL,
  requesting_principal  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_deletes_block ON audit_deletes(block_id);
CREATE INDEX IF NOT EXISTS idx_audit_deletes_ts    ON audit_deletes(deleted_at);

-- 0.7.1 — GDPR Art. 17 hard-delete audit trail for project facts
-- (L4 semantic memory). Parallel to audit_deletes but keyed by
-- fact_id; same privacy contract — body of the deleted fact is
-- intentionally NOT preserved. Without a separate ledger, fact
-- erasure would either pollute the block-keyed audit table or
-- silently bypass the audit path entirely.
CREATE TABLE IF NOT EXISTS audit_fact_deletes (
  id                    TEXT PRIMARY KEY,
  fact_id               TEXT NOT NULL,
  deleted_at            INTEGER NOT NULL,
  reason                TEXT NOT NULL,
  requesting_principal  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_fact_deletes_fact ON audit_fact_deletes(fact_id);
CREATE INDEX IF NOT EXISTS idx_audit_fact_deletes_ts   ON audit_fact_deletes(deleted_at);
`;

/**
 * A single migration step. Strings are exec'd directly; function steps
 * receive the database handle and may call helpers like
 * `addColumnIfMissing` that need probe-then-act semantics.
 *
 * 0.7.0-rc.2 widened the type from `string` to `string | function` so
 * migrations that need conditional ALTER TABLE could compose with the
 * existing exec-each-string walker without re-implementing column
 * presence probes inside raw SQL.
 */
type MigrationStep = string | ((db: Database.Database) => void);

/**
 * Incremental migrations for existing v2 databases. Fresh installs run
 * the full V2_SCHEMA above; existing databases walk this map step-by-step
 * from their current version to V2_SCHEMA_VERSION.
 */
const V2_MIGRATIONS: Record<number, MigrationStep[]> = {
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
  // v6 → v7: 0.5.2 TB CONTEXT lands. Two additive changes to
  // project_facts:
  //   (a) widen the fact_type CHECK to include 'session_digest';
  //   (b) add a nullable `ttl_until_at` column so digests cap at 14
  //       days and the doctor sweeper retires them after expiry.
  //
  // Same idempotent rebuild pattern as v6: bootstrap the table with
  // the v6-shape CHECK (in case a legacy DB somehow reached v6 without
  // it), then rebuild via v7_new.
  7: [
    // Bootstrap — no-op when the table already exists in its v6 shape.
    // Column list matches v6 exactly, so a real v6 DB's rows transfer
    // cleanly to the v7 layout.
    `CREATE TABLE IF NOT EXISTS project_facts (
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
    // Rebuild with widened CHECK + new ttl_until_at column.
    `CREATE TABLE project_facts_v7 (
      id                TEXT PRIMARY KEY,
      version           INTEGER NOT NULL,
      scope             TEXT NOT NULL,
      fact_type         TEXT NOT NULL CHECK(fact_type IN ('convention','schema','repo_fact','architecture','preference','file_semantic','session_digest')),
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
      ttl_until_at      INTEGER,
      dedupe_key        TEXT NOT NULL
    )`,
    `INSERT INTO project_facts_v7
       (id, version, scope, fact_type, statement,
        inv_language, inv_framework, inv_error_type, inv_api_surface,
        src_origin, src_trace_id, src_author, src_reference,
        confidence, last_verified_at, created_at, updated_at, status,
        ttl_until_at, dedupe_key)
       SELECT id, version, scope, fact_type, statement,
              inv_language, inv_framework, inv_error_type, inv_api_surface,
              src_origin, src_trace_id, src_author, src_reference,
              confidence, last_verified_at, created_at, updated_at, status,
              NULL, dedupe_key
         FROM project_facts`,
    `DROP TABLE IF EXISTS project_facts_fts`,
    `DROP TABLE project_facts`,
    `ALTER TABLE project_facts_v7 RENAME TO project_facts`,
    `CREATE INDEX IF NOT EXISTS idx_facts_scope     ON project_facts(scope)`,
    `CREATE INDEX IF NOT EXISTS idx_facts_type      ON project_facts(fact_type)`,
    `CREATE INDEX IF NOT EXISTS idx_facts_language  ON project_facts(inv_language)`,
    `CREATE INDEX IF NOT EXISTS idx_facts_status    ON project_facts(status)`,
    `CREATE INDEX IF NOT EXISTS idx_facts_ttl       ON project_facts(ttl_until_at) WHERE ttl_until_at IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_dedupe ON project_facts(dedupe_key)`,
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
    `INSERT INTO project_facts_fts(project_facts_fts) VALUES('rebuild')`,
  ],
  // v7 → v8: 0.5.3 TB TOOL lands. Adds the additive `tool_observations`
  // table + its three indexes. Pure additive — no rewrite of existing
  // rows, no CHECK widening, no FTS mirror. The `IF NOT EXISTS` shape
  // keeps this idempotent on DBs that may have been hand-bootstrapped
  // by a future helper before reaching the migration walker.
  8: [
    `CREATE TABLE IF NOT EXISTS tool_observations (
      id            TEXT PRIMARY KEY,
      ts            INTEGER NOT NULL,
      session_id    TEXT NOT NULL,
      batch_id      TEXT,
      batch_order   INTEGER NOT NULL DEFAULT 0,
      tool_use_id   TEXT,
      tool_name     TEXT NOT NULL,
      arg_summary   TEXT NOT NULL,
      arg_key       TEXT NOT NULL,
      outcome       TEXT NOT NULL DEFAULT 'unknown' CHECK(outcome IN ('ok','error','unknown')),
      redundant_of  TEXT,
      created_at    INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tool_obs_session_ts ON tool_observations(session_id, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_tool_obs_argkey_ts  ON tool_observations(arg_key, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_tool_obs_use_id     ON tool_observations(tool_use_id)`,
  ],
  // v8 → v9: 0.7.0-rc.1 introduces the per-step `schema_version` log
  // table. Every prior migration's outcome was tracked only in the
  // `v2_schema_meta` KV (single "current version" cell); this step
  // adds a richer log with one row per applied migration. The migrate()
  // wrapper inserts the version-9 row itself; this step just creates
  // the table and back-fills rows for versions 1..8 so audit history
  // exists for upgrades from 0.6.x.
  //
  // INSERT OR IGNORE keeps it idempotent: if a future migrate path or
  // a partial run already populated some rows, this step doesn't
  // duplicate-key. `applied_at` is best-effort for the back-fill —
  // we don't know when those historical migrations actually ran on
  // this database.
  9: [
    `CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
    // Back-fill 1..8. Version 9 itself is recorded by the migrate()
    // wrapper after this migration's transaction commits.
    `INSERT OR IGNORE INTO schema_version(version, applied_at)
       SELECT 1, COALESCE((SELECT MIN(ts) FROM analytics_events), strftime('%s','now')*1000)`,
    `INSERT OR IGNORE INTO schema_version(version, applied_at)
       SELECT 2, COALESCE((SELECT MIN(ts) FROM analytics_events), strftime('%s','now')*1000)`,
    `INSERT OR IGNORE INTO schema_version(version, applied_at)
       SELECT 3, COALESCE((SELECT MIN(ts) FROM analytics_events), strftime('%s','now')*1000)`,
    `INSERT OR IGNORE INTO schema_version(version, applied_at)
       SELECT 4, COALESCE((SELECT MIN(ts) FROM analytics_events), strftime('%s','now')*1000)`,
    `INSERT OR IGNORE INTO schema_version(version, applied_at)
       SELECT 5, COALESCE((SELECT MIN(ts) FROM analytics_events), strftime('%s','now')*1000)`,
    `INSERT OR IGNORE INTO schema_version(version, applied_at)
       SELECT 6, COALESCE((SELECT MIN(ts) FROM analytics_events), strftime('%s','now')*1000)`,
    `INSERT OR IGNORE INTO schema_version(version, applied_at)
       SELECT 7, COALESCE((SELECT MIN(ts) FROM analytics_events), strftime('%s','now')*1000)`,
    `INSERT OR IGNORE INTO schema_version(version, applied_at)
       SELECT 8, COALESCE((SELECT MIN(ts) FROM analytics_events), strftime('%s','now')*1000)`,
  ],
  // v9 → v10: 0.7.0-rc.2 file indexer (PLAN-0.7 §rc.2).
  //
  // Three changes, all additive + idempotent:
  //   1. `provenance_kind` column on `project_facts`. Probe-then-add
  //      via `addColumnIfMissing` so re-running on a DB that already
  //      has the column no-ops. DEFAULT `'chat-derived'` covers
  //      every existing row at zero migration cost (SQLite fills it
  //      lazily on read for unfilled rows).
  //   2. `indexed_files` table — one row per heuristically-summarized
  //      file. Bodies leakage- + injection-scanned at write time;
  //      cloud allowlist drops every column except aggregates.
  //   3. `indexer_pending` queue with composite (rel_path, kind) PK.
  //      Drain order keys on (kind, enqueued_at).
  10: [
    (db) =>
      addColumnIfMissing(
        db,
        "project_facts",
        "provenance_kind",
        "TEXT DEFAULT 'chat-derived'",
      ),
    `CREATE TABLE IF NOT EXISTS indexed_files (
       id            TEXT PRIMARY KEY,
       rel_path      TEXT NOT NULL UNIQUE,
       hash          TEXT NOT NULL,
       language      TEXT,
       size_bytes    INTEGER NOT NULL,
       summary       TEXT NOT NULL,
       symbols       TEXT,
       summarizer    TEXT NOT NULL,
       indexed_at    INTEGER NOT NULL,
       updated_at    INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_indexed_files_hash ON indexed_files(hash)`,
    `CREATE INDEX IF NOT EXISTS idx_indexed_files_lang ON indexed_files(language)`,
    `CREATE TABLE IF NOT EXISTS indexer_pending (
       rel_path     TEXT NOT NULL,
       kind         TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
       enqueued_at  INTEGER NOT NULL,
       last_attempt INTEGER,
       PRIMARY KEY (rel_path, kind)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_indexer_pending_kind ON indexer_pending(kind, enqueued_at)`,
  ],
  // v10 → v11: 0.7.0-rc.3 file memory recall (PLAN-0.7 §rc.3).
  //
  // Adds FTS5 mirror over indexed_files(summary, symbols) plus
  // its three insert/delete/update sync triggers, then rebuilds
  // the index for any rows that already exist in indexed_files.
  // The 'rebuild' insert is a no-op on an empty table — same
  // idempotency contract as the project_facts_fts rebuild in
  // migration #6.
  11: [
    `CREATE VIRTUAL TABLE IF NOT EXISTS indexed_files_fts USING fts5(
       summary,
       symbols,
       content='indexed_files',
       content_rowid='rowid',
       tokenize='porter unicode61'
     )`,
    `CREATE TRIGGER IF NOT EXISTS indexed_files_fts_insert AFTER INSERT ON indexed_files BEGIN
       INSERT INTO indexed_files_fts(rowid, summary, symbols)
       VALUES (new.rowid, new.summary, new.symbols);
     END`,
    `CREATE TRIGGER IF NOT EXISTS indexed_files_fts_delete AFTER DELETE ON indexed_files BEGIN
       INSERT INTO indexed_files_fts(indexed_files_fts, rowid, summary, symbols)
       VALUES ('delete', old.rowid, old.summary, old.symbols);
     END`,
    `CREATE TRIGGER IF NOT EXISTS indexed_files_fts_update
       AFTER UPDATE OF summary, symbols ON indexed_files
     BEGIN
       INSERT INTO indexed_files_fts(indexed_files_fts, rowid, summary, symbols)
       VALUES ('delete', old.rowid, old.summary, old.symbols);
       INSERT INTO indexed_files_fts(rowid, summary, symbols)
       VALUES (new.rowid, new.summary, new.symbols);
     END`,
    `INSERT INTO indexed_files_fts(indexed_files_fts) VALUES('rebuild')`,
  ],
  // v11 → v12: 0.7.0-rc.5 loop redirect anti-self-loop guard
  // (PLAN-0.7 §rc.5). Pure additive — one new table + one index.
  // Idempotent via IF NOT EXISTS.
  12: [
    `CREATE TABLE IF NOT EXISTS loop_redirect_dedupe (
       session_id  TEXT NOT NULL,
       anchor_id   TEXT NOT NULL,
       arg_key     TEXT NOT NULL,
       ts          INTEGER NOT NULL,
       PRIMARY KEY (session_id, anchor_id, arg_key)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_loop_redirect_dedupe_ts ON loop_redirect_dedupe(ts)`,
  ],
  // v12 → v13: 0.7.0-rc.6 chunk-based context compression
  // (PLAN-0.7 §rc.6). Pure additive — one new table + two
  // indexes (one for session+turn ordering, one UNIQUE for
  // turn_hash idempotency). Idempotent via IF NOT EXISTS.
  13: [
    `CREATE TABLE IF NOT EXISTS session_chunks (
       id                TEXT PRIMARY KEY,
       session_id        TEXT NOT NULL,
       chunk_start_turn  INTEGER NOT NULL,
       chunk_end_turn    INTEGER NOT NULL,
       turn_hash         TEXT NOT NULL,
       summary           TEXT NOT NULL,
       tokens_before     INTEGER NOT NULL,
       tokens_after      INTEGER NOT NULL,
       summarizer        TEXT NOT NULL,
       expires_at        INTEGER NOT NULL,
       created_at        INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_session_chunks_session
       ON session_chunks(session_id, chunk_start_turn)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_chunks_dedupe
       ON session_chunks(session_id, turn_hash)`,
  ],
  // v13 → v14: 0.7.1 GDPR Art. 17 — hard-delete audit trail.
  // Pure additive table + two indexes; existing data untouched.
  // Powers BlockStore.hardDeleteBlock: each call deletes the
  // reasoning_blocks row (CASCADE on block_case_refs) and writes
  // a tombstone here in a single transaction.
  14: [
    `CREATE TABLE IF NOT EXISTS audit_deletes (
       id                    TEXT PRIMARY KEY,
       block_id              TEXT NOT NULL,
       deleted_at            INTEGER NOT NULL,
       reason                TEXT NOT NULL,
       requesting_principal  TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_deletes_block ON audit_deletes(block_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_deletes_ts    ON audit_deletes(deleted_at)`,
  ],
  // v14 → v15: parallel audit ledger for project_facts erasure.
  // Same shape as audit_deletes, keyed by fact_id. Adding a
  // separate table (rather than widening audit_deletes) keeps the
  // foreign-key narrative clean — the existing audit_deletes
  // contract "block_id NOT NULL" remains intact.
  15: [
    `CREATE TABLE IF NOT EXISTS audit_fact_deletes (
       id                    TEXT PRIMARY KEY,
       fact_id               TEXT NOT NULL,
       deleted_at            INTEGER NOT NULL,
       reason                TEXT NOT NULL,
       requesting_principal  TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_fact_deletes_fact ON audit_fact_deletes(fact_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_fact_deletes_ts   ON audit_fact_deletes(deleted_at)`,
  ],
};

// ---------------------------------------------------------------------------
// Migration helpers (0.7.0-rc.1 §Ground)
// ---------------------------------------------------------------------------

/**
 * Idempotent ALTER TABLE ADD COLUMN. The migration runner uses this
 * helper for every column-addition step so re-running a migration on
 * a DB that already saw it doesn't raise `duplicate column name`.
 *
 * Why a helper instead of inline SQL: SQLite has no `ADD COLUMN IF
 * NOT EXISTS`. The probe-then-alter pattern is the only portable
 * shape, and centralising it here means later rc's migrations all
 * inherit the same idempotency contract without each one re-inventing
 * the probe.
 *
 * `type` is a free-form column-type string (`"TEXT"`, `"INTEGER NOT
 * NULL DEFAULT 0"`, etc.) — it goes verbatim after the column name in
 * the ALTER statement, so the caller is responsible for keeping it
 * SQLite-syntactically valid. Tests for migration steps that use this
 * helper exercise the probe both ways (column missing, column
 * present).
 */
export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  name: string,
  type: string,
): void {
  // PRAGMA table_info returns one row per column; `name` is the column
  // identifier the SQLite parser exposes (case-sensitive).
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LeakageError extends Error {
  constructor(public readonly pattern: string) {
    super(`block content leaks gold-truth material: ${pattern}`);
    this.name = "LeakageError";
  }
}

/**
 * Raised by storage paths when the prompt-injection guard
 * (`detectPromptInjectionPatterns` in `src/core/guard.ts`) matches a
 * named pattern in the candidate write. The pattern name is one of
 * the entries in `PROMPT_INJECTION_PATTERNS` and is also recorded as
 * a `store.injection_rejected` analytics event with the same name.
 */
export class PromptInjectionError extends Error {
  constructor(
    public readonly pattern: string,
    public readonly surface: "block" | "fact" | "imported" | "indexer" | "fold",
  ) {
    super(`${surface} content matches prompt-injection pattern: ${pattern}`);
    this.name = "PromptInjectionError";
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

    const now = this.now();

    if (current === 0) {
      // 0.7.0-rc.1 §hardening — fresh-init wrapped in a single
      // transaction so a process death mid-init can never leave a
      // partially-initialised DB. Either every table + index + FTS
      // mirror exists with the full audit log, or nothing did.
      // (The `current === 0` re-check on next open will see the
      // rolled-back state and re-run the full init.)
      const tx = this.db.transaction(() => {
        this.db.exec(V2_SCHEMA);
        this.setSchemaVersion(V2_SCHEMA_VERSION);
        // Mirror the per-step log retroactively so a fresh install
        // lands with the same audit history as an upgraded one. The
        // schema_version table was created by V2_SCHEMA above, so
        // this insert always succeeds (INSERT OR IGNORE keeps it
        // safe against re-runs on the same connection).
        const stamp = this.db.prepare(
          "INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (?, ?)",
        );
        for (let v = 1; v <= V2_SCHEMA_VERSION; v++) stamp.run(v, now);
      });
      tx();
      return;
    }

    // Existing DB at an older v2 version — walk incremental migrations.
    // Each step runs in its own transaction so a partial walk leaves
    // the DB at a coherent intermediate version. The per-step log row
    // lands inside the same transaction as the migration's own SQL,
    // so on rollback we never claim a version we didn't reach.
    for (let v = current + 1; v <= V2_SCHEMA_VERSION; v++) {
      const steps = V2_MIGRATIONS[v];
      if (!steps) continue;
      const tx = this.db.transaction(() => {
        for (const step of steps) {
          // 0.7.0-rc.2 — steps are now `string | (db) => void`.
          // Function steps get the live db handle so they can run
          // probe-then-act helpers (`addColumnIfMissing`) that need
          // PRAGMA table_info to drive a conditional ALTER.
          if (typeof step === "string") {
            this.db.exec(step);
          } else {
            step(this.db);
          }
        }
        this.setSchemaVersion(v);
        // Per-step audit row. INSERT OR IGNORE because migration v=9
        // itself populated rows 1..8 already (back-fill bridge for
        // 0.6.x DBs); it never tries to claim its own row, which the
        // wrapper writes here.
        try {
          this.db
            .prepare("INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (?, ?)")
            .run(v, this.now());
        } catch {
          // schema_version doesn't exist yet — only possible on a
          // pre-9 DB whose current step hasn't created it. The next
          // pass (or migration 9 itself) will back-fill.
        }
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

  /**
   * Run a function inside a single SQLite transaction.
   *
   * Thin wrapper over `this.db.transaction(fn)()` for higher-layer
   * helpers that need to compose multiple `BlockStore` writes
   * atomically without reaching for `rawDb`. The canonical caller is
   * `storeReasoningPattern` (mcp-v2-helpers): the 3-step candidate →
   * origin-ref → active sequence must roll back as a unit on partial
   * failure, otherwise a mid-sequence crash leaves a `candidate`
   * block invisible to read paths (which filter `status='active'`)
   * and orphaned from the case-ref graph.
   *
   * better-sqlite3 implements nested transactions via savepoints, so
   * calling existing methods that internally start their own
   * `db.transaction(...)` (e.g. `attachCaseRef`) from inside this
   * wrapper is safe.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
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

    // 0.7.0-rc.1 §Ground — prompt-injection guard. Scan the
    // user-visible body fields together so a payload split across
    // mechanism + unlock still matches. The dead-ends + guardrails
    // arrays carry agent-supplied prose too.
    const corpus = [
      block.trigger.situation,
      block.body.mechanism,
      block.body.unlock,
      block.body.verification,
      ...(block.body.deadEnds ?? []),
      ...(block.body.guardrails ?? []),
    ].join("\n");
    const injection = detectPromptInjectionPatterns(corpus);
    if (injection) {
      this.recordInjectionRejected("block", injection);
      throw new PromptInjectionError(injection, "block");
    }

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

  /**
   * GDPR Art. 17 hard-delete with audit trail.
   *
   * Removes the reasoning_blocks row (CASCADE sweeps every attached
   * `block_case_refs` row automatically — see schema FK) and writes a
   * tombstone to `audit_deletes`. Both writes happen in a single
   * transaction; on failure neither side persists.
   *
   * Body of the deleted block is intentionally NOT preserved in the
   * audit row — that would defeat the erasure purpose. We keep
   * `block_id`, `deleted_at`, `reason`, and an optional
   * `requesting_principal` so the deletion remains auditable while
   * the content itself is gone. Existing `analytics_events` rows that
   * referenced this block_id are intentionally left in place: they're
   * append-only audit telemetry and the bare id alone is not personal
   * data.
   *
   * Returns true if a block was deleted, false if it did not exist
   * (idempotent — repeat calls are no-ops and write no audit row).
   */
  hardDeleteBlock(
    blockId: string,
    reason: string,
    requestingPrincipal?: string,
  ): boolean {
    const found = this.db
      .prepare("SELECT 1 FROM reasoning_blocks WHERE id = ?")
      .get(blockId);
    if (!found) return false;

    this.transaction(() => {
      this.db.prepare("DELETE FROM reasoning_blocks WHERE id = ?").run(blockId);
      this.db
        .prepare(
          `INSERT INTO audit_deletes (id, block_id, deleted_at, reason, requesting_principal)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          blockId,
          this.now(),
          reason,
          requestingPrincipal ?? null,
        );
    });
    return true;
  }

  /**
   * Hard-delete a project fact (L4 semantic memory) and write a
   * tombstone to `audit_fact_deletes` in a single transaction.
   *
   * Same privacy contract as `hardDeleteBlock`: the fact's
   * `statement` is intentionally NOT preserved in the audit row —
   * we keep `fact_id`, `deleted_at`, `reason`, and an optional
   * `requesting_principal` so the deletion remains auditable while
   * the content is gone. The existing AFTER DELETE trigger on
   * `project_facts` sweeps the FTS index entry; no separate cleanup
   * is required.
   *
   * Returns true if a fact was deleted, false if it did not exist
   * (idempotent — repeat calls write no audit row).
   *
   * Surfaces the GDPR Art. 17 erasure path for the semantic-memory
   * substrate at parity with the procedural one. Without it, an
   * integrator that turns on fact serving would have a soft-only
   * deletion path (`deleteFact`) with no audit trail — which fails
   * the regulator-facing "what got deleted, when, why, by whom"
   * test the procedural side already passes.
   */
  hardDeleteFact(
    factId: string,
    reason: string,
    requestingPrincipal?: string,
  ): boolean {
    const found = this.db
      .prepare("SELECT 1 FROM project_facts WHERE id = ?")
      .get(factId);
    if (!found) return false;

    this.transaction(() => {
      this.db.prepare("DELETE FROM project_facts WHERE id = ?").run(factId);
      this.db
        .prepare(
          `INSERT INTO audit_fact_deletes (id, fact_id, deleted_at, reason, requesting_principal)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          factId,
          this.now(),
          reason,
          requestingPrincipal ?? null,
        );
    });
    return true;
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

    // 0.7.0-rc.1 §Ground — prompt-injection guard. Imported facts
    // (`src.origin === 'imported'`) are tagged with the `imported`
    // surface so the analytics event reflects which pipe the
    // payload tried to enter through.
    const surface: "fact" | "imported" =
      input.source.origin === "imported" ? "imported" : "fact";
    const injection = detectPromptInjectionPatterns(input.statement);
    if (injection) {
      this.recordInjectionRejected(surface, injection);
      throw new PromptInjectionError(injection, surface);
    }

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

    // Absolute expiry timestamp, or null when the caller didn't
    // ask for a TTL. `ttl_until_at` is indexed (partial index on
    // non-null values) so `sweepExpiredFacts` can do a cheap range
    // scan without scanning durable facts.
    const ttlUntilAt =
      input.ttlDays !== undefined && input.ttlDays > 0
        ? now + Math.floor(input.ttlDays * 86_400_000)
        : null;

    this.db
      .prepare(
        `INSERT INTO project_facts (
           id, version, scope, fact_type, statement,
           inv_language, inv_framework, inv_error_type, inv_api_surface,
           src_origin, src_trace_id, src_author, src_reference,
           confidence, last_verified_at, created_at, updated_at, status,
           ttl_until_at, dedupe_key
         ) VALUES (
           @id, @version, @scope, @fact_type, @statement,
           @inv_language, @inv_framework, @inv_error_type, @inv_api_surface,
           @src_origin, @src_trace_id, @src_author, @src_reference,
           @confidence, @last_verified_at, @created_at, @updated_at, @status,
           @ttl_until_at, @dedupe_key
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
        ttl_until_at: ttlUntilAt,
        dedupe_key: dedupeKey,
      });

    return this.getFact(id)!;
  }

  /**
   * Retire expired TTL facts. Rows written with `StoreProjectFactInput.ttlDays`
   * carry a non-null `ttl_until_at` epoch-ms deadline; once the
   * wall-clock is past that deadline, the row's status flips to
   * `retired` so recall stops surfacing it. Durable facts
   * (`ttl_until_at IS NULL`) are never touched.
   *
   * Returns the number of rows transitioned. Called by `tracebase
   * doctor` on every invocation so the sweep is cheap and
   * deterministic — no background scheduler needed.
   */
  sweepExpiredFacts(): number {
    const now = this.now();
    const res = this.db
      .prepare(
        `UPDATE project_facts
            SET status = 'retired', updated_at = ?
          WHERE ttl_until_at IS NOT NULL
            AND ttl_until_at <= ?
            AND status <> 'retired'`,
      )
      .run(now, now);
    return Number(res.changes ?? 0);
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

  /**
   * 0.7.0-rc.1 §hardening — closed surface enum at runtime.
   *
   * The TS type for `recordInjectionRejected.surface` constrains
   * values, but TS is a compile-time guarantee. JS callers + future
   * code paths that build a synthetic event from JSON / DB row /
   * external input could pass an arbitrary string. This Set is the
   * runtime check: if a surface isn't here, the event is dropped
   * before any analytics row writes. The `analytics_events.payload`
   * column never carries a free-form surface value as a result.
   */
  private static readonly KNOWN_INJECTION_SURFACES = new Set<string>([
    "block",
    "fact",
    "imported",
    "indexer",
    "fold",
  ]);

  /**
   * Warn-once trackers for telemetry-side failures inside
   * `recordInjectionRejected`. Static state because there's only one
   * stderr per process and a single warn line per category is enough
   * — the goal is "operator sees something is off in debug mode",
   * not a per-occurrence audit log.
   */
  private static loggedTelemetryFailure = false;
  private static loggedUnknownSurfaces = new Set<string>();

  /**
   * Internal helper: emit a `store.injection_rejected` analytics
   * event when the prompt-injection guard rejects a write.
   *
   * Best-effort — telemetry must never break a user write path. Two
   * defenses:
   *   1. Surface arg is checked against `KNOWN_INJECTION_SURFACES`;
   *      unknown values drop without persisting. Warn-once under
   *      `TRACEBASE_DEBUG=1` so an operator notices in development.
   *   2. `appendEvent` is wrapped in try/catch; any failure logs
   *      warn-once (debug only) and silently returns. The throw the
   *      caller does next (PromptInjectionError) is what enforces
   *      the "no partial content stored" contract — the event is
   *      audit, not enforcement.
   */
  private recordInjectionRejected(
    surface: "block" | "fact" | "imported" | "indexer" | "fold",
    patternName: string,
  ): void {
    if (!BlockStore.KNOWN_INJECTION_SURFACES.has(surface)) {
      // Drop. Don't write an arbitrary surface value to
      // analytics_events.payload — that's a future PII vector.
      BlockStore.warnOnceUnknownSurface(surface);
      return;
    }
    try {
      this.appendEvent({
        ts: this.now(),
        // Synthetic queryId — there's no caller queryId for storage
        // rejections. Prefix marks it as a rejection record so any
        // future query-by-id grep is unambiguous.
        queryId: `injection-reject-${randomUUID()}`,
        event: "store.injection_rejected",
        surface,
        patternName,
      });
    } catch (err) {
      BlockStore.warnOnceTelemetryFailure(err);
    }
  }

  private static warnOnceUnknownSurface(surface: string): void {
    if (BlockStore.loggedUnknownSurfaces.has(surface)) return;
    BlockStore.loggedUnknownSurfaces.add(surface);
    if (process.env.TRACEBASE_DEBUG) {
      // String-coerce to keep stderr safe even if `surface` is a
      // weird object that snuck through a JSON boundary.
      process.stderr.write(
        `[tracebase] dropping injection-reject event with unknown surface: ${String(surface)}\n`,
      );
    }
  }

  private static warnOnceTelemetryFailure(err: unknown): void {
    if (BlockStore.loggedTelemetryFailure) return;
    BlockStore.loggedTelemetryFailure = true;
    if (process.env.TRACEBASE_DEBUG) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[tracebase] injection-reject telemetry append failed (write path unaffected): ${msg}\n`,
      );
    }
  }

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
  // Tool observations (0.5.3 TB TOOL substrate)
  // -------------------------------------------------------------------------

  /**
   * Record a batch of tool observations in a single transaction.
   * Caller is responsible for sanitising `argSummary` / `argKey` —
   * this method NEVER inspects argument content, just persists what
   * the per-tool sanitiser produced. Returns the inserted ids in
   * input order.
   *
   * Empty input is a no-op that returns `[]`. The PostToolBatch hook
   * already filters empty `tool_calls` arrays upstream, but the guard
   * here keeps the contract symmetrical with the rest of the store.
   */
  recordToolObservations(inputs: RecordToolObservationInput[]): string[] {
    if (inputs.length === 0) return [];
    const now = this.now();
    const ids: string[] = [];
    const insert = this.db.prepare(`
      INSERT INTO tool_observations (
        id, ts, session_id, batch_id, batch_order, tool_use_id,
        tool_name, arg_summary, arg_key, outcome, redundant_of, created_at
      ) VALUES (
        @id, @ts, @session_id, @batch_id, @batch_order, @tool_use_id,
        @tool_name, @arg_summary, @arg_key, @outcome, @redundant_of, @created_at
      )
    `);
    const tx = this.db.transaction((rows: RecordToolObservationInput[]) => {
      for (const row of rows) {
        const id = randomUUID();
        ids.push(id);
        insert.run({
          id,
          ts: now,
          session_id: row.sessionId,
          batch_id: row.batchId ?? null,
          batch_order: row.batchOrder,
          tool_use_id: row.toolUseId ?? null,
          tool_name: row.toolName,
          arg_summary: row.argSummary,
          arg_key: row.argKey,
          outcome: row.outcome ?? "unknown",
          redundant_of: null,
          created_at: now,
        });
      }
    });
    tx(inputs);
    return ids;
  }

  /**
   * Last `limit` observations for a session, oldest-first so
   * detection logic walks them in the order they happened. The
   * PostToolBatch hook only writes here; the UserPromptSubmit hook
   * only reads. The (session_id, ts) index keeps the lookup
   * sub-millisecond even on long sessions.
   */
  recentToolObservations(sessionId: string, limit: number = 6): ToolObservation[] {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_observations
         WHERE session_id = ?
         ORDER BY ts DESC, rowid DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as ToolObservationRow[];
    return rows.map((r) => this.rowToToolObservation(r)).reverse();
  }

  /** Test / diagnostic helper. Total observations recorded for a session. */
  countToolObservations(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tool_observations WHERE session_id = ?`,
      )
      .get(sessionId) as { c: number };
    return row.c;
  }

  // -------------------------------------------------------------------------
  // 0.7.0-rc.6 — session_chunks (chunk-based context compression)
  // -------------------------------------------------------------------------

  /**
   * Highest persisted `chunk_end_turn` for a session. The PreCompact
   * folder uses this as the starting watermark — chunks past this
   * index are new candidates; chunks at-or-below are already
   * folded. Returns -1 when the session has no chunks yet.
   */
  latestSessionChunkWatermark(sessionId: string): number {
    try {
      const row = this.db
        .prepare(
          `SELECT MAX(chunk_end_turn) AS m FROM session_chunks WHERE session_id = ?`,
        )
        .get(sessionId) as { m: number | null };
      return typeof row.m === "number" ? row.m : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Insert a batch of `FoldedChunk` rows, idempotent on
   * `(session_id, turn_hash)`. Returns the number of rows actually
   * inserted (already-existing rows count as 0). Used by the
   * PreCompact path; emits one `context.folded` analytics event
   * per inserted row.
   */
  recordSessionChunks(
    rows: ReadonlyArray<{
      sessionId: string;
      chunkStartTurn: number;
      chunkEndTurn: number;
      turnHash: string;
      summary: string;
      tokensBefore: number;
      tokensAfter: number;
      summarizer: string;
      expiresAt: number;
    }>,
  ): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO session_chunks (
         id, session_id, chunk_start_turn, chunk_end_turn,
         turn_hash, summary, tokens_before, tokens_after,
         summarizer, expires_at, created_at
       ) VALUES (
         @id, @session_id, @chunk_start_turn, @chunk_end_turn,
         @turn_hash, @summary, @tokens_before, @tokens_after,
         @summarizer, @expires_at, @created_at
       )`,
    );
    const tNow = this.now();
    let inserted = 0;
    type Mutable<T> = T extends ReadonlyArray<infer U> ? U[] : never;
    const insertedChunks: Mutable<typeof rows> = [];
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        const res = stmt.run({
          id: randomUUID(),
          session_id: r.sessionId,
          chunk_start_turn: r.chunkStartTurn,
          chunk_end_turn: r.chunkEndTurn,
          turn_hash: r.turnHash,
          summary: r.summary,
          tokens_before: r.tokensBefore,
          tokens_after: r.tokensAfter,
          summarizer: r.summarizer,
          expires_at: r.expiresAt,
          created_at: tNow,
        });
        if (res.changes > 0) {
          inserted += 1;
          insertedChunks.push(r);
        }
      }
    });
    tx();

    // Emit one `context.folded` per inserted chunk. Best-effort —
    // telemetry must never break the fold path.
    for (const c of insertedChunks) {
      try {
        this.appendEvent({
          ts: tNow,
          queryId: `context-fold-${randomUUID()}`,
          event: "context.folded",
          sessionId: c.sessionId,
          chunkRange: `${c.chunkStartTurn}-${c.chunkEndTurn}`,
          tokensBefore: c.tokensBefore,
          tokensAfter: c.tokensAfter,
          summarizer:
            c.summarizer === "embedding"
              ? "embedding"
              : c.summarizer === "llm"
                ? "llm"
                : "heuristic",
        });
      } catch {
        // best-effort
      }
    }
    return inserted;
  }

  /**
   * Recall the top-K most recent session chunks for `sessionId`,
   * ordered by `chunk_end_turn DESC`. Returns oldest-first within
   * the K-window so injection prefix order matches the transcript.
   * Empty array when the session has no chunks. Cross-session
   * recall is structurally impossible — the SQL filters on
   * `session_id`.
   *
   * Recency-only contract — used by callers that explicitly want
   * "the last K chunks of this session" (the SDK
   * `runtime.recallChunks` direct surface). The recall path that
   * feeds `<context_fold>` injection uses the prompt-aware variant
   * `recallSessionChunksForPrompt` instead.
   */
  recallSessionChunks(
    sessionId: string,
    limit: number = 3,
  ): Array<{
    chunkStartTurn: number;
    chunkEndTurn: number;
    summary: string;
    tokensBefore: number;
    tokensAfter: number;
  }> {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT chunk_start_turn, chunk_end_turn, summary,
                tokens_before, tokens_after
           FROM session_chunks
          WHERE session_id = ?
          ORDER BY chunk_end_turn DESC, rowid DESC
          LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{
      chunk_start_turn: number;
      chunk_end_turn: number;
      summary: string;
      tokens_before: number;
      tokens_after: number;
    }>;
    return rows
      .map((r) => ({
        chunkStartTurn: r.chunk_start_turn,
        chunkEndTurn: r.chunk_end_turn,
        summary: r.summary,
        tokensBefore: r.tokens_before,
        tokensAfter: r.tokens_after,
      }))
      .reverse();
  }

  /**
   * 0.7.0-rc.6 hardening — prompt-aware chunk recall.
   *
   * Pre-hardening, the recall path reused `recallSessionChunks`
   * which is recency-only. Long sessions with multiple folded
   * topics surfaced the most recent K regardless of which topic
   * the user just asked about — weakening the actual context-
   * compression capability into a recency cache.
   *
   * Post-hardening, callers from `recallForPrompt` use this method
   * instead. Scoring is Jaccard-style token overlap between the
   * prompt and each chunk's `summary` (lowercased, metachar-
   * stripped). Sort by score DESC, recency DESC as tiebreaker.
   * Empty / too-short prompts fall back to recency-only ordering
   * — same shape as the legacy method.
   *
   * Cross-session recall is structurally impossible (the SQL
   * filters on `session_id`).
   */
  recallSessionChunksForPrompt(
    sessionId: string,
    prompt: string,
    limit: number = 3,
  ): Array<{
    chunkStartTurn: number;
    chunkEndTurn: number;
    summary: string;
    tokensBefore: number;
    tokensAfter: number;
  }> {
    if (limit <= 0) return [];
    // 0.7.0-rc.6 hardening 2 — score ALL same-session chunks, not
    // a recency-capped pre-fetch. Pre-hardening this query was
    // `LIMIT 32`, which silently dropped older folded topics from
    // ever resurfacing in a long session — leaving the recall
    // partly recency-bound even though scoring ran.
    //
    // session_chunks rows are bounded per workspace by the
    // 14-day TTL (`expires_at`) the PreCompact path stamps at
    // write time, so a "no LIMIT" walk stays small enough to
    // score in JS without I/O concerns. The hard ceiling below
    // is a defense-in-depth — pathological 100k-row sessions
    // still get capped, but the cap is set well above any
    // realistic single-workspace fold count.
    const HARD_CEILING = 4_096;
    const rows = this.db
      .prepare(
        `SELECT chunk_start_turn, chunk_end_turn, summary,
                tokens_before, tokens_after
           FROM session_chunks
          WHERE session_id = ?
          ORDER BY chunk_end_turn DESC, rowid DESC
          LIMIT ?`,
      )
      .all(sessionId, HARD_CEILING) as Array<{
      chunk_start_turn: number;
      chunk_end_turn: number;
      summary: string;
      tokens_before: number;
      tokens_after: number;
    }>;
    if (rows.length === 0) return [];

    const promptTokens = tokeniseForChunkRecall(prompt);
    if (promptTokens.size === 0) {
      // No usable signal in the prompt → fall back to recency,
      // same shape as `recallSessionChunks`.
      return rows
        .slice(0, limit)
        .map((r) => ({
          chunkStartTurn: r.chunk_start_turn,
          chunkEndTurn: r.chunk_end_turn,
          summary: r.summary,
          tokensBefore: r.tokens_before,
          tokensAfter: r.tokens_after,
        }))
        .reverse();
    }

    // Score each row by token-overlap fraction against the prompt
    // token set. Recency (chunk_end_turn DESC) is the tiebreaker.
    const scored = rows.map((r, idx) => {
      const summaryTokens = tokeniseForChunkRecall(r.summary);
      let overlap = 0;
      for (const t of promptTokens) if (summaryTokens.has(t)) overlap++;
      const denom = Math.max(1, summaryTokens.size + promptTokens.size - overlap);
      const score = overlap / denom; // Jaccard
      return {
        score,
        idx,
        row: r,
      };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Earlier idx == newer (rows came back chunk_end_turn DESC).
      return a.idx - b.idx;
    });
    // If every score is zero, no token overlap found — fall back
    // to recency. Otherwise pick the top-K by score+tiebreaker.
    const anyHit = scored.some((s) => s.score > 0);
    const picked = (anyHit ? scored : scored).slice(0, limit);

    return picked
      .map((s) => ({
        chunkStartTurn: s.row.chunk_start_turn,
        chunkEndTurn: s.row.chunk_end_turn,
        summary: s.row.summary,
        tokensBefore: s.row.tokens_before,
        tokensAfter: s.row.tokens_after,
      }))
      // Final ordering for injection: oldest-first within the K-
      // window so the prompt prefix reads chronologically when
      // chunks share the same score.
      .sort((a, b) => a.chunkStartTurn - b.chunkStartTurn);
  }

  /** Diagnostic count helper used by the doctor / tests. */
  countSessionChunks(sessionId: string): number {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM session_chunks WHERE session_id = ?`,
        )
        .get(sessionId) as { c: number };
      return row.c;
    } catch {
      return 0;
    }
  }

  /**
   * 0.5.4 §6 — aggregate counts over `tool_observations` for the
   * given window. Returns the per-(session_id, arg_key) buckets
   * the auto-sync coordinator turns into TB TOOL / TB LOOP cloud
   * counts. Caller does the family normalisation + bucket
   * thresholds; this method only joins on the index and emits
   * raw counts so it stays cheap.
   *
   * Window is `[afterTs, beforeTs)` — half-open like the rest of
   * the analytics aggregator.
   */
  toolObservationStats(
    afterTs: number,
    beforeTs: number,
  ): { totalRows: number; perKey: Map<string, { sessionId: string; toolName: string; count: number }> } {
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tool_observations
         WHERE ts >= ? AND ts < ?`,
      )
      .get(afterTs, beforeTs) as { c: number };

    const perKey = new Map<
      string,
      { sessionId: string; toolName: string; count: number }
    >();
    if (totalRow.c === 0) {
      return { totalRows: 0, perKey };
    }
    type Row = { session_id: string; arg_key: string; tool_name: string; n: number };
    const rows = this.db
      .prepare(
        `SELECT session_id, arg_key, tool_name, COUNT(*) AS n
         FROM tool_observations
         WHERE ts >= ? AND ts < ?
         GROUP BY session_id, arg_key, tool_name`,
      )
      .all(afterTs, beforeTs) as Row[];
    for (const r of rows) {
      perKey.set(`${r.session_id}:${r.arg_key}`, {
        sessionId: r.session_id,
        toolName: r.tool_name,
        count: r.n,
      });
    }
    return { totalRows: totalRow.c, perKey };
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

  private rowToToolObservation(r: ToolObservationRow): ToolObservation {
    return {
      id: r.id,
      ts: r.ts,
      sessionId: r.session_id,
      batchId: r.batch_id ?? null,
      batchOrder: r.batch_order,
      toolUseId: r.tool_use_id ?? null,
      toolName: r.tool_name,
      argSummary: r.arg_summary,
      argKey: r.arg_key,
      outcome: (r.outcome as ToolObservationOutcome) ?? "unknown",
      redundantOf: r.redundant_of ?? null,
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
      ...(r.ttl_until_at !== null ? { ttlUntilAt: r.ttl_until_at } : {}),
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
 * 0.7.0-rc.6 hardening — tokenise prompt / chunk summary for
 * chunk-recall scoring. Same lexical shape as `intentKeyTokens`
 * in `src/core/intent-key.ts` (lowercase, regex-metachars stripped,
 * `[_-]` and whitespace collapsed) so the scoring is stable
 * across alias variants. Stop-words filter prevents trivial
 * filler tokens (`the`, `and`, `for`, etc.) from inflating the
 * Jaccard denominator.
 */
const CHUNK_RECALL_STOPWORDS = new Set<string>([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "not", "if", "then", "else", "when", "while",
  "of", "in", "on", "at", "by", "for", "with", "to", "from", "as",
  "this", "that", "these", "those", "it", "its", "they", "them",
  "what", "which", "who", "how", "why", "where",
  "i", "we", "you", "he", "she",
  "user", "asked", "assistant",
]);

function tokeniseForChunkRecall(s: string): Set<string> {
  if (typeof s !== "string" || s.length === 0) return new Set();
  const lowered = s
    .toLowerCase()
    .replace(/[*?[\]()\\^$+|.{}/#'"`]/g, " ")
    .replace(/[_\-\s]+/g, " ")
    .trim();
  const out = new Set<string>();
  for (const t of lowered.split(/\s+/)) {
    if (t.length < 2) continue;
    if (CHUNK_RECALL_STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
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
  ttl_until_at: number | null;
  dedupe_key: string;
}

interface ToolObservationRow {
  id: string;
  ts: number;
  session_id: string;
  batch_id: string | null;
  batch_order: number;
  tool_use_id: string | null;
  tool_name: string;
  arg_summary: string;
  arg_key: string;
  outcome: string;
  redundant_of: string | null;
  created_at: number;
}
