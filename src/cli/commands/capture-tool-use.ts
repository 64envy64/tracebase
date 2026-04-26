/**
 * `tracebase capture-tool-use` — Claude Code `PostToolBatch` hook
 * backend (0.5.3 TB TOOL substrate).
 *
 * Runs after a batch of tool calls completes. Reads the
 * PostToolBatch stdin, sanitises each `tool_input` down to an
 * allowlisted projection per tool, computes an HMAC bucket id
 * (`arg_key`), and persists one row per call into the
 * `tool_observations` table (V2_MIGRATIONS[8]). The next
 * `UserPromptSubmit` reads recent rows and surfaces a TB TOOL /
 * TB LOOP badge if a duplicate / loop / ping-pong is detected.
 *
 * Hard rules (enforced in `src/core/tool-arg.ts`):
 *
 *   - NEVER reads `tool_response` — the field is ignored at the
 *     parser boundary; the per-tool projection helpers in
 *     `tool-arg.ts` only read named fields off `tool_input`.
 *   - NEVER stores raw `tool_input` content. File paths land
 *     repo-relative or `arg-hidden`; Bash keeps only the binary
 *     name; Edit / Write / TodoWrite / WebFetch / Task all
 *     collapse to `arg-hidden`.
 *   - NEVER ships `arg_key`, `arg_summary`, `tool_use_id`,
 *     `session_id`, or `batch_id` to the cloud allowlist (see
 *     `cloud-allowlist.ts` — primitive-only leaves enforce this).
 *
 * Modes:
 *
 *   - Default: observe → sanitise → write batch in one
 *     transaction. No badge from this hook (per user directive
 *     and PLAN-0.5 §5.3) — the badge is computed and surfaced on
 *     the next UserPromptSubmit.
 *
 *   - `--capture off` (env: `TRACEBASE_CAPTURE_TOOL=off`): pure
 *     no-op for users who want to opt out of the substrate.
 *
 *   - `--dump-stdin` (dev-only): writes the parsed stdin to
 *     stderr and the raw bytes to
 *     `~/.tracebase/posttoolbatch-dumps/`, then returns. NEVER in
 *     the canonical installed hook command — the installer in
 *     `install-targets.ts` writes the plain capture form.
 *
 * Never throws. The PostToolBatch hook fires after the agent has
 * already finished its tool batch — a crash here can't block the
 * agent's forward progress, but a non-zero exit still surfaces red
 * in the transcript. Every failure mode collapses to a clean empty
 * envelope.
 */
import { Command } from "commander";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../core/block-store.js";
import {
  findProjectRoot,
  getOrMintWorkspaceSalt,
  isInitialized,
  loadConfig,
} from "../../core/config.js";
import {
  observeToolBatch,
  type ObserveToolBatchCall,
} from "../../runtime/observe-tools.js";
import { ensureManagedHooksCurrent } from "../hook-self-heal.js";
import type { ToolObservationOutcome } from "../../types.js";

// ---------------------------------------------------------------------------
// Hook shape + CLI options
// ---------------------------------------------------------------------------

/**
 * Live `PostToolBatch` stdin shape, locked against the dump captured
 * in the 0.5.3 dump-first sequence:
 *
 *   {
 *     hook_event_name: "PostToolBatch",
 *     session_id: "<uuid>",
 *     transcript_path: "/abs/path/to/transcript.jsonl",
 *     cwd: "/abs/workspace/root",
 *     permission_mode: "default",
 *     tool_calls: [
 *       {
 *         tool_name: "Read",
 *         tool_input: { file_path: "/abs/path" },
 *         tool_use_id: "toolu_...",
 *         tool_response: "<full output body — IGNORED>"
 *       },
 *       …
 *     ]
 *   }
 *
 * Notable absences from the live shape: no `turn_index`, no
 * `batch_id`, no `trigger`, no per-call `outcome`. We accept the
 * camelCase variants too in case Claude Code spells them
 * differently in a future release.
 */
export interface ToolBatchHookStdin {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  transcript_path?: string;
  transcriptPath?: string;
  /** Stored only for telemetry; never persisted. */
  permission_mode?: string;
  tool_calls?: unknown[];
  // PostToolUse fallback (manual user opt-in only) — single tool call
  // fields at the top level instead of wrapped in an array.
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  outcome?: string;
}

/** `compact` writes; `silent` writes; `off` pure no-op. No visible badge difference today. */
export type CaptureToolMode = "compact" | "silent" | "off";

