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
import { readFileSync, statSync } from "node:fs";
import { resolve as pathResolve, sep as pathSep } from "node:path";
import type { BlockStore } from "./block-store.js";
import { detectLeakageExtended, detectPromptInjectionPatterns, isRepoRelative } from "./guard.js";
import { detectLanguage, summarizeFile, type FileLanguage } from "./file-summarizer.js";
import { walkWorkspace, type WalkBudget, type WalkResult } from "./file-walker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SummarizerKind = "heuristic" | "embedding" | "llm";

export interface IndexWorkspaceOptions {
  /**
   * Absolute root path of the workspace to walk. When `baseRoot` is
   * also set, this is the BFS START point; `baseRoot` becomes the
   * repo-relative pivot.
   */
  root: string;
  /**
   * 0.7.0-rc.2 hardening — repo-base override for sub-walks.
   *
   * Used by `drainIndexerPending` when re-walking a queued
   * sub-directory: the BFS starts at `<projectRoot>/<rel>` but
   * yielded files must persist with the full repo-relative path.
   * When omitted, behaviour matches pre-hardening (`baseRoot ===
   * root`).
   */
  baseRoot?: string;
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
    baseRoot: opts.baseRoot,
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
// Single-file indexer (PLAN-0.7 §rc.2 hardening)
//
// Pre-hardening, the file-pending drain branch in
// `drainIndexerPending` ignored the queued `rel_path` and ran
// `indexWorkspace(maxFiles=1)` from the project root, which BFS-
// yielded whatever it saw first — NOT the queued file. The pending
// row was deleted regardless, so a modified `src/deep/target.ts`
// could be silently dropped.
//
// `indexSingleFile` is the exact-file path: read THIS file, run
// the same exclusion / size / binary / privacy / persist gates
// the walker+indexer pair runs, return a typed outcome. The
// caller decides whether to drop the pending row based on that
// outcome.
// ---------------------------------------------------------------------------

export type IndexSingleOutcome =
  | "indexed" // newly inserted
  | "updated" // upserted because hash changed
  | "no-op" // hash unchanged
  | "missing" // file no longer at that path
  | "too-large"
  | "binary"
  | "excluded-suffix"
  | "out-of-repo"
  | "unreadable"
  | "leakage"
  | "injection";

const PER_FILE_MAX_BYTES = 256 * 1024;
const NULL_SNIFF_BYTES = 8 * 1024;

const SINGLE_EXCLUDED_SUFFIXES = new Set<string>([
  ".pyc", ".pyo", ".class", ".o", ".obj", ".exe", ".dll", ".so", ".dylib",
  ".a", ".lib", ".jar", ".war", ".tar", ".gz", ".zip", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".webm", ".mov", ".avi", ".wav", ".ogg",
  ".pdf",
  ".lock", ".sum",
  ".map",
]);

export function indexSingleFile(
  store: BlockStore,
  baseRoot: string,
  rel: string,
  opts?: { summarizer?: SummarizerKind; maxBytes?: number; now?: () => number },
): IndexSingleOutcome {
  if (!isRepoRelative(rel)) return "out-of-repo";

  const now = opts?.now ?? Date.now;
  const summarizer = opts?.summarizer ?? "heuristic";
  const maxBytes = opts?.maxBytes ?? PER_FILE_MAX_BYTES;

  // Resolve abs and verify it doesn't escape baseRoot via traversal.
  const baseAbs = pathResolve(baseRoot);
  const abs = pathResolve(baseRoot, rel);
  if (!abs.startsWith(baseAbs + pathSep) && abs !== baseAbs) {
    return "out-of-repo";
  }

  const lower = rel.toLowerCase();
  for (const ext of SINGLE_EXCLUDED_SUFFIXES) {
    if (lower.endsWith(ext)) {
      emitSkippedEvent(store, "excluded-suffix", rel, now);
      return "excluded-suffix";
    }
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    // File no longer exists — drop the row, emit a skip so the
    // operator sees the churn.
    emitSkippedEvent(store, "missing", rel, now);
    return "missing";
  }
  if (!st.isFile()) {
    emitSkippedEvent(store, "missing", rel, now);
    return "missing";
  }
  if (st.size > maxBytes) {
    emitSkippedEvent(store, "too-large", rel, now);
    return "too-large";
  }

  let content: string;
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    emitSkippedEvent(store, "unreadable", rel, now);
    return "unreadable";
  }
  // Null-byte sniff.
  const sniffLimit = Math.min(content.length, NULL_SNIFF_BYTES);
  for (let i = 0; i < sniffLimit; i++) {
    if (content.charCodeAt(i) === 0) {
      emitSkippedEvent(store, "binary", rel, now);
      return "binary";
    }
  }

