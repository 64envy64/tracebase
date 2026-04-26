/**
 * `normalizeIntentKey` — semantic-equivalence collapse for tool
 * arguments (PLAN-0.7 §rc.5).
 *
 * Two tool calls with different `argKey` values can describe the
 * same SEMANTIC intent — `grep -r "auth_token"` and
 * `rg "auth[_-]token"` both look for the auth-token symbol, but
 * the HMAC argKey treats them as orthogonal. The loop redirect
 * resolver in §rc.5 keys on this `intent_key` so repeated search-
 * shaped calls collapse into a single signal even when the
 * underlying tool / regex flags differ.
 *
 * Privacy invariants:
 *   - Reads ONLY the already-sanitised `argSummary` string. Never
 *     touches raw `tool_input` (which is forbidden — see
 *     `tests/privacy/no-tool-input-bodies.test.ts`).
 *   - Output is bounded; no part of `argSummary` survives outside
 *     what the sanitiser already approved at PostToolBatch time.
 *   - Tool name is mapped via `toolFamily()` so the LITERAL tool
 *     name never appears in the intent_key — only the family slot
 *     (`read` / `search` / `shell` / etc.). Same vocabulary the
 *     cloud allowlist uses.
 */
import { toolFamily } from "../runtime/tool-family.js";

/**
 * Common flags we drop from search/read/shell argSummaries before
 * normalising. The sanitiser at PostToolBatch already drops most
 * of these; this list is belt-and-braces in case a host emits a
 * subtly different shape (e.g. some grep variants flatten args
 * into a single string with the flag inline).
 *
 * The list is conservative — only flags that are widely understood
 * to alter HOW a search runs without changing WHAT it searches
 * for. We don't drop `-w` (word-bounded) or `-x` (exact line)
 * because those DO change the semantic intent.
 */
const DROPPABLE_FLAGS = new Set<string>([
  // recursion / case
  "-r",
  "-R",
  "--recursive",
  "-i",
  "--ignore-case",
  // include hidden files / line counts
  "--hidden",
  "--include",
  "-l",
  "--files-with-matches",
  "-n",
  "--line-number",
  "-h",
  "--no-filename",
]);

/**
 * Regex metacharacter strip — turns `auth[_-]token` and `auth_token`
 * into the same lexical shape after step 3. Also strips `/` and `#`
 * so the resolver's content-derivation audit can split rel-path
 * fragments (`src/auth.ts` → `src auth ts`) and id-prefix tokens
 * (`#a5a12778` → `a5a12778`) the same way the inputs are tokenised.
 */
const REGEX_METACHAR_RE = /[*?[\]()\\^$+|.{}/#]/g;

/**
 * Lowercase + strip metachars + collapse `[_-]` and whitespace to
 * a single space + drop droppable flags. Returns the family-prefixed
 * intent_key. Example:
 *
 *   normalizeIntentKey("Grep(-r 'auth_token')", "Grep")
 *     → "search:grep auth token"
 *   normalizeIntentKey("rg('auth[_-]token')", "ripgrep")
 *     → "search:rg auth token"
 *
 * Note: the binary name (grep vs rg) survives because the
 * sanitiser kept it; what collapses is the regex metachar layer
 * + flag noise. The downstream resolver sees both as
 * "search:* auth token" after tokenization — see
 * `intentKeyTokens()` for the per-call token split.
 */
export function normalizeIntentKey(argSummary: string, toolName: string): string {
  const family = toolFamily(toolName);

  // Step 0: strip the `ToolName(...)` envelope the sanitiser wraps
  // every argSummary in. The literal binary name (grep / rg / ag /
  // findstr) lives as the leading token; without this strip,
  // `Grep(auth)` and `rg(auth)` would have different intent_keys
  // even though the family slot already captures the binary
  // family. The match is conservative — only the leading
  // `Word(` ... matching `)` collapses; anything that doesn't fit
  // the wrapper falls through unchanged.
  let s = stripToolEnvelope(argSummary ?? "");

  // Step 1: lowercase + strip regex metacharacters. Quotes around
  // strings drop here too (` ' `, ` " `), which is the right move
  // — `auth_token` and `'auth_token'` were the same intent.
  s = s.toLowerCase().replace(REGEX_METACHAR_RE, " ");
  // Quotes (apostrophes / double-quotes) are not in the metachar
  // class above; strip them explicitly.
  s = s.replace(/['"`]/g, " ");

  // Step 2: collapse `[_-]` and whitespace to single space.
  s = s.replace(/[_\-\s]+/g, " ").trim();

  // Step 3: tokenise + drop droppable flags. Tokens that look like
  // flags (`-x` / `--longflag`) but aren't in the closed drop list
  // survive as-is; that's the conservative-by-default stance.
  const tokens = s.split(/\s+/).filter((t) => {
    if (t.length === 0) return false;
    if (DROPPABLE_FLAGS.has(t) || DROPPABLE_FLAGS.has("-" + t) || DROPPABLE_FLAGS.has("--" + t)) {
      return false;
    }
    return true;
  });

  // Step 4: prefix with family slot. The literal tool name never
  // appears here — `toolFamily()` collapses grep / rg / ag /
  // findstr / Grep / Glob → "search".
  return `${family}:${tokens.join(" ")}`.trimEnd();
}

/**
 * Token split for the loop-redirect's content-derivation audit.
 * The redirect MUST contain nothing not in (argSummary tokens ∪
 * anchor tokens ∪ fixed phrase set); this returns the token set
 * the redirect is allowed to draw from on the argSummary side.
 *
 * Returns the FULL token set including the leading binary name —
 * the audit cares about every token the user might see in a
 * redirect, not just the family-collapsed payload.
 */
export function intentKeyTokens(argSummary: string): Set<string> {
  const lowered = (argSummary ?? "")
    .toLowerCase()
    .replace(REGEX_METACHAR_RE, " ")
    .replace(/['"`]/g, " ")
    .replace(/[_\-\s]+/g, " ")
    .trim();
  const tokens = lowered.split(/\s+/).filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Strip the `ToolName(...)` envelope the per-tool sanitiser wraps
 * every argSummary in. Returns the inner payload, or the original
 * string when no wrapper match.
 */
function stripToolEnvelope(s: string): string {
  // Match leading `Word(` ... trailing `)`. The match is
  // intentionally non-greedy — a payload that itself contains a
  // `)` keeps that character; only the OUTER wrapper drops.
  const m = s.match(/^[A-Za-z][A-Za-z0-9]*\((.*)\)\s*$/s);
  if (m && typeof m[1] === "string") return m[1];
  return s;
}
