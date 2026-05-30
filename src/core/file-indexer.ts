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
import { detectLanguage, summarizeFile, extractFileSymbols, splitIdentifier, type FileLanguage } from "./file-summarizer.js";
import { walkWorkspace, type WalkBudget, type WalkResult } from "./file-walker.js";
import { FTS_STOP_WORDS } from "./block-serving.js";

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

/**
 * Replace a file's rows in indexed_symbols with the freshly-extracted set.
 * Symbol `tokens` carry the camelCase/snake split so a concept query
 * ("record") matches a symbol named `ZodRecord`. Bounded by
 * extractFileSymbols' per-file cap; one transaction per file.
 */
function reindexSymbols(
  db: BlockStore["rawDb"],
  relPath: string,
  content: string,
  language: FileLanguage,
  now: () => number,
): void {
  db.prepare("DELETE FROM indexed_symbols WHERE rel_path = ?").run(relPath);
  const syms = extractFileSymbols(content, language);
  if (syms.length === 0) return;
  const t = now();
  const insert = db.prepare(
    `INSERT INTO indexed_symbols (id, rel_path, name, kind, signature, tokens, language, indexed_at)
     VALUES (@id, @rel_path, @name, @kind, @signature, @tokens, @language, @indexed_at)`,
  );
  const insertMany = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const r of rows) insert.run(r);
  });
  insertMany(syms.map((s) => ({
    id: randomUUID(),
    rel_path: relPath,
    name: s.name,
    kind: s.kind,
    signature: s.signature || null,
    tokens: splitIdentifier(s.name).join(" ").toLowerCase() || null,
    language,
    indexed_at: t,
  })));
}

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

  // Symbol-level index for this file (replaces prior rows).
  reindexSymbols(db, file.relPath, file.content, language, now);

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

/**
 * 0.7.0-rc.3 hardening — same value as `DEFAULT_MAX_BYTES` in
 * file-walker.ts. The duplicate is intentional today: the walker
 * runs against budgets that may differ from the indexer's per-
 * file cap in a future revision. Until that diverges (or the
 * dedupe lands cleanly), the locked constants test keeps both
 * pinned to the same value.
 */
export const PER_FILE_MAX_BYTES = 256 * 1024;
/** 0.7.0-rc.3 hardening — same value as `NULL_SNIFF_BYTES` in file-walker.ts. */
export const NULL_SNIFF_BYTES = 8 * 1024;

/**
 * 0.7.0-rc.3 hardening — exported for the locked-constants
 * regression. Stays byte-identical to `EXCLUDED_SUFFIXES` in
 * file-walker.ts; a divergence fails the locked test loudly.
 */
