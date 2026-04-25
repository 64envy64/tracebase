/**
 * Per-tool argument sanitiser for the 0.5.3 PostToolBatch hook
 * (`tracebase capture-tool-use`).
 *
 * The PostToolBatch payload Claude Code hands us carries the FULL
 * `tool_input` body for every completed tool call (and the
 * `tool_response` body — which we never read at all). Storing those
 * verbatim would put user-prompt tokens, source code, and command
 * lines into `tool_observations` rows. That is not what this table
 * is for.
 *
 * What this module does instead:
 *
 *   1. For each known tool, project `tool_input` down to a fixed
 *      allowlist of fields (Read → `file_path`, Grep → `pattern` +
 *      optional `path`, Bash → first token of `command`, …). Every
 *      field on every other tool is dropped.
 *
 *   2. Normalise the survivors. File paths are forced to repo-
 *      relative — anything outside `cwd` collapses to `arg-hidden`.
 *      Patterns are clipped to a hard byte cap. Bash commands keep
 *      only the binary name; the arguments never make it through.
 *
 *   3. Run `detectLeakageExtended` on the human-readable summary as
 *      a last-line defence: a Read of `~/.aws/credentials` would
 *      already have been rejected at step 2 (outside `cwd`), but if
 *      a future caller skips the cwd guard the leakage scanner here
 *      catches it and downgrades to `arg-hidden`.
 *
 *   4. Emit:
 *        argSummary — a short human-readable form
 *                     (`Read(src/foo.ts)`, `Grep("regex")[src]`,
 *                      `Bash(npm)`, `Edit(arg-hidden)`).
 *        argKey     — HMAC-SHA256 of the canonicalised allowlisted
 *                     payload, keyed with the local workspace salt.
 *                     Same Read of the same file collides into the
 *                     same bucket within a workspace — across
 *                     workspaces, the buckets diverge because the
 *                     salts differ.
 *
 * The duplicate / loop / ping-pong detector in inject-context reads
 * the stored `argKey` column and never sees the literal arguments.
 *
 * NEVER reads `tool_response`. Caller is responsible for not passing
 * it in. Defence in depth: this module ignores any field the
 * tool-specific projection doesn't list, so a stray `tool_response`
 * in the input dict is a no-op even if the caller forgets to strip
 * it.
 */

import { createHmac } from "node:crypto";
import { detectLeakageExtended, toRepoRelative } from "./guard.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SanitizeToolArgsInput {
  toolName: string;
  /** Raw `tool_input` from the PostToolBatch payload. May be anything. */
  toolInput: unknown;
  /** Repo root used to normalise file paths — typically `stdin.cwd`. */
  cwd: string;
  /** Workspace HMAC key from `getOrMintWorkspaceSalt`. */
  workspaceSalt: string;
}

export interface SanitizedToolArgs {
  /** Human-readable: `Read(src/foo.ts)`, `Bash(npm)`, `Edit(arg-hidden)`. */
  argSummary: string;
  /** 16-hex-char HMAC bucket. Same bucket = same arg shape per workspace. */
  argKey: string;
}

/**
 * Hard cap for clipped pattern fields (Grep / Glob `pattern`). 80
 * chars is comfortably above any realistic regex (`pgrep`-style
 * patterns are typically 20–40 chars) and well under the leakage-
 * scanner's natural matching window.
 */
const PATTERN_CLIP = 80;

/**
 * Bucket id length. 16 hex chars = 64 bits — collision-free in
 * practice for the small number of distinct (tool_name, args)
 * combinations a single session produces (typically << 1k).
 */
const ARG_KEY_HEX = 16;

/**
 * Sentinel surfaced both in `argSummary` and in `argKey` when the
 * tool's projection refuses every field. Stored verbatim so two
 * `arg-hidden` calls never accidentally collide with a real call.
 */
const HIDDEN_TOKEN = "arg-hidden";

export function sanitizeToolArgs(input: SanitizeToolArgsInput): SanitizedToolArgs {
  const { toolName, toolInput, cwd, workspaceSalt } = input;
  const tool = typeof toolName === "string" && toolName.length > 0 ? toolName : "Unknown";

  // Defensive: a malformed payload (string / null / array) goes
  // straight to `arg-hidden`. The projection helpers below assume an
  // object input, but we don't crash — the hook is on the user's
  // critical path.
  const obj =
    toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : {};

  const projected = projectArgs(tool, obj, cwd);
  const summary = formatSummary(tool, projected);
  // Last-line defence: even after path normalisation, a tool that
  // slipped a literal abs path / token through (Bash arg-bypassed,
  // future tool we forgot to allowlist) is downgraded to hidden.
  const safeSummary = detectLeakageExtended(summary) ? hiddenSummary(tool) : summary;
  const safeProjected = safeSummary === summary ? projected : { hidden: true };

  const argKey = computeArgKey(workspaceSalt, tool, safeProjected);
  return { argSummary: safeSummary, argKey };
}

/**
 * HMAC bucket id. Exposed so tests can assert determinism without
 * round-tripping through `sanitizeToolArgs`. The canonical form
 * always starts with the tool name to keep `Read({})` and
 * `Write({})` from colliding on the empty-projection case.
 */
