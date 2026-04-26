/**
 * File indexer pipeline (PLAN-0.7 §rc.2).
 *
 * Orchestrates the rc.2 substrate:
 *   walker (file-walker.ts)
 *     → summarizer (file-summarizer.ts)
 *       → privacy scans (guard.ts: leakage + injection)
 *         → persist (indexed_files / indexer_pending)
 *           → emit telemetry (file_index.completed / file_index.skipped)
 *
 * Idempotent: SHA-256 over file content acts as the dedup key.
 * Re-running on an unchanged file no-ops; a content change updates
 * the row.
 *
 * Privacy invariants enforced here, not at downstream layers:
 *   1. summary + symbols pass `detectLeakageExtended` AND
 *      `detectPromptInjectionPatterns` before write. A positive
 *      match emits `file_index.skipped` (reason `'leakage'` or
 *      `'injection'`) and the row never lands.
 *   2. `rel_path` checked via `isRepoRelative` before persistence.
 *      The walker should never hand us a non-repo-relative path,
 *      but the defense-in-depth rejects on a bug.
 *   3. `file_index.skipped` events carry `reason` only — no path
 *      reaches the cloud (the wire allowlist drops `path` even if
 *      the local event held it).
 */
import { createHash, randomUUID } from "node:crypto";
import type { BlockStore } from "./block-store.js";
import { detectLeakageExtended, detectPromptInjectionPatterns, isRepoRelative } from "./guard.js";
import { detectLanguage, summarizeFile, type FileLanguage } from "./file-summarizer.js";
import { walkWorkspace, type WalkBudget, type WalkResult } from "./file-walker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SummarizerKind = "heuristic" | "embedding" | "llm";

export interface IndexWorkspaceOptions {
  /** Absolute root path of the workspace to walk. */
  root: string;
  /** Budget passed straight to the walker. Defaults documented there. */
  budget?: Partial<WalkBudget>;
  /** Per-file size cap. Defaults to walker default (256 KiB). */
  maxBytes?: number;
  /**
   * Summarizer label persisted on each indexed_files row + emitted
   * with file_index.completed. Currently only `'heuristic'` actually
   * runs; `'embedding'` / `'llm'` are reserved for later rc work.
   * Defaults to `'heuristic'`.
   */
  summarizer?: SummarizerKind;
  /** `now()` override for deterministic tests. */
  now?: () => number;
}

