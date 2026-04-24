/**
 * `tracebase inject-context` — silent pre-prompt injection for
 * host hooks (Claude Code `UserPromptSubmit` / `SessionStart`,
 * Codex hooks). Reads the host's hook payload from stdin, queries
 * the local reasoning store, and writes a host-shaped JSON envelope
 * to stdout that the host injects directly into the model's prompt
 * — without the agent ever calling an MCP tool.
 *
 * Why this command exists:
 *   The MCP `get_reasoning_patterns` tool is high-friction. The
 *   agent has to recognise the right moment, narrate the call,
 *   wait for the response, then narrate again. By the time we tell
 *   it not to narrate, half the budget is spent. A hook that runs
 *   *before* the model produces tokens removes the entire round
 *   trip — the agent reads the patterns alongside the user's
 *   prompt as background knowledge.
 *
 * Why JSON, never throw:
 *   A hook crash (or non-zero exit) blocks the user's prompt in
 *   Claude Code. We swallow every internal failure and emit the
 *   "no patterns" envelope so a broken store is invisible to the
 *   user. The downstream MCP tool path remains as a fallback when
 *   the agent decides on its own that it wants more.
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { BlockStore } from "../../core/block-store.js";
import { BlockServer, type RecallV2Result } from "../../core/block-serving.js";
import {
  buildInjectionPayload,
  type InjectionPayload,
} from "../../core/build-injection-payload.js";
import { loadBlockCalibrator } from "../../lifecycle/calibrator.js";
import { findProjectRoot, isInitialized, loadConfig, readHoldoutConfig } from "../../core/config.js";
import { runReasoningPatternsRecall } from "../../server/reasoning-patterns-entry.js";

export type InjectContextHost = "claude-code" | "codex";

/**
 * Compact shows one-line status badges on the host; silent suppresses
 * them. The default is `compact` — users who ran `tracebase init` see
 * a visible breadcrumb when the hook recalled patterns (or decided
 * not to), without reading the injected context itself. Silent is for
 * power users who don't want the host showing anything at all.
 */
export type HookStatusMode = "compact" | "silent";

/**
 * One-shot classification of what the hook actually did, fed into
 * `formatStatus`. Keeping the situation closed-shape avoids duplicate
 * badge logic — there is exactly one place that maps a situation to
 * a badge string, and the compact/silent flag flows through it.
 */
type InjectSituation =
  | { kind: "match"; queryId: string; patterns: number; facts: number; tokens: number }
  | { kind: "no-match" }
  | { kind: "trivial" }
  | { kind: "uninitialized" }
  | { kind: "failure" };

/**
 * Hook event shapes we recognise. Claude Code spells the field
 * `prompt`; Codex calls it `userPrompt` in some contexts. We accept
 * both so a single command serves both hosts.
 */
export interface HookStdin {
  hook_event_name?: string;
  hookEventName?: string;
  prompt?: string;
  userPrompt?: string;
  user_prompt?: string;
  /** Workspace path, when the host supplies it. */
  cwd?: string;
  workspace?: string;
}

export interface RunInjectContextOptions {
  host?: string;
  event?: string;
  budget?: string | number;
  path?: string;
  /**
   * `compact` (default) attaches a one-line `systemMessage` to the
   * envelope summarising what the hook did. `silent` emits only the
   * `hookSpecificOutput` envelope — no top-level badge, ever. Env
   * override: `TRACEBASE_HOOK_STATUS=compact|silent` wins over this
   * flag, so a user can flip the project-wide installer default
   * without editing `.claude/settings.json`.
   */
  status?: string;
}

export interface InjectContextOutcome {
  /** Envelope JSON string the host receives on stdout. Always one line. */
  envelope: string;
  /** True iff the envelope carried non-empty additionalContext. */
  injected: boolean;
}

const STDIN_BYTE_LIMIT = 256 * 1024; // 256 KiB — well above any realistic hook payload
const MIN_PROMPT_CHARS = 40; // skip "hi", "thanks", trivial chatter

