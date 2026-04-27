/**
 * RecentToolCache (PLAN-0.7 §rc.4b).
 *
 * In-memory ring buffer of recent tool observations per sessionId,
 * persisted to `.tracebase/cache/rtools.bin` so a fresh process can
 * warm without opening SQLite on the hot path. PreToolUse reads
 * ONLY from this cache — cache miss → no-op (fail-open); cache hit
 * → read in-memory window for the duplicate / loop check.
 *
 * Design:
 *   - One file per workspace at `.tracebase/cache/rtools.bin`.
 *   - Fixed-record JSON-Lines format. Each record is one
 *     observation: `{ s, k, n, t }` = (sessionId, argKey, toolName,
 *     ts). Field names short for compactness.
 *   - File-level cap: MAX_RECORDS records. Older records evicted
 *     in FIFO order via the in-memory ring; the on-disk file is
 *     fully rewritten on each persist (cap is small enough — at
 *     128 bytes/record × 4096 records = ~512 KiB worst case).
 *   - Privacy: cache rows carry the same fields the rest of
 *     TraceBase already persists (argKey HMAC, sanitised toolName).
 *     Never raw tool_input or tool_response. The cloud allowlist
 *     drops every column from tool_observations and from this
 *     cache equivalently — see USAGE_TOOL_BATCH_SPEC.
 *
 * Failure model:
 *   - Missing file → empty cache (warm-start cost is one read; the
 *     PostToolBatch path repopulates as observations arrive).
 *   - Corrupt JSON in any line → that line is dropped; the rest
 *     are kept. The tail rewrite repairs the file on next persist.
 *   - Write failure (permissions, disk full) → swallowed; the
 *     in-memory cache stays consistent.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CachedObservation {
  /** Stable session id (Claude Code session_id, etc.). */
  sessionId: string;
  /** HMAC bucket id from `sanitizeToolArgs` — never the raw arg. */
  argKey: string;
  /** Canonical tool name (e.g. "Read", "Grep"). Family lives at the wire. */
  toolName: string;
  /** Wall-clock ms when the observation was recorded. */
  ts: number;
  /**
   * 0.7.1 — semantic-equivalence collapse for search-family tools
   * (`Grep` / `Glob` / `ripgrep` / `ag` / `findstr`). Two calls
   * with different `argKey` (HMAC over normalized args) can collapse
   * to the same `intentKey` when the SEMANTIC search target is the
   * same — `grep "auth_token"` and `rg "auth[_-]token"` both
   * normalise to `search:* auth token`.
   *
   * Only set for search-family observations; left undefined for
   * read/shell/edit/write/web/task/other so the schema stays
   * minimal and the count-by-intent logic doesn't accidentally
   * trip on non-search activity.
   *
   * Backward-compatible on-disk: serialised as the optional `i`
   * field. Pre-0.7.1 cache rows have no `i` on disk; `hydrate()`
   * reads them as `intentKey: undefined` and the count-by-intent
   * logic excludes those rows.
   */
  intentKey?: string;
}

export interface RecentToolCacheOptions {
  /** Max in-memory records before FIFO eviction. Default 4096. */
  maxRecords?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling on the persisted cache size (records). */
export const DEFAULT_MAX_RECORDS = 4096;

/**
 * 0.7.0 §6 stable §5 — append-only disk size cap.
 *
 * `appendBatchToDisk` is an O(1) append on the hot PostToolBatch
 * path; without explicit rotation the on-disk file can grow
 * unbounded between `flush()` calls (a long-running session that
 * never restarts the process). When the file size crosses
 * MAX_DISK_BYTES, the next append performs a hydrate + flush
 * rewrite to enforce the cap.
 *
 * The threshold is intentionally generous (≈ 4× the worst-case
 * full-ring on-disk size) so the rewrite is rare; a long session
 * with constant tool spam still amortises to one rewrite per few
 * thousand observations.
 */
export const MAX_DISK_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Cache file path resolver. */
export function cacheFilePath(workspacePath: string): string {
  return join(workspacePath, ".tracebase", "cache", "rtools.bin");
}

// ---------------------------------------------------------------------------
// In-memory cache — bounded ring + persistence helpers
// ---------------------------------------------------------------------------

export class RecentToolCache {
  private readonly maxRecords: number;
  /**
   * Append-only ring. Pushed at the tail; head dropped when over
   * `maxRecords`. The session window read by `recent()` filters
   * by sessionId after slicing the tail.
   */
  private readonly entries: CachedObservation[] = [];