export const SINGLE_EXCLUDED_SUFFIXES = new Set<string>([
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
    reindexSymbols(db, rel, content, summary.language, now);
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
  reindexSymbols(db, rel, content, summary.language, now);
  return "indexed";
}

// ---------------------------------------------------------------------------
// File memory recall (PLAN-0.7 §rc.3)
//
// FTS5-backed prompt-term overlap against `indexed_files(summary,
// symbols)`. Returns up to K hits ordered by bm25 score. Pure DB
// query — no I/O against the workspace.
// ---------------------------------------------------------------------------

export interface RecallFilesOptions {
  /** Free-text prompt. Empty / too-short prompts return an empty hit list. */
  prompt: string;
  /** Top-K cap. Default 3, hard ceiling 10. */
  k?: number;
  /**
   * Whether to include documentation / metadata files (README, *.md,
   * LICENSE, CHANGELOG, package.json, lockfiles, docs/…) in the result.
   *
   * Default `false`: doc-class hits are dropped UNLESS the query itself
   * has documentation intent (mentions readme/docs/license/changelog/
   * install/setup/config/dependency…). Rationale: for a code-navigation
   * query ("fix the derivative special-char bug") a prose doc that merely
   * shares a stemmed word ("Derived from…", "derivation") otherwise
   * out-ranks the actual source file under bm25 (short prose doc + porter
   * stemming). Code queries should recall code; doc queries recall docs.
   * Set `true` to recover the legacy "everything" behaviour.
   */
  includeDocs?: boolean;
  /**
   * Whether to include test files / test-data fixtures (*.test.*, *.spec.*,
   * test_*.py, paths under test(s)/ __tests__/ spec/, tests/data/…). Default
   * `false`: dropped UNLESS the query has test intent (mentions test/spec/
   * fixture). A "where is the fix" query wants the implementation, not the
   * test that exercises it; test files are otherwise systematically
   * over-ranked (feature term repeated across test names). Set `true` to
   * recover them.
   */
  includeTests?: boolean;
}

/**
 * A symbol whose name (or camelCase/snake split tokens) matched the recall
 * query, rolled up from `indexed_symbols`. Surfaced on a FileHit ONLY when the
 * file was reached via the symbol index — never invented for a file recalled
 * by basename or summary FTS alone (so the payload can't fabricate a span).
 * `signature` is the trimmed declaration line (already ≤140 chars +
 * whitespace-collapsed at extraction time).
 */
export interface MatchedSymbol {
  name: string;
  signature: string;
}

export interface FileHit {
  /** Repo-relative path. */
  relPath: string;
  /** Heuristic summary (≤ 600 chars, leakage + injection scanned at write). */
  summary: string;
  /** JSON-encoded symbols payload (≤ 256 chars, parseable). */
  symbols: string;
  /** Detected language slot. */
  language: string | null;
  /** File size in bytes — useful for the "Xkb avoided" badge. */
  sizeBytes: number;
  /** FTS5 bm25 score. Lower is more relevant. Exposed so callers can rank. */
  score: number;
  /**
   * Symbols that caused this file to surface via the symbol-rollup tier (a
   * concept query "record" → `ZodRecord` / `record` deep in a monolithic
   * `schemas.ts`). Present ONLY for symbol-rollup hits; ABSENT for
   * basename/summary-only hits, so the injection payload never invents a span.
   * Deduped by name, best-bm25 first, length-capped. The payload renders 1–2
   * as a `matched: …` prefix so the agent jumps to the span instead of
   * issuing locate-Greps.
   */
  matchedSymbols?: MatchedSymbol[];
}

/** Hard ceiling on K. Calls past 10 cap silently. */
const RECALL_FILES_MAX_K = 10;
/** Reject queries below this many chars (post-trim). */
const MIN_PROMPT_LEN = 4;

export function recallFiles(store: BlockStore, opts: RecallFilesOptions): FileHit[] {
  const k = Math.min(Math.max(1, opts.k ?? 3), RECALL_FILES_MAX_K);
  const prompt = (opts.prompt ?? "").trim();
  if (prompt.length < MIN_PROMPT_LEN) return [];

  const fts = sanitizeRecallQuery(prompt);
  if (!fts) return [];

  // Whether to drop doc/metadata hits. Excluded by default unless the
  // caller opts in OR the query itself is doc-intent.
  const excludeDocs = opts.includeDocs !== true && !hasDocIntent(prompt);
  // Whether to drop test / test-fixture hits. Excluded by default unless
  // the caller opts in OR the query itself is test-intent. A
  // code-navigation query ("where is the fix") wants the implementation,
  // not the test that exercises it — and test files (often named after the
  // feature, with the feature term repeated in test names) systematically
  // out-rank the single source file under bm25. Test DATA fixtures
  // (tests/data/cases/*) crowd even harder.
  const excludeTests = opts.includeTests !== true && !hasTestIntent(prompt);

  // Over-fetch so we can (a) dedupe on rel_path, (b) drop doc/test-class
  // rows, and (c) re-rank with the filename boost while still surfacing K
  // code files. When excluding we fetch a wider candidate window because
  // tests/docs can dominate the raw bm25 head; bm25 over a few dozen rows
  // is cheap.
  const overFetch = (excludeDocs || excludeTests) ? Math.max(k * 4, 60) : k * 2;
  const rows = store.rawDb
    .prepare(
      `SELECT
         indexed_files.rel_path AS rel_path,
         indexed_files.summary AS summary,
         indexed_files.symbols AS symbols,
         indexed_files.language AS language,
         indexed_files.size_bytes AS size_bytes,
         bm25(indexed_files_fts) AS score
       FROM indexed_files
       JOIN indexed_files_fts ON indexed_files.rowid = indexed_files_fts.rowid
       WHERE indexed_files_fts MATCH @fts
       ORDER BY bm25(indexed_files_fts)
       LIMIT @limit`,
    )
    .all({ fts, limit: overFetch }) as Array<{
      rel_path: string;
      summary: string;
      symbols: string | null;
      language: string | null;
      size_bytes: number;
      score: number;
    }>;

  // Symbol-level rollup: files that DEFINE a symbol matching the query
  // (by name or camelCase/snake split tokens), even if the file summary
  // never surfaced the term. Lets a concept query reach a monolithic file
  // (e.g. "record" → `ZodRecord` in a big schemas.ts). The rollup also
  // carries the matched symbols themselves (name + signature) so the
  // injection payload can show the span, not just the file.
  const symbolHitsByFile = recallSymbols(store, fts);

  const qTokens = recallQueryTokens(prompt);
  const seen = new Set<string>();
  const candidates: Array<FileHit & { boost: number; symbolHits: number }> = [];
  const consider = (
    relPath: string, summary: string, symbols: string | null,
    language: string | null, sizeBytes: number, score: number,
  ): void => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    if (excludeDocs && isDocClassPath(relPath)) return;
    if (excludeTests && isTestClassPath(relPath)) return;
    const rollup = symbolHitsByFile.get(relPath);
    candidates.push({
      relPath, summary, symbols: symbols ?? "{}", language, sizeBytes, score,
      boost: filenameBoost(relPath, qTokens),
      symbolHits: rollup?.count ?? 0,
      // matchedSymbols ONLY when this file was reached via the symbol index —
      // never invented for a basename/summary-only hit.
      ...(rollup && rollup.symbols.length > 0 ? { matchedSymbols: rollup.symbols } : {}),
    });
  };

  for (const r of rows) {
    consider(r.rel_path, r.summary, r.symbols, r.language, r.size_bytes, r.score);
  }
  // Pull in symbol-matched files not already surfaced by the file-summary FTS.
  const extraPaths = [...symbolHitsByFile.keys()].filter((p) => !seen.has(p));
  if (extraPaths.length > 0) {
    const ph = extraPaths.map(() => "?").join(",");
    const extraRows = store.rawDb
      .prepare(
        `SELECT rel_path, summary, symbols, language, size_bytes
           FROM indexed_files WHERE rel_path IN (${ph})`,
      )
      .all(...extraPaths) as Array<{
        rel_path: string; summary: string; symbols: string | null;
        language: string | null; size_bytes: number;
      }>;
    for (const r of extraRows) {
      // No file-level bm25 (it didn't match the summary FTS); a neutral 0
      // score — its symbol-match tier carries the ranking.
      consider(r.rel_path, r.summary, r.symbols, r.language, r.size_bytes, 0);
    }
  }

  // Rank tier (higher first):
  //   4 — exact basename match (the file you named)
  //   3 — multi-word basename overlap (all query tokens are name words)
  //   2 — defines a matching symbol, OR a path-segment match
  //   1 — file-summary FTS match only
  // Within a tier: more matching symbols first, then bm25 (lower = better).
  const tier = (c: { boost: number; symbolHits: number }): number =>
    c.boost === 3 ? 4 : c.boost === 2 ? 3 : (c.symbolHits > 0 || c.boost === 1) ? 2 : 1;
  candidates.sort((a, b) =>
    (tier(b) - tier(a)) || (b.symbolHits - a.symbolHits) || (a.score - b.score),
  );
  return candidates.slice(0, k).map(({ boost: _b, symbolHits: _s, ...hit }) => hit);
}