export interface RunCaptureToolUseOptions {
  host?: string;
  path?: string;
  /**
   * `compact` (default) | `silent` | `off`. Env override:
   * `TRACEBASE_CAPTURE_TOOL=off|compact|silent` wins over this flag.
   * `off` is the only behaviourally distinct mode — it skips both
   * the sanitiser and the SQLite write entirely.
   */
  capture?: string;
  /**
   * Dev-only diagnostic. NEVER in the canonical installed hook
   * command. Writes raw bytes to `~/.tracebase/posttoolbatch-dumps/`.
   */
  dumpStdin?: boolean;
}

export interface CaptureToolUseOutcome {
  /** One-line JSON envelope for the host. */
  envelope: string;
  /** Number of tool_observations rows the hook wrote on this call. */
  recorded: number;
  /** True iff the dump mode wrote a file on this invocation. */
  dumped: boolean;
  dumpPath: string | null;
}

const STDIN_BYTE_LIMIT = 256 * 1024;
const DUMP_BYTE_CAP = 4 * 1024 * 1024;
// MAX_CALLS_PER_BATCH lives on the pure core in
// `src/runtime/observe-tools.ts` so the SDK runtime applies the
// same cap. Imported transitively via observeToolBatch().

export const captureToolUseCommand = new Command("capture-tool-use")
  .description(
    "Internal: Claude Code PostToolBatch hook backend. Sanitises each tool call " +
      "down to an allowlisted projection, computes an HMAC arg_key keyed by the " +
      "local workspace salt, and writes one row per call into tool_observations. " +
      "The detector and TB TOOL / TB LOOP badge live on the next UserPromptSubmit.",
  )
  .option("--host <host>", "host shaping the JSON envelope: claude-code (default)", "claude-code")
  .option(
    "--capture <mode>",
    "capture behaviour: compact (default) | silent | off (skips write). Env: TRACEBASE_CAPTURE_TOOL.",
    "compact",
  )
  .option(
    "--dump-stdin",
    "dev: write parsed hook stdin to stderr + raw bytes to ~/.tracebase/posttoolbatch-dumps/",
  )
  .option("-p, --path <path>", "project root override")
  .action(async (opts: RunCaptureToolUseOptions) => {
    const stdin = readStdinBytes();
    const outcome = runCaptureToolUse(opts, stdin);
    process.stdout.write(outcome.envelope + "\n");
  });

/**
 * Pure helper. Same "never throws, always emits a parseable
 * envelope" contract as the sibling 0.5.x hook commands.
 */
