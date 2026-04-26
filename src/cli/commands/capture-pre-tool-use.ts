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

  // Strict ONLY blocks safe-read tools — read + search families.
  const family = toolFamily(toolName);
  const strictAppliesToTool = strictEnabled && (family === "read" || family === "search");

  const labelTool = toolName;
  const warnLabel = `▣ TB TOOL  duplicate ${labelTool} · already in window (×${signal.count})`;

  let blocked = false;
  const envelopePayload: Record<string, unknown> = {};
  if (alreadyWarned) {
    // Suppressed — emit silently, no badge.
    appendAnalyticsEvent(config.storagePath, {
      event: "tool_supervision.suppressed",
      argKey,
      toolName,
    });
  } else {
    appendAnalyticsEvent(config.storagePath, {
      event: "tool_supervision.warned",
      argKey,
      toolName,
      mode: strictAppliesToTool ? "block" : "warn",
    });
    if (strictAppliesToTool) {
      // Spec: Claude Code emits `decision: "block"` with a reason
      // string the host surfaces to the user.
      envelopePayload.decision = "block";
      envelopePayload.reason = warnLabel + " — strict mode blocks duplicate read tools.";
      blocked = true;
    } else {
      envelopePayload.systemMessage = warnLabel;
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
    | { event: "tool_supervision.suppressed"; argKey: string; toolName: string },
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