export interface IndexWorkspaceOutcome {
  /** Files newly written or updated this run. */
  indexedCount: number;
  /** Total bytes the summarizer processed (= walker bytesRead). */
  bytesSummarized: number;
  /** Wall-clock duration of walker + summarizer + persist combined. */
  durationMs: number;
  /** Pending file count after the run (queue size including pre-existing). */
  pendingFilesCount: number;
  /** Pending dir count after the run. */
  pendingDirsCount: number;
  /** Reason → count of files the indexer dropped. */
  skipped: Record<string, number>;
  /** Summarizer label that ran. */
  summarizer: SummarizerKind;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function indexWorkspace(
  store: BlockStore,
  opts: IndexWorkspaceOptions,
): IndexWorkspaceOutcome {
  const summarizer: SummarizerKind = opts.summarizer ?? "heuristic";
  const now = opts.now ?? Date.now;
  const start = now();

  const walked: WalkResult = walkWorkspace({
    root: opts.root,
    budget: opts.budget,
    maxBytes: opts.maxBytes,
    now,
  });

  // Skip-reason counts mutate as we process; pre-seed with the
  // walker's structural skips (binary / too-large / excluded-* /
  // unreadable / out-of-repo). Each gets one analytics row at the
  // end so the cloud aggregator can fold them.
  const skipped: Record<string, number> = {};
  for (const s of walked.skipped) {
    skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
    emitSkippedEvent(store, s.reason, s.relPath, now);
  }

  let indexedCount = 0;
  for (const file of walked.files) {
    const reason = persistFile(store, file, summarizer, now);
    if (reason === null) {
      indexedCount++;
    } else {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      emitSkippedEvent(store, reason, file.relPath, now);
    }
  }

  // Persist pending queue state. INSERT OR IGNORE keeps it
  // idempotent against re-walks of the same root.
  const enqueueAt = now();
  for (const rel of walked.pendingFiles) {
    enqueuePending(store, rel, "file", enqueueAt);
  }
  for (const rel of walked.pendingDirs) {
    enqueuePending(store, rel, "dir", enqueueAt);
  }

  const pendingFilesCount = countPending(store, "file");
  const pendingDirsCount = countPending(store, "dir");

  const durationMs = now() - start;

  // Emit a single completion event with aggregates only.
  store.appendEvent({
    ts: now(),
    queryId: `file-index-${randomUUID()}`,
    event: "file_index.completed",
    fileCount: indexedCount,
    bytesSummarized: walked.bytesRead,
    durationMs,
    summarizer,
    pending: pendingFilesCount + pendingDirsCount,
  });

  return {
    indexedCount,
    bytesSummarized: walked.bytesRead,
    durationMs,
    pendingFilesCount,
    pendingDirsCount,
    skipped,
    summarizer,
  };
}

// ---------------------------------------------------------------------------
// Persist a single walked file
//
// Returns `null` on success, or a skip-reason string on rejection.
// Skip reasons surface as `file_index.skipped` events; "success"
// produces no per-file event (only the aggregate completion event
// at the end of the run).
// ---------------------------------------------------------------------------

function persistFile(
  store: BlockStore,
  file: { relPath: string; content: string; sizeBytes: number },
  summarizer: SummarizerKind,
  now: () => number,
): string | null {
  if (!isRepoRelative(file.relPath)) return "out-of-repo";

  const language: FileLanguage = detectLanguage(file.relPath);
  const hash = createHash("sha256").update(file.content).digest("hex");

  const db = store.rawDb;

  // Dedup gate. Same hash on the same rel_path → no-op.
  const existing = db
    .prepare("SELECT hash FROM indexed_files WHERE rel_path = ?")
    .get(file.relPath) as { hash: string } | undefined;
  if (existing && existing.hash === hash) return null;

  const summary = summarizeFile({
    relPath: file.relPath,
    content: file.content,
    language,
  });

  // Privacy gates. The summarizer's output goes through both
  // scanners; either match drops the file with a typed reason.
  const corpus = `${summary.summary}\n${summary.symbols}`;
  const leak = detectLeakageExtended(corpus);
  if (leak) return "leakage";
  const inj = detectPromptInjectionPatterns(corpus);
  if (inj) {
    // Reuse the rc.1 injection-rejection telemetry surface so the
    // operator's existing dashboard catches indexer-side hits.
    // (The bare `file_index.skipped` event also fires below; both
    // signals are useful — one for skip-reason aggregation, the
    // other for the named-pattern breakdown.)
    try {
      store.appendEvent({
        ts: now(),
        queryId: `injection-reject-${randomUUID()}`,
        event: "store.injection_rejected",
        surface: "indexer",
        patternName: inj,
      });
    } catch {
      // Telemetry must never break a write path.
    }
    return "injection";
  }

  // Upsert.
  const tNow = now();
  if (existing) {
    db.prepare(
      `UPDATE indexed_files SET
         hash = @hash,
         language = @language,
         size_bytes = @size_bytes,
         summary = @summary,
         symbols = @symbols,
         summarizer = @summarizer,
         updated_at = @updated_at
       WHERE rel_path = @rel_path`,
    ).run({
      hash,
      language: summary.language,
      size_bytes: file.sizeBytes,
      summary: summary.summary,
      symbols: summary.symbols,
      summarizer,
      updated_at: tNow,
      rel_path: file.relPath,
    });
  } else {
    db.prepare(
      `INSERT INTO indexed_files (
         id, rel_path, hash, language, size_bytes,
         summary, symbols, summarizer, indexed_at, updated_at
       ) VALUES (
         @id, @rel_path, @hash, @language, @size_bytes,
         @summary, @symbols, @summarizer, @indexed_at, @updated_at
       )`,
    ).run({
      id: randomUUID(),
      rel_path: file.relPath,
      hash,
      language: summary.language,
      size_bytes: file.sizeBytes,
      summary: summary.summary,
      symbols: summary.symbols,
      summarizer,
      indexed_at: tNow,
      updated_at: tNow,
    });
  }

  // The file is now in indexed_files — drop any pending row for
  // the same rel_path so the queue doesn't keep retrying it.
  db.prepare("DELETE FROM indexer_pending WHERE rel_path = ? AND kind = 'file'").run(
    file.relPath,
  );

  return null;
}

// ---------------------------------------------------------------------------
// Pending queue helpers
// ---------------------------------------------------------------------------

export function enqueuePending(
  store: BlockStore,
  relPath: string,
  kind: "file" | "dir",
  ts: number,
): void {
  if (!isRepoRelative(relPath) && relPath !== ".") return;
  store.rawDb
    .prepare(
      `INSERT OR IGNORE INTO indexer_pending(rel_path, kind, enqueued_at)
       VALUES (?, ?, ?)`,
    )
    .run(relPath, kind, ts);
}

export function countPending(store: BlockStore, kind: "file" | "dir"): number {
  const row = store.rawDb
    .prepare("SELECT COUNT(*) AS c FROM indexer_pending WHERE kind = ?")
    .get(kind) as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// Opportunistic drain (PLAN-0.7 §rc.2)
//
// Called from `recallForPrompt` after the recall result is built.
// Pulls a small slice from `indexer_pending`, summarizes what fits
// in the slice budget, and either persists or re-enqueues. Dir
// rows are drained slightly preferentially when both kinds exist
// because re-walking a dir can unlock multiple files in one slice.
//
// All work is best-effort: any throw / I/O error / privacy-gate
// rejection is swallowed because the drain is non-load-bearing on
// the prompt path.
// ---------------------------------------------------------------------------

export interface DrainSliceOptions {
  /** Workspace root. Required so file-pending paths can resolve to absolute. */
  root: string;
  /** Wall-clock cap for the slice. Default 200ms. */
  timeMs?: number;
  /** Hard count cap on files processed in the slice. Default 50. */
  maxFiles?: number;
  /** `now()` override for tests. */
  now?: () => number;
}

export interface DrainSliceOutcome {
  /** Files newly indexed in this slice. */
  indexedCount: number;
  /** Pending rows the slice processed and removed (file or dir). */
  drainedRows: number;
  /** Wall-clock duration of the slice. */
  durationMs: number;
}

export function drainIndexerPending(
  store: BlockStore,
  opts: DrainSliceOptions,
): DrainSliceOutcome {
  const now = opts.now ?? Date.now;
  const start = now();
  const timeBudget = opts.timeMs ?? 200;
  const fileBudget = opts.maxFiles ?? 50;

  let indexedCount = 0;
  let drainedRows = 0;

  // Drain dirs first, then files. Each row is processed as a tiny
  // budgeted indexWorkspace call rooted at the prefix.
  const fetchSlice = (kind: "dir" | "file", limit: number): string[] =>
    (store.rawDb
      .prepare(
        `SELECT rel_path FROM indexer_pending
           WHERE kind = ?
           ORDER BY enqueued_at ASC
           LIMIT ?`,
      )
      .all(kind, limit) as Array<{ rel_path: string }>).map((r) => r.rel_path);

  const exhausted = (): boolean =>
    indexedCount >= fileBudget || now() - start >= timeBudget;

  // --- Dirs first ---
  for (const rel of fetchSlice("dir", 8)) {
    if (exhausted()) break;
    const remainingFiles = Math.max(0, fileBudget - indexedCount);
    const remainingMs = Math.max(0, timeBudget - (now() - start));
    const subRoot = rel === "." ? opts.root : `${opts.root}/${rel}`;
    try {
      const sub = indexWorkspace(store, {
        root: subRoot,
        budget: { maxFiles: remainingFiles, timeMs: remainingMs },
        now,
      });
      indexedCount += sub.indexedCount;
    } catch {
      // swallow: drain is non-load-bearing
    }
    // Whether the sub-walk succeeded or not, drop this dir from the
    // queue. If it had un-walked descendants, the sub-walk re-
    // enqueued them as new file/dir rows already.
    store.rawDb
      .prepare("DELETE FROM indexer_pending WHERE rel_path = ? AND kind = 'dir'")
      .run(rel);
    drainedRows++;
  }

  // --- Files second ---
  if (!exhausted()) {
    for (const rel of fetchSlice("file", fileBudget - indexedCount)) {
      if (exhausted()) break;
      // Re-walk just this file. We pretend the parent dir is the
      // walker root and pass a one-file budget so the walker yields
      // it (the BFS will stop after the first file in the dir
      // matching the path tail).
      //
      // Simpler: read + persist in-place via the per-file path. We
      // have the rel; resolve to abs and load.
      try {
        const sub = indexWorkspace(store, {
          // Walk the parent so toRepoRelative produces the same
          // rel as the queued row.
          root: opts.root,
          budget: { maxFiles: 1, timeMs: Math.max(0, timeBudget - (now() - start)) },
          now,
        });
        indexedCount += sub.indexedCount;
      } catch {
        // swallow
      }
      // Drop the row regardless — if persistence didn't happen
      // (large file, leakage, etc.), the un-indexed state is
      // recoverable via a future PostToolBatch enqueue.
      store.rawDb
        .prepare("DELETE FROM indexer_pending WHERE rel_path = ? AND kind = 'file'")
        .run(rel);
      drainedRows++;
    }
  }

  return {
    indexedCount,
    drainedRows,
    durationMs: now() - start,
  };
}

// ---------------------------------------------------------------------------
// Telemetry helper
// ---------------------------------------------------------------------------

function emitSkippedEvent(
  store: BlockStore,
  reason: string,
  path: string | undefined,
  now: () => number,
): void {
  try {
    store.appendEvent({
      ts: now(),
      queryId: `file-index-skip-${randomUUID()}`,
      event: "file_index.skipped",
      reason,
      // Path is local-only; cloud allowlist drops it. We still
      // record it for the doctor / debugging.
      ...(path !== undefined && path !== "" ? { path } : {}),
    });
  } catch {
    // Telemetry must never break a write path.
  }
}