/**
 * Per-file symbol-rollup result. `count` is the number of matching symbol
 * ROWS (overloads counted separately) — the ranking signal recallFiles tiers
 * on, unchanged from the pre-matchedSymbols behaviour. `symbols` is the
 * deduped (by name), best-bm25-first, length-capped list the injection payload
 * renders as a `matched: …` span.
 */
interface SymbolRollup {
  count: number;
  symbols: MatchedSymbol[];
}

/**
 * Symbol-level recall: query the indexed_symbols FTS and roll matching
 * symbols up to their parent files. Returns a map rel_path → { count, symbols }
 * where `count` is the rollup ranking signal and `symbols` are the matched
 * declarations (name + signature) for the payload. Best-effort: if the symbol
 * table is absent (pre-migration) or the query is empty, returns an empty map.
 * Bounded by SYMBOL_ROLLUP_LIMIT candidate symbols.
 */
const SYMBOL_ROLLUP_LIMIT = 200;
/**
 * Distinct matched symbols retained per file. The payload renders only 1–2;
 * we keep a small surplus so downstream dedupe/clamp has options without the
 * list growing unbounded on a file with hundreds of matching overloads.
 */
const MATCHED_SYMBOLS_PER_FILE = 3;
function recallSymbols(store: BlockStore, fts: string): Map<string, SymbolRollup> {
  const out = new Map<string, SymbolRollup>();
  if (!fts) return out;
  let rows: Array<{ rel_path: string; name: string; signature: string | null }>;
  try {
    rows = store.rawDb
      .prepare(
        `SELECT indexed_symbols.rel_path AS rel_path,
                indexed_symbols.name AS name,
                indexed_symbols.signature AS signature
           FROM indexed_symbols
           JOIN indexed_symbols_fts ON indexed_symbols.rowid = indexed_symbols_fts.rowid
           WHERE indexed_symbols_fts MATCH @fts
           ORDER BY bm25(indexed_symbols_fts)
           LIMIT @limit`,
      )
      .all({ fts, limit: SYMBOL_ROLLUP_LIMIT }) as Array<{
        rel_path: string; name: string; signature: string | null;
      }>;
  } catch {
    return out; // table not present (pre-migration store) — degrade cleanly
  }
  for (const r of rows) {
    const entry = out.get(r.rel_path) ?? { count: 0, symbols: [] };
    entry.count += 1;
    // Dedupe the rendered list by symbol name (keep the best-bm25 occurrence,
    // which sorts first), capped. `count` still reflects every row so the
    // existing tier ordering ("more matching symbols first") is unchanged.
    if (
      entry.symbols.length < MATCHED_SYMBOLS_PER_FILE &&
      !entry.symbols.some((s) => s.name === r.name)
    ) {
      entry.symbols.push({ name: r.name, signature: (r.signature ?? "").trim() });
    }
    out.set(r.rel_path, entry);
  }
  return out;
}