  constructor(opts: RecentToolCacheOptions = {}) {
    this.maxRecords = Math.max(1, opts.maxRecords ?? DEFAULT_MAX_RECORDS);
  }

  /** Append one observation. Evicts the oldest record at cap. */
  append(obs: CachedObservation): void {
    this.entries.push(obs);
    if (this.entries.length > this.maxRecords) {
      this.entries.splice(0, this.entries.length - this.maxRecords);
    }
  }

  /**
   * Last `windowSize` observations for the given session, oldest
   * first (matches `BlockStore.recentToolObservations` ordering).
   */
  recent(sessionId: string, windowSize: number): CachedObservation[] {
    if (windowSize <= 0) return [];
    const out: CachedObservation[] = [];
    // Walk from the tail backward, collecting up to `windowSize`.
    for (let i = this.entries.length - 1; i >= 0 && out.length < windowSize; i--) {
      const e = this.entries[i]!;
      if (e.sessionId === sessionId) out.push(e);
    }
    return out.reverse();
  }

  /** Total entries across all sessions. Useful for tests + the cap regression. */
  size(): number {
    return this.entries.length;
  }

  /**
   * 0.7.1 — count cached observations in the given session whose
   * `intentKey` matches `intentKey`. Used by the PreToolUse hook
   * to decide whether the agent has tried the same SEMANTIC search
   * intent enough times to justify a block.
   *
   * Pre-0.7.1 rows (no `intentKey`) are ignored — they can't
   * collapse into the count without a recompute. The counter walks
   * the entire ring (not a windowSize slice) so a long-running
   * session keeps escalating once the threshold is crossed; the
   * 14-day TTL on the underlying `tool_observations` row + the
   * 4096-record cap make the walk cheap.
   *
   * `intentKey === undefined` returns 0 — non-search observations
   * never participate in this count.
   */
  recentIntentCount(sessionId: string, intentKey: string | undefined): number {
    if (!intentKey) return 0;
    let n = 0;
    for (const e of this.entries) {
      if (e.sessionId !== sessionId) continue;
      if (e.intentKey === intentKey) n += 1;
    }
    return n;
  }

