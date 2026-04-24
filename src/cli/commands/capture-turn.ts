/**
 * `tracebase capture-turn` — background capture for Claude Code Stop
 * hooks. Runs when the main agent stops, reads the transcript, decides
 * whether the turn looks like a reusable problem-solution pair, and
 * writes the pattern directly to the local BlockStore — with no MCP
 * tool permission prompt and no payload dump in the transcript.
 *
 * Why this command exists
 * -----------------------
 *   The v1 capture path required the agent to call the MCP tool
 *   `store_reasoning_pattern` at the end of every novel task. In
 *   Claude Code, each MCP tool call pops a permission dialog and
 *   displays the entire arguments object (400–2000 chars of
 *   situation/mechanism/unlock/verification) in the transcript. For a
 *   normal user doing routine development that UX was unacceptable:
 *   they saw a giant "store_reasoning_pattern" payload after every
 *   question, and had to click through a prompt to save memory they
 *   didn't explicitly ask for.
 *
 *   A Stop hook lets us capture in the background: Claude Code hands
 *   us the transcript path, we open the file in-process, pick the
 *   pattern out via heuristics, and write it directly to SQLite. The
 *   only user-visible signal is a one-line `▣ TB TRACE` badge in
 *   the transcript — and only when compact mode is on.
 *
 * Capture heuristic
 * -----------------
 *   Auto-capture is intentionally conservative. The MCP tool path is
 *   still the right tool when an LLM itself distils a careful pattern;
 *   this hook's job is to catch obvious cases without polluting the
 *   store. We refuse to write unless:
 *     - last user turn is substantive (≥ MIN_TASK_CHARS)
 *     - last assistant text block is substantive (≥ MIN_OUTCOME_CHARS)
 *     - a plausible mechanism paragraph exists
 *     - an action-oriented unlock line can be extracted
 *
 *   Any weaker signal → we emit "no reusable pattern" and store
 *   nothing. False negatives (missed captures) are cheap; false
 *   positives (junk in the store) are expensive because the next
 *   retrieval would surface them.
 *
 * Why JSON, never throw
 * ---------------------
 *   A hook crash blocks nothing for Stop (the agent has already
 *   stopped), but a non-zero exit still lands in the transcript as a
 *   red badge. We swallow every internal failure and emit the
 *   "capture unavailable" envelope so a broken store is invisible to
 *   the user's normal workflow.
 */
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { BlockStore } from "../../core/block-store.js";
import { findProjectRoot, isInitialized, loadConfig } from "../../core/config.js";
import {
  storeReasoningPattern,
  StorePatternValidationError,
  type StoreReasoningPatternArgs,
} from "../../server/mcp-v2-helpers.js";

// ---------------------------------------------------------------------------
// Hook shape + CLI options
// ---------------------------------------------------------------------------

/**
 * The `Stop` hook payload Claude Code sends on stdin. Only the fields
 * we read are typed; everything else is ignored (and the parser
 * collapses any unreadable shape to `{}`).
 */
export interface StopHookStdin {
  hook_event_name?: string;
  hookEventName?: string;
  transcript_path?: string;
  transcriptPath?: string;
  cwd?: string;
  session_id?: string;
  sessionId?: string;
}

/**
 * `compact` writes + emits a one-line badge. `silent` writes but
 * suppresses the badge. `off` skips the write entirely, useful when
 * users want memory capture pinned to manual MCP tool calls only.
 */
export type CaptureStatusMode = "compact" | "silent" | "off";

export interface RunCaptureTurnOptions {
  host?: string;
  budget?: string | number;
  path?: string;
  /**
   * `compact` (default) | `silent` | `off`. Env override:
   * `TRACEBASE_CAPTURE=off|compact|silent` wins over this flag.
   */
  capture?: string;
}

export interface CaptureTurnOutcome {
  envelope: string;
  /** True iff a block was written (new OR reinforcing an existing one). */
  captured: boolean;
  /** Block id when a write happened; null otherwise. */
  blockId: string | null;
}

/**
 * Exhaustive classification of what capture-turn did. A single
 * `formatStatus(situation, mode)` maps each to at most one badge
 * literal — no duplicate label strings anywhere. Mirrors the
 * `InjectSituation` pattern in inject-context.ts for consistency.
 */
