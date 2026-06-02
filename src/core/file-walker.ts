/**
 * Budget-bounded workspace walker (PLAN-0.7 §rc.2).
 *
 * Walks the workspace tree under explicit time / file-count / byte
 * budgets. Yields one `WalkedFile` per indexable file. Halts when
 * any budget is exhausted; the unconsumed remainder is returned as
 * `pendingFiles` (visited-but-not-yielded) and `pendingDirs`
 * (never-entered directory prefixes).
 *
 * Privacy invariants:
 *   - All paths surface as `relPath` via `toRepoRelative`. A file
 *     whose absolute path can't be repo-rooted is dropped (skipped
 *     with reason `'out-of-repo'` — the indexer emits a
 *     `file_index.skipped` event without the path).
 *   - The exclusion list is a closed set; arbitrary user-supplied
 *     globs are NOT honored at this layer (the indexer parses
 *     `.gitignore` separately and feeds it in as a filter).
 *
 * No DB writes here, no summarizer calls — this layer is just I/O.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative as pathRelative, sep as pathSep } from "node:path";
import { isRepoRelative, toRepoRelative } from "./guard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalkBudget {
  /** Wall-clock cap. Default 30000 (= 30s). */
  timeMs: number;
  /** Hard count cap on yielded files. Default 5000. */
  maxFiles: number;
  /** Hard cumulative byte cap on file CONTENTS the walker reads. Default 64 MiB. */
  maxBytesScan: number;
}

export const DEFAULT_BUDGET: WalkBudget = {
  timeMs: 30_000,
  maxFiles: 5_000,
  maxBytesScan: 64 * 1024 * 1024,
};

export interface WalkOptions {
  /**
   * Root directory to walk. Doubles as both BFS start point AND
   * the basis for repo-relative `relPath` resolution UNLESS
   * `baseRoot` is provided separately.
   */
  root: string;
  /**
   * 0.7.0-rc.2 hardening — repo-base override.
   *
   * When `drainIndexerPending` re-walks a queued sub-directory
   * (`kind='dir'`), the BFS START is the sub-directory but the
   * repo-relative `relPath` for any yielded file MUST still be
   * computed against the original project root — otherwise
   * `src/deep/target.ts` ends up persisted as `target.ts`,
   * breaking the `indexed_files.rel_path UNIQUE` contract and
   * silently corrupting recall.
   *
   * Contract: when omitted, `baseRoot === root` and behaviour is
   * identical to pre-hardening. When set, BFS starts at `root`
   * but every yielded file's `relPath` is `path.relative(baseRoot, abs)`.
   * Caller is responsible for ensuring `root` is inside `baseRoot`;
   * the walker doesn't validate this (an out-of-base path would
   * surface as `..`-prefixed and fail the repo-rel guard cleanly).
   */
  baseRoot?: string;
  /** Optional budget override. Missing fields fall back to DEFAULT_BUDGET. */
  budget?: Partial<WalkBudget>;
  /**
   * Per-file size cap. Files larger than this are skipped with
   * reason `'too-large'`. Default 256 KiB.
   */
  maxBytes?: number;
  /**
   * `now()` override for tests; lets us drive the time budget
   * without sleeps. Defaults to `Date.now`.
   */
  now?: () => number;
}

/** A file that cleared all filters and was read into memory. */
export interface WalkedFile {
  relPath: string;
  content: string;
  sizeBytes: number;
}

/** A file the walker skipped, with a coarse reason. Path is local-only. */
export interface SkippedFile {
  relPath: string;
  reason:
    | "binary"
    | "too-large"
    | "out-of-repo"
    | "unreadable"
    | "excluded-dir"
    | "excluded-suffix";
}

