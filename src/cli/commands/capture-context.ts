/**
 * `tracebase capture-context` — Claude Code PreCompact hook backend.
 *
 * Ships in 0.5.2 as a **dump-first scaffold**. Today it has two modes:
 *
 *   1. `--dump-stdin` (dev-only): prints the parsed PreCompact hook
 *      stdin to stderr, writes the raw bytes to
 *      `~/.tracebase/precompact-dumps/<ts>-<session>.jsonl`, and
 *      emits an empty host envelope. Purpose: lock the real stdin
 *      shape against ground truth *before* the parser / digest
 *      extractor lands. PLAN-0.5 §5.2 prereq.
 *
 *   2. Default (no flag): emits a valid empty envelope and does
 *      nothing else. Explicit no-op so the command is safe to
 *      install as a PreCompact hook today without shipping a
 *      speculative digest pipeline.
 *
 * 0.5.3 (or later) locks the parser + digest extractor based on the
 * captured payloads; until then the default mode is inert on purpose.
 *
 * Never throws. The Stop / UserPromptSubmit contract applies here too:
 * a crash would block the user's compaction flow in Claude Code, and
 * the whole point of a hook-safe backend is that a broken install is
 * invisible.
 */
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hook shape + CLI options
// ---------------------------------------------------------------------------

/**
 * Speculative shape of the PreCompact hook stdin envelope. Real
 * fields land in a follow-up release after the dump path produces
 * ground-truth payloads. Anything we don't recognise is preserved in
 * the raw dump, so nothing is lost at this stage.
 */
export interface PreCompactHookStdin {
  hook_event_name?: string;
  hookEventName?: string;
  /** Path to the conversation transcript JSONL Claude Code maintains. */
  transcript_path?: string;
  transcriptPath?: string;
  /** Workspace root the user's Claude Code session is rooted at. */
  cwd?: string;
  /** Stable identifier for the Claude Code session. */
  session_id?: string;
  sessionId?: string;
  /** `"manual"` | `"auto"` — why the compaction is firing. */
  trigger?: string;
  /** Free-form additional instructions the host may pass. */
  custom_instructions?: string;
}

export interface RunCaptureContextOptions {
  host?: string;
  path?: string;
  /**
   * `dump-stdin` dev-mode. When set, the command writes the parsed
   * stdin JSON to stderr and the raw bytes to disk; default mode
   * emits an empty envelope. Kept as a separate flag rather than
   * an env var so dump runs are explicit and traceable in a hook
   * command string.
   */
  dumpStdin?: boolean;
}

export interface CaptureContextOutcome {
  /** One-line JSON envelope for the host to consume. */
  envelope: string;
  /** True iff the dump mode wrote a file on this invocation. */
  dumped: boolean;
  /** Absolute path of the dump file (dump mode only). */
  dumpPath: string | null;
}

const STDIN_BYTE_LIMIT = 256 * 1024; // 256 KiB — well above any realistic hook stdin
const DUMP_BYTE_CAP = 4 * 1024 * 1024; // 4 MiB — mirrors transcript tail cap

export const captureContextCommand = new Command("capture-context")
  .description(
    "Internal: Claude Code PreCompact hook backend (0.5.2 dump-first scaffold). " +
      "Use --dump-stdin to capture the real hook payload shape; default mode is an " +
      "intentional no-op until the parser / digest pipeline lands in a follow-up release.",
  )
  .option("--host <host>", "host shaping the JSON envelope: claude-code (default)", "claude-code")
  .option(
    "--dump-stdin",
    "dev: write parsed hook stdin to stderr + raw bytes to ~/.tracebase/precompact-dumps/ for offline parser lockdown",
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
 *
 * In dump mode, writes the raw bytes to a per-invocation file under
 * `~/.tracebase/precompact-dumps/`. The dump dir lives in the user's
 * home rather than the project because PreCompact fires from Claude
 * Code's session root, which may not correspond to a TraceBase-
 * initialised project — and dumps should not depend on `.tracebase/`
 * existing.
 */
export function runCaptureContext(
  opts: RunCaptureContextOptions,
  rawStdin: Buffer,
): CaptureContextOutcome {
  try {
    if (opts.dumpStdin) {
      const parsed = parseStdinPayload(rawStdin);
      return handleDump(rawStdin, parsed);
    }
    // Default: no-op envelope. The real digest pipeline lands in the
    // next patch after the dump path has produced ground-truth
    // payloads. Until then, installing this hook is safe but inert.
    return { envelope: JSON.stringify({}), dumped: false, dumpPath: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-context: ${reason}\n`);
    return { envelope: JSON.stringify({}), dumped: false, dumpPath: null };
  }
}

function handleDump(raw: Buffer, parsed: PreCompactHookStdin): CaptureContextOutcome {
  // Echo the parsed form to stderr for quick inspection in a Claude
  // Code transcript. Stdout is reserved for the host envelope; stderr
  // shows up in the hook's error surface without breaking the event.
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
    // Dumping is dev-only. A write failure must not break the hook —
    // worst case we lost one sample, not the user's compaction flow.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-context (dump): write failed: ${reason}\n`);
    dumpPath = null;
  }

  return { envelope: JSON.stringify({}), dumped: dumpPath !== null, dumpPath };
}

// ---------------------------------------------------------------------------
// Stdin / payload helpers
// ---------------------------------------------------------------------------

/**
 * Read raw stdin bytes with the same bounded-byte discipline as
 * inject-context / capture-turn. Returns an empty Buffer on TTY /
 * read failure so the helper downstream can short-circuit.
 */
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
 * Tolerant parser. Any malformed / oversized / primitive input
 * collapses to `{}`. Callers treat that as "no payload, emit empty
 * envelope".
 */
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

/**
 * Per-invocation dump filenames must be filesystem-safe, so strip any
 * char that isn't a letter, digit, dash, or underscore. A long
 * session id gets truncated to 40 chars — plenty for disambiguation
 * across a dev's local runs without inflating filenames.
 */
function sanitiseTag(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "unknown";
}