type CaptureSituation =
  | { kind: "stored"; blockId: string }
  | { kind: "reinforced"; blockId: string }
  | { kind: "no-pattern" }
  | { kind: "unavailable" }
  | { kind: "off" };

// Soft caps. Intentionally loose on input reading (we'll still cap
// rendered field lengths at store time) but strict on the "did this
// turn do real work?" gate.
const MIN_TASK_CHARS = 80;
const MIN_OUTCOME_CHARS = 300;
const MIN_MECHANISM_CHARS = 80;
const MIN_UNLOCK_CHARS = 15;
const MAX_SITUATION = 280;
const MAX_FIELD = 600;
const TRANSCRIPT_BYTE_LIMIT = 8 * 1024 * 1024; // 8 MiB — Claude Code transcripts can get large

export const captureTurnCommand = new Command("capture-turn")
  .description(
    "Internal: Stop-hook capture of a completed Claude Code turn. Reads the hook's " +
      "stdin JSON + transcript file, heuristically extracts a situation/mechanism/unlock/" +
      "verification, and writes a TraceBase block directly — no MCP tool permission prompt.",
  )
  .option("--host <host>", "host shaping the JSON envelope: claude-code (default)", "claude-code")
  .option(
    "--capture <mode>",
    "capture behaviour: compact (default, writes + badge) | silent (writes, no badge) | off (no-op). Env: TRACEBASE_CAPTURE.",
    "compact",
  )
  .option("-p, --path <path>", "project root override")
  .action(async (opts: RunCaptureTurnOptions) => {
    const stdin = readStdinJson();
    const outcome = runCaptureTurn(opts, stdin);
    process.stdout.write(outcome.envelope + "\n");
  });

/**
 * Pure helper. Same "never throws, always emits a parseable envelope"
 * contract as inject-context.ts.
 */
export function runCaptureTurn(
  opts: RunCaptureTurnOptions,
  stdin: StopHookStdin,
): CaptureTurnOutcome {
  const mode = resolveCaptureMode(opts.capture);

  // `off` short-circuits: no store touch, no badge, empty envelope.
  // Still a legitimate exit so the hook timing stays honest.
  if (mode === "off") {
    return wrapEnvelope("", formatStatus({ kind: "off" }, mode));
  }

  try {
    const basePath = resolveBasePath(opts.path, stdin);
    if (!basePath || !isInitialized(basePath)) {
      // Uninitialised project → quiet no-op, same UX as inject-context.
      return wrapEnvelope("", formatStatus({ kind: "no-pattern" }, mode));
    }

    const transcriptPath = stdin.transcript_path ?? stdin.transcriptPath ?? null;
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return wrapEnvelope("", formatStatus({ kind: "no-pattern" }, mode));
    }

    const transcript = readTranscript(transcriptPath);
    if (!transcript) {
      return wrapEnvelope("", formatStatus({ kind: "no-pattern" }, mode));
    }

    const extracted = extractPattern(transcript.lastUserText, transcript.lastAssistantText);
    if (!extracted) {
      return wrapEnvelope("", formatStatus({ kind: "no-pattern" }, mode));
    }

    const config = loadConfig(basePath);
    const result = withBlockStore(config.storagePath, (store) => {
      return storeReasoningPattern(store, extracted);
    });

    const situation: CaptureSituation = result.isNew
      ? { kind: "stored", blockId: result.blockId }
      : { kind: "reinforced", blockId: result.blockId };
    return wrapEnvelope(result.blockId, formatStatus(situation, mode));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Store validation errors are expected (the heuristic can produce
    // a field that's technically too short even after we gated it) —
    // log them at info level only, they aren't a broken install.
    const isValidation = err instanceof StorePatternValidationError;
    process.stderr.write(
      `tracebase capture-turn: ${isValidation ? "skipped (validation): " : ""}${reason}\n`,
    );
    return wrapEnvelope(
      "",
      formatStatus(isValidation ? { kind: "no-pattern" } : { kind: "unavailable" }, mode),
    );
  }
}

function wrapEnvelope(blockId: string, status: string | null): CaptureTurnOutcome {
  const envelope: Record<string, unknown> = {};
  if (status !== null) envelope.systemMessage = status;
  return {
    envelope: JSON.stringify(envelope),
    captured: blockId.length > 0,
    blockId: blockId.length > 0 ? blockId : null,
  };
}