export const injectContextCommand = new Command("inject-context")
  .description(
    "Internal: produce a silent pre-prompt context envelope for a host hook " +
      "(Claude Code UserPromptSubmit, Codex hooks). Reads the hook's stdin JSON, " +
      "queries the local reasoning store, prints the host's expected JSON envelope.",
  )
  .option("--host <host>", "host shaping the JSON envelope: claude-code | codex", "claude-code")
  .option("--event <event>", "hook event name (UserPromptSubmit | SessionStart)", "UserPromptSubmit")
  .option("--budget <tokens>", "soft token budget for injected content (default 1200)", "1200")
  .option(
    "--status <mode>",
    "hook status-line mode: compact (default) | silent. Env override: TRACEBASE_HOOK_STATUS.",
    "compact",
  )
  .option("-p, --path <path>", "project root override")
  .action(async (opts: RunInjectContextOptions) => {
    // Spawn-side wrapper: pull stdin via fs, hand off to the pure
    // helper, write the envelope to stdout. The pure helper is
    // exported so tests can exercise the contract without spawning
    // the CLI binary (which would require a built dist).
    const stdin = readStdinJson();
    const outcome = runInjectContext(opts, stdin);
    process.stdout.write(outcome.envelope + "\n");
  });

/**
 * Pure helper. Given parsed hook stdin and CLI options, returns the
 * exact envelope string the host should receive — never throws.
 *
 * Hard guarantee: we always return a well-formed envelope, even on
 * total internal failure. A hook that crashes blocks the user; an
 * empty envelope is invisible. Any error is recorded on stderr (Claude
 * Code surfaces it in the transcript without blocking the prompt).
 */
export function runInjectContext(
  opts: RunInjectContextOptions,
  stdin: HookStdin,
): InjectContextOutcome {
  const host = normaliseHost(opts.host);
  const eventName = normaliseEvent(opts.event);
  const budget = parseBudget(opts.budget);
  const statusMode = resolveStatusMode(opts.status);

  try {
    const prompt = extractPrompt(stdin);
    const basePath = resolveBasePath(opts.path, stdin);

    // Skip trivial chatter so analytics aren't drowned in retrieval
    // events for "hi" and "thanks". The MCP tool path is still
    // available if the agent really wants patterns mid-thread.
    if (!shouldQuery(eventName, prompt)) {
      return wrapEnvelope(host, eventName, "", formatStatus({ kind: "trivial" }, statusMode));
    }

    // Project may not be initialised — that's fine, we emit empty.
    // First-run UX is: user types something, hook fires, hook sees
    // no .tracebase, exits clean. No crash, no nag.
    if (!basePath || !isInitialized(basePath)) {
      return wrapEnvelope(host, eventName, "", formatStatus({ kind: "uninitialized" }, statusMode));
    }

    const config = loadConfig(basePath);
    const payload = withBlockServer(config.storagePath, basePath, (server, store, holdoutLoader) => {
      const result = runReasoningPatternsRecall(
        server,
        { problem: prompt },
        { readHoldoutConfig: holdoutLoader },
      );
      const built = buildInjectionPayload(result, { tokenBudget: budget });
      recordHookRecallEvents(store, result, built);
      return built;
    });

    // `hasContent` encodes the full gate chain: query ran, something
    // cleared the gate, something fit the budget. Anything else — no
    // matches, all shadow, everything cut by the budget — lands as
    // "checked · no match" so the user sees the hook ran.
    if (!payload.hasContent) {
      return wrapEnvelope(host, eventName, "", formatStatus({ kind: "no-match" }, statusMode));
    }

    const situation: InjectSituation = {
      kind: "match",
      queryId: payload.queryId,
      patterns: payload.blockIds.length,
      facts: payload.factIds.length,
      tokens: payload.tokensEstimate,
    };
    return wrapEnvelope(host, eventName, payload.text, formatStatus(situation, statusMode));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase inject-context: ${reason}\n`);
    return wrapEnvelope(host, eventName, "", formatStatus({ kind: "failure" }, statusMode));
  }
}

/**
 * Single source of truth for the TB TRACE badge. Every caller funnels
 * through here — there are no duplicated label literals elsewhere in
 * this file, so changing the prefix only touches one spot. Returns
 * `null` when the host should see no `systemMessage`:
 *   - silent mode (hard suppress everywhere)
 *   - trivial / uninitialized in any mode (we haven't done work worth
 *     announcing; see spec)
 *
 * Every emitted badge is capped under 100 characters by construction:
 * queryId short-hand is 8 chars, patterns/facts cap at single digits
 * (renderer caps at 4), tokens cap at 4 digits (budget ≤ 2200).
 */
function formatStatus(situation: InjectSituation, mode: HookStatusMode): string | null {
  if (mode === "silent") return null;
  switch (situation.kind) {
    case "trivial":
    case "uninitialized":
      return null;
    case "match": {
      const factsPart =
        situation.facts > 0 ? ` + ${situation.facts} fact(s)` : "";
      const shortId = situation.queryId.slice(0, 8);
      return (
        `▣ TB TRACE  recalled ${situation.patterns} pattern(s)` +
        `${factsPart} · #${shortId} · ${situation.tokens}t`
      );
    }
    case "no-match":
      return "▣ TB TRACE  checked · no match";
    case "failure":
      return "▣ TB TRACE  skipped · unavailable";
  }
}

