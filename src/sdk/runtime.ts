/**
 * `createRuntime` — framework-neutral SDK surface (PLAN-0.5.4 §3,
 * §8.6). Brings the five capabilities Claude Code gets through hooks
 * (TB TRACE / MEMORY / CONTEXT / TOOL / LOOP) to OpenAI / Anthropic /
 * LangChain / generic / custom hosts via a small in-process API.
 *
 * Lifecycle:
 *   - The SQLite handle and BlockServer are opened lazily on the
 *     first runtime method call that needs them, then reused across
 *     subsequent calls. This is intentional: the SDK runtime is
 *     long-lived (one per process / per agent), unlike the CLI hooks
 *     which open-and-close per spawn.
 *   - `runtime.close()` releases the handle and clears any pending
 *     queues. Idempotent.
 *
 * Privacy invariants enforced (PLAN-0.5.4 §2.2):
 *   - `BadgeEvent` carries counts + labels + queryId only — type
 *     itself excludes prompt/response/tool body fields.
 *   - `observeToolBatch` reuses the per-tool sanitiser; never reads
 *     `tool_response`.
 *   - `saveContext` runs `boundField` + `detectLeakageExtended`
 *     before any digest write.
 *   - `onBadge` callbacks run in `try/catch`; throwing inside the
 *     callback never propagates into the wrapped LLM call.
 *   - No network I/O in any runtime method. Auto-sync (§8.8) runs
 *     on its own debounced timer outside the hot path.
 *
 * Lifecycle constraint (PLAN-0.5.4 §5.1.1):
 *   - The runtime does NOT install global `'exit'` / `'beforeExit'`
 *     / `'SIGINT'` handlers. Durability is explicit:
 *     `runtime.flush()` waits for queued capture jobs, and
 *     `runtime.close()` releases resources.
 */

import Database from "better-sqlite3";
import { BlockStore } from "../core/block-store.js";
import { BlockServer } from "../core/block-serving.js";
import { detectToolPattern, type ToolPatternSignal } from "../core/tool-loop-detect.js";
import {
  findProjectRoot,
  getOrMintWorkspaceSalt,
  isInitialized,
  loadConfig,
  readHoldoutConfig,
} from "../core/config.js";
import { boundField, detectLeakageExtended } from "../core/guard.js";
import { loadBlockCalibrator } from "../lifecycle/calibrator.js";
import {
  recallForPrompt,
  shouldQueryForPrompt,
  type HoldoutLoader,
} from "../runtime/recall.js";
import { observeToolBatch } from "../runtime/observe-tools.js";
import { extractDigest, sessionScope } from "../cli/commands/capture-context.js";
import type { ReasoningLayer } from "../core/engine.js";
import type {
  AfterRunInput,
  BadgeEvent,
  BeforeRunInput,
  BeforeRunResult,
  CreateRuntimeOptions,
  ObserveToolBatchInput,
  ObserveToolBatchResult,
  Runtime,
  RuntimeSource,
  SaveContextInput,
  SaveContextResult,
  StoreProjectFactInput,
} from "../types.js";

// ---------------------------------------------------------------------------
// Private state types
// ---------------------------------------------------------------------------

interface ConnectionBundle {
  db: Database.Database;
  store: BlockStore;
  server: BlockServer;
  basePath: string;
  holdoutLoader: HoldoutLoader;
}