export function computeArgKey(
  workspaceSalt: string,
  toolName: string,
  projected: Record<string, unknown>,
): string {
  const canonical = canonicalize({ tool: toolName, args: projected });
  return createHmac("sha256", workspaceSalt).update(canonical).digest("hex").slice(0, ARG_KEY_HEX);
}

// ---------------------------------------------------------------------------
// Per-tool projections — the only place tool_input fields are read.
// ---------------------------------------------------------------------------

function projectArgs(
  tool: string,
  args: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  switch (tool) {
    case "Read":
      return projectRead(args, cwd);
    case "Grep":
      return projectGrep(args, cwd);
    case "Glob":
      return projectGlob(args, cwd);
    case "Bash":
      return projectBash(args);
    // Tools whose inputs are inherently sensitive (carry user prose
    // / source code / arbitrary content) collapse to `hidden` —
    // their bucket is keyed only by tool name + the `hidden` marker,
    // so duplicate-call detection still works (two consecutive
    // `Edit`s with the same intent will share a bucket) without
    // ever exposing the body.
    case "Edit":
    case "Write":
    case "NotebookEdit":
    case "TodoWrite":
    case "WebFetch":
    case "WebSearch":
    case "Task":
    case "Skill":
      return { hidden: true };
    default:
      // Unknown tool — name-only bucket. New tools land here until
      // an explicit projection is written.
      return { hidden: true };
  }
}

function projectRead(args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const rel = repoRelative(args.file_path, cwd);
  if (rel === null) return { hidden: true };
  return { file_path: rel };
}

function projectGrep(args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const patternRaw = typeof args.pattern === "string" ? args.pattern : "";
  if (patternRaw.length === 0) return { hidden: true };
  const pattern = clipPattern(patternRaw);
  // Refuse the row if even the clipped pattern looks like a secret.
  if (detectLeakageExtended(pattern)) return { hidden: true };
  const out: Record<string, unknown> = { pattern };
  const rel = repoRelative(args.path, cwd);
  if (rel !== null) out.path = rel;
  return out;
}

function projectGlob(args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const patternRaw = typeof args.pattern === "string" ? args.pattern : "";
  if (patternRaw.length === 0) return { hidden: true };
  const pattern = clipPattern(patternRaw);
  if (detectLeakageExtended(pattern)) return { hidden: true };
  const out: Record<string, unknown> = { pattern };
  const rel = repoRelative(args.path, cwd);
  if (rel !== null) out.path = rel;
  return out;
}

function projectBash(args: Record<string, unknown>): Record<string, unknown> {
  const cmd = typeof args.command === "string" ? args.command : "";
  if (cmd.length === 0) return { hidden: true };
  // First non-whitespace token. Rejects pipelines / && chains / env
  // prefixes (`FOO=bar npm run`) — anything past the first token is
  // user content and never lands in the bucket.
  const first = cmd
    .trim()
    .split(/[\s|&;]/)[0]!
    .trim();
  // Strip leading `./`, `~/`, drive letters; if what's left looks
  // like a path, just keep the basename so `node_modules/.bin/foo`
  // and `./foo` both bucket as `foo`.
  const cleaned = first.replace(/^[./~]+/, "").split(/[\\/]/).pop() ?? first;
  if (cleaned.length === 0 || cleaned.length > 64) return { hidden: true };
  // Reject if the binary name itself looks like a secret pattern —
  // shouldn't happen, defence-in-depth.
  if (detectLeakageExtended(cleaned)) return { hidden: true };
  return { command: cleaned };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoRelative(value: unknown, cwd: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const rel = toRepoRelative(value, cwd);
  if (rel === null) return null;
  // Even a successful conversion may still embed an absolute path
  // shape inside (`../etc/passwd` resolved to `etc/passwd`); a
  // direct leakage check on the relative form is the final guard.
  if (detectLeakageExtended(rel)) return null;
  return rel;
}

function clipPattern(raw: string): string {
  // Strip newlines so a multi-line regex doesn't break the
  // human-readable summary; clip after.
  const flat = raw.replace(/[\r\n\t]/g, " ").trim();
  return flat.length > PATTERN_CLIP ? flat.slice(0, PATTERN_CLIP) : flat;
}

function formatSummary(tool: string, projected: Record<string, unknown>): string {
  if (projected.hidden) return hiddenSummary(tool);
  switch (tool) {
    case "Read": {
      const fp = projected.file_path as string;
      return `Read(${fp})`;
    }
    case "Grep": {
      const p = projected.pattern as string;
      const path = projected.path as string | undefined;
      return path ? `Grep("${p}")[${path}]` : `Grep("${p}")`;
    }
    case "Glob": {
      const p = projected.pattern as string;
      const path = projected.path as string | undefined;
      return path ? `Glob("${p}")[${path}]` : `Glob("${p}")`;
    }
    case "Bash": {
      const cmd = projected.command as string;
      return `Bash(${cmd})`;
    }
    default:
      return hiddenSummary(tool);
  }
}

function hiddenSummary(tool: string): string {
  return `${tool}(${HIDDEN_TOKEN})`;
}

/**
 * Deterministic JSON canonicaliser — sorts object keys at every
 * level so two semantically identical projections hash to the same
 * key regardless of insertion order. Arrays preserve order
 * (positional). No pretty-printing.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(canon(value));
}

function canon(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = canon(obj[k]);
    }
    return out;
  }
  return value;
}
