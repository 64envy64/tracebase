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
import { ensureManagedHooksCurrent } from "../hook-self-heal.js";
import { boundField, detectLeakageExtended, isRepoRelative } from "../../core/guard.js";
import {
  storeReasoningPattern,
  StorePatternValidationError,
  type StoreReasoningPatternArgs,
} from "../../server/mcp-v2-helpers.js";
import type { StoreProjectFactInput } from "../../types.js";

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
 *
 * `factCount` is optional on stored / reinforced / no-pattern so the
 * composite TB TRACE + TB MEMORY badge can render either half
 * without a dangling separator.
 */
type CaptureSituation =
  | { kind: "stored"; blockId: string; factCount: number }
  | { kind: "reinforced"; blockId: string; factCount: number }
  | { kind: "no-pattern"; factCount: number }
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

// ---------------------------------------------------------------------------
// 0.5.7 §A — quality gate (narrow, high-precision).
//
// Pre-0.5.7 the gate was length-only: any user turn with ≥80 chars
// + assistant turn with ≥300 chars + one substantive paragraph
// produced a stored pattern. That admitted a wide class of
// project-management noise — release tags, plan approvals,
// "schedule a follow-up", session-continuation wrappers, etc. —
// every one of which then surfaced in `additionalContext` on
// future prompts as fake "prior debugging".
//
// New gate intent: a missed capture is cheaper than a noisy
// stored pattern. We REJECT user turns that:
//   1. Are/contain Claude Code session-continuation / meta wrappers
//      that escape the per-line strip in `extractUserText`.
//   2. Lead with project-management vocabulary
//      ("Plan approved", "Start 0.5.x", "Yes, schedule", etc.) —
//      the user is operating, not debugging.
//   3. Carry NO problem signal — no `?`, no error/bug/failure
//      vocabulary in EN or RU.
//
// Each predicate is a pure regex over the cleaned user text.
// Tests use literal strings from the live store so the gate
// catches the exact noise classes we observed in the wild.
// ---------------------------------------------------------------------------

/**
 * Patterns the user text MUST NOT lead with (or contain in
 * context-leak cases). Each entry is anchored or scoped tight
 * enough that a real bug-report sentence can't accidentally
 * match.
 */
const META_WRAP_LEADS: readonly RegExp[] = [
  /^This session is being continued from a previous conversation/i,
  /^This conversation is being continued/i,
  /^Continuing from where (we|I) left off/i,
  /^<(command-name|local-command-(caveat|stdout|output)|system-reminder|tracebase)\b/i,
  /^Login successful\s*$/i,
] as const;

/**
 * Project-management / release-process leads. The user is driving
 * a release / approval / scheduling flow, not asking the agent to
 * solve a problem. None of these belong in `reasoning_blocks`.
 *
 * Both `\b` and `^` are deliberate: leads must be at the START
 * of the trimmed user text, not buried inside a longer paragraph
 * that happens to use the word.
 */
const PROJECT_MANAGEMENT_LEADS: readonly RegExp[] = [
  // Approvals / sign-offs
  /^plan approved\b/i,
  /^approved\s*(with\b|\.|$)/i,
  /^lgtm\b/i,
  /^ship it\b/i,
  // Release / version starts
  /^start\b.*\b(0\.\d|candidate|implementation|the\s+work|release|0\.5\.|0\.6\.)/i,
  /^bump (to )?\d+\.\d+\b/i,
  /^cut (a |the )?release\b/i,
  // Planning / build verbs aimed at the agent itself
  /^build (one|a|the)\s+(unified|combined)\b/i,
  /^do(es)? .*later\b/i,
  // Scheduling / smoke / verify-and-do
  /^yes,?\s+(schedule|do|continue|proceed|publish|push|ship)\b/i,
  /^schedule (a |the )?follow[- ]?up\b/i,
  /^run (a |the )?smoke\b/i,
  // Russian project-management leads
  /^(окей|ок|давай|сделай|сделать|запускай|пиши|посмотри|глянь|погляди|продолжи)\b/iu,
  /^(всё|все)\s+(гуд|ок|норм)\b/iu,
] as const;

/**
 * Problem signals — at least one MUST appear in the user text.
 * Question mark, EN error/bug vocabulary, RU equivalents. The
 * list is deliberately narrow: "the store gave me nothing useful"
 * is the wrong concern at the gate; "the store fed me a noisy
 * project-management note as if it were debugging" is the right
 * one.
 */
const PROBLEM_SIGNAL_RE =
  /[?]|\b(error|errors|bug|bugs|fails?|failure|failed|broken|breaking|issue|issues|crash(?:ed|es|ing)?|stuck|wrong|why|how come|regression|regress|hang(?:s|ing)?|panic|exception|trace(?:back)?|throws?|timeout|leaks?)\b|(?:ошибк[аиуые]|баг[иу]?|не\s+работает|не\s+пашет|сломал[оа]?сь?|сломан[оы]?|завис(?:ло|ли|ает)?|регрессия|регрес|вылет(?:ает|ел|ела))/iu;