/**
 * Doc/metadata path classifier. True for files whose value to a code-
 * navigation query is low and which tend to spuriously out-rank source
 * under bm25 (prose density + porter stemming). Conservative on purpose:
 * only well-known documentation + package-metadata shapes.
 */
export function isDocClassPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  const base = p.split("/").pop() ?? p;
  const lower = base.toLowerCase();
  // Prose / documentation extensions.
  if (/\.(md|mdx|markdown|rst|adoc|txt)$/i.test(lower)) return true;
  // Well-known metadata files (no extension or json).
  if (/^(license|licence|copying|authors|notice|changelog|contributing|code_of_conduct|security|maintainers|codeowners)(\.[a-z]+)?$/i.test(lower)) return true;
  // Package + lockfile + common tool config metadata.
  if (
    lower === "package.json" || lower === "package-lock.json" ||
    lower === "yarn.lock" || lower === "pnpm-lock.yaml" || lower === "composer.lock" ||
    lower === "cargo.lock" || lower === "poetry.lock" || lower === "go.sum" ||
    /^(tsconfig|jsconfig)(\.[\w.-]+)?\.json$/i.test(lower) ||
    /^\.?(eslintrc|prettierrc|babelrc|browserslistrc|editorconfig|npmrc|nvmrc|gitignore|gitattributes|mailmap)(\.[\w.-]+)?$/i.test(lower)
  ) return true;
  // Anything under a docs/ directory tree.
  if (/(^|\/)docs?\//i.test(p)) return true;
  return false;
}

/**
 * Doc-intent keywords for the prompt-side override. Deliberately
 * SPECIFIC: bare words that also appear in code-task instructions
 * ("install", "setup", "config") are excluded, because a prompt like
 * "fix the bug; do NOT install packages" must NOT be treated as a
 * documentation query. We require unambiguous doc phrasing.
 */
const DOC_INTENT_RE =
  /\b(readme|documentation|changelog|change-log|licen[sc]e|contributing\s+guide|installation|getting[- ]started|tutorial|user[- ]guide|how\s+to\s+(?:install|configure|set\s?up)|package\.json|dependenc(?:y|ies))\b/i;

function hasDocIntent(prompt: string): boolean {
  return DOC_INTENT_RE.test(prompt);
}

