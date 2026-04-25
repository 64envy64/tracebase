/**
 * `tracebase capture-tool-use` — Claude Code `PostToolBatch` (default)
 * / `PostToolUse` (compat) hook backend.
 *
 * Ships in 0.5.3 as a **dump-first scaffold** mirroring the
 * 0.5.2 capture-context approach. Today this command has two modes:
 *
 *   1. `--dump-stdin` (dev-only diagnostic): prints the parsed
 *      stdin payload to stderr, writes the raw bytes to
 *      `~/.tracebase/posttoolbatch-dumps/<ts>-<session>.jsonl`,
 *      emits an empty host envelope, and returns. Purpose: lock
 *      the real PostToolBatch stdin shape against ground truth
 *      *before* the parser, the `tool_observations` table
 *      (V2_MIGRATIONS[8]), and the duplicate / loop detector are
 *      written.
 *
 *   2. Default: emits a valid empty envelope and does nothing
 *      else. Explicit no-op so the command is safe to install as
 *      a PostToolBatch hook today without shipping speculative
 *      logic against an assumed shape.
 *
 * 0.5.3 follow-up — once a real PostToolBatch payload has been
 * captured and the shape locked — replaces the default mode with:
 *   - hard guard on `!tool_calls || tool_calls.length === 0`
 *   - allowlisted-fields-only `arg_summary` per tool (Read,
 *     Grep, Glob, Bash; everything else collapses to "tool_name(arg-hidden)")
 *   - `arg_key = HMAC(workspaceSalt, canonical(allowlistedFields))`
 *   - one SQLite transaction inserting N rows into
 *     `tool_observations` (V2_MIGRATIONS[8])
 *   - signal computation deferred to next UserPromptSubmit
 *   - `▣ TB TOOL` / `▣ TB LOOP` badges only emitted on next
 *     UserPromptSubmit, never from this hook directly
 *
 * Invariants this scaffold already commits to (enforced when the
 * real path lands, not yet here):
 *
 *   - NEVER store `tool_input` or `tool_response` body content.
 *   - NEVER ship `arg_key`, `arg_summary`, `tool_use_id`,
 *     `session_id`, or `batch_id` to the cloud allowlist — only
 *     aggregate `duplicate_count` / `loop_count` /
 *     `tool_family_counts` / latency buckets / error class counts.
 *   - PreToolUse remains opt-in only via `TRACEBASE_PRETOOLUSE=on`
 *     at install time.
 *   - PostToolUse is manual user compat only via
 *     `npx tracebase init --compat=posttooluse`. No auto-switchover.
 *
 * Never throws. The PostToolBatch hook fires after the agent has
 * finished a tool batch — a crash here can't block the agent's
 * forward progress, but a non-zero exit still surfaces red in the
 * transcript. Every failure mode collapses to a clean empty
 * envelope.
 */
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hook shape + CLI options (pre-lockdown — TOLERANT, NOT NORMATIVE)
// ---------------------------------------------------------------------------

/**
 * Speculative shape of the `PostToolBatch` (and fallback `PostToolUse`)
 * stdin envelope. Real fields land in a follow-up release after the
 * dump-first sequence captures a live payload. Anything we don't
 * recognise is preserved by the tolerant parser, so nothing is lost
 * at this stage.
 */
export interface ToolBatchHookStdin {
  hook_event_name?: string;
  hookEventName?: string;
  /** Stable identifier for the Claude Code session. */
  session_id?: string;
  sessionId?: string;
  /** Workspace root the user's Claude Code session is rooted at. */
  cwd?: string;
  /** Path to the conversation transcript JSONL Claude Code maintains. */
  transcript_path?: string;
  transcriptPath?: string;
  /** PostToolBatch: array of completed tool calls. */
  tool_calls?: unknown[];
  /** PostToolUse fallback: single tool call fields at the top level. */
  tool_use_id?: string;
  tool_name?: string;
  /** NOT parsed for content — only inspected for shape during dump. */
  tool_input?: unknown;
  tool_response?: unknown;
  outcome?: string;
}