/**
 * Single source of truth for the TB TRACE capture badge. Silent and
 * off-mode always return null. Off is included in the switch so every
 * caller is type-safe exhaustive.
 */
function formatStatus(situation: CaptureSituation, mode: CaptureStatusMode): string | null {
  if (mode === "silent" || mode === "off") return null;
  switch (situation.kind) {
    case "off":
      return null; // should never reach here with mode=compact, but kept for exhaustiveness
    case "stored":
      return `▣ TB TRACE  stored #${shortBlockId(situation.blockId)}`;
    case "reinforced":
      return `▣ TB TRACE  reinforced #${shortBlockId(situation.blockId)}`;
    case "no-pattern":
      return "▣ TB TRACE  no reusable pattern";
    case "unavailable":
      return "▣ TB TRACE  capture unavailable";
  }
}

function shortBlockId(id: string): string {
  return id.replace(/^block-/, "").slice(0, 8);
}

function resolveCaptureMode(raw: string | undefined): CaptureStatusMode {
  // Env override wins: lets a user flip capture project-wide off
  // without editing .claude/settings.json.
  const fromEnv = normaliseCaptureMode(process.env.TRACEBASE_CAPTURE);
  if (fromEnv) return fromEnv;
  const fromFlag = normaliseCaptureMode(raw);
  if (fromFlag) return fromFlag;
  return "compact";
}

function normaliseCaptureMode(raw: string | undefined): CaptureStatusMode | null {
  const v = raw?.trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "silent") return "silent";
  if (v === "compact") return "compact";
  return null;
}

// ---------------------------------------------------------------------------
// Stdin / basePath resolution — tolerant parsers, collapse-to-{} on error
// ---------------------------------------------------------------------------

export function readStdinJson(): StopHookStdin {
  if (process.stdin.isTTY) return {};
  let raw: Buffer;
  try {
    raw = readFileSync(0, { flag: "r" });
  } catch {
    return {};
  }
  return parseStdinPayload(raw);
}

export function parseStdinPayload(raw: Buffer | string): StopHookStdin {
  const buf = typeof raw === "string" ? Buffer.from(raw) : raw;
  if (buf.length === 0) return {};
  if (buf.length > 256 * 1024) return {};
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as StopHookStdin;
    return {};
  } catch {
    return {};
  }
}

function resolveBasePath(explicit: string | undefined, stdin: StopHookStdin): string | null {
  if (explicit) return explicit;
  if (typeof stdin.cwd === "string" && stdin.cwd) {
    return findProjectRoot(stdin.cwd) ?? stdin.cwd;
  }
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

// ---------------------------------------------------------------------------
// Transcript reader
// ---------------------------------------------------------------------------

interface TranscriptSummary {
  lastUserText: string;
  lastAssistantText: string;
}

/**
 * Walk the JSONL transcript backwards, skipping meta/command/tool
 * entries, and return the final real user prompt + final assistant
 * text. Returns null if either side is missing — no pattern without
 * both halves.
 *
 * Claude Code transcripts can exceed a few MiB for long sessions;
 * we cap at 8 MiB and read the tail only from that cap. In practice
 * capture-turn is called on a completed turn, so what matters is
 * *near the end* of the file, not the whole history.
 */
export function readTranscript(path: string): TranscriptSummary | null {
  let raw: string;
  try {
    const buf = readFileSync(path);
    if (buf.length === 0) return null;
    const tail = buf.length > TRANSCRIPT_BYTE_LIMIT
      ? buf.subarray(buf.length - TRANSCRIPT_BYTE_LIMIT)
      : buf;
    raw = tail.toString("utf-8");
  } catch {
    return null;
  }
  return parseTranscript(raw);
}

export function parseTranscript(raw: string): TranscriptSummary | null {
  const lines = raw.split("\n");
  let lastUserText = "";
  let lastAssistantText = "";
  // Walk backwards — we want the tail of the conversation.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };

    if (!lastAssistantText && e.type === "assistant" && e.message) {
      const text = extractAssistantText(e.message.content);
      if (text.length > 0) lastAssistantText = text;
    }
    if (!lastUserText && e.type === "user" && e.message) {
      const text = extractUserText(e.message.content);
      if (text.length > 0) lastUserText = text;
    }
    if (lastUserText && lastAssistantText) break;
  }

  if (!lastUserText || !lastAssistantText) return null;
  return { lastUserText, lastAssistantText };
}

