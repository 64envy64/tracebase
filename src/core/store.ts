import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type {
  ReasoningTrace,
  Problem,
  Solution,
  TraceMetadata,
  QualityMetrics,
  StorageStats,
  SimilaritySignals,
} from "../types.js";
import { encodeFloat32LE, decodeFloat32 } from "./embedding-codec.js";

// ============================================================================
// Schema — Version 2
//
// v1 → v2 changes:
//   - Added p_tokens (cached tokenized problem for Jaccard without recompute)
//   - Added p_features (cached extracted features for structural matching)
//   - Added feedback_signals table (for adaptive weight learning)
//   - Fixed FTS UPDATE trigger (only fires on content column changes)
//   - Fixed prune to handle never-recalled traces via age-based fallback
//   - Added index on p_file_path
// ============================================================================

// V4 (May-2026 PR 3 of the modernization):
//   - feedback_signals gains `sig_cosine` and `sig_freshness` columns
//     (audit #8: cosine + freshness were silently dropped, breaking
//     weight learning for the embeddings-on path).
//   - `pending_embeddings` table for the retry queue on failed
//     embedding writes (replaces the pre-PR-3 silent `catch {}` in
//     `engine.storeTraceAsync`).
const SCHEMA_VERSION = 4;

const SCHEMA_V2 = `
-- Core trace storage
CREATE TABLE IF NOT EXISTS traces (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  -- Problem
  p_description   TEXT NOT NULL,
  p_error_type    TEXT,
  p_error_message TEXT,
  p_stack_trace   TEXT,
  p_file_path     TEXT,
  p_language      TEXT,
  p_framework     TEXT,
  p_tags          TEXT NOT NULL DEFAULT '[]',
  p_fingerprint   TEXT NOT NULL,

  -- Cached similarity data (computed at store time, avoids recomputation)
  p_tokens        TEXT,   -- JSON array of normalized tokens
  p_features      TEXT,   -- JSON object of extracted features

  -- Solution
  s_summary       TEXT NOT NULL,
  s_steps         TEXT NOT NULL DEFAULT '[]',
  s_outcome       TEXT NOT NULL CHECK(s_outcome IN ('success','failure','partial')),
  s_diff          TEXT,
  s_explanation   TEXT,

  -- Metadata
  m_agent         TEXT NOT NULL DEFAULT 'unknown',
  m_model         TEXT,
  m_tokens_used   INTEGER,
  m_duration_ms   INTEGER,
  m_source        TEXT,
  m_custom        TEXT,

  -- Quality
  q_recall_count      INTEGER NOT NULL DEFAULT 0,
  q_helpful_count     INTEGER NOT NULL DEFAULT 0,
  q_last_recalled_at  INTEGER,
  q_score             REAL NOT NULL DEFAULT 0.5,

  -- Provenance (v3)
  prov_origin         TEXT NOT NULL DEFAULT 'local',
  prov_author         TEXT,
  prov_verified_by    TEXT NOT NULL DEFAULT '[]',
  prov_applied_count  INTEGER NOT NULL DEFAULT 0,
  prov_last_applied   INTEGER,

  -- Embeddings (optional, stored as Float32Array binary)
  embedding_problem   BLOB,
  embedding_solution  BLOB
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_fingerprint  ON traces(p_fingerprint);
CREATE INDEX IF NOT EXISTS idx_error_type   ON traces(p_error_type);
CREATE INDEX IF NOT EXISTS idx_language     ON traces(p_language);
CREATE INDEX IF NOT EXISTS idx_framework    ON traces(p_framework);
CREATE INDEX IF NOT EXISTS idx_file_path    ON traces(p_file_path);
CREATE INDEX IF NOT EXISTS idx_outcome      ON traces(s_outcome);
CREATE INDEX IF NOT EXISTS idx_score        ON traces(q_score DESC);
CREATE INDEX IF NOT EXISTS idx_created      ON traces(created_at DESC);

-- Full-text search via FTS5 with BM25 ranking
-- Uses porter stemmer + unicode61 tokenizer for broad matching
CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts USING fts5(
  p_description,
  s_summary,
  s_explanation,
  p_tags,
  p_error_message,
  content='traces',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- FTS sync: INSERT
CREATE TRIGGER IF NOT EXISTS traces_fts_insert AFTER INSERT ON traces BEGIN
  INSERT INTO traces_fts(rowid, p_description, s_summary, s_explanation, p_tags, p_error_message)
  VALUES (new.rowid, new.p_description, new.s_summary, new.s_explanation, new.p_tags, new.p_error_message);
END;

-- FTS sync: DELETE
CREATE TRIGGER IF NOT EXISTS traces_fts_delete AFTER DELETE ON traces BEGIN
  INSERT INTO traces_fts(traces_fts, rowid, p_description, s_summary, s_explanation, p_tags, p_error_message)
  VALUES ('delete', old.rowid, old.p_description, old.s_summary, old.s_explanation, old.p_tags, old.p_error_message);
END;

-- FTS sync: UPDATE — only fires when FTS-indexed content columns change
-- (avoids unnecessary FTS churn on quality metric updates)
CREATE TRIGGER IF NOT EXISTS traces_fts_update_v2
  AFTER UPDATE OF p_description, s_summary, s_explanation, p_tags, p_error_message ON traces
BEGIN
  INSERT INTO traces_fts(traces_fts, rowid, p_description, s_summary, s_explanation, p_tags, p_error_message)
  VALUES ('delete', old.rowid, old.p_description, old.s_summary, old.s_explanation, old.p_tags, old.p_error_message);
  INSERT INTO traces_fts(rowid, p_description, s_summary, s_explanation, p_tags, p_error_message)
  VALUES (new.rowid, new.p_description, new.s_summary, new.s_explanation, new.p_tags, new.p_error_message);
END;

-- Schema versioning
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Config key-value store (also used for adaptive weight state)
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Feedback signal log for adaptive weight learning
-- Records which signals contributed to each helpful/unhelpful recall.
-- May-2026 PR 3: sig_cosine + sig_freshness added (audit #8). All five
-- signal contributions are now logged so V1 weight learning works on
-- the embeddings-on path identically to the embeddings-off path.
CREATE TABLE IF NOT EXISTS feedback_signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id        TEXT NOT NULL,
  helpful         INTEGER NOT NULL,
  sig_fingerprint REAL NOT NULL DEFAULT 0,
  sig_bm25        REAL NOT NULL DEFAULT 0,
  sig_jaccard     REAL NOT NULL DEFAULT 0,
  sig_structural  REAL NOT NULL DEFAULT 0,
  sig_cosine      REAL NOT NULL DEFAULT 0,
  sig_freshness   REAL NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_trace ON feedback_signals(trace_id);

-- May-2026 PR 3: pending embeddings retry queue.
-- Replaces the silent catch in engine.storeTraceAsync (audit #1).
-- Each row records a failed embedding attempt; the queue is drained
-- opportunistically on every store() and forced by doctor --fix.
CREATE TABLE IF NOT EXISTS pending_embeddings (
  trace_id     TEXT PRIMARY KEY,
  last_error   TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  enqueued_at  INTEGER NOT NULL,
  last_try_at  INTEGER,
  FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_embeddings_enqueued ON pending_embeddings(enqueued_at);
`;