export function runCaptureToolUse(
  opts: RunCaptureToolUseOptions,
  rawStdin: Buffer,
): CaptureToolUseOutcome {
  if (opts.dumpStdin) {
    return handleDump(rawStdin, parseStdinPayload(rawStdin));
  }

  const mode = resolveCaptureMode(opts.capture);
  if (mode === "off") return emptyEnvelope();

  try {
    const parsed = parseStdinPayload(rawStdin);
    const calls = collectToolCalls(parsed);
    if (calls.length === 0) return emptyEnvelope();

    const basePath = resolveBasePath(opts.path, parsed);
    if (!basePath || !isInitialized(basePath)) return emptyEnvelope();

    // 0.5.6 — throttled hook self-heal. See inject-context call site.
    try {
      ensureManagedHooksCurrent(basePath, "claude-code");
    } catch {
      // best-effort
    }

    const salt = getOrMintWorkspaceSalt(basePath);
    if (!salt) return emptyEnvelope();

    const sessionId = stringField(parsed.session_id ?? parsed.sessionId, "unknown-session");
    const cwd = stringField(parsed.cwd, basePath);

    const observeCalls: ObserveToolBatchCall[] = calls.map((c) => ({
      toolName: c.toolName,
      toolInput: c.toolInput,
      toolUseId: c.toolUseId,
      outcome: c.outcome,
    }));

    const config = loadConfig(basePath);
    const { recorded } = withBlockStore(config.storagePath, (store) =>
      observeToolBatch(store, {
        sessionId,
        cwd,
        workspaceSalt: salt,
        toolCalls: observeCalls,
        // 0.7.0-rc.4 hardening — warm the PreToolUse cache so the
        // rc.4 hook actually has data to detect duplicates against.
        workspacePath: basePath,
      }),
    );

    return {
      envelope: JSON.stringify({}),
      recorded,
      dumped: false,
      dumpPath: null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-tool-use: ${reason}\n`);
    return emptyEnvelope();
  }
}

function emptyEnvelope(): CaptureToolUseOutcome {
  return { envelope: JSON.stringify({}), recorded: 0, dumped: false, dumpPath: null };
}

// ---------------------------------------------------------------------------
// Tool-call extraction
// ---------------------------------------------------------------------------

interface ExtractedCall {
  toolName: string;
  toolInput: unknown;
  toolUseId: string | null;
  outcome: ToolObservationOutcome;
}

/**
 * Collect tool calls from either the PostToolBatch shape (array
 * under `tool_calls`) or the PostToolUse fallback shape (single
 * call at the root). Anything else collapses to `[]` and the hook
 * no-ops without writing.
 */
function collectToolCalls(parsed: ToolBatchHookStdin): ExtractedCall[] {
  if (Array.isArray(parsed.tool_calls)) {
    const out: ExtractedCall[] = [];
    for (const raw of parsed.tool_calls) {
      const call = extractCall(raw);
      if (call) out.push(call);
    }
    return out;
  }
  // PostToolUse fallback — fields live at the root.
  const root = extractCall({
    tool_name: parsed.tool_name,
    tool_input: parsed.tool_input,
    tool_use_id: parsed.tool_use_id,
    outcome: parsed.outcome,
  });
  return root ? [root] : [];
}

function extractCall(raw: unknown): ExtractedCall | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const toolName = typeof c.tool_name === "string" ? c.tool_name : null;
  if (!toolName) return null;
  return {
    toolName,
    toolInput: c.tool_input,
    toolUseId: typeof c.tool_use_id === "string" ? c.tool_use_id : null,
    outcome: parseOutcome(c.outcome),
  };
}

function parseOutcome(raw: unknown): ToolObservationOutcome {
  if (typeof raw !== "string") return "unknown";
  const v = raw.trim().toLowerCase();
  if (v === "ok" || v === "success") return "ok";
  if (v === "error" || v === "failure" || v === "failed") return "error";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Mode + path resolution
// ---------------------------------------------------------------------------

function resolveCaptureMode(raw: string | undefined): CaptureToolMode {
  const fromEnv = normaliseMode(process.env.TRACEBASE_CAPTURE_TOOL);
  if (fromEnv) return fromEnv;
  const fromFlag = normaliseMode(raw);
  if (fromFlag) return fromFlag;
  return "compact";
}

function normaliseMode(raw: string | undefined): CaptureToolMode | null {
  const v = raw?.trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "silent") return "silent";
  if (v === "compact") return "compact";
  return null;
}

function resolveBasePath(explicit: string | undefined, stdin: ToolBatchHookStdin): string | null {
  if (explicit) return explicit;
  if (typeof stdin.cwd === "string" && stdin.cwd) {
    return findProjectRoot(stdin.cwd) ?? stdin.cwd;
  }
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Stdin reading + tolerant parsing
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

/**
 * Tolerant parser. Any malformed / oversized / primitive / array
 * input collapses to `{}`. Unknown fields are preserved verbatim
 * so the dump path captures every byte the host actually sent.
 */
export function parseStdinPayload(raw: Buffer | string): ToolBatchHookStdin {
  const buf = typeof raw === "string" ? Buffer.from(raw) : raw;
  if (buf.length === 0) return {};
  if (buf.length > STDIN_BYTE_LIMIT) return {};
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ToolBatchHookStdin;
    }
    return {};
  } catch {
    return {};
  }
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

// ---------------------------------------------------------------------------
// --dump-stdin dev-only path (never in the canonical installed hook)
// ---------------------------------------------------------------------------

function handleDump(raw: Buffer, parsed: ToolBatchHookStdin): CaptureToolUseOutcome {
  try {
    const stderrDump = JSON.stringify(parsed, null, 2);
    process.stderr.write("tracebase capture-tool-use (dump): parsed stdin:\n");
    process.stderr.write(stderrDump.slice(0, DUMP_BYTE_CAP) + "\n");
  } catch {
    process.stderr.write("tracebase capture-tool-use (dump): parsed stdin unserialisable\n");
  }

  let dumpPath: string | null = null;
  try {
    const dir = join(homedir(), ".tracebase", "posttoolbatch-dumps");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const sessionTag = sanitiseTag(
      parsed.session_id ?? parsed.sessionId ?? "unknown-session",
    );
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    dumpPath = join(dir, `${ts}-${sessionTag}.jsonl`);
    const payload = raw.length > DUMP_BYTE_CAP ? raw.subarray(0, DUMP_BYTE_CAP) : raw;
    writeFileSync(dumpPath, payload);
    process.stderr.write(`tracebase capture-tool-use (dump): raw bytes written to ${dumpPath}\n`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-tool-use (dump): write failed: ${reason}\n`);
    dumpPath = null;
  }

  return {
    envelope: JSON.stringify({}),
    recorded: 0,
    dumped: dumpPath !== null,
    dumpPath,
  };
}

function sanitiseTag(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "unknown";
}
