/**
 * `tracebase capture-pre-tool-use` — Claude Code `PreToolUse` hook
 * backend (PLAN-0.7 §rc.4).
 *
 * Runs BEFORE a tool call executes. Reads the PreToolUse stdin,
 * sanitises the prospective tool_input down to an allowlisted
 * projection, computes an HMAC bucket id (`arg_key`), appends the
 * synthetic observation to the recent-tool warm cache (NOT to
 * SQLite — real persistence stays at PostToolBatch), and runs the
 * existing duplicate / loop / ping-pong classifier on the
 * prospective tail.
 *
 * Outputs:
 *
 *   - On a duplicate hit (warn mode default), emits a
 *     `systemMessage` line `▣ TB TOOL  duplicate Read · already in
 *     window (×N)` so the operator sees the warning. Hook still
 *     exits 0 — no decision injection.
 *
 *   - On strict mode (`.tracebase/config.json` `toolSupervision.
 *     strict: true` OR `TRACEBASE_TOOL_STRICT=on`), AND the duplicate
 *     is on a safe-read tool (Read / Glob / Grep — i.e. families
 *     `read` + `search`), emits `decision: "block"` with a reason.
 *     Strict NEVER blocks Bash / Edit / Write.
 *
 *   - Cache miss / parse failure / any error → empty envelope. The
 *     hook is fail-open: PreToolUse must never block the agent's
 *     forward progress because of an internal hiccup.
 *
 * Modes:
 *
 *   - Default: warn mode. Emits the systemMessage badge on dup +
 *     emits `tool_supervision.warned` event; subsequent dups on the
 *     same arg_key in the same session emit `tool_supervision.
 *     suppressed` instead (warn-once-per-arg-per-session).
 *
 *   - `--dump-only` (dev): writes parsed stdin to .tracebase/dumps/
 *     pre-tool-use/<ts>.json and exits 0 without reading any state.
 *     The committed golden fixtures (tests/fixtures/pre-tool-use/)
 *     are exactly such dumps from a real Claude Code session.
 *
 *   - `--capture off` / env `TRACEBASE_CAPTURE_TOOL=off`: pure no-op.
 *
 * Privacy invariants:
 *   - NEVER reads the future tool_response (the hook fires BEFORE
 *     the call).
 *   - NEVER stores raw tool_input — same per-tool projection as
 *     PostToolBatch via `sanitizeToolArgs`.
 *   - The warn cache lives at `.tracebase/cache/rtools.bin` —
 *     local-only; the cloud allowlist drops every column.
 */
import { Command } from "commander";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BlockStore } from "../../core/block-store.js";
import {
  findProjectRoot,
  getOrMintWorkspaceSalt,
  isInitialized,
  loadConfig,
} from "../../core/config.js";
import { sanitizeToolArgs } from "../../core/tool-arg.js";
import { detectToolPattern } from "../../core/tool-loop-detect.js";
import { toolFamily } from "../../runtime/tool-family.js";
import { normalizeIntentKey } from "../../core/intent-key.js";
import {
  RecentToolCache,
  type CachedObservation,
} from "../../runtime/recent-tool-cache.js";
import { randomUUID } from "node:crypto";
import type { ToolObservation } from "../../types.js";

// ---------------------------------------------------------------------------
// Hook stdin shape (PreToolUse)
// ---------------------------------------------------------------------------

/**
 * Live `PreToolUse` stdin shape, locked against committed golden
 * dumps under `tests/fixtures/pre-tool-use/`. Single-tool only —
 * unlike PostToolBatch, PreToolUse fires per-call.
 *
 * Notable absences vs PostToolBatch: no `tool_calls[]`, no
 * `tool_response` (this is the BEFORE hook). camelCase variants
 * accepted defensively.
 */