function resolveStatusMode(raw: string | undefined): HookStatusMode {
  // Env override wins so a user can flip the project-wide default
  // (written into .claude/settings.json by `init`) without editing
  // config. Invalid env values fall through to the --status flag.
  const fromEnv = normaliseStatusMode(process.env.TRACEBASE_HOOK_STATUS);
  if (fromEnv) return fromEnv;
  const fromFlag = normaliseStatusMode(raw);
  if (fromFlag) return fromFlag;
  return "compact";
}

function normaliseStatusMode(raw: string | undefined): HookStatusMode | null {
  const v = raw?.trim().toLowerCase();
  if (v === "silent") return "silent";
  if (v === "compact") return "compact";
  return null;
}

// ---------------------------------------------------------------------------
// Host envelopes
// ---------------------------------------------------------------------------

/**
 * Both Claude Code and Codex use the same hook envelope shape:
 *
 *   {
 *     "systemMessage"?: "▣ TB TRACE  …",
 *     "hookSpecificOutput": {
 *       "hookEventName": "UserPromptSubmit" | "SessionStart" | …,
 *       "additionalContext": "<text the host inlines into the model prompt>"
 *     }
 *   }
 *
 * `systemMessage` is Claude Code's top-level channel for user-visible
 * breadcrumbs (rendered in the transcript as a dim status line). When
 * `status` is `null` we omit the field entirely — absence is the
 * contract for "show nothing".
 *
 * If `additionalContext` is empty, the host injects nothing — which
 * is exactly the behaviour we want for trivial prompts and
 * uninitialised projects. Returned as a string so the caller can
 * decide whether to print or assert; production prints, tests assert.
 */