const DIGEST_TTL_DAYS = 14;
const MAX_DIGEST_CHARS = 1200;
const TOOL_WINDOW_DEFAULT = 6;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRuntime(
  layer: ReasoningLayer,
  options: CreateRuntimeOptions = {},
): Runtime {
  // `layer` is accepted on the signature so wrappers can pass the
  // user's existing ReasoningLayer through; today the runtime opens
  // its own SQLite connection rather than borrowing layer's. Future
  // releases may piggyback on layer's TraceStore for cross-tool
  // analytics correlation.
  void layer;

  const defaultSessionId = options.sessionId;
  const defaultProjectPath = options.projectPath;
  const onBadge = options.onBadge;
  const source: RuntimeSource | undefined = options.source;

  const enableTrace = options.enableTrace !== false;
  const enableMemory = options.enableMemory !== false;
  const enableContext = options.enableContext !== false;
  const enableTool = options.enableTool !== false;
  const enableLoop = options.enableLoop !== false;
  const detectorEnabled = enableTool || enableLoop;

  // Auto-sync coordinator integration lands in §8.8. The factory
  // accepts the options now so callers don't need to refactor when
  // it lights up. For 0.5.4-§8.6 these fields are inert.
  void options.autoSync;
  void options.syncDebounceMs;
  void options.syncMaxIntervalMs;

  // Connection cached by basePath so repeated calls against the
  // same project reuse the SQLite handle. Different projectPaths
  // open new handles (rare in practice — one runtime per project).
  let connection: ConnectionBundle | null = null;
  let salt: string | null = null;
  let closed = false;

  const pendingJobs = new Set<Promise<unknown>>();

  function ensureConnection(basePath: string): ConnectionBundle | null {
    if (closed) return null;
    if (!isInitialized(basePath)) return null;
    if (connection && connection.basePath === basePath) return connection;
    if (connection) {
      // basePath changed — close the old handle and reopen. Rare.
      try {
        connection.store.close();
      } catch {
        // best-effort
      }
      connection = null;
    }
    const config = loadConfig(basePath);
    const db = new Database(config.storagePath);
    const store = new BlockStore(db);
    const server = new BlockServer(store, {
      calibrator: loadBlockCalibrator(store),
      emitEvents: false,
      gateThreshold: 0,
    });
    const holdoutLoader: HoldoutLoader = () => readHoldoutConfig(basePath);
    connection = { db, store, server, basePath, holdoutLoader };
    return connection;
  }

  function ensureSalt(basePath: string): string | null {
    if (salt) return salt;
    salt = getOrMintWorkspaceSalt(basePath);
    return salt;
  }

  function resolveBasePath(explicit?: string): string | null {
    if (explicit) return explicit;
    if (defaultProjectPath) return defaultProjectPath;
    return findProjectRoot(process.cwd()) ?? process.cwd();
  }

  function emitBadge(ev: BadgeEvent): void {
    if (!onBadge) return;
    try {
      onBadge(ev);
    } catch (err) {
      // Hard guarantee: a throw inside onBadge must NEVER propagate
      // into the wrapped LLM call. Best-effort log to stderr so
      // callers debugging broken callbacks see something.
      const reason = err instanceof Error ? err.message : String(err);
      try {
        process.stderr.write(`tracebase runtime onBadge: ${reason}\n`);
      } catch {
        // even stderr can fail in some sandboxes — swallow
      }
    }
  }

  function signalToBadgeEvent(
    signal: ToolPatternSignal,
    queryId: string | undefined,
  ): BadgeEvent | null {
    const ts = Date.now();
    const baseSrc = source ? { source } : {};
    if (signal.kind === "straight" && enableLoop) {
      return {
        kind: "loop",
        label: signal.toolName
          ? `▣ TB LOOP  straight × ${signal.count} (${signal.toolName})`
          : `▣ TB LOOP  straight × ${signal.count}`,
        count: signal.count,
        ...(signal.toolName ? { toolName: signal.toolName } : {}),
        ...(queryId ? { queryId } : {}),
        ts,
        ...baseSrc,
      };
    }
    if (signal.kind === "pingpong" && enableLoop) {
      return {
        kind: "loop",
        label: signal.toolName
          ? `▣ TB LOOP  ping-pong (${signal.toolName})`
          : "▣ TB LOOP  ping-pong",
        count: signal.count,
        ...(signal.toolName ? { toolName: signal.toolName } : {}),
        ...(queryId ? { queryId } : {}),
        ts,
        ...baseSrc,
      };
    }
    if (signal.kind === "duplicate" && enableTool) {
      return {
        kind: "tool",
        label: signal.toolName
          ? `▣ TB TOOL  repeated ${signal.count}× (${signal.toolName})`
          : `▣ TB TOOL  repeated ${signal.count}×`,
        count: signal.count,
        ...(signal.toolName ? { toolName: signal.toolName } : {}),
        ...(queryId ? { queryId } : {}),
        ts,
        ...baseSrc,
      };
    }
    return null;
  }

  function recallToBadgeEvents(
    payload: { blockIds: string[]; factIds: string[]; tokensEstimate: number },
    queryId: string,
  ): BadgeEvent[] {
    const events: BadgeEvent[] = [];
    const ts = Date.now();
    const baseSrc = source ? { source } : {};
    if (enableTrace && payload.blockIds.length > 0) {
      events.push({
        kind: "trace",
        label: `▣ TB TRACE  recalled ${payload.blockIds.length} pattern(s)`,
        count: payload.blockIds.length,
        queryId,
        tokens: payload.tokensEstimate,
        ts,
        ...baseSrc,
      });
    }
    if (enableMemory && payload.factIds.length > 0) {
      events.push({
        kind: "memory",
        label: `▣ TB MEMORY  recalled ${payload.factIds.length} fact(s)`,
        count: payload.factIds.length,
        queryId,
        ts,
        ...baseSrc,
      });
    }
    return events;
  }

  // -----------------------------------------------------------------------
  // beforeRun
  // -----------------------------------------------------------------------

  async function beforeRun(input: BeforeRunInput): Promise<BeforeRunResult> {
    if (closed) throw new Error("runtime closed");
    const prompt = input.prompt ?? "";
    const sessionId = input.sessionId ?? defaultSessionId ?? null;
    const basePath = resolveBasePath(input.projectPath);

    if (!basePath) {
      return { additionalContext: "", badgeEvents: [] };
    }

    const conn = ensureConnection(basePath);
    if (!conn) {
      return { additionalContext: "", badgeEvents: [] };
    }

    // Trivial-prompt early return — but still run the loop detector
    // when a session is known and detection is enabled. The loop
    // signal is independent of prompt content, so a chatty user
    // shouldn't suppress the safety warning.
    if (!shouldQueryForPrompt(prompt)) {
      if (sessionId && detectorEnabled) {
        try {
          const recent = conn.store.recentToolObservations(sessionId, TOOL_WINDOW_DEFAULT);
          const signal = detectToolPattern(recent);
          const ev = signalToBadgeEvent(signal, undefined);
          if (ev) {
            emitBadge(ev);
            return { additionalContext: "", badgeEvents: [ev] };
          }
        } catch {
          // detector failure non-load-bearing
        }
      }
      return { additionalContext: "", badgeEvents: [] };
    }

    const recall = recallForPrompt(conn.server, conn.store, conn.holdoutLoader, {
      prompt,
      basePath,
      sessionId,
      enableToolDetection: detectorEnabled,
    });

    const events: BadgeEvent[] = [];
    if (recall.hasContent) {
      events.push(...recallToBadgeEvents(recall.payload, recall.queryId));
    }
    const toolEvent = signalToBadgeEvent(recall.signal, recall.queryId);
    if (toolEvent) events.push(toolEvent);

    for (const ev of events) emitBadge(ev);

    return {
      additionalContext: recall.hasContent ? recall.payload.text : "",
      badgeEvents: events,
      ...(recall.hasContent ? { queryId: recall.queryId } : {}),
    };
  }

  // -----------------------------------------------------------------------
  // observeToolBatch
  // -----------------------------------------------------------------------

  async function observe(
    input: ObserveToolBatchInput,
  ): Promise<ObserveToolBatchResult> {
    if (closed) throw new Error("runtime closed");
    if (!enableTool && !enableLoop) {
      // Tool capability fully disabled — short-circuit.
      return { recorded: 0 };
    }
    const basePath = resolveBasePath(input.projectPath);
    if (!basePath) return { recorded: 0 };
    const conn = ensureConnection(basePath);
    if (!conn) return { recorded: 0 };
    const workspaceSalt = ensureSalt(basePath);
    if (!workspaceSalt) return { recorded: 0 };

    const cwd = input.projectPath ?? basePath;
    const result = observeToolBatch(conn.store, {
      sessionId: input.sessionId,
      cwd,
      workspaceSalt,
      toolCalls: input.toolCalls,
    });
    return { recorded: result.recorded };
  }

  // -----------------------------------------------------------------------
  // saveContext
  // -----------------------------------------------------------------------

  async function saveContext(input: SaveContextInput): Promise<SaveContextResult> {
    if (closed) throw new Error("runtime closed");
    if (!enableContext) return { factId: null };
    const basePath = resolveBasePath(input.projectPath);
    if (!basePath) return { factId: null };
    const conn = ensureConnection(basePath);
    if (!conn) return { factId: null };

    const digest = resolveDigest(input);
    if (!digest) return { factId: null };

    try {
      const factInput: StoreProjectFactInput = {
        scope: sessionScope(input.sessionId),
        factType: "session_digest",
        statement: digest,
        invariants: {},
        source: { origin: "observed", reference: input.sessionId },
        ttlDays: DIGEST_TTL_DAYS,
      };
      const fact = conn.store.storeFact(factInput);
      return { factId: fact.id };
    } catch (err) {
      // storeFact rejects on dedupe-key collision (already stored).
      // Treat as no-op rather than throwing — the same digest
      // already lives in the store.
      void err;
      return { factId: null };
    }
  }

  // -----------------------------------------------------------------------
  // afterRun (queued, best-effort)
  // -----------------------------------------------------------------------
  //
  // 0.5.4-§8.6 ships afterRun as a queued no-op that returns
  // immediately to the caller and does the bookkeeping under the
  // queue. Block distillation lands in §8.5 (deferred to 0.5.5 if
  // 0.5.4 grows large) — that phase will move the canonical
  // capture-turn distiller into `src/runtime/capture-turn.ts` and
  // wire it here.
  //
  // The queue + flush() path is in place TODAY so:
  //   1. SDK consumers can call afterRun freely without blocking
  //      the LLM response;
  //   2. tests can use flush() to wait for any future async work;
  //   3. wiring §8.5's distiller in becomes a one-line change.

  async function afterRun(input: AfterRunInput): Promise<void> {
    if (closed) throw new Error("runtime closed");
    const basePath = resolveBasePath(input.projectPath);
    if (!basePath) return;
    const conn = ensureConnection(basePath);
    if (!conn) return;

    const job = (async () => {
      try {
        // Bound + leakage-scan the texts so a forgotten direct
        // store write (today, none; tomorrow, after §8.5) sees
        // already-bounded inputs.
        const userBounded = boundField(input.userText, 8000, "userText").value;
        const assistantBounded = boundField(input.assistantText, 8000, "assistantText").value;
        if (
          userBounded.length === 0 ||
          assistantBounded.length === 0 ||
          detectLeakageExtended(userBounded) ||
          detectLeakageExtended(assistantBounded)
        ) {
          return;
        }
        // §8.5 will add: distill candidate, validate, store via the
        // BlockStore + analytics_events path. For now we exit
        // cleanly so the runtime contract stands.
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
          process.stderr.write(`tracebase runtime afterRun: ${reason}\n`);
        } catch {
          // swallow
        }
      }
    })();
    pendingJobs.add(job);
    job.finally(() => pendingJobs.delete(job));
  }

  // -----------------------------------------------------------------------
  // flush + close
  // -----------------------------------------------------------------------

  async function flush(): Promise<void> {
    while (pendingJobs.size > 0) {
      await Promise.allSettled(Array.from(pendingJobs));
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await flush();
    if (connection) {
      try {
        connection.store.close();
      } catch {
        // best-effort
      }
      connection = null;
    }
  }

  return {
    beforeRun,
    observeToolBatch: observe,
    saveContext,
    afterRun,
    flush,
    close,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveDigest(input: SaveContextInput): string | null {
  // Caller-supplied digest takes precedence — the runtime trusts
  // the caller's extraction but still bounds + leakage-scans the
  // result before persisting.
  if (typeof input.digest === "string" && input.digest.trim().length > 0) {
    const bounded = boundField(input.digest, MAX_DIGEST_CHARS, "digest").value;
    if (bounded.length < 40) return null;
    if (detectLeakageExtended(bounded)) return null;
    return bounded;
  }
  if (Array.isArray(input.turns) && input.turns.length > 0) {
    return extractDigestFromTurns(input.turns);
  }
  return null;
}

/**
 * Bridge between the SDK's `{ role, content }[]` shape and the
 * `extractDigest` helper that already lives on capture-context and
 * expects a JSONL transcript. Reuses the canonical digest extractor
 * verbatim so SDK-derived digests look identical to PreCompact-derived
 * ones — same rules, same bounds, same leakage scan.
 */
function extractDigestFromTurns(
  turns: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): string | null {
  const lines: string[] = [];
  for (const t of turns) {
    if (typeof t.content !== "string" || t.content.length === 0) continue;
    if (t.role === "user") {
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: t.content } }));
    } else if (t.role === "assistant") {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: t.content }],
          },
        }),
      );
    }
  }
  if (lines.length === 0) return null;
  return extractDigest(lines.join("\n"));
}
