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
import {
  indexWorkspace as indexWorkspaceCore,
  recallFiles as recallFilesCore,
} from "../core/file-indexer.js";
import type {
  IndexFilesInput,
  IndexFilesResult,
  RecallFilesInput,
  RecallFilesResult,
} from "../types.js";
import { captureTurnFromTexts } from "../runtime/capture-turn.js";
import { extractDigestFromTurns, sessionScope } from "../runtime/digest.js";
import { createSyncCoordinator, type SyncCoordinator } from "./sync-coordinator.js";
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

  // 0.5.4 §8.8 — auto-sync coordinator. Materialises lazily on
  // first markDirty so a runtime created with `autoSync: false`
  // never holds a timer.
  //
  // 0.5.5 §1: the coordinator now calls into
  // `buildSendInputForWindow` which reads `.tracebase/config.json`
  // + queries the local store. The runtime supplies a
  // `resolveBasePath` callback so the coordinator picks up
  // whichever project the most recent runtime call bound to.
  let syncCoordinator: SyncCoordinator | null = null;
  function getCoordinator(): SyncCoordinator | null {
    if (options.autoSync === false) return null;
    if (!syncCoordinator) {
      syncCoordinator = createSyncCoordinator(layer, options, {
        resolveBasePath: () => connection?.basePath ?? null,
      });
    }
    return syncCoordinator;
  }
  function markDirty(reason: string): void {
    const coord = getCoordinator();
    if (coord) coord.markDirty(reason);
  }

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
    payload: {
      blockIds: string[];
      factIds: string[];
      // 0.7.0-rc.3 — file memory fields. Optional in the type so
      // callers built before rc.3 still compile; the default
      // payload from buildInjectionPayload always sets them.
      fileIds?: string[];
      bytesAvoided?: number;
      tokensEstimate: number;
    },
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
    // 0.7.0-rc.3 §rc.3 — file memory bullet, separate from the
    // facts counter. "Xkb avoided" is rendered into the label;
    // BadgeEvent intentionally has no `bytesAvoided` field so the
    // privacy regression test's keyset stays disjoint from the
    // forbidden surface.
    const fileCount = payload.fileIds?.length ?? 0;
    if (enableMemory && fileCount > 0) {
      const kb = Math.round((payload.bytesAvoided ?? 0) / 1024);
      const kbTag = kb > 0 ? ` · ${kb}kb avoided` : "";
      events.push({
        kind: "memory-files",
        label: `▣ TB MEMORY  recalled ${fileCount} file(s)${kbTag}`,
        count: fileCount,
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
    if (events.length > 0) markDirty("beforeRun");

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
    if (result.recorded > 0) markDirty("observeToolBatch");
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
        // Bound the texts so the heuristic distiller sees inputs
        // within the same caps the CLI hook applies. Leakage
        // scanning happens DOWNSTREAM inside `storeReasoningPattern`
        // (gold-truth scanner) and `BlockStore.storeFact`
        // (extended-leakage scanner) — running it again here would
        // double-reject content the canonical store paths are
        // designed to handle.
        const userBounded = boundField(input.userText, 8000, "userText").value;
        const assistantBounded = boundField(input.assistantText, 8000, "assistantText").value;
        if (userBounded.length === 0 || assistantBounded.length === 0) return;
        const result = captureTurnFromTexts(conn.store, {
          userText: userBounded,
          assistantText: assistantBounded,
        });
        // markDirty so the next coordinator cycle sees the new
        // analytics events even if the user only calls afterRun
        // (no beforeRun / observeToolBatch on this turn).
        if (result.blockId || result.factCount > 0) {
          markDirty("afterRun");
        }
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
    // Drain the coordinator's pending sync attempt too — tests +
    // enterprise shutdown rely on this to confirm the cloud has
    // received the latest aggregates before the process exits.
    if (syncCoordinator) {
      await syncCoordinator.flush();
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await flush();
    if (syncCoordinator) {
      syncCoordinator.close();
      syncCoordinator = null;
    }
    if (connection) {
      try {
        connection.store.close();
      } catch {
        // best-effort
      }
      connection = null;
    }
  }

  // -----------------------------------------------------------------------
  // 0.7.0-rc.3 §rc.3 — file memory SDK surface
  // -----------------------------------------------------------------------

  async function indexFiles(input: IndexFilesInput): Promise<IndexFilesResult> {
    if (closed) throw new Error("runtime closed");
    const basePath = resolveBasePath(input.root);
    if (!basePath) {
      // Mirror the beforeRun shape: missing config returns an
      // empty-shaped result, never throws.
      return {
        indexedCount: 0,
        bytesSummarized: 0,
        durationMs: 0,
        pendingFilesCount: 0,
        pendingDirsCount: 0,
        skipped: {},
        summarizer: input.summarizer ?? "heuristic",
      };
    }
    const conn = ensureConnection(basePath);
    if (!conn) {
      return {
        indexedCount: 0,
        bytesSummarized: 0,
        durationMs: 0,
        pendingFilesCount: 0,
        pendingDirsCount: 0,
        skipped: {},
        summarizer: input.summarizer ?? "heuristic",
      };
    }
    const out = indexWorkspaceCore(conn.store, {
      root: basePath,
      budget: input.budget,
      maxBytes: input.maxBytes,
      summarizer: input.summarizer ?? "heuristic",
    });
    if (out.indexedCount > 0) markDirty("indexFiles");
    return out;
  }

  async function recallFilesMethod(
    input: RecallFilesInput,
  ): Promise<RecallFilesResult> {
    if (closed) throw new Error("runtime closed");
    const basePath = resolveBasePath();
    if (!basePath) return { hits: [] };
    const conn = ensureConnection(basePath);
    if (!conn) return { hits: [] };
    const hits = recallFilesCore(conn.store, {
      prompt: input.prompt,
      k: input.k,
    });
    return { hits };
  }

  return {
    beforeRun,
    observeToolBatch: observe,
    saveContext,
    afterRun,
    indexFiles,
    recallFiles: recallFilesMethod,
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

// `extractDigestFromTurns` moved to `src/runtime/digest.ts` in
// §3a. The SDK runtime imports the canonical implementation now.
