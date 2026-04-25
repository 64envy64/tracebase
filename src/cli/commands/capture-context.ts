/**
 * `tracebase capture-context` — Claude Code `PreCompact` hook backend.
 *
 * Runs right before Claude Code compacts its context. Reads the
 * transcript tail via `transcript_path`, distils a bounded
 * deterministic digest of the session, and writes it straight to
 * `project_facts` with `fact_type = "session_digest"`, scoped to the
 * session. 0.5.1 `inject-context` picks it up on the next
 * UserPromptSubmit *in the same session* so the agent keeps its bearings
 * across the compaction boundary.
 *
 * Two modes:
 *
 *   - Default: observe → extract → write. Compact-mode emits a
 *     `▣ TB CONTEXT  digest saved · Tt` badge; silent/off suppress
 *     the badge; off skips the write entirely.
 *
 *   - `--dump-stdin` (dev-only diagnostic): writes the parsed stdin
 *     to stderr + raw bytes to `~/.tracebase/precompact-dumps/` for
 *     offline parser lockdown. NEVER installed as the canonical
 *     hook command — installer uses the plain `--capture compact`
 *     form. The flag stays so developers can validate payload shape
 *     after protocol upgrades without shipping a new release.
 *
 * Digest content rule (deterministic, no paraphrase):
 *   [last 5 user-question first lines]
 *   + [assistant section headers — markdown headings]
 *   + [assistant bullet-list first-items]
 * Bounded at 1200 chars. No code blocks. No tool args. No
 * chain-of-thought. Leakage scanner runs before write so absolute
 * paths / API keys / `.env` shapes never land on disk.
 *
 * Never throws. A PreCompact crash would block the user's compaction
 * flow in Claude Code; the contract is "degrade silently, emit
 * `▣ TB CONTEXT  skipped · unavailable` and move on".
 */
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BlockStore } from "../../core/block-store.js";
import {
  findProjectRoot,
  isInitialized,
  loadConfig,
} from "../../core/config.js";
import { extractDigest, sessionScope } from "../../runtime/digest.js";
import type { StoreProjectFactInput } from "../../types.js";

// Back-compat re-exports — older importers (`inject-context`,
// `runtime/recall.ts`) used to pull these from this file. The
// canonical implementations now live on `src/runtime/digest.ts`;
// both names resolve to those.
export { extractDigest, sessionScope };

// ---------------------------------------------------------------------------
// Hook shape + CLI options
// ---------------------------------------------------------------------------

/**
 * Fields the `PreCompact` hook sends on stdin. Claude Code has
 * historically sent `{hook_event_name, session_id, transcript_path,
 * cwd, trigger, custom_instructions}`; 0.5.2 was locked against that
 * shape via a live dump before shipping. Unknown fields are preserved
 * by the tolerant parser so future additions don't break the hook.
 */
export interface PreCompactHookStdin {
  hook_event_name?: string;
  hookEventName?: string;
  transcript_path?: string;
  transcriptPath?: string;
  cwd?: string;
  session_id?: string;
  sessionId?: string;
  /** `"manual"` (user typed `/compact`) or `"auto"` (context filled up). */
  trigger?: string;
  custom_instructions?: string;
}

/** `compact` writes + badge; `silent` writes, no badge; `off` pure no-op. */
export type CaptureContextMode = "compact" | "silent" | "off";

export interface RunCaptureContextOptions {
  host?: string;
  path?: string;
  /**
   * `compact` (default) | `silent` | `off`. Env override:
   * `TRACEBASE_CAPTURE_CONTEXT=off|compact|silent` wins over this flag.
   */
  capture?: string;
  /**
   * Dev-only diagnostic. When set, the command writes the parsed
   * stdin JSON to stderr and the raw bytes to
   * `~/.tracebase/precompact-dumps/` — then returns before any
   * digest extraction or fact-store write. NEVER in the canonical
   * installed hook command.
   */
  dumpStdin?: boolean;
}

export interface CaptureContextOutcome {
  envelope: string;
  /** True iff a digest was written to project_facts. */
  captured: boolean;
  /** Fact id when a write happened. */
  factId: string | null;
  /** True iff `--dump-stdin` wrote a raw dump file this invocation. */
  dumped: boolean;
  dumpPath: string | null;
}

/**
 * Exhaustive classification of what capture-context did. One
 * `formatStatus(situation, mode)` maps each to at most one badge
 * literal — mirrors the `InjectSituation` / `CaptureSituation`
 * pattern in the sibling commands.
 */
type ContextSituation =
  | { kind: "saved"; tokens: number }
  | { kind: "skipped-no-content" }
  | { kind: "skipped-uninitialized" }
  | { kind: "unavailable" }
  | { kind: "off" };