function extractUserText(content: unknown): string {
  // Real user input: `content` is a string AND doesn't look like a
  // command caveat or tool result. Arrays are almost always
  // tool_result turns that Claude Code synthesises on the user's
  // behalf — skipped.
  if (typeof content !== "string") return "";
  const trimmed = content.trim();
  if (trimmed.length === 0) return "";
  // Meta wrappers that Claude Code emits internally:
  //   <command-name>...</command-name>
  //   <local-command-caveat>...</local-command-caveat>
  //   <system-reminder>...</system-reminder>
  //   <tracebase queryId=...>...</tracebase>
  if (/^<(command-name|local-command-caveat|system-reminder|tracebase)[\s>]/.test(trimmed)) {
    return "";
  }
  return trimmed;
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
      parts.push(b.text.trim());
    }
    // Skip tool_use, tool_result, thinking, image — we only capture
    // text the model surfaced to the user.
  }
  return parts.join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// Heuristic pattern extraction
// ---------------------------------------------------------------------------

/**
 * Distil a situation/mechanism/unlock/verification from the raw turn
 * using shape-level heuristics. Returns null when the turn doesn't
 * look like a reusable problem-solution pair — the store never sees a
 * partial pattern.
 */
export function extractPattern(
  userText: string,
  assistantText: string,
): StoreReasoningPatternArgs | null {
  if (userText.length < MIN_TASK_CHARS) return null;
  if (assistantText.length < MIN_OUTCOME_CHARS) return null;

  const situation = firstSentence(userText).slice(0, MAX_SITUATION);
  if (situation.length < 20) return null;

  const cleaned = stripCodeBlocks(assistantText).trim();
  if (cleaned.length < MIN_MECHANISM_CHARS) return null;
  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 20);
  if (paragraphs.length === 0) return null;

  const mechanism = paragraphs[0]!.slice(0, MAX_FIELD);
  if (mechanism.length < MIN_MECHANISM_CHARS) return null;

  const unlock =
    findActionLine(cleaned) ??
    (paragraphs[1] ? paragraphs[1]!.slice(0, MAX_FIELD) : null) ??
    (mechanism.length > MIN_UNLOCK_CHARS + 20 ? mechanism.slice(MIN_UNLOCK_CHARS) : null);
  if (!unlock || unlock.length < MIN_UNLOCK_CHARS) return null;

  const verification =
    findVerificationLine(cleaned) ??
    "Re-run the failing step or relevant tests to confirm the fix holds.";

  return {
    situation,
    mechanism,
    unlock: unlock.slice(0, MAX_FIELD),
    verification: verification.slice(0, MAX_FIELD),
  };
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  // Take up to the first sentence terminator or newline pair —
  // whichever comes first.
  const match = /^[\s\S]*?(?:[.!?]\s|\n{2,}|$)/.exec(trimmed);
  return (match?.[0] ?? trimmed).trim();
}

function stripCodeBlocks(text: string): string {
  // Drop triple-backtick fenced code blocks — they inflate the
  // mechanism/unlock extraction with verbatim snippets the next
  // retrieval can't usefully match against. Inline backticks stay.
  return text.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n");
}

function findActionLine(text: string): string | null {
  const lines = text.split(/\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < MIN_UNLOCK_CHARS) continue;
    // Imperative verb at the start = "do this" sentence. The list is
    // deliberately narrow: broader verbs like "use" produce too many
    // false positives from descriptive prose.
    if (/^(Add|Change|Set|Install|Run|Fix|Replace|Move|Delete|Create|Update|Remove|Rename|Pin|Migrate|Switch|Wrap|Extract|Rewrite)\b/i.test(line)) {
      return line.slice(0, MAX_FIELD);
    }
  }
  return null;
}

function findVerificationLine(text: string): string | null {
  const lines = text.split(/\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < 15 || line.length > MAX_FIELD) continue;
    // Verification markers that sound like "here's how to check".
    if (/\b(verify|verification|test|tests|check|confirm|re-?run|assert)\b/i.test(line)) {
      return line.slice(0, MAX_FIELD);
    }
  }
  return null;
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