export interface PreToolUseHookStdin {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  transcript_path?: string;
  transcriptPath?: string;
  permission_mode?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: unknown;
  toolInput?: unknown;
  tool_use_id?: string;
  toolUseId?: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PreToolUseMode = "warn" | "off";

export interface RunCapturePreToolUseOptions {
  host?: string;
  path?: string;
  /**
   * `warn` (default) | `off`. Env override:
   * `TRACEBASE_CAPTURE_PRE_TOOL=off|warn` wins. Strict is NOT a
   * mode — it's a config-file-only override that layers on top of
   * `warn`.
   */
  capture?: string;
  /**
   * Dev-only diagnostic. Writes raw stdin to
   * `.tracebase/dumps/pre-tool-use/<ts>.json` and exits 0 without
   * reading any state. NEVER in the canonical installed hook.
   */
  dumpOnly?: boolean;
}

export interface CapturePreToolUseOutcome {
  /** One-line JSON envelope for the host. */
  envelope: string;
  /** True iff the hook detected a duplicate in the warm window. */
  warned: boolean;
  /** True iff the hook actually emitted `decision: "block"`. */
  blocked: boolean;
  /** Pattern signal kind detected (used by tests + telemetry). */
  signalKind: "none" | "duplicate" | "straight" | "pingpong";
  /** True iff the dump-only path wrote a fixture this run. */
  dumped: boolean;
  dumpPath: string | null;
}

const STDIN_BYTE_LIMIT = 256 * 1024;

/**
 * 0.7.1 — block-after-N threshold for the intent-loop counter.
 *
 * `N = 3` semantically-equivalent search invocations in the same
 * session triggers `decision:"block"` on the next attempt. The
 * threshold is intentionally generous: a real agent often tries
 * 2–3 phrasings of a search before pivoting; only the 4th attempt
 * (or beyond) at the same SEMANTIC intent is "stuck in a loop".
 *
 * Strict mode still blocks on the 1st duplicate hit for safe-read
 * families — strict is for regulated workspaces that want zero
 * duplicate-execution latency, not scope-widening hints.
 */
export const INTENT_LOOP_BLOCK_AT = 3;

// ---------------------------------------------------------------------------
// Commander surface
// ---------------------------------------------------------------------------

export const capturePreToolUseCommand = new Command("capture-pre-tool-use")
  .description(
    "Internal: Claude Code PreToolUse hook backend. Reads stdin → sanitises the " +
      "prospective tool_input → runs duplicate/loop/ping-pong detection over the " +
      "warm RecentToolCache → emits a TB TOOL warn line on hit. Strict mode " +
      "(.tracebase/config.json toolSupervision.strict OR TRACEBASE_TOOL_STRICT=on) " +
      "additionally emits decision:'block' for safe-read tools (Read/Glob/Grep).",
  )
  .option("--host <host>", "host shaping the JSON envelope: claude-code (default)", "claude-code")
  .option(
    "--capture <mode>",
    "capture behaviour: warn (default) | off. Env: TRACEBASE_CAPTURE_PRE_TOOL.",
    "warn",
  )
  .option(
    "--dump-only",
    "dev: write raw stdin to .tracebase/dumps/pre-tool-use/<ts>.json and exit 0 (no state reads)",
  )
  .option("-p, --path <path>", "project root override")
  .action(async (opts: RunCapturePreToolUseOptions) => {
    const stdin = readStdinBytes();
    const outcome = runCapturePreToolUse(opts, stdin);
    process.stdout.write(outcome.envelope + "\n");
  });

/**
 * Pure helper. Same "never throws, always emits a parseable envelope"
 * contract as the sibling 0.5.x hook commands.
 */
export function runCapturePreToolUse(
  opts: RunCapturePreToolUseOptions,
  rawStdin: Buffer,
): CapturePreToolUseOutcome {
  // rc.4a — dump-only path runs first. The committed golden fixtures
  // came from this path, and the spec contract is "no state reads".
  if (opts.dumpOnly) {
    return handleDumpOnly(opts, rawStdin);
  }

  const mode = resolveCaptureMode(opts.capture);
  if (mode === "off") return emptyEnvelope();

  let parsed: PreToolUseHookStdin;
  try {
    parsed = parsePreToolUseStdin(rawStdin);
  } catch {
    return emptyEnvelope();
  }

  const toolName = stringField(parsed.tool_name ?? parsed.toolName, "");
  if (!toolName) return emptyEnvelope();

  const basePath = resolveBasePath(opts.path, parsed);
  if (!basePath || !isInitialized(basePath)) return emptyEnvelope();

  const salt = getOrMintWorkspaceSalt(basePath);
  if (!salt) return emptyEnvelope();

  const sessionId = stringField(parsed.session_id ?? parsed.sessionId, "unknown-session");
  const cwd = stringField(parsed.cwd, basePath);

  // rc.4c — synthesise the candidate observation (in-memory only).
  let argKey: string;
  let argSummary: string;
  try {
    const sanitized = sanitizeToolArgs({
      toolName,
      toolInput: parsed.tool_input ?? parsed.toolInput,
      cwd,
      workspaceSalt: salt,
    });
    argKey = sanitized.argKey;
    argSummary = sanitized.argSummary;
  } catch {
    // Any parser hiccup → fail open. The PostToolBatch path is
    // the authoritative observation; a missed PreToolUse warning
    // is recoverable, a crashed agent is not.
    return emptyEnvelope();
  }

  // rc.4b — read ONLY the warm cache. PreToolUse never opens
  // SQLite on the hot path. Cache miss → no-op (fail open).
  const cache = new RecentToolCache();
  cache.hydrate(basePath);
  const synthetic: CachedObservation = {
    sessionId,
    argKey,
    toolName,
    ts: Date.now(),
  };
  // Append the synthetic record to a SHALLOW COPY of the cache —
  // we mustn't persist the prospective observation; PostToolBatch
  // owns persistence after the call actually ran.
  const window = [...cache.recent(sessionId, 6), {
    argKey: synthetic.argKey,
    toolName: synthetic.toolName,
    sessionId: synthetic.sessionId,
    ts: synthetic.ts,
  }];

  const observations: ToolObservation[] = window.map((w) => ({
    id: "synthetic",
    ts: w.ts,
    sessionId: w.sessionId,
    batchId: null,
    batchOrder: 0,
    toolUseId: null,
    toolName: w.toolName,
    argSummary: "",
    argKey: w.argKey,
    outcome: "unknown",
    redundantOf: null,
    createdAt: w.ts,
  }));
  const signal = detectToolPattern(observations);

  if (signal.kind === "none") {
    return {
      envelope: JSON.stringify({}),
      warned: false,
      blocked: false,
      signalKind: "none",
      dumped: false,
      dumpPath: null,
    };
  }

  // Warn-once-per-arg-per-session — record the suppression event
  // when we'd otherwise warn twice on the same argKey.
  const config = loadConfig(basePath);
  const dedupe = readWarnDedupe(config.storagePath);
  const dedupeKey = `${sessionId}::${argKey}`;
  const alreadyWarned = dedupe.has(dedupeKey);

  // rc.4d — strict mode opt-in. Env wins, then config-file.
  const strictEnv = (process.env.TRACEBASE_TOOL_STRICT ?? "").trim().toLowerCase();
  const strictFromEnv = strictEnv === "on" || strictEnv === "1" || strictEnv === "true";
  const strictFromConfig = readStrictConfig(basePath);
  const strictEnabled = strictFromEnv || strictFromConfig;

  // Family classification — drives both the escalation policy
  // (safe-read families get preventive blocks; the rest stay
  // warn-only) and the badge copy.
  const family = toolFamily(toolName);
  const isSafeRead = family === "read" || family === "search";

  // 0.7.1 — intent-key block-after-N for search loops.
  //
  // For search-family tools (Grep / Glob / ripgrep / ag / findstr),
  // count how many semantically-equivalent calls the agent has made
  // in this session. Two calls collapse to the same intentKey if
  // their normalised argSummary matches — `grep "auth_token"` and
  // `rg "auth[_-]token"` both become `search:* auth token` after
  // the regex/flag/quote normalisation.
  //
  // Threshold: INTENT_LOOP_BLOCK_AT (3 by default). Below the
  // threshold, the supervisor still runs the warn/escalation
  // policy below; at or above the threshold, the search family
  // gets an intent-loop block regardless of whether this is the
  // 1st or Nth raw-arg duplicate.
  //
  // intentKey is undefined for non-search families; the count is
  // always 0 for them, so this branch is a no-op outside search.
  const intentKey =
    family === "search" ? normalizeIntentKey(argSummary, toolName) : undefined;
  const priorIntentCount = cache.recentIntentCount(sessionId, intentKey);
  // The synthetic call we're about to greenlight is the
  // (priorIntentCount + 1)th attempt at this intent. Block when
  // that attempt would push past the threshold — the agent has
  // already tried the same SEMANTIC search ≥ N times this session.
  const intentBlock =
    intentKey !== undefined && priorIntentCount + 1 > INTENT_LOOP_BLOCK_AT;

  // 0.9.x — hardened supervision branch.
  //
  // When `toolSupervision.mode` is explicitly set in config or via env
  // (TRACEBASE_TOOL_MODE), the new tier ladder (warn → soft-redirect →
  // hard block) and mtime bypass kick in. Otherwise we fall through
  // to the legacy 0.7.1 policy below to preserve backward compatibility.
  const supervisionMode = resolveSupervisionMode(basePath);
  if (supervisionMode !== null && isSafeRead) {
    // Compute prior matching observations for the same argKey, excluding
    // the synthetic call we're about to greenlight. cache.recent already
    // excludes synthetic (only persisted obs); filter to same argKey.
    const priorMatching = cache
      .recent(sessionId, 6)
      .filter((o) => o.argKey === argKey);
    // mtime check is only meaningful for `read` family on a real path.
    const readPath = (() => {
      const ti = parsed.tool_input ?? parsed.toolInput;
      if (ti && typeof ti === "object" && "file_path" in ti) {
        return (ti as { file_path?: unknown }).file_path;
      }
      return undefined;
    })();
    const mtimeMs = family === "read" ? fileMtimeMs(readPath) : null;
    const tier = applyHardenedTier(
      supervisionMode,
      toolName,
      family,
      priorMatching,
      mtimeMs,
      signal.count,
      isSafeRead
        ? `▣ TB TOOL  reused: ${toolName} already returned this in the last ${signal.count} turn(s) — use the prior output instead`
        : `▣ TB TOOL  repeated ${toolName} · already ran with same args in the last ${signal.count} turn(s) — verify before re-running`,
    );
    // Persist analytics for the new event taxonomy.
    if (tier.allowedAfterEdit) {
      appendAnalyticsEvent(config.storagePath, {
        event: "tool_supervision.allowed_after_edit",
        argKey,
        toolName,
        mode: supervisionMode,
      });
    }
    if (tier.cacheHit) {
      appendAnalyticsEvent(config.storagePath, {
        event: "tool_supervision.cache_hit",
        argKey,
        toolName,
        mode: supervisionMode,
        priorDupCount: priorMatching.length,
      });
    }
    if (tier.wouldBlock && !tier.blocked) {
      appendAnalyticsEvent(config.storagePath, {
        event: "tool_supervision.would_block",
        argKey,
        toolName,
        mode: supervisionMode,
      });
    }
    if (tier.tier !== "free") {
      // Reuse existing canonical warned event so legacy aggregators still work.
      // Per the tier ladder, when `tier.blocked` is false the tier is always
      // "warn" (never "soft" or "block"), so this explicit "warn" cast is
      // sound and matches the canonical `ToolSupervisionWarnedEvent.mode`
      // union ("warn" | "block") in src/types.ts.
      appendAnalyticsEvent(config.storagePath, {
        event: "tool_supervision.warned",
        argKey,
        toolName,
        mode: tier.blocked ? "block" : "warn",
      });
    }
    return {
      envelope: JSON.stringify(tier.envelope),
      warned: tier.tier !== "free",
      blocked: tier.blocked,
      signalKind: signal.kind,
      dumped: false,
      dumpPath: null,
    };
  }

  // 0.7.1 — preventive supervision policy (legacy code path).
  //
  // Pre-0.7.1 default mode warned indefinitely; only the explicit
  // strict opt-in actually changed agent trajectory. Result: most
  // installs saw the badge once and the agent kept doing the same
  // duplicate Read forever.
  //
  // Post-0.7.1 default policy for safe-read families (Read / Grep
  // / Glob etc.):
  //   - 1st duplicate hit (alreadyWarned === false):
  //       emit an actionable "reuse" systemMessage. No block —
  //       give the agent a chance to read its own prior output.
  //   - 2nd+ duplicate hit (alreadyWarned === true):
  //       block via decision:"block". The agent ignored the reuse
  //       hint; we change trajectory ourselves rather than warning
  //       a third time into the void.
  //
  // Strict mode policy is unchanged: it blocks on the FIRST hit
  // for safe-read families. (Use case: regulated workspaces that
  // want zero duplicate-execution latency.)
  //
  // Non-safe-read families (Bash / Edit / Write / Web / Task) are
  // never blocked by default, regardless of repeat count. The
  // duplicate Read story is "you already have this answer in
  // context"; for shell/edit/write, repeated calls are usually
  // the legitimate retry path.
  const strictBlock = strictEnabled && isSafeRead;
  const escalationBlock = !strictEnabled && isSafeRead && alreadyWarned;
  const blocked = strictBlock || escalationBlock || intentBlock;

  const labelTool = toolName;
  // Copy contract (0.7.1): "reused" for the first-hit hint, "blocked
  // duplicate" for the escalated/strict block. Avoid the weak
  // "warning" / "duplicate" verbs when describing safe-read activity
  // — they read as advisory, not actionable.
  const reuseHint = isSafeRead
    ? `▣ TB TOOL  reused: ${labelTool} already returned this in the last ${signal.count} turn(s) — use the prior output instead`
    : `▣ TB TOOL  repeated ${labelTool} · already ran with same args in the last ${signal.count} turn(s) — verify before re-running`;
  // Three block-reason variants. intentBlock dominates the message
  // when it fires because the agent's repeat-search behaviour is
  // a stronger signal than "already flagged once" — the wording
  // tells the agent to widen scope rather than retry.
  const intentAttempts = priorIntentCount + 1;
  const blockReason = intentBlock
    ? `▣ TB LOOP  blocked repeated search · same intent already tried ${intentAttempts} times — widen scope or use the prior matched context`
    : strictBlock
      ? `▣ TB TOOL  blocked duplicate ${labelTool} (strict mode) — read prior ${family} output instead of re-running.`
      : `▣ TB TOOL  blocked duplicate ${labelTool} — already flagged once in this session, escalating to block. Use the prior output or pass different args.`;

  const envelopePayload: Record<string, unknown> = {};

  if (blocked) {
    envelopePayload.decision = "block";
    envelopePayload.reason = blockReason;
  }

  if (alreadyWarned) {
    // Subsequent hit. In default mode for safe-read families, this
    // path now ALSO blocks (escalationBlock above). The dedupe
    // guard still silences badge spam — the block decision is
    // surfaced via envelope.reason.
    //
    // 0.7.0-rc.7 hardening — record `blocked` so mechanism savings
    // only counts events that actually changed agent trajectory.
    appendAnalyticsEvent(config.storagePath, {
      event: "tool_supervision.suppressed",
      argKey,
      toolName,
      blocked,
    });
  } else {
    // First hit. Mode tag reflects whether the supervisor actually
    // changed agent trajectory on this call:
    //   - "block": ANY block kind fired (strict / intent-loop /
    //             escalation can't reach this branch yet because
    //             alreadyWarned must be false here, but strict and
    //             intent-loop both can fire on a first hit)
    //   - "warn":  no block fired — the badge is advisory
    //
    // Mechanism savings reads `mode === "block"` on warned events
    // (rc.7 hardening) so this is the canonical "did we credit
    // an avoided tool call" flag for first-hit events.
    appendAnalyticsEvent(config.storagePath, {
      event: "tool_supervision.warned",
      argKey,
      toolName,
      mode: blocked ? "block" : "warn",
    });
    // Visible badge: surface the reuse/repeat hint when we're NOT
    // already blocking via decision (strict mode already conveys
    // the reason via envelope.reason; doubling channels is noise).
    if (!strictBlock) {
      envelopePayload.systemMessage = reuseHint;
    }
    dedupe.add(dedupeKey);
    writeWarnDedupe(config.storagePath, dedupe);
  }

  // Suppress unused-var noise: argSummary is read here so a future
  // refactor that returns it on the envelope (locally) doesn't
  // break — privacy invariant: argSummary stays local-only.
  void argSummary;

  return {
    envelope: JSON.stringify(envelopePayload),
    warned: !alreadyWarned,
    blocked,
    signalKind: signal.kind,
    dumped: false,
    dumpPath: null,
  };
}

function emptyEnvelope(): CapturePreToolUseOutcome {
  return {
    envelope: JSON.stringify({}),
    warned: false,
    blocked: false,
    signalKind: "none",
    dumped: false,
    dumpPath: null,
  };
}

// ---------------------------------------------------------------------------
// Stdin reading + parser (locked against committed golden fixtures)
// ---------------------------------------------------------------------------

export function readStdinBytes(): Buffer {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(0, { flag: "r" });
    return raw.length > STDIN_BYTE_LIMIT ? raw.subarray(0, STDIN_BYTE_LIMIT) : raw;
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Tolerant parser. Any malformed / oversized / primitive / array
 * input collapses to `{}`. Unknown fields are preserved verbatim
 * so a future Claude Code release that adds a field doesn't crash
 * the hook — the dump-only path captures every byte the host sent.
 */
export function parsePreToolUseStdin(raw: Buffer | string): PreToolUseHookStdin {
  const buf = typeof raw === "string" ? Buffer.from(raw) : raw;
  if (buf.length === 0) return {};
  if (buf.length > STDIN_BYTE_LIMIT) return {};
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PreToolUseHookStdin;
    }
    return {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// rc.4a — dump-only path (writes golden-style fixtures locally)
// ---------------------------------------------------------------------------

function handleDumpOnly(
  opts: RunCapturePreToolUseOptions,
  raw: Buffer,
): CapturePreToolUseOutcome {
  const basePath = opts.path ?? findProjectRoot(process.cwd()) ?? process.cwd();
  let dumpPath: string | null = null;
  try {
    const dir = join(basePath, ".tracebase", "dumps", "pre-tool-use");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    dumpPath = join(dir, `${ts}.json`);
    writeFileSync(dumpPath, raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tracebase capture-pre-tool-use (dump): ${reason}\n`);
    dumpPath = null;
  }
  return {
    envelope: JSON.stringify({}),
    warned: false,
    blocked: false,
    signalKind: "none",
    dumped: dumpPath !== null,
    dumpPath,
  };
}

// ---------------------------------------------------------------------------
// Mode + path resolution
// ---------------------------------------------------------------------------

function resolveCaptureMode(raw: string | undefined): PreToolUseMode {
  const fromEnv = normaliseMode(process.env.TRACEBASE_CAPTURE_PRE_TOOL);
  if (fromEnv) return fromEnv;
  const fromFlag = normaliseMode(raw);
  if (fromFlag) return fromFlag;
  return "warn";
}

function normaliseMode(raw: string | undefined): PreToolUseMode | null {
  const v = raw?.trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "warn") return "warn";
  return null;
}

function resolveBasePath(
  explicit: string | undefined,
  stdin: PreToolUseHookStdin,
): string | null {
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
// rc.4d — strict mode config reader
// ---------------------------------------------------------------------------

function readStrictConfig(basePath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(
      join(basePath, ".tracebase", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { toolSupervision?: { strict?: unknown } };
    return parsed.toolSupervision?.strict === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 0.9.x — hardened supervision: explicit mode + tier ladder + mtime bypass.
//
// New `toolSupervision.mode` field opts in to the hardened semantics WITHOUT
// disturbing the legacy strict/default behavior. Existing installs continue
// to see the 0.7.1 escalation policy (warn 1st → block 2nd; strict blocks
// 1st). New installs that set `toolSupervision.mode = "soft"` (recommended
// for benching) get the 3-tier ladder plus file-mtime bypass.
//
// Resolution precedence: env TRACEBASE_TOOL_MODE > config toolSupervision.mode
// > null (legacy code path).
// ---------------------------------------------------------------------------

export type SupervisionMode = "warn" | "soft" | "strict";

export function resolveSupervisionMode(basePath: string): SupervisionMode | null {
  const envRaw = (process.env.TRACEBASE_TOOL_MODE ?? "").trim().toLowerCase();
  if (envRaw === "warn" || envRaw === "soft" || envRaw === "strict") return envRaw;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(
      join(basePath, ".tracebase", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { toolSupervision?: { mode?: unknown } };
    const m = parsed.toolSupervision?.mode;
    if (m === "warn" || m === "soft" || m === "strict") return m;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Fetch file mtime in milliseconds. Returns null if the file does not exist
 * or the path is not a string we can stat. Used by the mtime-bypass branch
 * to detect a post-edit re-read (legitimate) vs a redundant re-read (waste).
 */
function fileMtimeMs(filePath: unknown): number | null {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const stat = fs.statSync(filePath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

interface HardenedTierResult {
  envelope: Record<string, unknown>;
  blocked: boolean;
  /** True iff we'd block on this call under strict-tier policy (counterfactual). */
  wouldBlock: boolean;
  /** True iff the mtime check fired and we bypassed supervision. */
  allowedAfterEdit: boolean;
  /** True iff the soft-redirect tier served a prior-output reference. */
  cacheHit: boolean;
  tier: "free" | "warn" | "soft" | "block";
}

/**
 * Tier ladder when `toolSupervision.mode` is explicitly set. Returns the
 * envelope payload + event flags. Legacy code path is unchanged.
 *
 * Tier policy (by priorDupCount of matching argKey in session window):
 *   0          → free (first call)
 *   1          → warn  (reuse hint via systemMessage)
 *   2 or 3     → soft-redirect (block with prior-output reference reason)
 *   4 or more  → hard block
 *
 * Mode dispatch:
 *   warn   → all hits degraded to warn; never block, never soft-redirect.
 *   soft   → warn + soft-redirect; the 4+ tier is also degraded to soft.
 *   strict → full ladder (warn → soft → block).
 *
 * mtime bypass: when current file mtime is newer than every prior matching
 * observation's ts, the file was modified between calls. The Read is a
 * legitimate post-edit re-read; supervision steps aside, `allowedAfterEdit`
 * is emitted.
 *
 * Only applies to safe-read families (Read / Glob / Grep). Non-safe-read
 * is handled by the legacy code path.
 */
function applyHardenedTier(
  mode: SupervisionMode,
  toolName: string,
  family: ReturnType<typeof toolFamily>,
  priorMatchingObs: ReadonlyArray<{ ts: number }>,
  fileMtimeMillis: number | null,
  signalCount: number,
  reuseHintCopy: string,
): HardenedTierResult {
  const free: HardenedTierResult = {
    envelope: {},
    blocked: false,
    wouldBlock: false,
    allowedAfterEdit: false,
    cacheHit: false,
    tier: "free",
  };

  const isSafeRead = family === "read" || family === "search";
  if (!isSafeRead) return free; // legacy handles non-safe-read

  const priorDupCount = priorMatchingObs.length;
  if (priorDupCount === 0) return free; // first call

  // mtime bypass: only meaningful for `read` family (Glob/Grep don't bind to
  // a single file). When the current file is newer than the most recent
  // prior matching observation, the Read is a legitimate post-edit re-read.
  if (family === "read" && fileMtimeMillis !== null) {
    const newestPriorTs = Math.max(...priorMatchingObs.map((o) => o.ts));
    if (fileMtimeMillis > newestPriorTs) {
      return { ...free, allowedAfterEdit: true };
    }
  }

  // Counterfactual: would strict mode block?
  const wouldBlock = priorDupCount >= 4;

  if (mode === "warn") {
    return {
      envelope: { systemMessage: reuseHintCopy },
      blocked: false,
      wouldBlock,
      allowedAfterEdit: false,
      cacheHit: false,
      tier: "warn",
    };
  }

  if (priorDupCount === 1) {
    // warn tier in all explicit modes
    return {
      envelope: { systemMessage: reuseHintCopy },
      blocked: false,
      wouldBlock: false,
      allowedAfterEdit: false,
      cacheHit: false,
      tier: "warn",
    };
  }

  if (mode === "soft" || (mode === "strict" && priorDupCount <= 3)) {
    // soft-redirect tier: block with a prior-output-reference reason so the
    // agent treats it as "use what you already have", not as an error.
    const softReason =
      `▣ TB TOOL  ${toolName} already returned this in the last ${signalCount} turn(s) and the file hasn't changed since. ` +
      `Refer to that prior output instead of re-running. (soft-redirect tier — agent should change strategy.)`;
    return {
      envelope: { decision: "block", reason: softReason },
      blocked: true,
      wouldBlock: priorDupCount >= 4,
      allowedAfterEdit: false,
      cacheHit: true,
      tier: "soft",
    };
  }

  // mode === "strict" && priorDupCount >= 4 — hard block tier
  const hardReason =
    `▣ TB TOOL  blocked ${toolName} (strict tier) — same args have been used ${priorDupCount + 1} times this session and the file has not changed. ` +
    `Stop re-running; the prior output is the source of truth.`;
  return {
    envelope: { decision: "block", reason: hardReason },
    blocked: true,
    wouldBlock: true,
    allowedAfterEdit: false,
    cacheHit: false,
    tier: "block",
  };
}

// ---------------------------------------------------------------------------
// Warn-once dedupe
//
// Stored in a tiny SQLite table created on first use so we can
// share a single connection contract with PostToolBatch. The
// PreToolUse path opens this connection lazily (only after a
// duplicate is detected — not on every call) so the warm-path
// p95 stays under the bench gate.
// ---------------------------------------------------------------------------

function readWarnDedupe(storagePath: string): Set<string> {
  const out = new Set<string>();
  try {
    const db = new Database(storagePath);
    try {
      db.exec(
        `CREATE TABLE IF NOT EXISTS tool_warn_dedupe (
           session_id TEXT NOT NULL,
           arg_key    TEXT NOT NULL,
           ts         INTEGER NOT NULL,
           PRIMARY KEY (session_id, arg_key)
         )`,
      );
      const rows = db
        .prepare("SELECT session_id, arg_key FROM tool_warn_dedupe")
        .all() as Array<{ session_id: string; arg_key: string }>;
      for (const r of rows) out.add(`${r.session_id}::${r.arg_key}`);
    } finally {
      db.close();
    }
  } catch {
    // best-effort
  }
  return out;
}

function writeWarnDedupe(storagePath: string, set: Set<string>): void {
  try {
    const db = new Database(storagePath);
    try {
      db.exec(
        `CREATE TABLE IF NOT EXISTS tool_warn_dedupe (
           session_id TEXT NOT NULL,
           arg_key    TEXT NOT NULL,
           ts         INTEGER NOT NULL,
           PRIMARY KEY (session_id, arg_key)
         )`,
      );
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO tool_warn_dedupe(session_id, arg_key, ts) VALUES (?, ?, ?)",
      );
      const tx = db.transaction((entries: string[]) => {
        const now = Date.now();
        for (const e of entries) {
          const [sessionId, argKey] = e.split("::");
          if (sessionId && argKey) stmt.run(sessionId, argKey, now);
        }
      });
      tx([...set]);
    } finally {
      db.close();
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Analytics emit (`tool_supervision.warned` / `tool_supervision.suppressed`)
// ---------------------------------------------------------------------------

function appendAnalyticsEvent(
  storagePath: string,
  payload:
    | { event: "tool_supervision.warned"; argKey: string; toolName: string; mode: "warn" | "block" }
    | { event: "tool_supervision.suppressed"; argKey: string; toolName: string; blocked: boolean }
    | { event: "tool_supervision.allowed_after_edit"; argKey: string; toolName: string; mode: SupervisionMode }
    | { event: "tool_supervision.cache_hit"; argKey: string; toolName: string; mode: SupervisionMode; priorDupCount: number }
    | { event: "tool_supervision.would_block"; argKey: string; toolName: string; mode: SupervisionMode },
): void {
  try {
    const db = new Database(storagePath);
    try {
      const store = new BlockStore(db);
      try {
        store.appendEvent({
          ts: Date.now(),
          queryId: `pre-tool-use-${randomUUID()}`,
          ...payload,
        });
      } finally {
        store.close();
      }
    } catch {
      db.close();
    }
  } catch {
    // best-effort — telemetry must never break the hook
  }
}