// Soft caps. The digest must be small — the next UserPromptSubmit
// will inject it alongside TB TRACE / TB MEMORY, competing for a
// bounded context budget.
//
// MAX_DIGEST_CHARS / MAX_USER_LINES / MAX_ASSISTANT_HEADERS /
// MAX_ASSISTANT_BULLETS now live on `src/runtime/digest.ts` so the
// SDK runtime + CLI hook share the same bounds — see §3a.
const MIN_TRANSCRIPT_CHARS = 400;
const DIGEST_TTL_DAYS = 14;
const TRANSCRIPT_BYTE_LIMIT = 4 * 1024 * 1024; // 4 MiB cap per PLAN-0.5 §5.2

const STDIN_BYTE_LIMIT = 256 * 1024;
const DUMP_BYTE_CAP = 4 * 1024 * 1024;

export const captureContextCommand = new Command("capture-context")
  .description(
    "Internal: Claude Code PreCompact hook. Reads the transcript tail, distils a " +
      "bounded deterministic session digest, writes it as a session-scoped project_fact " +
      "so the next UserPromptSubmit can keep context across compaction.",
  )
  .option("--host <host>", "host shaping the JSON envelope: claude-code (default)", "claude-code")
  .option(
    "--capture <mode>",
    "capture behaviour: compact (default, writes + badge) | silent (writes, no badge) | off (no-op). Env: TRACEBASE_CAPTURE_CONTEXT.",
    "compact",
  )
  .option(
    "--dump-stdin",
    "dev-only diagnostic: write parsed stdin + raw bytes to ~/.tracebase/precompact-dumps/ then return without extraction. Never shipped in the installed hook command.",
  )
  .option("-p, --path <path>", "project root override")
  .action(async (opts: RunCaptureContextOptions) => {
    const stdin = readStdinBytes();
    const outcome = runCaptureContext(opts, stdin);
    process.stdout.write(outcome.envelope + "\n");
  });

/**
 * Pure helper. Same "never throws, always emits a parseable envelope"
 * contract as inject-context / capture-turn.
 */
