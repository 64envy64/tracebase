/**
 * Shared guards for every write path into the local reasoning/memory
 * store. Centralised here so new features don't invent their own
 * bounds + leakage checks; 0.5's TB MEMORY extractor, the future
 * TB CONTEXT digest writer, and any SDK-facing store path all route
 * through these helpers.
 *
 * Three concerns live together because they always fire together on a
 * write:
 *   1. `boundField` — enforce a hard char cap on user-visible text, so
 *      a runaway extractor can't balloon a row.
 *   2. `isRepoRelative` / `toRepoRelative` — reject absolute paths at
 *      the API boundary; normalise workspace-rooted paths when safe.
 *   3. `LEAKAGE_PATTERNS_EXTENDED` — secret / env / abs-path shapes
 *      layered on top of the distiller's existing gold-truth scanner
 *      (block.ts).
 *
 * All helpers are pure and dependency-free. They run on the hot hook
 * path, so no async IO, no regex compile-in-loop.
 */

import { isAbsolute, relative as pathRelative, normalize as pathNormalize } from "node:path";

// ---------------------------------------------------------------------------
// Bounded text fields
// ---------------------------------------------------------------------------

/**
 * Trim + clamp a user-visible text field. Returns the bounded string
 * along with a `truncated` flag the caller can use to record that the
 * original was cut. Never throws — an empty / whitespace-only input
 * returns `""` so callers can fold "absent" and "too short" into one
 * branch at the top.
 *
 * `max` is a hard character cap; we intentionally don't count tokens
 * here — tokens are budget territory for the injector, fields are
 * storage territory.
 */
export interface BoundedField {
  value: string;
  truncated: boolean;
}

export function boundField(input: unknown, max: number, _label: string): BoundedField {
  if (typeof input !== "string") return { value: "", truncated: false };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { value: "", truncated: false };
  if (trimmed.length <= max) return { value: trimmed, truncated: false };
  return { value: trimmed.slice(0, max), truncated: true };
}

// ---------------------------------------------------------------------------
// Path handling — repo-relative enforcement
// ---------------------------------------------------------------------------

/**
 * True iff `candidate` looks like a path we accept into storage:
 *   - non-empty
 *   - not absolute (no leading `/`, no Windows drive letter)
 *   - doesn't start with `..` (would escape the workspace)
 *   - doesn't contain a `~` home-dir hint
 *
 * The check is deliberately conservative — any candidate the extractor
 * can't prove safe gets rejected. Repo-relative paths like
 * `src/foo.ts` or `tests/cli/*.test.ts` pass.
 */
export function isRepoRelative(candidate: string): boolean {
  if (typeof candidate !== "string") return false;
  const c = candidate.trim();
  if (c.length === 0) return false;
  if (c.length > 256) return false;
  if (isAbsolute(c)) return false;
  if (c.startsWith("~")) return false;
  if (/^[A-Za-z]:[\\/]/.test(c)) return false; // Windows drive letter
  // Normalise and reject if the normalised form escapes the repo.
  const norm = pathNormalize(c);
  if (norm.startsWith("..")) return false;
  return true;
}

/**
 * Convert an absolute path to repo-relative, or return `null` if that
 * would escape `basePath`. Used by extractors that capture a full path
 * from a transcript and want to store the short form.
 *
 * Returns `null` for any input we can't prove safe — absolute paths
 * outside the workspace, `~`-relative paths, drive-letter paths. The
 * caller treats `null` as "reject this candidate".
 */
export function toRepoRelative(candidate: string, basePath: string): string | null {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
  const c = candidate.trim();
  if (c.startsWith("~")) return null;
  if (/^[A-Za-z]:[\\/]/.test(c)) return null;
  if (isAbsolute(c)) {
    const rel = pathRelative(basePath, c);
    // `relative` returning an absolute path means the conversion
    // failed (different roots on Windows, etc.) — reject.
    if (isAbsolute(rel) || rel.startsWith("..")) return null;
    return rel || ".";
  }
  // Already relative — still validate it doesn't escape.
  return isRepoRelative(c) ? pathNormalize(c) : null;
}

// ---------------------------------------------------------------------------
// Extended leakage patterns (§4.3 of PLAN-0.5)
// ---------------------------------------------------------------------------

/**
 * Shapes that must never appear in a stored field. Layered on top of
 * the distiller's gold-truth scanner in `block.ts`. When any pattern
 * matches, the write is rejected at the extractor boundary — we don't
 * mutate the string.
 *
 * Names are stable (used in telemetry error-class counts per §7).
 */
export const LEAKAGE_PATTERNS_EXTENDED: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Absolute filesystem paths on Unix-like hosts. `/etc/…`, `/Users/…`,
  // `/home/…`, `/tmp/…`, `/private/…`, `/var/…` cover > 99 % of real leaks.
  { name: "abs-path-posix", re: /(?:^|[\s(`"'])\/(?:Users|home|tmp|private|var|etc|root|opt|usr)\//m },
  // Windows absolute paths.
  { name: "abs-path-windows", re: /(?:^|[\s(`"'])[A-Za-z]:[\\/]/ },
  // API keys / bearer tokens. The leading `sk-` or `Bearer ` cue is
  // conservative enough to skip false positives in normal prose.
  // More-specific patterns come first so overlaps resolve to the
  // most informative label (e.g. `sk-ant-…` should classify as
  // `api-key-anthropic`, not the generic `api-key-sk`).
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/ },
  { name: "api-key-anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "api-key-github", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "api-key-sk", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  // `.env`-line shape: ALL_CAPS name `=` then a non-empty value on one
  // line. Matches `AWS_SECRET_KEY=…` etc. Tight enough to skip casual
  // `X=1` prose.
  { name: "env-line", re: /^\s*[A-Z][A-Z0-9_]{2,}=[^\s=][^\n]{3,}$/m },
];

/**
 * Run the extended pattern set against a single string. Returns the
 * first matched pattern name, or `null` on a clean corpus. Callers
 * stitch together the strings they want scanned and hand the result
 * to this fn — same calling convention as `detectLeakage` in block.ts.
 */
export function detectLeakageExtended(corpus: string): string | null {
  if (typeof corpus !== "string" || corpus.length === 0) return null;
  for (const { name, re } of LEAKAGE_PATTERNS_EXTENDED) {
    if (re.test(corpus)) return name;
  }
  return null;
}