export interface RunCaptureToolUseOptions {
  host?: string;
  path?: string;
  /**
   * Dev-only diagnostic. When set, the command writes the parsed
   * stdin JSON to stderr and the raw bytes to
   * `~/.tracebase/posttoolbatch-dumps/` then returns before any
   * detection / observation work. NEVER in the canonical installed
   * hook command.
   */
  dumpStdin?: boolean;
}

export interface CaptureToolUseOutcome {
  /** One-line JSON envelope for the host to consume. */
  envelope: string;
  /** True iff the dump mode wrote a file on this invocation. */
  dumped: boolean;
  /** Absolute path of the dump file (dump mode only). */
  dumpPath: string | null;
}

const STDIN_BYTE_LIMIT = 256 * 1024; // 256 KiB — well above any realistic hook stdin
const DUMP_BYTE_CAP = 4 * 1024 * 1024; // 4 MiB — same cap capture-context uses

export const captureToolUseCommand = new Command("capture-tool-use")
  .description(
    "Internal: Claude Code PostToolBatch (default) / PostToolUse (compat) hook " +
      "backend (0.5.3 dump-first scaffold). Use --dump-stdin to capture real hook " +
      "payloads; default mode is an intentional no-op until the parser, " +
      "tool_observations schema (V2_MIGRATIONS[8]), and detection logic land in a " +
      "follow-up release.",
  )
  .option("--host <host>", "host shaping the JSON envelope: claude-code (default)", "claude-code")
  .option(
    "--dump-stdin",
    "dev: write parsed hook stdin to stderr + raw bytes to ~/.tracebase/posttoolbatch-dumps/ for offline parser lockdown",
  )
  .option("-p, --path <path>", "project root override")
  .action(async (opts: RunCaptureToolUseOptions) => {
    const stdin = readStdinBytes();
    const outcome = runCaptureToolUse(opts, stdin);
    process.stdout.write(outcome.envelope + "\n");
  });

/**
 * Pure helper. Same "never throws, always emits a parseable envelope"
 * contract as inject-context / capture-turn / capture-context.
 *
 * In dump mode, writes the raw bytes to a per-invocation file under
 * `~/.tracebase/posttoolbatch-dumps/`. Lives in the user's home
 * rather than the project because PostToolBatch fires from Claude
 * Code's session root, which may not correspond to a TraceBase-
 * initialised project — and dumps should not depend on `.tracebase/`
 * existing.
 */
export function runCaptureToolUse(
  opts: RunCaptureToolUseOptions,
  rawStdin: Buffer,
): CaptureToolUseOutcome {
  try {
    if (opts.dumpStdin) {
      const parsed = parseStdinPayload(rawStdin);
      return handleDump(rawStdin, parsed);
    }
    // Default: no-op envelope. The real detection / observation
    // pipeline lands in the next patch after the dump path has
    // produced ground-truth payloads. Until then, installing this
    // hook is safe but inert.
    return { envelope: JSON.stringify({}), dumped: false, dumpPath: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-tool-use: ${reason}\n`);
    return { envelope: JSON.stringify({}), dumped: false, dumpPath: null };
  }
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
 * input collapses to `{}`. Callers treat that as "no payload, emit
 * empty envelope". Unknown fields are preserved verbatim so the
 * dump captures every byte the host actually sent — that's the
 * whole point of the dump-first sequence.
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
// --dump-stdin dev-only path (never in the canonical installed hook)
// ---------------------------------------------------------------------------

function handleDump(raw: Buffer, parsed: ToolBatchHookStdin): CaptureToolUseOutcome {
  // Echo the parsed form to stderr for quick inspection in a Claude
  // Code transcript. Stdout is reserved for the host envelope; stderr
  // shows up in the hook's error surface without breaking the event.
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
    // Dumping is dev-only. A write failure must not break the hook —
    // worst case we lost one sample, not the user's tool flow.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-tool-use (dump): write failed: ${reason}\n`);
    dumpPath = null;
  }

  return {
    envelope: JSON.stringify({}),
    dumped: dumpPath !== null,
    dumpPath,
  };
}

/**
 * Per-invocation dump filenames must be filesystem-safe. PostToolBatch
 * fires every assistant turn that has tool calls — multiple per
 * session — so we lean on millisecond timestamps to disambiguate
 * between dumps in the same session.
 */
function sanitiseTag(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "unknown";
}