/**
 * Test / test-fixture path classifier. True for unit/spec test files and the
 * data fixtures they drive. These exercise the code under test; a
 * "where is the fix" query wants the implementation, not the test — and test
 * files (feature term repeated across test names) + data fixtures otherwise
 * out-rank the single source file under bm25.
 */
export function isTestClassPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  const base = (p.split("/").pop() ?? p).toLowerCase();
  // Test/spec file naming: foo.test.ts, foo.spec.js, test_foo.py, foo_test.go.
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(base)) return true;
  if (/^test_.+\.py$/i.test(base) || /_test\.(py|go)$/i.test(base)) return true;
  if (base === "conftest.py") return true;
  // Anything under a test(s)/ __tests__/ spec/ tree, or a fixtures dir.
  if (/(^|\/)(tests?|__tests__|spec|specs|fixtures?)\//i.test(p)) return true;
  return false;
}

/** Test-intent keywords for the prompt-side override. */
const TEST_INTENT_RE = /\b(test|tests|spec|specs|fixture|fixtures|unit[- ]test|test[- ]case)\b/i;
function hasTestIntent(prompt: string): boolean {
  return TEST_INTENT_RE.test(prompt);
}

/**
 * Tokenize + escape a free-text prompt into an FTS5 MATCH expression.
 *
 * Strategy (aligned with block recall's `sanitizeFtsQuery`):
 *   1. strip FTS5 metacharacters;
 *   2. drop stop-words / tool-names / generic agent-prompt fillers
 *      (shared `FTS_STOP_WORDS`) — they carry no retrieval signal and
 *      otherwise bury the real term under bm25;
 *   3. quote each surviving token and join with OR.
 *
 * The join is ALWAYS OR (was: AND for ≤3 tokens). The old AND rule was
 * too brittle against the heuristic summaries: a 2-term query built from
 * two source basenames (`derivative typed`) required BOTH terms in one
 * file's summary, which excluded each single-responsibility source file
 * (derivative.js has "derivative" but not "typed", and vice-versa). OR +
 * bm25 naturally ranks a file matching more query terms above one matching
 * fewer, so precision survives without the all-or-nothing gate.
 */
function sanitizeRecallQuery(prompt: string): string {
  const words = recallQueryTokens(prompt);
  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(" OR ");
}

/**
 * Tokenize a free-text prompt into deduped, lowercased, stop-word-stripped
 * terms — the shared basis for both the FTS MATCH expression and the
 * filename-boost re-rank.
 */
function recallQueryTokens(prompt: string): string[] {
  const cleaned = (prompt ?? "").replace(/[*"():^~{}[\]\\]/g, " ").trim();
  if (!cleaned) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    const w = raw.toLowerCase();
    if (w.length > 1 && !FTS_STOP_WORDS.has(w) && !seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out;
}

/**
 * Relevance boost for path/name matches the bm25 lexical score under-weights.
 * Tier 2: a query token equals the file's basename (sans extension) — the
 * strongest "this is the file you named" signal (counters bm25 length-penalty
 * on large canonical files like console.py). Tier 1: a query token equals any
 * intermediate path segment (sans extension). Tier 0: no path match.
 */
function filenameBoost(relPath: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const segs = relPath.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  if (segs.length === 0) return 0;
  const base = (segs[segs.length - 1] ?? "").replace(/\.[a-z0-9]+$/i, "");
  const tokenSet = new Set(tokens);
  // 3 — exact basename match (the file you named). Strictly strongest: an
  // exact `console.ts` must beat a sibling `_win32_console.ts` that merely
  // contains "console" as a word.
  if (tokenSet.has(base)) return 3;
  // 2 — multi-word basename overlap: every query token is one of the
  // basename's component words (so `from-json-schema.ts` boosts for
  // "json schema"). Subset match avoids boosting on a single shared word.
  const baseParts = new Set(splitIdentifier(base).map((w) => w.toLowerCase()));
  if (baseParts.size > 0 && tokens.every((t) => baseParts.has(t))) return 2;
  // 1 — a path segment exactly equals a query token.
  for (const seg of segs.slice(0, -1)) {
    const s = seg.replace(/\.[a-z0-9]+$/i, "");
    if (tokenSet.has(s)) return 1;
  }
  return 0;
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