  // Hash dedup.
  const hash = createHash("sha256").update(content).digest("hex");
  const db = store.rawDb;
  const existing = db
    .prepare("SELECT hash FROM indexed_files WHERE rel_path = ?")
    .get(rel) as { hash: string } | undefined;
  if (existing && existing.hash === hash) return "no-op";

  // Summarize + privacy gates.
  const language = detectLanguage(rel);
  const summary = summarizeFile({ relPath: rel, content, language });
  const corpus = `${summary.summary}\n${summary.symbols}`;

  const leak = detectLeakageExtended(corpus);
  if (leak) {
    emitSkippedEvent(store, "leakage", rel, now);
    return "leakage";
  }
  const inj = detectPromptInjectionPatterns(corpus);
  if (inj) {
    try {
      store.appendEvent({
        ts: now(),
        queryId: `injection-reject-${randomUUID()}`,
        event: "store.injection_rejected",
        surface: "indexer",
        patternName: inj,
      });
    } catch {
      // telemetry must never break a write path
    }
    emitSkippedEvent(store, "injection", rel, now);
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
      size_bytes: st.size,
      summary: summary.summary,
      symbols: summary.symbols,
      summarizer,
      updated_at: tNow,
      rel_path: rel,
    });
    return "updated";
  }
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
    rel_path: rel,
    hash,
    language: summary.language,
    size_bytes: st.size,
    summary: summary.summary,
    symbols: summary.symbols,
    summarizer,
    indexed_at: tNow,
    updated_at: tNow,
  });
  return "indexed";
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
  // 0.7.0-rc.2 hardening — pass `baseRoot: opts.root` so file
  // `rel_path` resolves against the project root, not the
  // sub-directory. Pre-hardening this branch persisted
  // `src/deep/target.ts` as `target.ts`, breaking the
  // `indexed_files.rel_path UNIQUE` contract.
  for (const rel of fetchSlice("dir", 8)) {
    if (exhausted()) break;
    const remainingFiles = Math.max(0, fileBudget - indexedCount);
    const remainingMs = Math.max(0, timeBudget - (now() - start));
    const startRoot = rel === "." ? opts.root : `${opts.root}/${rel}`;
    try {
      const sub = indexWorkspace(store, {
        root: startRoot,
        baseRoot: opts.root,
        budget: { maxFiles: remainingFiles, timeMs: remainingMs },
        now,
      });
      indexedCount += sub.indexedCount;
    } catch {
      // swallow: drain is non-load-bearing
    }
    // Whether the sub-walk succeeded or not, drop this dir from the
    // queue. If it had un-walked descendants, the sub-walk re-
    // enqueued them as new file/dir rows already (now with correct
    // repo-rel paths because `baseRoot` was passed).
    store.rawDb
      .prepare("DELETE FROM indexer_pending WHERE rel_path = ? AND kind = 'dir'")
      .run(rel);
    drainedRows++;
  }

  // --- Files second ---
  // 0.7.0-rc.2 hardening — exact-file path. Pre-hardening this
  // branch ran a one-file walker from the project root, which
  // BFS-yielded whatever it saw first instead of the queued file.
  // Modified files at deep paths could be silently dropped.
  if (!exhausted()) {
    const remaining = fileBudget - indexedCount;
    for (const rel of fetchSlice("file", Math.max(1, remaining))) {
      if (exhausted()) break;
      const outcome = indexSingleFile(store, opts.root, rel, { now });
      if (outcome === "indexed" || outcome === "updated") {
        indexedCount++;
      }
      // Drop the pending row regardless of outcome — the queued
      // file was given an exact-file pass. If it surfaced a
      // skip-reason event (binary / leakage / etc.), the operator
      // sees it in the doctor / event log.
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