export function runCaptureContext(
  opts: RunCaptureContextOptions,
  rawStdin: Buffer,
): CaptureContextOutcome {
  // --dump-stdin short-circuits before any store work. This branch
  // is never reached in production — the installer's canonical hook
  // command doesn't include the flag. See class header.
  if (opts.dumpStdin) {
    return handleDump(rawStdin);
  }

  const mode = resolveCaptureMode(opts.capture);
  if (mode === "off") {
    return wrapEnvelope(null, false, null, formatStatus({ kind: "off" }, mode));
  }

  const parsed = parseStdinPayload(rawStdin);
  try {
    const basePath = resolveBasePath(opts.path, parsed);
    if (!basePath || !isInitialized(basePath)) {
      return wrapEnvelope(
        null,
        false,
        null,
        formatStatus({ kind: "skipped-uninitialized" }, mode),
      );
    }

    const transcriptPath = parsed.transcript_path ?? parsed.transcriptPath ?? null;
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return wrapEnvelope(
        null,
        false,
        null,
        formatStatus({ kind: "skipped-no-content" }, mode),
      );
    }

    const transcript = readTranscriptTail(transcriptPath);
    if (!transcript || transcript.length < MIN_TRANSCRIPT_CHARS) {
      return wrapEnvelope(
        null,
        false,
        null,
        formatStatus({ kind: "skipped-no-content" }, mode),
      );
    }

    const digest = extractDigest(transcript);
    if (!digest) {
      return wrapEnvelope(
        null,
        false,
        null,
        formatStatus({ kind: "skipped-no-content" }, mode),
      );
    }

    const sessionId = parsed.session_id ?? parsed.sessionId ?? "unknown";
    const config = loadConfig(basePath);
    const factId = withBlockStore(config.storagePath, (store) => {
      const input: StoreProjectFactInput = {
        scope: sessionScope(sessionId),
        factType: "session_digest",
        statement: digest,
        invariants: {},
        source: {
          origin: "observed",
          reference: sessionId,
        },
        ttlDays: DIGEST_TTL_DAYS,
      };
      const fact = store.storeFact(input);
      return fact.id;
    });

    const approxTokens = Math.ceil(digest.length / 4);
    return wrapEnvelope(
      factId,
      false,
      null,
      formatStatus({ kind: "saved", tokens: approxTokens }, mode),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-context: ${reason}\n`);
    return wrapEnvelope(null, false, null, formatStatus({ kind: "unavailable" }, mode));
  }
}

function wrapEnvelope(
  factId: string | null,
  dumped: boolean,
  dumpPath: string | null,
  status: string | null,
): CaptureContextOutcome {
  const envelope: Record<string, unknown> = {};
  if (status !== null) envelope.systemMessage = status;
  return {
    envelope: JSON.stringify(envelope),
    captured: factId !== null,
    factId,
    dumped,
    dumpPath,
  };
}

/**
 * Single source of truth for the `▣ TB CONTEXT` badge. Silent + off
 * never emit; compact emits one of four literals. Every one is well
 * under 100 chars.
 */
function formatStatus(s: ContextSituation, mode: CaptureContextMode): string | null {
  if (mode === "silent" || mode === "off") return null;
  switch (s.kind) {
    case "off":
      return null;
    case "saved":
      return `▣ TB CONTEXT  digest saved · ${s.tokens}t`;
    case "skipped-no-content":
      return "▣ TB CONTEXT  skipped · no content";
    case "skipped-uninitialized":
      // Same copy as "no content" — uninitialised project is
      // invisible to the user by design; see inject-context.
      return "▣ TB CONTEXT  skipped · no content";
    case "unavailable":
      return "▣ TB CONTEXT  skipped · unavailable";
  }
}

function resolveCaptureMode(raw: string | undefined): CaptureContextMode {
  const fromEnv = normaliseMode(process.env.TRACEBASE_CAPTURE_CONTEXT);
  if (fromEnv) return fromEnv;
  const fromFlag = normaliseMode(raw);
  if (fromFlag) return fromFlag;
  return "compact";
}

function normaliseMode(raw: string | undefined): CaptureContextMode | null {
  const v = raw?.trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "silent") return "silent";
  if (v === "compact") return "compact";
  return null;
}

// ---------------------------------------------------------------------------
// Transcript reader (still CLI-side — the SDK runtime never reads
// transcript files; only the Claude Code PreCompact hook does).
// ---------------------------------------------------------------------------

function readTranscriptTail(path: string): string | null {
  try {
    const buf = readFileSync(path);
    if (buf.length === 0) return null;
    const tail = buf.length > TRANSCRIPT_BYTE_LIMIT
      ? buf.subarray(buf.length - TRANSCRIPT_BYTE_LIMIT)
      : buf;
    return tail.toString("utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stdin / path resolution
// ---------------------------------------------------------------------------

export function readStdinBytes(): Buffer {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  try {
    const raw = readFileSync(0, { flag: "r" });
    return raw.length > STDIN_BYTE_LIMIT ? raw.subarray(0, STDIN_BYTE_LIMIT) : raw;
  } catch {
    return Buffer.alloc(0);
  }
}

export function parseStdinPayload(raw: Buffer | string): PreCompactHookStdin {
  const buf = typeof raw === "string" ? Buffer.from(raw) : raw;
  if (buf.length === 0) return {};
  if (buf.length > STDIN_BYTE_LIMIT) return {};
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PreCompactHookStdin;
    }
    return {};
  } catch {
    return {};
  }
}

function resolveBasePath(explicit: string | undefined, stdin: PreCompactHookStdin): string | null {
  if (explicit) return explicit;
  if (typeof stdin.cwd === "string" && stdin.cwd) {
    return findProjectRoot(stdin.cwd) ?? stdin.cwd;
  }
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

// ---------------------------------------------------------------------------
// --dump-stdin dev-only path (never in the canonical installed hook)
// ---------------------------------------------------------------------------

function handleDump(raw: Buffer): CaptureContextOutcome {
  let parsed: PreCompactHookStdin = {};
  try {
    parsed = parseStdinPayload(raw);
  } catch {
    parsed = {};
  }

  try {
    const stderrDump = JSON.stringify(parsed, null, 2);
    process.stderr.write("tracebase capture-context (dump): parsed stdin:\n");
    process.stderr.write(stderrDump.slice(0, DUMP_BYTE_CAP) + "\n");
  } catch {
    process.stderr.write("tracebase capture-context (dump): parsed stdin unserialisable\n");
  }

  let dumpPath: string | null = null;
  try {
    const dir = join(homedir(), ".tracebase", "precompact-dumps");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const sessionTag = sanitiseTag(
      parsed.session_id ?? parsed.sessionId ?? "unknown-session",
    );
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    dumpPath = join(dir, `${ts}-${sessionTag}.jsonl`);
    const payload = raw.length > DUMP_BYTE_CAP ? raw.subarray(0, DUMP_BYTE_CAP) : raw;
    writeFileSync(dumpPath, payload);
    process.stderr.write(`tracebase capture-context (dump): raw bytes written to ${dumpPath}\n`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-context (dump): write failed: ${reason}\n`);
    dumpPath = null;
  }

  return wrapEnvelope(null, dumpPath !== null, dumpPath, null);
}

function sanitiseTag(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "unknown";
}

// ---------------------------------------------------------------------------
// BlockStore lifecycle
// ---------------------------------------------------------------------------

function withBlockStore<T>(storagePath: string, fn: (store: BlockStore) => T): T {
  const db = new Database(storagePath);
  const store = new BlockStore(db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}
