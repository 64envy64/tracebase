/**
 * Canonical tokenization + stop-word / generic-vocabulary policy.
 *
 * SINGLE SOURCE OF TRUTH for informative-term extraction, shared by:
 *   - FTS query sanitization      (`block-serving.ts` → `sanitizeFtsQuery`)
 *   - serving evidence + gating   (`serving-confidence.ts`)
 *   - offline precision evaluation (`scripts/reasoning-precision/*`)
 *
 * Retrieval and gating MUST agree on what counts as an informative term;
 * if they diverge, a query can retrieve a block on a token that the gate
 * never sees (or vice-versa) and the precision policy becomes incoherent.
 * Everything that needs "the informative tokens of this text" calls
 * `tokenizeInformative` here — nothing re-implements its own splitter.
 *
 * Two vocabularies:
 *   - STOP_WORDS         — removed entirely (English filler, agent-prompt
 *                          noise, Claude Code tool names). Never tokens.
 *   - GENERIC_CODE_TOKENS — kept as tokens (still searchable) but NOT
 *                          discriminative: a query that overlaps a block
 *                          ONLY on these is "generic-only" and abstains.
 */

/**
 * Tokens removed before anything downstream sees them. English stop-words,
 * Claude Code tool names, and generic agent-prompt fillers. Migrated from
 * the former `FTS_STOP_WORDS` in `block-serving.ts` so FTS sanitization and
 * serving evidence share one list.
 */
export const STOP_WORDS = new Set<string>([
  // English stop-words
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "to", "from", "by", "for", "with", "about",
  "into", "onto", "over", "under", "as", "than", "then", "so",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "our", "their", "its",
  "this", "that", "these", "those",
  "and", "or", "but", "if", "not", "no", "yes",
  "do", "does", "did", "doing", "done",
  "have", "has", "had", "having",
  "will", "would", "can", "could", "should", "may", "might", "must",
  "how", "what", "when", "where", "why", "who", "which",
  "just", "only", "also", "very", "more", "less", "most", "least",
  // Claude Code tool names — common in prompts, never useful retrieval signal.
  "read", "write", "edit", "bash", "grep", "glob", "task", "agent",
  "webfetch", "websearch", "notebookedit", "exitplanmode", "todowrite",
  "tool", "tools", "file", "files",
  // Generic agent verbs / fillers
  "please", "help", "need", "want", "like", "get", "make", "use", "using",
  "run", "running", "try", "trying", "check", "checking", "look", "looking",
  "see", "show", "find", "finding", "let", "lets",
]);

/**
 * Generic programming vocabulary. These ARE tokenized (so FTS can still
 * match on them) but carry too little discriminative power to justify an
 * injection on their own. Matching a block solely on these words is the
 * canonical "weak / generic-only" overlap that the precision policy
 * abstains on. Kept deliberately conservative — only words so common that
 * their presence says nearly nothing about which specific block applies.
 */
export const GENERIC_CODE_TOKENS = new Set<string>([
  "function", "func", "method", "class", "object", "type", "types",
  "value", "values", "variable", "var", "const",
  "string", "number", "int", "float", "bool", "boolean", "list", "array",
  "dict", "map", "set", "tuple", "enum", "struct", "interface",
  "code", "data", "field", "key", "name", "id", "index",
  "return", "returns", "import", "imports", "export", "exports", "module",
  "call", "calls", "called", "add", "remove", "update", "create", "delete",
  "handle", "handler", "process", "parse", "format", "convert",
  "config", "option", "options", "param", "params", "argument", "arg", "args",
  "result", "results", "output", "input", "case", "cases",
  "fix", "fixed", "issue", "bug", "problem", "fail", "failed", "failing",
  "pass", "passing", "test", "tests", "testing", "line", "lines",
  "property", "attribute", "instance", "element", "item", "items",
  "loop", "iterate", "iteration", "condition", "branch",
]);

const FTS_SYNTAX = /[*"():^~{}[\]\\]/g;
const SPLIT = /[^a-z0-9_]+/;

/**
 * Lowercase, strip FTS syntax, split on non-word boundaries, and drop
 * stop-words, single-character tokens, and pure-numeric tokens. Returns a
 * de-duplicated, order-preserving list of informative tokens.
 *
 * This is the canonical informative-token set. FTS sanitization builds its
 * query string from it; serving evidence computes coverage against it;
 * offline eval scores against it. One splitter, one policy.
 */
export function tokenizeInformative(text: string): string[] {
  if (!text) return [];
  const cleaned = text.replace(FTS_SYNTAX, " ").toLowerCase();
  const words = cleaned.split(SPLIT);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (w.length < 2) continue;
    if (/^\d+$/.test(w)) continue;
    if (STOP_WORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** True when `token` is informative but too generic to be discriminative. */
export function isGenericToken(token: string): boolean {
  return GENERIC_CODE_TOKENS.has(token);
}

/**
 * The discriminative subset of `tokens` — informative AND not generic.
 * These are the tokens whose overlap actually identifies a specific block.
 */
export function meaningfulTokens(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !GENERIC_CODE_TOKENS.has(t));
}

/**
 * Stable, non-reversible hash of a prompt for telemetry. We never persist
 * the raw prompt to the event log; the hash lets us correlate repeated
 * queries without storing sensitive text. FNV-1a (32-bit) — deterministic,
 * dependency-free, sufficient for correlation (not cryptographic).
 */
export function queryHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 to get an unsigned 32-bit int, then hex.
  return "q_" + (h >>> 0).toString(16).padStart(8, "0");
}