function wrapEnvelope(
  host: InjectContextHost,
  eventName: string,
  additionalContext: string,
  status: string | null,
): InjectContextOutcome {
  const envelope: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
  if (status !== null) envelope.systemMessage = status;
  // host parameter is currently identical for the two supported
  // hosts. Kept on the function signature so a divergent envelope
  // (e.g. a future host that wants a different field name) only
  // touches this function.
  void host;
  return {
    envelope: JSON.stringify(envelope),
    injected: additionalContext.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Stdin / hook payload parsing
// ---------------------------------------------------------------------------

/**
 * Read & parse the hook event JSON from stdin. Always returns an
 * object — every failure mode (TTY, empty, malformed, oversize)
 * collapses to `{}`, which downstream paths treat as "no prompt"
 * and emit an empty envelope.
 */
export function readStdinJson(): HookStdin {
  if (process.stdin.isTTY) return {};
  let raw: Buffer;
  try {
    raw = readFileSync(0, { flag: "r" });
  } catch {
    return {};
  }
  return parseStdinPayload(raw);
}

export function parseStdinPayload(raw: Buffer | string): HookStdin {
  const buf = typeof raw === "string" ? Buffer.from(raw) : raw;
  if (buf.length === 0) return {};
  if (buf.length > STDIN_BYTE_LIMIT) {
    // Protect against a misbehaving host blasting megabytes at us.
    // 256 KiB is many multiples of any realistic hook payload.
    return {};
  }
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as HookStdin;
    return {};
  } catch {
    return {};
  }
}

function extractPrompt(stdin: HookStdin): string {
  // First match wins. `prompt` is Claude Code's spelling;
  // `userPrompt` / `user_prompt` cover Codex variants.
  const candidates = [stdin.prompt, stdin.userPrompt, stdin.user_prompt];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

function resolveBasePath(explicit: string | undefined, stdin: HookStdin): string | null {
  if (explicit) return explicit;
  // Hosts include cwd / workspace in some payloads. When they do,
  // we trust them — that's the project the user is actually
  // editing. Fall back to walking up from process.cwd() (the hook
  // is spawned in the project root by Claude Code).
  const fromHook =
    typeof stdin.cwd === "string" && stdin.cwd
      ? stdin.cwd
      : typeof stdin.workspace === "string" && stdin.workspace
        ? stdin.workspace
        : null;
  if (fromHook) return findProjectRoot(fromHook) ?? fromHook;
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

function shouldQuery(eventName: string, prompt: string): boolean {
  // SessionStart fires once per session and may have no prompt.
  // We still want to warm context (e.g. on `/compact`), but only
  // if the project is initialised — handled upstream — and we use
  // the most recent user message if the host gave us one. If the
  // host didn't, we have nothing to query, so skip.
  if (eventName === "SessionStart") {
    return prompt.length >= MIN_PROMPT_CHARS;
  }
  // UserPromptSubmit fires on every user turn. Skip greetings and
  // trivial follow-ups; analytics get noisy fast otherwise, and the
  // gate would reject these anyway.
  return prompt.length >= MIN_PROMPT_CHARS;
}

function parseBudget(raw: string | number | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1200;
  // Cap at the host's hard ceiling (Claude Code: 10 KB string =
  // ~2500 tokens). Stay below it to leave headroom for the
  // wrapper and lead-in.
  return Math.min(Math.floor(n), 2200);
}

function normaliseHost(raw: string | undefined): InjectContextHost {
  const v = raw?.trim().toLowerCase();
  if (v === "codex") return "codex";
  return "claude-code";
}

function normaliseEvent(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) return "UserPromptSubmit";
  // Whitelist the events we know the host accepts. An unknown
  // event would still ship to the host but might be rejected.
  if (v === "SessionStart") return "SessionStart";
  return "UserPromptSubmit";
}

// ---------------------------------------------------------------------------
// Block server lifecycle
// ---------------------------------------------------------------------------

/**
 * Open a BlockStore + BlockServer for the duration of one query and
 * close them. The hook process is short-lived (one query, one exit),
 * so we don't bother caching across calls — each invocation pays a
 * single SQLite open (typically <10 ms) and a single FTS query
 * (typically <50 ms).
 *
 * Always closes the DB even if the inner callback throws — a
 * lingering WAL handle in a hook process would surface as a
 * "database is locked" error on a follow-on `tracebase` invocation.
 */
function withBlockServer<T>(
  storagePath: string,
  basePath: string,
  fn: (
    server: BlockServer,
    store: BlockStore,
    holdoutLoader: () => ReturnType<typeof readHoldoutConfig>,
  ) => T,
): T {
  const db = new Database(storagePath);
  const store = new BlockStore(db);
  try {
    const server = new BlockServer(store, {
      calibrator: loadBlockCalibrator(store),
      emitEvents: false,
      gateThreshold: 0,
    });
    const holdoutLoader = () => readHoldoutConfig(basePath);
    return fn(server, store, holdoutLoader);
  } finally {
    store.close();
  }
}

/**
 * The generic BlockServer emits injection events for every above-gate
 * hit. Silent hooks add a stricter budget after recall, so they must
 * emit only the ids that survived into `additionalContext`; otherwise
 * `record_reasoning_outcome({ usedPattern: true })` would credit
 * patterns the agent never saw.
 */
function recordHookRecallEvents(
  store: BlockStore,
  result: RecallV2Result,
  payload: InjectionPayload,
): void {
  let ts = Date.now();
  const nextTs = () => ts++;

  store.appendEvent({
    ts: nextTs(),
    queryId: result.queryId,
    event: "retrieval",
    candidates: result.blocks.map((h) => ({ blockId: h.block.id, score: h.score })),
    shadow: result.shadow,
    ...(result.controlReason ? { controlReason: result.controlReason } : {}),
    ...(result.facts.length > 0
      ? { factCandidates: result.facts.map((h) => ({ factId: h.fact.id, score: h.score })) }
      : {}),
  });

  const visibleBlocks = new Set(payload.blockIds);
  for (const hit of result.blocks) {
    if (!visibleBlocks.has(hit.block.id)) continue;
    store.appendEvent({
      ts: nextTs(),
      queryId: result.queryId,
      event: "injection",
      blockId: hit.block.id,
      score: hit.score,
      calibratedProb: hit.calibratedProb,
    });
  }

  const visibleFacts = new Set(payload.factIds);
  for (const hit of result.facts) {
    if (!visibleFacts.has(hit.fact.id)) continue;
    store.appendEvent({
      ts: nextTs(),
      queryId: result.queryId,
      event: "fact_injection",
      factId: hit.fact.id,
      score: hit.score,
      calibratedProb: hit.calibratedProb,
    });
  }
}
