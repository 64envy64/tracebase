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
import { BlockServer, resolveProductionGateThreshold } from "../../core/block-serving.js";
import { loadBlockCalibrator } from "../../lifecycle/calibrator.js";
import { findProjectRoot, isInitialized, loadConfig, readCascadeConfig, readHoldoutConfig } from "../../core/config.js";
import {
  buildRerankerFromCascadeConfig,
  extractCascadeKnobs,
} from "../../experiments/cascade-rollout.js";
import { routerServingOptions } from "../../experiments/reasoning-router-rollout.js";
import {
  recallForPrompt,
  shouldQueryForPrompt,
  type HoldoutLoader,
} from "../../runtime/recall.js";
import { ensureManagedHooksCurrent } from "../hook-self-heal.js";
import type { ToolPatternSignal } from "../../core/tool-loop-detect.js";

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
  | {
      kind: "match";
      queryId: string;
      patterns: number;
      facts: number;
      tokens: number;
      // 0.7.0-rc.6 hardening — file memory + chunk fold counters
      // surface alongside the legacy patterns/facts. `formatStatus`
      // composes one fragment per non-zero counter.
      files: number;
      bytesAvoided: number;
      chunkTurns: number;
      chunkTokensBefore: number;
      chunkTokensAfter: number;
    }
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
  /**
   * Optional explicit, focused retrieval query supplied by an integration
   * (NOT the end user's chat text). When present and non-empty it is used
   * as the recall query INSTEAD of `prompt`, and it BYPASSES the
   * trivial-prompt length gate (`MIN_PROMPT_CHARS`) — a deliberately
   * constructed query is intentional, not chatter. It still flows through
   * the SAME serving threshold + ranking as any other query (no gate or
   * scoring change). The ordinary `prompt` path keeps `MIN_PROMPT_CHARS`.
   */
  retrievalQuery?: string;
  retrieval_query?: string;
  /** Workspace path, when the host supplies it. */
  cwd?: string;
  workspace?: string;
  /**
   * Claude Code's stable session id. When present, inject-context
   * narrows fact recall to the matching `project.session.<hash>`
   * sub-scope so the next turn after a `/compact` re-injects THIS
   * session's TB CONTEXT digest — and never another session's.
   * Hierarchical resolution still surfaces project-level
   * (`project`) and workspace-global (`global`) facts.
   */
  session_id?: string;
  sessionId?: string;
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
    const outcome = await runInjectContext(opts, stdin);
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
export async function runInjectContext(
  opts: RunInjectContextOptions,
  stdin: HookStdin,
): Promise<InjectContextOutcome> {
  const host = normaliseHost(opts.host);
  const eventName = normaliseEvent(opts.event);
  const budget = parseBudget(opts.budget);
  const statusMode = resolveStatusMode(opts.status);

  // TRACEBASE_DISABLED=1 short-circuits the hook to a no-op empty
  // envelope without touching the store or running the recall path.
  // Used by the demo harness (off variant), and as a global
  // kill-switch for users who want to keep the install present but
  // suppress all activity for a single session. The trivial-prompt
  // shape is reused — it's already a no-injection envelope the host
  // accepts cleanly.
  if (process.env.TRACEBASE_DISABLED === "1") {
    return wrapEnvelope(
      host,
      eventName,
      "",
      formatStatus({ kind: "trivial" }, NO_TOOL_SIGNAL, statusMode),
    );
  }

  try {
    const prompt = extractPrompt(stdin);
    const retrievalQuery = extractRetrievalQuery(stdin);
    // The recall query is the explicit focused query when supplied, else
    // the user prompt. An explicit retrievalQuery is intentional and
    // bypasses the trivial-prompt length gate; the ordinary prompt path
    // keeps MIN_PROMPT_CHARS. Either way the query then flows through the
    // unchanged serving threshold + ranking downstream.
    const queryForRecall = retrievalQuery ?? prompt;
    const basePath = resolveBasePath(opts.path, stdin);

    // Skip trivial chatter so analytics aren't drowned in retrieval
    // events for "hi" and "thanks". The MCP tool path is still
    // available if the agent really wants patterns mid-thread. An
    // explicit retrievalQuery skips this length gate (it is not chatter).
    if (retrievalQuery === null && !shouldQueryForPrompt(prompt, eventName)) {
      return wrapEnvelope(host, eventName, "", formatStatus({ kind: "trivial" }, NO_TOOL_SIGNAL, statusMode));
    }

    // Project may not be initialised — that's fine, we emit empty.
    // First-run UX is: user types something, hook fires, hook sees
    // no .tracebase, exits clean. No crash, no nag.
    if (!basePath || !isInitialized(basePath)) {
      return wrapEnvelope(host, eventName, "", formatStatus({ kind: "uninitialized" }, NO_TOOL_SIGNAL, statusMode));
    }

    // 0.5.6 — best-effort, throttled hook self-heal so projects
    // installed before a managed event existed (e.g. PostToolBatch
    // landing in 0.5.3) pick up the new spec without a manual
    // re-run of `npx tracebase-ai init`. Errors are silent unless
    // TRACEBASE_DEBUG is set.
    try {
      if (process.env.TRACEBASE_SKIP_HOOK_SELF_HEAL !== "1") {
        ensureManagedHooksCurrent(basePath, "claude-code");
      }
    } catch {
      // best-effort — never let self-heal failure block the prompt
    }

    const config = loadConfig(basePath);
    const sessionId = stdin.session_id ?? stdin.sessionId;
    const recall = await withBlockServer(config.storagePath, basePath, (server, store, holdoutLoader) =>
      recallForPrompt(
        server,
        store,
        holdoutLoader,
        {
          prompt: queryForRecall,
          basePath,
          sessionId: sessionId ?? null,
          tokenBudget: budget,
        },
        // B1.2: hot-load cascade config per prompt so
        // `tracebase cascade set-rate` takes effect without restart.
        () => readCascadeConfig(basePath),
      ),
    );

    // `hasContent` encodes the full gate chain: query ran, something
    // cleared the gate, something fit the budget. Anything else — no
    // matches, all shadow, everything cut by the budget — lands as
    // "checked · no match" so the user sees the hook ran.
    if (!recall.hasContent) {
      return wrapEnvelope(host, eventName, "", formatStatus({ kind: "no-match" }, recall.signal, statusMode));
    }

    // 0.7.0-rc.6 hardening — derive chunkTurns from contextFoldRanges
    // honestly (sum of inclusive turn counts).
    const chunkTurns = recall.payload.contextFoldRanges.reduce(
      (acc, r) => acc + (r.end - r.start + 1),
      0,
    );
    const situation: InjectSituation = {
      kind: "match",
      queryId: recall.queryId,
      patterns: recall.payload.blockIds.length,
      facts: recall.payload.factIds.length,
      tokens: recall.payload.tokensEstimate,
      files: recall.payload.fileIds.length,
      bytesAvoided: recall.payload.bytesAvoided,
      chunkTurns,
      chunkTokensBefore: recall.payload.contextFoldTokensBefore,
      chunkTokensAfter: recall.payload.contextFoldTokensAfter,
    };
    return wrapEnvelope(host, eventName, recall.payload.text, formatStatus(situation, recall.signal, statusMode));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase inject-context: ${reason}\n`);
    return wrapEnvelope(host, eventName, "", formatStatus({ kind: "failure" }, NO_TOOL_SIGNAL, statusMode));
  }
}

const NO_TOOL_SIGNAL: ToolPatternSignal = { kind: "none", count: 0 };

/**
 * Single source of truth for the inject-side badge. Silent mode hard-
 * suppresses. Composes up to three independent fragments separated
 * by " · ":
 *
 *   - TB TRACE — reasoning-pattern recall result, or `checked · no
 *     match` / `skipped · unavailable` for the corresponding
 *     non-match cases.
 *   - TB MEMORY — fact recall count (only on match with facts > 0).
 *   - TB TOOL / TB LOOP — 0.5.3 detector output for the previous
 *     turn's tool calls. Surfaces even when the prompt was trivial
 *     or recall returned no match, because it warns about the
 *     agent's own behaviour, not the user's prompt.
 *
 * Trivial prompts with no tool signal still suppress entirely —
 * `null` keeps the host's transcript clean for genuine chatter.
 * Uninitialized projects always emit `null` (we can't trust any
 * fragment without a DB).
 *
 * Every emitted badge stays under ~150 characters by construction.
 */
function formatStatus(
  situation: InjectSituation,
  signal: ToolPatternSignal,
  mode: HookStatusMode,
): string | null {
  if (mode === "silent") return null;
  if (situation.kind === "uninitialized") return null;

  const fragments: string[] = [];
  switch (situation.kind) {
    case "match": {
      if (situation.patterns > 0) {
        fragments.push(`▣ TB TRACE  recalled ${situation.patterns} pattern(s)`);
      }
      if (situation.facts > 0) {
        fragments.push(`▣ TB MEMORY  recalled ${situation.facts} fact(s)`);
      }
      // 0.7.0-rc.6 hardening — file memory bullet, separate counter.
      if (situation.files > 0) {
        const kb = Math.round((situation.bytesAvoided ?? 0) / 1024);
        const kbTag = kb > 0 ? ` · ${kb}kb avoided` : "";
        fragments.push(`▣ TB MEMORY  recalled ${situation.files} file(s)${kbTag}`);
      }
      // 0.7.0-rc.6 hardening — TB CONTEXT bullet. Numbers come
      // straight from the persisted chunk rows surfaced via the
      // payload — never invented. Format mirrors the SDK badge:
      //   ▣ TB CONTEXT  folded N turns · Xk→Yk
      if (situation.chunkTurns > 0) {
        const kBefore = Math.round((situation.chunkTokensBefore ?? 0) / 100) / 10;
        const kAfter = Math.round((situation.chunkTokensAfter ?? 0) / 100) / 10;
        fragments.push(
          `▣ TB CONTEXT  folded ${situation.chunkTurns} turns · ${kBefore}k→${kAfter}k`,
        );
      }
      break;
    }
    case "no-match":
      fragments.push("▣ TB TRACE  checked · no match");
      break;
    case "failure":
      fragments.push("▣ TB TRACE  skipped · unavailable");
      break;
    case "trivial":
      // No TB TRACE fragment — but the tool fragment may still fire
      // below for a trivial prompt issued mid-loop.
      break;
  }

  // Tool / loop fragment: composes onto every situation EXCEPT
  // failure (we can't trust a fresh DB read after an exception
  // bubbled out of the recall).
  if (situation.kind !== "failure") {
    const toolFragment = formatToolFragment(signal);
    if (toolFragment) fragments.push(toolFragment);
  }

  if (fragments.length === 0) return null;

  // Tail: queryId + token count, only on a real match. Other
  // situations don't have a queryId to reference.
  const tail =
    situation.kind === "match"
      ? ` · #${situation.queryId.slice(0, 8)} · ${situation.tokens}t`
      : "";
  return fragments.join(" · ") + tail;
}

/**
 * One-line label for a TB TOOL / TB LOOP signal. `straight` and
 * `pingpong` use the louder TB LOOP brand because the agent is
 * actively repeating itself; `duplicate` uses the softer TB TOOL
 * label because the same call merely appeared twice in a window
 * with other work between.
 */
function formatToolFragment(signal: ToolPatternSignal): string | null {
  switch (signal.kind) {
    case "none":
      return null;
    case "straight":
      return signal.toolName
        ? `▣ TB LOOP  straight × ${signal.count} (${signal.toolName})`
        : `▣ TB LOOP  straight × ${signal.count}`;
    case "pingpong":
      return signal.toolName
        ? `▣ TB LOOP  ping-pong (${signal.toolName})`
        : "▣ TB LOOP  ping-pong";
    case "duplicate":
      return signal.toolName
        ? `▣ TB TOOL  repeated ${signal.count}× (${signal.toolName})`
        : `▣ TB TOOL  repeated ${signal.count}×`;
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

/**
 * Explicit integration-supplied focused recall query, if any. Returns the
 * trimmed string or `null`. When present, the caller is asserting an
 * intentional retrieval query (not end-user chatter), so the recall path
 * uses it INSTEAD of the prompt and skips the `MIN_PROMPT_CHARS` length
 * gate. Serving threshold + ranking are unchanged.
 */
function extractRetrievalQuery(stdin: HookStdin): string | null {
  const candidates = [stdin.retrievalQuery, stdin.retrieval_query];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
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
/**
 * Async because the May-2026 B1.2 cascade-rollout path inside
 * `recallForPrompt` is async. Holds the SQLite connection open across
 * the `await` so the cascade reranker can complete before we close.
 *
 * The Claude Code hook is the highest-traffic surface for the cascade
 * rollout — wiring `readCascadeConfig` here is what lets the rollout
 * gate actually fire on production traffic instead of being a
 * library-only knob.
 */
async function withBlockServer<T>(
  storagePath: string,
  basePath: string,
  fn: (
    server: BlockServer,
    store: BlockStore,
    holdoutLoader: HoldoutLoader,
  ) => Promise<T>,
): Promise<T> {
  const db = new Database(storagePath);
  const store = new BlockStore(db);
  try {
    // B1.2: construct the reranker from cascade config so the hook
    // path also routes through the configured cascade. The fail-safe
    // returns NoopReranker on any malformed config.
    const bootCascadeConfig = readCascadeConfig(basePath);
    const reranker = buildRerankerFromCascadeConfig(bootCascadeConfig);
    const cascadeKnobs = extractCascadeKnobs(bootCascadeConfig);
    const server = new BlockServer(store, {
      calibrator: loadBlockCalibrator(store),
      emitEvents: false,
      gateThreshold: resolveProductionGateThreshold(),
      reranker,
      ...cascadeKnobs,
      // Router V2 rollout (TRACEBASE_REASONING_ROUTER=off|shadow|on); default off.
      ...routerServingOptions(),
    });
    const holdoutLoader: HoldoutLoader = () => readHoldoutConfig(basePath);
    return await fn(server, store, holdoutLoader);
  } finally {
    store.close();
  }
}

