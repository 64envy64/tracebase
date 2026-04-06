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
} from "../types.js";

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_VERSION = 1;

const SCHEMA = `
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

  -- Embeddings (optional, stored as Float32Array binary)
  embedding_problem   BLOB,
  embedding_solution  BLOB
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_fingerprint  ON traces(p_fingerprint);
CREATE INDEX IF NOT EXISTS idx_error_type   ON traces(p_error_type);
CREATE INDEX IF NOT EXISTS idx_language     ON traces(p_language);
CREATE INDEX IF NOT EXISTS idx_framework    ON traces(p_framework);
CREATE INDEX IF NOT EXISTS idx_outcome      ON traces(s_outcome);
CREATE INDEX IF NOT EXISTS idx_score        ON traces(q_score DESC);
CREATE INDEX IF NOT EXISTS idx_created      ON traces(created_at DESC);

-- Full-text search via FTS5 with BM25 ranking
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

-- Keep FTS in sync with triggers
CREATE TRIGGER IF NOT EXISTS traces_fts_insert AFTER INSERT ON traces BEGIN
  INSERT INTO traces_fts(rowid, p_description, s_summary, s_explanation, p_tags, p_error_message)
  VALUES (new.rowid, new.p_description, new.s_summary, new.s_explanation, new.p_tags, new.p_error_message);
END;

CREATE TRIGGER IF NOT EXISTS traces_fts_delete AFTER DELETE ON traces BEGIN
  INSERT INTO traces_fts(traces_fts, rowid, p_description, s_summary, s_explanation, p_tags, p_error_message)
  VALUES ('delete', old.rowid, old.p_description, old.s_summary, old.s_explanation, old.p_tags, old.p_error_message);
END;

CREATE TRIGGER IF NOT EXISTS traces_fts_update AFTER UPDATE ON traces BEGIN
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
`;

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

  /** Run schema migrations. */
  private migrate(): void {
    this.db.exec(SCHEMA);

    const currentVersion = this.getSchemaVersion();
    if (currentVersion < SCHEMA_VERSION) {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
        )
        .run(String(SCHEMA_VERSION));
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

  /** Prepare frequently-used statements for performance. */
  private prepareStatements() {
    return {
      insert: this.db.prepare(`
        INSERT INTO traces (
          id, created_at, updated_at,
          p_description, p_error_type, p_error_message, p_stack_trace,
          p_file_path, p_language, p_framework, p_tags, p_fingerprint,
          s_summary, s_steps, s_outcome, s_diff, s_explanation,
          m_agent, m_model, m_tokens_used, m_duration_ms, m_source, m_custom,
          q_recall_count, q_helpful_count, q_last_recalled_at, q_score,
          embedding_problem, embedding_solution
        ) VALUES (
          @id, @created_at, @updated_at,
          @p_description, @p_error_type, @p_error_message, @p_stack_trace,
          @p_file_path, @p_language, @p_framework, @p_tags, @p_fingerprint,
          @s_summary, @s_steps, @s_outcome, @s_diff, @s_explanation,
          @m_agent, @m_model, @m_tokens_used, @m_duration_ms, @m_source, @m_custom,
          @q_recall_count, @q_helpful_count, @q_last_recalled_at, @q_score,
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

      pruneByScore: this.db.prepare(
        "DELETE FROM traces WHERE q_score < ? AND q_recall_count > 0",
      ),

      getByLanguage: this.db.prepare(
        "SELECT * FROM traces WHERE p_language = ? ORDER BY q_score DESC LIMIT ?",
      ),

      getByErrorType: this.db.prepare(
        "SELECT * FROM traces WHERE p_error_type = ? ORDER BY q_score DESC LIMIT ?",
      ),
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Store a new reasoning trace. Returns the generated ID. */
  store(trace: ReasoningTrace): string {
    const params = this.traceToRow(trace);
    this.stmts.insert.run(params);
    return trace.id;
  }

  /** Store a trace, computing ID and timestamps automatically. */
  storeNew(
    problem: Problem,
    solution: Solution,
    metadata: TraceMetadata,
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
    };
    this.store(trace);
    return trace;
  }

  /** Get a trace by its ID. */
  getById(id: string): ReasoningTrace | null {
    const row = this.stmts.getById.get(id) as RawRow | undefined;
    return row ? this.rowToTrace(row) : null;
  }

  /** Find traces with an exact fingerprint match. */
  getByFingerprint(fingerprint: string, limit = 5): ReasoningTrace[] {
    const rows = this.stmts.getByFingerprint.all(fingerprint, limit) as RawRow[];
    return rows.map((r) => this.rowToTrace(r));
  }

  /** Full-text search using SQLite FTS5 with BM25 ranking. */
  searchFts(
    query: string,
    limit = 10,
  ): Array<{ trace: ReasoningTrace; rank: number }> {
    // Escape special FTS5 characters and build query
    const sanitized = this.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    try {
      const rows = this.stmts.searchFts.all(sanitized, limit) as Array<
        RawRow & { rank: number }
      >;
      return rows.map((r) => ({
        trace: this.rowToTrace(r),
        rank: r.rank,
      }));
    } catch {
      // FTS query syntax error — fall back to simple LIKE search
      return this.searchLike(query, limit);
    }
  }

  /** Fallback LIKE-based search when FTS query fails. */
  private searchLike(
    query: string,
    limit: number,
  ): Array<{ trace: ReasoningTrace; rank: number }> {
    const pattern = `%${query}%`;
    const stmt = this.db.prepare(`
      SELECT *, 0 AS rank FROM traces
      WHERE p_description LIKE ? OR s_summary LIKE ? OR p_error_message LIKE ?
      ORDER BY q_score DESC
      LIMIT ?
    `);
    const rows = stmt.all(pattern, pattern, pattern, limit) as Array<
      RawRow & { rank: number }
    >;
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

  /** Record that a trace was recalled and optionally helpful. */
  recordRecall(id: string, helpful?: boolean): void {
    const trace = this.getById(id);
    if (!trace) return;

    const q = trace.quality;
    q.recallCount += 1;
    if (helpful) q.helpfulCount += 1;
    q.lastRecalledAt = Date.now();

    // Recompute quality score using Wilson score interval lower bound
    q.score = this.computeQualityScore(q);
    this.updateQuality(id, q);
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

  /** Remove traces below a quality threshold. Returns number pruned. */
  prune(threshold = 0.05): number {
    const result = this.stmts.pruneByScore.run(threshold);
    return result.changes;
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

  /** Import traces from an array (skips duplicates by ID). */
  importTraces(traces: ReasoningTrace[]): number {
    let imported = 0;
    const tx = this.db.transaction(() => {
      for (const trace of traces) {
        const existing = this.getById(trace.id);
        if (!existing) {
          this.store(trace);
          imported++;
        }
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

  /** Get all traces that have embeddings, returning them with vectors. */
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

  /** Get the raw database instance (for advanced use). */
  get rawDb(): Database.Database {
    return this.db;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private sanitizeFtsQuery(query: string): string {
    // Remove FTS5 special characters, then wrap each word in quotes
    const cleaned = query
      .replace(/[*"():^~{}[\]\\]/g, " ")
      .trim();

    if (!cleaned) return "";

    // Split into words, wrap in quotes, join with OR for broad matching
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";

    // Use implicit AND for multi-word queries
    return words.map((w) => `"${w}"`).join(" OR ");
  }

  /**
   * Wilson score interval lower bound.
   * This is the same algorithm Reddit uses for ranking.
   * It balances between ratio of helpful/recalled and sample size.
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

  private traceToRow(t: ReasoningTrace): Record<string, unknown> {
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
    };
  }
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
// ============================================================================

function float32ToBuffer(arr: number[]): Buffer {
  const f32 = new Float32Array(arr);
  return Buffer.from(f32.buffer);
}

function bufferToFloat32(buf: Buffer): number[] {
  const f32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(f32);
}