// ============================================================================
// Migration helpers
// ============================================================================

const MIGRATIONS: Record<number, string[]> = {
  2: [
    // Add cached token/feature columns (safe on existing tables)
    "ALTER TABLE traces ADD COLUMN p_tokens TEXT",
    "ALTER TABLE traces ADD COLUMN p_features TEXT",
    // Add file path index
    "CREATE INDEX IF NOT EXISTS idx_file_path ON traces(p_file_path)",
    // Drop the old catch-all UPDATE trigger that fires on quality updates
    "DROP TRIGGER IF EXISTS traces_fts_update",
    // Create feedback_signals table
    `CREATE TABLE IF NOT EXISTS feedback_signals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id        TEXT NOT NULL,
      helpful         INTEGER NOT NULL,
      sig_fingerprint REAL NOT NULL DEFAULT 0,
      sig_bm25        REAL NOT NULL DEFAULT 0,
      sig_jaccard     REAL NOT NULL DEFAULT 0,
      sig_structural  REAL NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_feedback_trace ON feedback_signals(trace_id)",
    // Create config table
    "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ],
  3: [
    // Provenance columns
    "ALTER TABLE traces ADD COLUMN prov_origin TEXT NOT NULL DEFAULT 'local'",
    "ALTER TABLE traces ADD COLUMN prov_author TEXT",
    "ALTER TABLE traces ADD COLUMN prov_verified_by TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE traces ADD COLUMN prov_applied_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE traces ADD COLUMN prov_last_applied INTEGER",
    // Compound indexes for scale (Task #9)
    "CREATE INDEX IF NOT EXISTS idx_quality_recall ON traces(q_score DESC, q_recall_count DESC)",
    "CREATE INDEX IF NOT EXISTS idx_has_embedding ON traces(id) WHERE embedding_problem IS NOT NULL",
  ],
  4: [
    // May-2026 PR 3 — full signal logging + pending-embeddings retry queue.
    "ALTER TABLE feedback_signals ADD COLUMN sig_cosine REAL NOT NULL DEFAULT 0",
    "ALTER TABLE feedback_signals ADD COLUMN sig_freshness REAL NOT NULL DEFAULT 0",
    `CREATE TABLE IF NOT EXISTS pending_embeddings (
      trace_id     TEXT PRIMARY KEY,
      last_error   TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      enqueued_at  INTEGER NOT NULL,
      last_try_at  INTEGER,
      FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
    )`,
    "CREATE INDEX IF NOT EXISTS idx_pending_embeddings_enqueued ON pending_embeddings(enqueued_at)",
  ],
};

// ============================================================================
// Store Implementation
// ============================================================================

export class TraceStore {
  private db: Database.Database;
  private stmts!: ReturnType<typeof this.prepareStatements>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.configure();
    this.migrate();
    this.stmts = this.prepareStatements();
  }

  /** SQLite pragmas for performance and reliability. */
  private configure(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("temp_store = MEMORY");
  }

  /** Run schema creation and incremental migrations. */
  private migrate(): void {
    const currentVersion = this.getSchemaVersion();

    if (currentVersion === 0) {
      // Fresh database — create full v2 schema
      this.db.exec(SCHEMA_V2);
      this.setSchemaVersion(SCHEMA_VERSION);
      return;
    }

    // Incremental migration for existing databases
    for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
      const steps = MIGRATIONS[v];
      if (!steps) continue;

      const tx = this.db.transaction(() => {
        for (const sql of steps) {
          try {
            this.db.exec(sql);
          } catch {
            // Column/index may already exist — safe to skip
          }
        }
        this.setSchemaVersion(v);
      });
      tx();
    }
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
        .get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  }

  private setSchemaVersion(v: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
      )
      .run(String(v));
  }

  /** Prepare frequently-used statements for performance. */
  private prepareStatements() {
    return {
      insert: this.db.prepare(`
        INSERT INTO traces (
          id, created_at, updated_at,
          p_description, p_error_type, p_error_message, p_stack_trace,
          p_file_path, p_language, p_framework, p_tags, p_fingerprint,
          p_tokens, p_features,
          s_summary, s_steps, s_outcome, s_diff, s_explanation,
          m_agent, m_model, m_tokens_used, m_duration_ms, m_source, m_custom,
          q_recall_count, q_helpful_count, q_last_recalled_at, q_score,
          prov_origin, prov_author, prov_verified_by, prov_applied_count, prov_last_applied,
          embedding_problem, embedding_solution
        ) VALUES (
          @id, @created_at, @updated_at,
          @p_description, @p_error_type, @p_error_message, @p_stack_trace,
          @p_file_path, @p_language, @p_framework, @p_tags, @p_fingerprint,
          @p_tokens, @p_features,
          @s_summary, @s_steps, @s_outcome, @s_diff, @s_explanation,
          @m_agent, @m_model, @m_tokens_used, @m_duration_ms, @m_source, @m_custom,
          @q_recall_count, @q_helpful_count, @q_last_recalled_at, @q_score,
          @prov_origin, @prov_author, @prov_verified_by, @prov_applied_count, @prov_last_applied,
          @embedding_problem, @embedding_solution
        )
      `),

      getById: this.db.prepare("SELECT * FROM traces WHERE id = ?"),

      getByFingerprint: this.db.prepare(
        "SELECT * FROM traces WHERE p_fingerprint = ? ORDER BY q_score DESC LIMIT ?",
      ),

      searchFts: this.db.prepare(`
        SELECT traces.*, bm25(traces_fts, 5.0, 3.0, 2.0, 1.0, 2.0) AS rank
        FROM traces_fts
        JOIN traces ON traces.rowid = traces_fts.rowid
        WHERE traces_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),

      updateQuality: this.db.prepare(`
        UPDATE traces
        SET q_recall_count = @recall_count,
            q_helpful_count = @helpful_count,
            q_last_recalled_at = @last_recalled_at,
            q_score = @score,
            updated_at = @updated_at
        WHERE id = @id
      `),

      deleteById: this.db.prepare("DELETE FROM traces WHERE id = ?"),

      countAll: this.db.prepare("SELECT COUNT(*) as count FROM traces"),

      listRecent: this.db.prepare(
        "SELECT * FROM traces ORDER BY created_at DESC LIMIT ? OFFSET ?",
      ),

      deleteOldest: this.db.prepare(
        "DELETE FROM traces WHERE id IN (SELECT id FROM traces ORDER BY created_at ASC LIMIT ?)",
      ),

      insertFeedback: this.db.prepare(`
        INSERT INTO feedback_signals (trace_id, helpful, sig_fingerprint, sig_bm25, sig_jaccard, sig_structural, sig_cosine, sig_freshness, created_at)
        VALUES (@trace_id, @helpful, @sig_fingerprint, @sig_bm25, @sig_jaccard, @sig_structural, @sig_cosine, @sig_freshness, @created_at)
      `),

      // May-2026 PR 3 — pending-embeddings retry queue.
      enqueuePendingEmbedding: this.db.prepare(`
        INSERT INTO pending_embeddings (trace_id, last_error, attempts, enqueued_at, last_try_at)
        VALUES (@trace_id, @last_error, 0, @now, NULL)
        ON CONFLICT (trace_id) DO UPDATE SET
          last_error = excluded.last_error,
          last_try_at = excluded.last_try_at
      `),
      bumpPendingEmbeddingAttempt: this.db.prepare(`
        UPDATE pending_embeddings
        SET attempts = attempts + 1, last_try_at = @now, last_error = @last_error
        WHERE trace_id = @trace_id
      `),
      removePendingEmbedding: this.db.prepare("DELETE FROM pending_embeddings WHERE trace_id = ?"),
      listPendingEmbeddings: this.db.prepare(`
        SELECT trace_id, last_error, attempts, enqueued_at, last_try_at
        FROM pending_embeddings
        ORDER BY enqueued_at ASC
        LIMIT @limit
      `),
      countPendingEmbeddings: this.db.prepare(
        "SELECT COUNT(*) AS count FROM pending_embeddings",
      ),

      existsByFingerprint: this.db.prepare(
        "SELECT id FROM traces WHERE p_fingerprint = ? LIMIT 1",
      ),

      candidatesFiltered: this.db.prepare(`
        SELECT * FROM traces
        WHERE (@lang IS NULL OR p_language = @lang)
          AND (@fw IS NULL OR p_framework = @fw)
          AND (@err IS NULL OR p_error_type = @err)
        ORDER BY q_score DESC
        LIMIT @limit
      `),

      countEligible: this.db.prepare(`
        SELECT COUNT(*) AS count FROM traces
        WHERE (@lang IS NULL OR p_language = @lang)
          AND (@fw IS NULL OR p_framework = @fw)
          AND (@err IS NULL OR p_error_type = @err)
      `),

      searchLike: this.db.prepare(`
        SELECT *, -1 AS rank FROM traces
        WHERE p_description LIKE @pattern
           OR s_summary LIKE @pattern
           OR p_error_message LIKE @pattern
        ORDER BY q_score DESC
        LIMIT @limit
      `),
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Store a new reasoning trace. Returns the generated ID. */
  store(trace: ReasoningTrace, cachedTokens?: string[], cachedFeatures?: Record<string, unknown>): string {
    const params = this.traceToRow(trace, cachedTokens, cachedFeatures);
    this.stmts.insert.run(params);
    return trace.id;
  }

  /** Store a trace, computing ID and timestamps automatically. */
  storeNew(
    problem: Problem,
    solution: Solution,
    metadata: TraceMetadata,
    cachedTokens?: string[],
    cachedFeatures?: Record<string, unknown>,
  ): ReasoningTrace {
    const now = Date.now();
    const trace: ReasoningTrace = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      problem,
      solution,
      metadata,
      quality: {
        recallCount: 0,
        helpfulCount: 0,
        score: 0.5,
      },
      provenance: {
        origin: "local",
        author: metadata.agent,
        appliedCount: 0,
      },
    };
    this.store(trace, cachedTokens, cachedFeatures);
    return trace;
  }

  /** Get a trace by its ID. */
  getById(id: string): ReasoningTrace | null {
    const row = this.stmts.getById.get(id) as RawRow | undefined;
    return row ? this.rowToTrace(row) : null;
  }

  /** Check if a trace with this fingerprint already exists. */
  existsByFingerprint(fingerprint: string): string | null {
    const row = this.stmts.existsByFingerprint.get(fingerprint) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Find traces with an exact fingerprint match. Returns with cached tokens/features. */
  getByFingerprint(fingerprint: string, limit = 5): CachedTraceRow[] {
    const rows = this.stmts.getByFingerprint.all(fingerprint, limit) as RawRow[];
    return rows.map((r) => this.rowToCachedTrace(r));
  }

  /**
   * Full-text search using SQLite FTS5 with BM25 ranking.
   * Query terms are ANDed for precision.
   */
  searchFts(
    query: string,
    limit = 10,
  ): Array<{ trace: ReasoningTrace; rank: number; cachedTokens?: string[]; cachedFeatures?: Record<string, unknown> }> {
    const sanitized = this.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    try {
      const rows = this.stmts.searchFts.all(sanitized, limit) as Array<
        RawRow & { rank: number }
      >;
      return rows.map((r) => ({
        trace: this.rowToTrace(r),
        rank: r.rank,
        cachedTokens: r.p_tokens ? (JSON.parse(r.p_tokens) as string[]) : undefined,
        cachedFeatures: r.p_features ? (JSON.parse(r.p_features) as Record<string, unknown>) : undefined,
      }));
    } catch {
      return this.searchLike(query, limit);
    }
  }

  /** Get candidates with optional pre-filtering by language/framework/errorType.
   *  Uses a single prepared statement with IS NULL coalescing. */
  getCandidatesFiltered(
    filters: { language?: string; framework?: string; errorType?: string },
    limit: number,
  ): CachedTraceRow[] {
    const rows = this.stmts.candidatesFiltered.all({
      lang: filters.language ?? null,
      fw: filters.framework ?? null,
      err: filters.errorType ?? null,
      limit,
    }) as RawRow[];
    return rows.map((r) => this.rowToCachedTrace(r));
  }

  /**
   * Count traces matching the same hard filters as
   * `getCandidatesFiltered`, without fetching rows.
   *
   * Used by the BM25 small-corpus damping path (`similarity.ts`):
   * the damping factor is keyed on the size of the **searchable
   * corpus** after hard filters, NOT on `ftsResults.length`. A
   * legitimately rare query that returns 2 FTS hits against a
   * 5000-row searchable corpus must NOT be damped — it's the
   * corpus size that says "BM25 has nothing meaningful to do".
   */
  countEligible(filters: { language?: string; framework?: string; errorType?: string }): number {
    const row = this.stmts.countEligible.get({
      lang: filters.language ?? null,
      fw: filters.framework ?? null,
      err: filters.errorType ?? null,
    }) as { count: number };
    return row.count;
  }

  /** Fallback LIKE-based search when FTS query fails. Uses prepared statement. */
  private searchLike(
    query: string,
    limit: number,
  ): Array<{ trace: ReasoningTrace; rank: number }> {
    const rows = this.stmts.searchLike.all({
      pattern: `%${query}%`,
      limit,
    }) as Array<RawRow & { rank: number }>;
    return rows.map((r) => ({
      trace: this.rowToTrace(r),
      rank: r.rank,
    }));
  }

  /** Update quality metrics for a trace. */
  updateQuality(id: string, metrics: QualityMetrics): void {
    this.stmts.updateQuality.run({
      id,
      recall_count: metrics.recallCount,
      helpful_count: metrics.helpfulCount,
      last_recalled_at: metrics.lastRecalledAt ?? null,
      score: metrics.score,
      updated_at: Date.now(),
    });
  }

  /**
   * Record a feedback event with signal contributions.
   * This is the ONLY method that should modify recall counts.
   */
  recordFeedback(id: string, helpful: boolean, signals?: SimilaritySignals): void {
    const trace = this.getById(id);
    if (!trace) return;

    const q = trace.quality;
    q.recallCount += 1;
    if (helpful) q.helpfulCount += 1;
    q.lastRecalledAt = Date.now();
    q.score = this.computeQualityScore(q);
    this.updateQuality(id, q);

    // Log signal contributions for adaptive weight learning.
    // May-2026 PR 3: cosine + freshness now persisted (audit #8). Pre-PR-3
    // these were silently dropped, which meant the embeddings-on path
    // couldn't learn from feedback even though the model carried a
    // cosine Beta posterior.
    if (signals) {
      this.stmts.insertFeedback.run({
        trace_id: id,
        helpful: helpful ? 1 : 0,
        sig_fingerprint: signals.fingerprint,
        sig_bm25: signals.bm25,
        sig_jaccard: signals.jaccard,
        sig_structural: signals.structural,
        sig_cosine: signals.cosine,
        sig_freshness: signals.freshness,
        created_at: Date.now(),
      });
    }
  }

  // -------------------------------------------------------------------
  // Pending embeddings retry queue (May-2026 PR 3, audit #1).
  // -------------------------------------------------------------------

  /** Mark a traceId as needing an embedding retry. Idempotent. */
  enqueuePendingEmbedding(traceId: string, error: string): void {
    this.stmts.enqueuePendingEmbedding.run({
      trace_id: traceId,
      last_error: error.slice(0, 500), // bound the row size
      now: Date.now(),
    });
  }

  /** Bump the attempt counter + error for an existing pending row. */
  bumpPendingEmbeddingAttempt(traceId: string, error: string): void {
    this.stmts.bumpPendingEmbeddingAttempt.run({
      trace_id: traceId,
      last_error: error.slice(0, 500),
      now: Date.now(),
    });
  }

  /** Remove a pending entry — call after a successful re-embed. */
  removePendingEmbedding(traceId: string): void {
    this.stmts.removePendingEmbedding.run(traceId);
  }

  /** List up to `limit` pending entries in enqueue order. */
  listPendingEmbeddings(limit = 32): Array<{
    traceId: string;
    lastError: string | null;
    attempts: number;
    enqueuedAt: number;
    lastTryAt: number | null;
  }> {
    const rows = this.stmts.listPendingEmbeddings.all({ limit }) as Array<{
      trace_id: string;
      last_error: string | null;
      attempts: number;
      enqueued_at: number;
      last_try_at: number | null;
    }>;
    return rows.map((r) => ({
      traceId: r.trace_id,
      lastError: r.last_error,
      attempts: r.attempts,
      enqueuedAt: r.enqueued_at,
      lastTryAt: r.last_try_at,
    }));
  }

  /** Count rows in the pending queue. */
  countPendingEmbeddings(): number {
    const row = this.stmts.countPendingEmbeddings.get() as { count: number };
    return row.count;
  }

  /** Delete a trace. */
  delete(id: string): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }

  /** Total number of stored traces. */
  count(): number {
    const row = this.stmts.countAll.get() as { count: number };
    return row.count;
  }

  /** List recent traces with pagination. */
  listRecent(limit = 20, offset = 0): ReasoningTrace[] {
    const rows = this.stmts.listRecent.all(limit, offset) as RawRow[];
    return rows.map((r) => this.rowToTrace(r));
  }

  /**
   * Prune low-quality traces. Returns number pruned.
   * Two strategies:
   *   1. Quality-based: remove recalled traces below threshold
   *   2. Age-based: remove oldest un-recalled traces exceeding maxCount
   */
  prune(threshold: number, maxCount?: number): number {
    let pruned = 0;

    // Strategy 1: Remove low-quality recalled traces
    const qualityResult = this.db
      .prepare("DELETE FROM traces WHERE q_score < ? AND q_recall_count > 0")
      .run(threshold);
    pruned += qualityResult.changes;

    // Strategy 2: If still over limit, remove oldest un-recalled traces
    if (maxCount && maxCount > 0) {
      const current = this.count();
      if (current > maxCount) {
        const excess = current - maxCount;
        const ageResult = this.stmts.deleteOldest.run(excess);
        pruned += ageResult.changes;
      }
    }

    return pruned;
  }

  /** Aggregate statistics about stored traces. */
  stats(): StorageStats {
    const total = this.count();

    const outcomes = this.db
      .prepare(
        "SELECT s_outcome, COUNT(*) as count FROM traces GROUP BY s_outcome",
      )
      .all() as Array<{ s_outcome: string; count: number }>;

    const outcomeCounts: Record<string, number> = {};
    for (const row of outcomes) {
      outcomeCounts[row.s_outcome] = row.count;
    }

    const avgScore = this.db
      .prepare("SELECT AVG(q_score) as avg FROM traces")
      .get() as { avg: number | null };

    const totalRecalls = this.db
      .prepare("SELECT SUM(q_recall_count) as total FROM traces")
      .get() as { total: number | null };

    const totalHelpful = this.db
      .prepare("SELECT SUM(q_helpful_count) as total FROM traces")
      .get() as { total: number | null };

    const topLanguages = this.db
      .prepare(
        "SELECT p_language as language, COUNT(*) as count FROM traces WHERE p_language IS NOT NULL GROUP BY p_language ORDER BY count DESC LIMIT 10",
      )
      .all() as Array<{ language: string; count: number }>;

    const topFrameworks = this.db
      .prepare(
        "SELECT p_framework as framework, COUNT(*) as count FROM traces WHERE p_framework IS NOT NULL GROUP BY p_framework ORDER BY count DESC LIMIT 10",
      )
      .all() as Array<{ framework: string; count: number }>;

    const topErrorTypes = this.db
      .prepare(
        "SELECT p_error_type as errorType, COUNT(*) as count FROM traces WHERE p_error_type IS NOT NULL GROUP BY p_error_type ORDER BY count DESC LIMIT 10",
      )
      .all() as Array<{ errorType: string; count: number }>;

    const timeRange = this.db
      .prepare(
        "SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM traces",
      )
      .get() as { oldest: number | null; newest: number | null };

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(this.db.name).size;
    } catch {
      // in-memory DB
    }

    return {
      totalTraces: total,
      successfulTraces: outcomeCounts["success"] ?? 0,
      failedTraces: outcomeCounts["failure"] ?? 0,
      partialTraces: outcomeCounts["partial"] ?? 0,
      avgQualityScore: avgScore.avg ?? 0,
      totalRecalls: totalRecalls.total ?? 0,
      totalHelpful: totalHelpful.total ?? 0,
      topLanguages,
      topFrameworks,
      topErrorTypes,
      oldestTrace: timeRange.oldest ?? undefined,
      newestTrace: timeRange.newest ?? undefined,
      dbSizeBytes,
    };
  }

  /** Export all traces as an array. */
  exportAll(): ReasoningTrace[] {
    const rows = this.db
      .prepare("SELECT * FROM traces ORDER BY created_at ASC")
      .all() as RawRow[];
    return rows.map((r) => this.rowToTrace(r));
  }

  /** Import traces from an array. Uses INSERT OR IGNORE for dedup efficiency. */
  importTraces(traces: ReasoningTrace[]): number {
    let imported = 0;
    const insertOrIgnore = this.db.prepare(`
      INSERT OR IGNORE INTO traces (
        id, created_at, updated_at,
        p_description, p_error_type, p_error_message, p_stack_trace,
        p_file_path, p_language, p_framework, p_tags, p_fingerprint,
        p_tokens, p_features,
        s_summary, s_steps, s_outcome, s_diff, s_explanation,
        m_agent, m_model, m_tokens_used, m_duration_ms, m_source, m_custom,
        q_recall_count, q_helpful_count, q_last_recalled_at, q_score,
        prov_origin, prov_author, prov_verified_by, prov_applied_count, prov_last_applied,
        embedding_problem, embedding_solution
      ) VALUES (
        @id, @created_at, @updated_at,
        @p_description, @p_error_type, @p_error_message, @p_stack_trace,
        @p_file_path, @p_language, @p_framework, @p_tags, @p_fingerprint,
        @p_tokens, @p_features,
        @s_summary, @s_steps, @s_outcome, @s_diff, @s_explanation,
        @m_agent, @m_model, @m_tokens_used, @m_duration_ms, @m_source, @m_custom,
        @q_recall_count, @q_helpful_count, @q_last_recalled_at, @q_score,
        @prov_origin, @prov_author, @prov_verified_by, @prov_applied_count, @prov_last_applied,
        @embedding_problem, @embedding_solution
      )
    `);

    const tx = this.db.transaction(() => {
      for (const trace of traces) {
        const params = this.traceToRow(trace);
        const result = insertOrIgnore.run(params);
        if (result.changes > 0) imported++;
      }
    });
    tx();
    return imported;
  }

  /** Store embeddings for a trace. */
  storeEmbeddings(
    id: string,
    problemEmbedding: number[],
    solutionEmbedding: number[],
  ): void {
    this.db
      .prepare(
        "UPDATE traces SET embedding_problem = ?, embedding_solution = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        float32ToBuffer(problemEmbedding),
        float32ToBuffer(solutionEmbedding),
        Date.now(),
        id,
      );
  }

  /** Get all traces that have embeddings. */
  getAllWithEmbeddings(): Array<{
    trace: ReasoningTrace;
    problemEmbedding: number[];
    solutionEmbedding: number[];
  }> {
    const rows = this.db
      .prepare(
        "SELECT * FROM traces WHERE embedding_problem IS NOT NULL",
      )
      .all() as RawRow[];

    return rows
      .filter((r) => r.embedding_problem && r.embedding_solution)
      .map((r) => ({
        trace: this.rowToTrace(r),
        problemEmbedding: bufferToFloat32(r.embedding_problem as Buffer),
        solutionEmbedding: bufferToFloat32(r.embedding_solution as Buffer),
      }));
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /** Get the raw database instance (for advanced use / adaptive weights). */
  get rawDb(): Database.Database {
    return this.db;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * Sanitize and build FTS5 query.
   * Strategy: AND for short queries (1-3 words), OR for longer ones.
   * This balances precision (AND) with recall (OR).
   * Ref: Robertson & Zaragoza (2009), "The Probabilistic Relevance Framework"
   */
  private sanitizeFtsQuery(query: string): string {
    const cleaned = query
      .replace(/[*"():^~{}[\]\\]/g, " ")
      .trim();

    if (!cleaned) return "";

    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";

    // Short queries: AND (all terms must match) for precision
    // Long queries: OR (any term can match) for broader recall
    const joiner = words.length <= 3 ? " " : " OR ";
    return words.map((w) => `"${w}"`).join(joiner);
  }

  /**
   * Wilson score interval lower bound.
   * Ref: Wilson, E.B. (1927). "Probable Inference, the Law of Succession,
   *      and Statistical Inference." JASA 22(158):209-212.
   *
   * Same ranking algorithm used by Reddit, Yelp, and other platforms.
   * Properly handles small sample sizes (unlike naive helpful/recalled ratio).
   */
  private computeQualityScore(q: QualityMetrics): number {
    if (q.recallCount === 0) return 0.5; // Prior: assume moderate quality

    const n = q.recallCount;
    const p = q.helpfulCount / n;

    // z = 1.96 for 95% confidence
    const z = 1.96;
    const z2 = z * z;

    const numerator = p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    const denominator = 1 + z2 / n;

    return Math.max(0, Math.min(1, numerator / denominator));
  }

  private traceToRow(t: ReasoningTrace, cachedTokens?: string[], cachedFeatures?: Record<string, unknown>): Record<string, unknown> {
    return {
      id: t.id,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      p_description: t.problem.description,
      p_error_type: t.problem.errorType ?? null,
      p_error_message: t.problem.errorMessage ?? null,
      p_stack_trace: t.problem.stackTrace ?? null,
      p_file_path: t.problem.filePath ?? null,
      p_language: t.problem.language ?? null,
      p_framework: t.problem.framework ?? null,
      p_tags: JSON.stringify(t.problem.tags),
      p_fingerprint: t.problem.fingerprint,
      p_tokens: cachedTokens ? JSON.stringify(cachedTokens) : null,
      p_features: cachedFeatures ? JSON.stringify(cachedFeatures) : null,
      s_summary: t.solution.summary,
      s_steps: JSON.stringify(t.solution.steps),
      s_outcome: t.solution.outcome,
      s_diff: t.solution.diff ?? null,
      s_explanation: t.solution.explanation ?? null,
      m_agent: t.metadata.agent,
      m_model: t.metadata.model ?? null,
      m_tokens_used: t.metadata.tokensUsed ?? null,
      m_duration_ms: t.metadata.durationMs ?? null,
      m_source: t.metadata.source ?? null,
      m_custom: t.metadata.custom ? JSON.stringify(t.metadata.custom) : null,
      q_recall_count: t.quality.recallCount,
      q_helpful_count: t.quality.helpfulCount,
      q_last_recalled_at: t.quality.lastRecalledAt ?? null,
      q_score: t.quality.score,
      prov_origin: t.provenance?.origin ?? "local",
      prov_author: t.provenance?.author ?? null,
      prov_verified_by: JSON.stringify(t.provenance?.verifiedBy ?? []),
      prov_applied_count: t.provenance?.appliedCount ?? 0,
      prov_last_applied: t.provenance?.lastAppliedAt ?? null,
      embedding_problem: null,
      embedding_solution: null,
    };
  }

  private rowToTrace(r: RawRow): ReasoningTrace {
    return {
      id: r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      problem: {
        description: r.p_description,
        errorType: r.p_error_type ?? undefined,
        errorMessage: r.p_error_message ?? undefined,
        stackTrace: r.p_stack_trace ?? undefined,
        filePath: r.p_file_path ?? undefined,
        language: r.p_language ?? undefined,
        framework: r.p_framework ?? undefined,
        tags: JSON.parse(r.p_tags) as string[],
        fingerprint: r.p_fingerprint,
      },
      solution: {
        summary: r.s_summary,
        steps: JSON.parse(r.s_steps) as ReasoningTrace["solution"]["steps"],
        outcome: r.s_outcome as ReasoningTrace["solution"]["outcome"],
        diff: r.s_diff ?? undefined,
        explanation: r.s_explanation ?? undefined,
      },
      metadata: {
        agent: r.m_agent,
        model: r.m_model ?? undefined,
        tokensUsed: r.m_tokens_used ?? undefined,
        durationMs: r.m_duration_ms ?? undefined,
        source: r.m_source ?? undefined,
        custom: r.m_custom
          ? (JSON.parse(r.m_custom) as Record<string, unknown>)
          : undefined,
      },
      quality: {
        recallCount: r.q_recall_count,
        helpfulCount: r.q_helpful_count,
        lastRecalledAt: r.q_last_recalled_at ?? undefined,
        score: r.q_score,
      },
      provenance: {
        origin: (((r as unknown as Record<string, unknown>).prov_origin as string) ?? "local") as "local" | "team" | "seed" | "global",
        author: ((r as unknown as Record<string, unknown>).prov_author as string) ?? undefined,
        verifiedBy: (r as unknown as Record<string, unknown>).prov_verified_by
          ? JSON.parse((r as unknown as Record<string, unknown>).prov_verified_by as string) as string[]
          : [],
        appliedCount: ((r as unknown as Record<string, unknown>).prov_applied_count as number) ?? 0,
        lastAppliedAt: ((r as unknown as Record<string, unknown>).prov_last_applied as number) ?? undefined,
      },
    };
  }

  private rowToCachedTrace(r: RawRow): CachedTraceRow {
    return {
      trace: this.rowToTrace(r),
      cachedTokens: r.p_tokens ? (JSON.parse(r.p_tokens) as string[]) : undefined,
      cachedFeatures: r.p_features
        ? (JSON.parse(r.p_features) as Record<string, unknown>)
        : undefined,
    };
  }
}

// ============================================================================
// Public types
// ============================================================================

/** A trace with its pre-computed similarity data from the DB. */
export interface CachedTraceRow {
  trace: ReasoningTrace;
  cachedTokens?: string[];
  cachedFeatures?: Record<string, unknown>;
}

// ============================================================================
// Raw row type from SQLite
// ============================================================================

interface RawRow {
  id: string;
  created_at: number;
  updated_at: number;
  p_description: string;
  p_error_type: string | null;
  p_error_message: string | null;
  p_stack_trace: string | null;
  p_file_path: string | null;
  p_language: string | null;
  p_framework: string | null;
  p_tags: string;
  p_fingerprint: string;
  p_tokens: string | null;
  p_features: string | null;
  s_summary: string;
  s_steps: string;
  s_outcome: string;
  s_diff: string | null;
  s_explanation: string | null;
  m_agent: string;
  m_model: string | null;
  m_tokens_used: number | null;
  m_duration_ms: number | null;
  m_source: string | null;
  m_custom: string | null;
  q_recall_count: number;
  q_helpful_count: number;
  q_last_recalled_at: number | null;
  q_score: number;
  embedding_problem: Buffer | null;
  embedding_solution: Buffer | null;
}

// ============================================================================
// Binary embedding helpers
//
// May-2026 PR 3: switched from `Buffer.from(Float32Array.buffer)` aliasing
// to the explicit LE-Float32 codec in `./embedding-codec.ts`. The shared
// codec is used by both V1 (this file) and V2 (`block-store.ts`) so the
// formats cannot drift again. Legacy v15 rows with no magic header round-
// trip correctly during reads; the v15→v16 migration rewrites them.
// ============================================================================

function float32ToBuffer(arr: number[]): Buffer {
  return encodeFloat32LE(arr);
}

function bufferToFloat32(buf: Buffer): number[] {
  return decodeFloat32(buf);
}