export interface WalkResult {
  files: WalkedFile[];
  skipped: SkippedFile[];
  /** Files visited but not yielded — budget hit before they were read. */
  pendingFiles: string[];
  /** Directories never descended into — budget hit before they were entered. */
  pendingDirs: string[];
  /** Total bytes the walker read from disk (sum of WalkedFile.sizeBytes). */
  bytesRead: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Exclusion lists
// ---------------------------------------------------------------------------

const EXCLUDED_DIR_BASENAMES = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".tracebase",
  ".next",
  ".cache",
  ".pnpm-store",
  ".turbo",
  // Python virtualenvs + dependency trees + tool caches. These hold
  // installed third-party packages (often vendoring other libraries, e.g.
  // pip bundles `rich`), not the project's own source — indexing them
  // pollutes recall with dependency junk. Matched by EXACT directory
  // basename, so a source file like `environment.ts` or a dir named
  // `environments/` is unaffected.
  ".venv",
  "venv",
  ".env",
  "env",
  "site-packages",
  "dist-packages",
  "__pycache__",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

/**
 * Suffixes we never read regardless of size — binary or
 * irrelevant-by-extension. Cheaper than null-byte sniffing for
 * known cases; the sniff is the second line of defense.
 *
 * 0.7.0-rc.3 hardening — exported so the indexSingleFile path in
 * file-indexer.ts can lock to the same set via a regression test.
 * Pre-export the lists were duplicated; the locked test in
 * `tests/core/walker-indexer-constants.test.ts` asserts the two
 * stay byte-identical until they're physically deduped before
 * 0.7.0 stable.
 */
export const EXCLUDED_SUFFIXES = new Set<string>([
  // Bytecode / archives / images / fonts / video.
  ".pyc", ".pyo", ".class", ".o", ".obj", ".exe", ".dll", ".so", ".dylib",
  ".a", ".lib", ".jar", ".war", ".tar", ".gz", ".zip", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".webm", ".mov", ".avi", ".wav", ".ogg",
  ".pdf",
  // Lock files (no semantic content for the indexer).
  ".lock", ".sum",
  // Generated source maps.
  ".map",
]);

/**
 * Per-file size cap. Files larger than this skip with reason
 * `'too-large'`. Matched by `PER_FILE_MAX_BYTES` in `file-indexer.ts`
 * — see the locked-constants test.
 */
export const DEFAULT_MAX_BYTES = 256 * 1024;
/**
 * Null-byte sniff window. Same threshold in `file-indexer.ts` —
 * see the locked-constants test.
 */
export const NULL_SNIFF_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

export function walkWorkspace(opts: WalkOptions): WalkResult {
  const budget: WalkBudget = {
    timeMs: opts.budget?.timeMs ?? DEFAULT_BUDGET.timeMs,
    maxFiles: opts.budget?.maxFiles ?? DEFAULT_BUDGET.maxFiles,
    maxBytesScan: opts.budget?.maxBytesScan ?? DEFAULT_BUDGET.maxBytesScan,
  };
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts.now ?? Date.now;
  const start = now();
  // 0.7.0-rc.2 hardening — `baseRoot` is the repo-relative pivot;
  // `startRoot` is the BFS entry point. Pre-hardening they were
  // collapsed into a single `root`. Defaulting `baseRoot` to
  // `root` keeps every existing call site byte-identical.
  const baseRoot = opts.baseRoot ?? opts.root;
  const startRoot = opts.root;

  const files: WalkedFile[] = [];
  const skipped: SkippedFile[] = [];
  const pendingFiles: string[] = [];
  const pendingDirs: string[] = [];
  let bytesRead = 0;

  const budgetExhausted = (): boolean =>
    files.length >= budget.maxFiles ||
    bytesRead >= budget.maxBytesScan ||
    now() - start >= budget.timeMs;

  // BFS so the budget hits the shallowest unexplored prefix first
  // (which is the most useful `pendingDirs` shape — nearer-the-root
  // dirs unlock the most files when re-walked).
  const queue: string[] = [startRoot];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (budgetExhausted()) {
      // Everything still in the queue becomes a pending dir.
      // `relPath` is always against `baseRoot` so the queue rows
      // resolve correctly on the next drain pass.
      const remaining = [dir, ...queue];
      for (const r of remaining) {
        const rel = toRel(baseRoot, r);
        if (rel !== null) pendingDirs.push(rel);
      }
      break;
    }

    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      // Permission denied or transient I/O — skip the dir, no
      // path leaks (we don't even record this in `skipped` because
      // the path is the dir itself, which is opaque without reads).
      continue;
    }

    // Sort for deterministic walks (test stability).
    entries.sort();

    for (const entry of entries) {
      if (budgetExhausted()) {
        // The current dir is half-walked — record what's left as
        // a pending dir so the resumer re-walks it.
        const rel = toRel(baseRoot, dir);
        if (rel !== null && !pendingDirs.includes(rel)) pendingDirs.push(rel);
        break;
      }

      const abs = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        if (EXCLUDED_DIR_BASENAMES.has(entry)) {
          // Excluded — record an aggregate skip so the doctor can
          // surface it; never echo the dir name path beyond rel.
          const rel = toRel(baseRoot, abs);
          if (rel !== null) {
            skipped.push({ relPath: rel, reason: "excluded-dir" });
          }
          continue;
        }
        queue.push(abs);
      } else if (st.isFile()) {
        const rel = toRel(baseRoot, abs);
        if (rel === null) {
          // Path won't repo-rel cleanly. We still want to record
          // a skipped event but with no path.
          skipped.push({ relPath: "", reason: "out-of-repo" });
          continue;
        }
        const lower = entry.toLowerCase();
        if ([...EXCLUDED_SUFFIXES].some((s) => lower.endsWith(s))) {
          skipped.push({ relPath: rel, reason: "excluded-suffix" });
          continue;
        }
        if (st.size > maxBytes) {
          skipped.push({ relPath: rel, reason: "too-large" });
          continue;
        }

        // Cumulative-bytes budget gate before reading.
        if (bytesRead + st.size > budget.maxBytesScan) {
          pendingFiles.push(rel);
          continue;
        }

        let content: string;
        try {
          content = readFileSync(abs, "utf-8");
        } catch {
          skipped.push({ relPath: rel, reason: "unreadable" });
          continue;
        }
        // Null-byte sniff over the first NULL_SNIFF_BYTES — catches
        // binaries that slipped past the suffix list.
        if (looksBinary(content)) {
          skipped.push({ relPath: rel, reason: "binary" });
          continue;
        }
        files.push({ relPath: rel, content, sizeBytes: st.size });
        bytesRead += st.size;
      }
    }
  }

  return {
    files,
    skipped,
    pendingFiles,
    pendingDirs,
    bytesRead,
    durationMs: now() - start,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRel(root: string, abs: string): string | null {
  // Repo-relative via `relative` (POSIX-style separators). Anything
  // that escapes the root or fails the guard returns null.
  const rel = pathRelative(root, abs).split(pathSep).join("/");
  if (rel === "" || rel === ".") return ".";
  if (!isRepoRelative(rel)) {
    // toRepoRelative covers absolute / `..` / `~` / drive-letter
    // shapes; isRepoRelative is the cheaper post-check.
    return toRepoRelative(rel, root);
  }
  return rel;
}

function looksBinary(content: string): boolean {
  // The null-byte sniff: if any of the first NULL_SNIFF_BYTES chars
  // is U+0000, treat as binary. ASCII text never carries NUL; UTF-8
  // text never carries NUL outside intentionally-binary sequences.
  const limit = Math.min(content.length, NULL_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}
