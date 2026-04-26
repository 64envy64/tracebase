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
        lines.push(JSON.stringify({ s: e.sessionId, k: e.argKey, n: e.toolName, t: e.ts }));
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
    const path = cacheFilePath(workspacePath);
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const fd = openSync(path, "a");
      try {
        appendFileSync(
          fd,
          JSON.stringify({ s: obs.sessionId, k: obs.argKey, n: obs.toolName, t: obs.ts }) + "\n",
        );
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