  /** Bulk-load from a file. Best-effort; corrupt lines are dropped silently. */
  hydrate(workspacePath: string): void {
    const path = cacheFilePath(workspacePath);
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return;
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as Partial<{
          s: string;
          k: string;
          n: string;
          t: number;
          // 0.7.1 — optional intent_key field. Absent on pre-0.7.1
          // rows; present only for search-family observations.
          i: string;
        }>;
        if (
          typeof parsed.s === "string" &&
          typeof parsed.k === "string" &&
          typeof parsed.n === "string" &&
          typeof parsed.t === "number"
        ) {
          this.append({
            sessionId: parsed.s,
            argKey: parsed.k,
            toolName: parsed.n,
            ts: parsed.t,
            ...(typeof parsed.i === "string" && parsed.i.length > 0
              ? { intentKey: parsed.i }
              : {}),
          });
        }
      } catch {
        // corrupt line — drop, keep walking
      }
    }
  }

  /**
   * Atomic-rewrite persistence. Used by `flush()` after a batch.
   * Writes to `<file>.tmp` then renames. A crash mid-rewrite
   * leaves the previous file intact.
   */
  flush(workspacePath: string): void {
    const path = cacheFilePath(workspacePath);
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = path + ".tmp";
      const lines: string[] = [];
      for (const e of this.entries) {
        lines.push(JSON.stringify(serializeObservation(e)));
      }
      writeFileSync(tmp, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
      renameSync(tmp, path);
    } catch {
      // Persistence failure is non-load-bearing — the in-memory
      // cache stays consistent for this process; the next process
      // start re-warms from whatever survived.
    }
  }

  /**
   * Append a single record to the on-disk cache without rewriting
   * the whole file. Used on the hot PostToolBatch path so we don't
   * pay an O(n) rewrite per observation. Eviction (cap) is handled
   * by `flush()` — the append-only path can briefly grow past cap
   * on disk; `hydrate()` re-applies the cap on next read.
   */
  appendToDisk(workspacePath: string, obs: CachedObservation): void {
    this.appendBatchToDisk(workspacePath, [obs]);
  }

  /**
   * 0.7.0-rc.4 hardening — batched on-disk append. PostToolBatch
   * receives up to MAX_CALLS_PER_BATCH observations at once;
   * appendToDisk one-by-one would open/close the file per call.
   * This variant opens once, writes all lines, closes once.
   *
   * 0.7.0 §6 stable §5 — disk-size cap enforcement. The append path
   * checks the file size BEFORE writing and triggers a full rewrite
   * (hydrate + flush) when the file is over `MAX_DISK_BYTES`. This
   * keeps the on-disk cache from growing unbounded over long
   * sessions that never restart the process.
   *
   * Empty array is a no-op. Failure swallowed — cache warming is
   * never load-bearing on the agent's tool path.
   */
  appendBatchToDisk(workspacePath: string, observations: CachedObservation[]): void {
    if (observations.length === 0) return;
    const path = cacheFilePath(workspacePath);
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // 0.7.0 §6 stable §5 — disk-size cap enforcement.
      //
      // If the on-disk file is over MAX_DISK_BYTES, rotate before
      // appending: read the file back into the in-memory ring
      // (which applies the record cap automatically), then full-
      // rewrite via `flush()`. The rewrite is bounded by
      // `maxRecords` so disk size is bounded too.
      //
      // Stat-then-decide is cheap; the rewrite path is rare on a
      // healthy session.
      let needsRotation = false;
      try {
        const st = statSync(path);
        if (st.size > MAX_DISK_BYTES) needsRotation = true;
      } catch {
        // file doesn't exist yet — nothing to rotate
      }
      if (needsRotation) {
        // Hydrate from the over-sized file (record cap applies),
        // then rewrite. The new in-memory contents include only
        // the most recent `maxRecords` rows.
        this.hydrate(workspacePath);
        // Add the incoming batch to the ring before flushing so we
        // don't lose this batch's data in the rotation.
        for (const obs of observations) this.append(obs);
        this.flush(workspacePath);
        return;
      }

      const fd = openSync(path, "a");
      try {
        const payload = observations
          .map((e) => JSON.stringify(serializeObservation(e)) + "\n")
          .join("");
        appendFileSync(fd, payload);
      } finally {
        closeSync(fd);
      }
    } catch {
      // see `flush` rationale
    }
  }

  /** Test helper — drop all records. */
  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * 0.7.1 — single source of truth for the on-disk record shape.
 * Keeps the `i` field optional so search-family observations carry
 * intent_key but every other family writes the legacy 4-field shape.
 * Pre-0.7.1 rows are forward-compatible: they hydrate with
 * `intentKey: undefined` and serialize back without an `i` field.
 */
function serializeObservation(e: CachedObservation): Record<string, unknown> {
  const base: Record<string, unknown> = {
    s: e.sessionId,
    k: e.argKey,
    n: e.toolName,
    t: e.ts,
  };
  if (typeof e.intentKey === "string" && e.intentKey.length > 0) {
    base.i = e.intentKey;
  }
  return base;
}