function isPatternShapedUserText(cleaned: string): boolean {
  if (META_WRAP_LEADS.some((re) => re.test(cleaned))) return false;
  if (PROJECT_MANAGEMENT_LEADS.some((re) => re.test(cleaned))) return false;
  if (!PROBLEM_SIGNAL_RE.test(cleaned)) return false;
  return true;
}

/**
 * Exposed for the prune command (§B) so it can reuse the same
 * classifier when sweeping previously-stored blocks. Keep the
 * implementation behind one function so future tweaks land in
 * exactly one place.
 */
export function isPatternShapedSituation(situation: string): boolean {
  return isPatternShapedUserText(situation);
}

// 0.5.0 TB MEMORY — semantic file facts.
// Hard bounds per plan §5.1: 400 chars per statement, 3 facts per turn.
const MAX_FACT_STATEMENT = 400;
const MAX_FACTS_PER_TURN = 3;
/** Scope shared by every TB MEMORY fact in a workspace. Hierarchical
 * searching can refine later; 0.5 treats all file_semantic facts as
 * workspace-level regardless of which transcript they came from. */
const FACT_SCOPE = "project";

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
  // TRACEBASE_DISABLED=1 from the demo harness (or any user
  // running a one-off suppression) takes the same path. Still a
  // legitimate exit so the hook timing stays honest.
  if (mode === "off" || process.env.TRACEBASE_DISABLED === "1") {
    return wrapEnvelope("", formatStatus({ kind: "off" }, mode));
  }

  try {
    const basePath = resolveBasePath(opts.path, stdin);
    if (!basePath || !isInitialized(basePath)) {
      // Uninitialised project → quiet no-op, same UX as inject-context.
      return wrapEnvelope("", formatStatus({ kind: "no-pattern", factCount: 0 }, mode));
    }

    // 0.5.6 — throttled hook self-heal. See inject-context call site.
    try {
      ensureManagedHooksCurrent(basePath, "claude-code");
    } catch {
      // best-effort
    }

    const transcriptPath = stdin.transcript_path ?? stdin.transcriptPath ?? null;
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return wrapEnvelope("", formatStatus({ kind: "no-pattern", factCount: 0 }, mode));
    }

    const transcript = readTranscript(transcriptPath);
    if (!transcript) {
      return wrapEnvelope("", formatStatus({ kind: "no-pattern", factCount: 0 }, mode));
    }

    // Fact extraction runs independently of pattern extraction so one
    // path's heuristic miss doesn't starve the other. Errors inside the
    // extractor fall through to 0 facts — the envelope still lands.
    let factsExtracted: StoreProjectFactInput[] = [];
    try {
      factsExtracted = extractFacts(transcript.lastUserText, transcript.lastAssistantText);
    } catch (err) {
      process.stderr.write(
        `tracebase capture-turn: fact extraction skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    const extracted = extractPattern(transcript.lastUserText, transcript.lastAssistantText);
    const config = loadConfig(basePath);

    // A single store handle services both the pattern and the facts so
    // the SQLite file is opened once per hook invocation.
    const { blockResult, factCount } = withBlockStore(config.storagePath, (store) => {
      let blockResult: ReturnType<typeof storeReasoningPattern> | null = null;
      if (extracted) {
        try {
          blockResult = storeReasoningPattern(store, extracted);
        } catch (err) {
          const isValidation = err instanceof StorePatternValidationError;
          process.stderr.write(
            `tracebase capture-turn: ${isValidation ? "pattern skipped (validation): " : "pattern error: "}${err instanceof Error ? err.message : String(err)}\n`,
          );
          if (!isValidation) throw err; // rethrow non-validation to the outer catch
        }
      }
      let factCount = 0;
      for (const candidate of factsExtracted) {
        try {
          store.storeFact(candidate);
          factCount += 1;
        } catch (err) {
          // Per-fact failures are swallowed with a stderr line; one bad
          // row never kills the batch. (§5.1 privacy / leakage scanner
          // rejections surface here.)
          process.stderr.write(
            `tracebase capture-turn: fact dropped: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      return { blockResult, factCount };
    });

    // Compose the situation from pattern + fact outcomes. When neither
    // produced anything, the hook emits "no reusable pattern"; when
    // only facts landed, we still report the capture via the fact
    // count — no block badge, but the TB MEMORY half lights up.
    let situation: CaptureSituation;
    if (blockResult) {
      situation = blockResult.isNew
        ? { kind: "stored", blockId: blockResult.blockId, factCount }
        : { kind: "reinforced", blockId: blockResult.blockId, factCount };
    } else {
      situation = { kind: "no-pattern", factCount };
    }
    const writtenBlockId = blockResult?.blockId ?? "";
    return wrapEnvelope(writtenBlockId, formatStatus(situation, mode));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const isValidation = err instanceof StorePatternValidationError;
    process.stderr.write(
      `tracebase capture-turn: ${isValidation ? "skipped (validation): " : ""}${reason}\n`,
    );
    return wrapEnvelope(
      "",
      formatStatus(isValidation ? { kind: "no-pattern", factCount: 0 } : { kind: "unavailable" }, mode),
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
 * Single source of truth for the capture-side badge. Silent and off
 * always return null. When both a pattern landed AND facts landed, the
 * badge is composed `▣ TB TRACE … · ▣ TB MEMORY …`; either half is
 * omitted if its count is zero so there's never a dangling separator.
 */
function formatStatus(situation: CaptureSituation, mode: CaptureStatusMode): string | null {
  if (mode === "silent" || mode === "off") return null;
  switch (situation.kind) {
    case "off":
      return null; // should never reach here with mode=compact, but kept for exhaustiveness
    case "stored":
      return composeCaptureBadge(
        `▣ TB TRACE  stored #${shortBlockId(situation.blockId)}`,
        situation.factCount,
      );
    case "reinforced":
      return composeCaptureBadge(
        `▣ TB TRACE  reinforced #${shortBlockId(situation.blockId)}`,
        situation.factCount,
      );
    case "no-pattern":
      // No pattern, but facts can still have landed. When both are
      // zero we keep the legacy "no reusable pattern" message so
      // users still see the hook ran.
      if (situation.factCount > 0) return memoryBadge(situation.factCount);
      return "▣ TB TRACE  no reusable pattern";
    case "unavailable":
      return "▣ TB TRACE  capture unavailable";
  }
}

function composeCaptureBadge(tracePart: string, factCount: number): string {
  if (factCount <= 0) return tracePart;
  return `${tracePart} · ${memoryBadge(factCount)}`;
}

function memoryBadge(factCount: number): string {
  return `▣ TB MEMORY  noted ${factCount} fact(s)`;
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
  //   <local-command-stdout>...</local-command-stdout>     (0.5.6 §5)
  //   <local-command-output>...</local-command-output>     (0.5.6 §5)
  //   <system-reminder>...</system-reminder>
  //   <tracebase queryId=...>...</tracebase>
  // Whole-turn match: the message IS one of these and nothing else.
  if (/^<(command-name|local-command-caveat|local-command-stdout|local-command-output|system-reminder|tracebase)[\s>]/.test(trimmed)) {
    return "";
  }
  // Inline match (0.5.6 §4): user turn contains a meta wrapper
  // mid-content (e.g. someone pastes the output of a slash command
  // alongside their actual prompt). Strip the wrapper so the
  // length gate sees the substantive part only — turns that were
  // 80% local-command-stdout don't get stored as patterns.
  return stripInlineMetaWrappers(trimmed);
}

const META_WRAPPER_TAGS = [
  "command-name",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-output",
  "system-reminder",
  "tracebase",
] as const;
const META_WRAPPER_RE = new RegExp(
  `<(${META_WRAPPER_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,
  "g",
);

function stripInlineMetaWrappers(text: string): string {
  return text.replace(META_WRAPPER_RE, " ").replace(/\s{2,}/g, " ").trim();
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

  // 0.5.7 §A — narrow, high-precision gate. Reject project-
  // management / release-process / meta-wrapper leads, and
  // require a problem signal (`?` or error vocabulary EN/RU)
  // before storing as a reusable pattern. See the predicate
  // declarations at the top of this file for the rationale —
  // missing a capture is far cheaper than injecting a noisy
  // pattern on every future prompt.
  const trimmedUser = userText.trim();
  if (!isPatternShapedUserText(trimmedUser)) return null;

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

  // 0.5.6 §4 — drop the mechanism.slice fallback. It produced a
  // degenerate "unlock" that was just the back half of the
  // mechanism, which surfaced as noisy reasoning_blocks where
  // mechanism + unlock told the same story. A real reusable
  // pattern needs an action line OR a distinct second paragraph;
  // turns missing both are not pattern-shaped.
  const unlock =
    findActionLine(cleaned) ??
    (paragraphs[1] ? paragraphs[1]!.slice(0, MAX_FIELD) : null);
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
// TB MEMORY — semantic project-fact extraction (0.5.0)
// ---------------------------------------------------------------------------

/**
 * Conservative, deterministic fact extractor. Pulls up to
 * `MAX_FACTS_PER_TURN` candidates in four deliberately narrow buckets:
 *
 *   1. Repo commands — `npm`, `pnpm`, `yarn`, `cargo`, `pytest`, `go`,
 *      `node`, `make`, `python` invocations mentioned near an action
 *      verb ("Run", "Use", "Build", "Test", etc.).
 *   2. File roles — `"<path> (lives|is|contains) <role>"`, path
 *      validated as repo-relative (§4.1 — no absolute paths).
 *   3. Conventions — "uses <Tool>" for a small allowlist of tools
 *      (ESLint / Prettier / Vitest / Jest / Mocha / Tsup / Webpack /
 *      Tailwind).
 *   4. Env requirements — "(Node|Python|Ruby|Go|Rust|Deno|Bun) >= X".
 *
 * Each candidate is bounded to `MAX_FACT_STATEMENT` chars, scanned
 * for leakage patterns (absolute paths, API keys, env lines) via the
 * shared `detectLeakageExtended`, and silently dropped on any match.
 * Returns `[]` on empty input, thrown regexes, or post-filter
 * emptiness — never throws at the call boundary.
 *
 * The extractor is intentionally dumb: it prefers false negatives
 * (missed facts) over false positives (polluting the fact store with
 * fragments that don't retrieve well).
 */
export function extractFacts(userText: string, assistantText: string): StoreProjectFactInput[] {
  const corpus = stripCodeBlocks(`${userText}\n\n${assistantText}`);
  if (corpus.length < 80) return [];

  const candidates: StoreProjectFactInput[] = [];
  const seenStatements = new Set<string>();

  const accept = (statement: string, factType: "repo_fact" | "convention" | "architecture" | "preference" | "file_semantic"): void => {
    if (candidates.length >= MAX_FACTS_PER_TURN) return;
    const bounded = boundField(statement, MAX_FACT_STATEMENT, factType).value;
    if (bounded.length < 10) return;
    // Leakage: reject any candidate that still carries an abs-path,
    // API key, or `.env`-line shape.
    if (detectLeakageExtended(bounded)) return;
    // Dedupe within-turn by normalized form; SQLite-level dedupe (by
    // sha256) handles cross-turn collapse.
    const key = bounded.toLowerCase().replace(/\s+/g, " ");
    if (seenStatements.has(key)) return;
    seenStatements.add(key);
    candidates.push({
      scope: FACT_SCOPE,
      factType: "file_semantic",
      statement: bounded,
      invariants: {},
      source: { origin: "observed" },
    });
  };

  try {
    // Bucket 1 — repo commands. Backtick-wrapped, imperative-verb
    // neighborhood.
    const COMMAND_RE = /(?:^|[\s(])(?:Run|Use|Build|Test|Install|Deploy|Start|Launch|Serve|Verify)[\s:]+?`([^`\n]{3,100})`/gim;
    for (const m of corpus.matchAll(COMMAND_RE)) {
      const cmd = (m[1] ?? "").trim();
      if (!/^(npm|pnpm|yarn|node|npx|pytest|python|cargo|go|make|bun|deno)\b/i.test(cmd)) continue;
      accept(`Run: \`${cmd}\``, "repo_fact");
    }

    // Bucket 2 — file roles. Only accept when the path is repo-relative.
    const FILE_ROLE_RE = /`([A-Za-z0-9_\-./*]+(?:\.[a-z]{1,6})?)`\s+(?:lives|is|located|contains|holds|defines|implements)\s+(.{4,180}?)[.\n]/gim;
    for (const m of corpus.matchAll(FILE_ROLE_RE)) {
      const p = (m[1] ?? "").trim();
      const role = (m[2] ?? "").trim();
      if (!p || !role) continue;
      if (!isRepoRelative(p)) continue;
      accept(`${p}: ${role}`, "file_semantic");
    }

    // Bucket 3 — conventions. Tight allowlist so prose like
    // "use it to compile" doesn't match.
    const CONVENTION_RE = /\buses?\s+`?(ESLint|Prettier|Vitest|Jest|Mocha|Tsup|Webpack|Vite|Rollup|Tailwind|Biome|Turbopack|Playwright|Cypress)`?\b/gi;
    for (const m of corpus.matchAll(CONVENTION_RE)) {
      const tool = (m[1] ?? "").trim();
      if (!tool) continue;
      accept(`Uses ${tool}`, "convention");
    }

    // Bucket 4 — env requirements. Standard "(Runtime) >= X" shapes.
    const ENV_RE = /\b(Node|Node\.js|Python|Ruby|Go|Rust|Deno|Bun)\s*(?:≥|>=|>|== ?)\s*([0-9][0-9.]*)\b/gi;
    for (const m of corpus.matchAll(ENV_RE)) {
      const runtime = (m[1] ?? "").trim();
      const version = (m[2] ?? "").trim();
      if (!runtime || !version) continue;
      accept(`${runtime} >= ${version}`, "repo_fact");
    }
  } catch {
    // Defensive — any regex engine hiccup drops the whole batch.
    return [];
  }

  return candidates;
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
