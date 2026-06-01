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
import { randomUUID } from "node:crypto";
import { BlockStore } from "../core/block-store.js";
import { BlockServer, resolveProductionGateThreshold } from "../core/block-serving.js";
import { detectToolPattern, type ToolPatternSignal } from "../core/tool-loop-detect.js";
import {
  findProjectRoot,
  getOrMintWorkspaceSalt,
  isInitialized,
  loadConfig,
  readCascadeConfig,
  readHoldoutConfig,
} from "../core/config.js";
import { boundField, detectLeakageExtended } from "../core/guard.js";
import { loadBlockCalibrator } from "../lifecycle/calibrator.js";
import {
  buildRerankerFromCascadeConfig,
  extractCascadeKnobs,
} from "../experiments/cascade-rollout.js";
import { routerServingOptions } from "../experiments/reasoning-router-rollout.js";
import { reasoningRetrievalOptions } from "../experiments/reasoning-retrieval-rollout.js";
import { reasoningEvidenceOptions } from "../experiments/reasoning-evidence-rollout.js";
import { reasoningQueryCompilerOptions } from "../experiments/reasoning-query-compiler-rollout.js";
import {
  recallForPrompt,
  shouldQueryForPrompt,
  type CascadeLoader,
  type HoldoutLoader,
} from "../runtime/recall.js";
import { observeToolBatch } from "../runtime/observe-tools.js";
import {
  indexWorkspace as indexWorkspaceCore,
  recallFiles as recallFilesCore,
} from "../core/file-indexer.js";
import { foldTurns as foldTurnsCore } from "../core/context-fold.js";
import type {
  IndexFilesInput,
  IndexFilesResult,
  RecallFilesInput,
  RecallFilesResult,
  FoldContextInput,
  FoldContextResult,
  RecallChunksInput,
  RecallChunksResult,
} from "../types.js";
import { captureTurnFromTexts } from "../runtime/capture-turn.js";
import {
  applyInferenceAndEmit,
  inferResolvedOutcomeFromTranscript,
} from "../runtime/attribution-inference.js";
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
  /** B1.2: hot cascade-config loader for the rollout gate. */
  cascadeLoader: CascadeLoader;
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

  const defaultSessionId = options.sessionId?.trim() || randomUUID();
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
    // B1.2: construct reranker from cascade config at connection
    // setup. Reranker kind is process-lifetime; rate/lambda/timeout
    // are hot via the loader below.
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
      // Phase C hybrid retrieval rollout (TRACEBASE_REASONING_RETRIEVAL=off|shadow|on); default off.
      ...reasoningRetrievalOptions(),
      // Phase C.2 ServingEvidenceV3 rollout (TRACEBASE_REASONING_EVIDENCE=off|shadow); default off.
      ...reasoningEvidenceOptions(),
      // Phase D.1 two-view query-compiler rollout (TRACEBASE_REASONING_QUERY_COMPILER=off|shadow); default off.
      ...reasoningQueryCompilerOptions(),
    });
    const holdoutLoader: HoldoutLoader = () => readHoldoutConfig(basePath);
    const cascadeLoader: CascadeLoader = () => readCascadeConfig(basePath);
    connection = { db, store, server, basePath, holdoutLoader, cascadeLoader };
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
    redirectLabel?: string,
  ): BadgeEvent | null {
    const ts = Date.now();
    const baseSrc = source ? { source } : {};
    // 0.7.0-rc.5 §rc.5 — when the resolver returned a label,
    // surface it as the loop badge text. The resolver already
    // produced "matched #<id> · <hint>" or
    // "repeated <pattern> · widen scope", clamped at 100 chars
    // and content-audited. The legacy literal-format branches
    // below stay as fallbacks when the resolver wasn't available
    // (e.g. the SDK runtime's loop-only path before recall).
    if (signal.kind === "straight" && enableLoop) {
      return {
        kind: "loop",
        label:
          redirectLabel ??
          (signal.toolName
            ? `▣ TB LOOP  straight × ${signal.count} (${signal.toolName})`
            : `▣ TB LOOP  straight × ${signal.count}`),
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
        label:
          redirectLabel ??
          (signal.toolName
            ? `▣ TB LOOP  ping-pong (${signal.toolName})`
            : "▣ TB LOOP  ping-pong"),
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
      // 0.7.0-rc.6 — context fold fields. Same back-compat shape.
      contextFoldRanges?: Array<{ start: number; end: number }>;
      contextFoldTokensBefore?: number;
      contextFoldTokensAfter?: number;
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
    // 0.7.0-rc.6 §rc.6 — TB CONTEXT folded badge. Numbers come
    // straight from the persisted chunk rows surfaced in the
    // payload — never invented. Format:
    //   ▣ TB CONTEXT  folded N turns · Xk→Yk
    // Where N = sum of (chunk_end_turn - chunk_start_turn + 1)
    // across the rendered ranges, and X/Y are the
    // tokens_before/tokens_after sums in thousands (rounded).
    const ranges = payload.contextFoldRanges ?? [];
    if (enableContext && ranges.length > 0) {
      const turnsFolded = ranges.reduce(
        (acc, r) => acc + (r.end - r.start + 1),
        0,
      );
      const kBefore = Math.round((payload.contextFoldTokensBefore ?? 0) / 100) / 10;
      const kAfter = Math.round((payload.contextFoldTokensAfter ?? 0) / 100) / 10;
      events.push({
        kind: "context",
        label: `▣ TB CONTEXT  folded ${turnsFolded} turns · ${kBefore}k→${kAfter}k`,
        count: turnsFolded,
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

    // B1.2: recallForPrompt is async (the cascade rollout decision can
    // route the query through recallAsync). beforeRun is already async,
    // so just await. cascadeLoader hot-loads the rollout knob per call.
    const recall = await recallForPrompt(
      conn.server,
      conn.store,
      conn.holdoutLoader,
      {
        prompt,
        basePath,
        sessionId,
        enableToolDetection: detectorEnabled,
        servingProfile: input.servingProfile ?? options.servingProfile,
      },
      conn.cascadeLoader,
    );

    const events: BadgeEvent[] = [];
    if (recall.hasContent) {
      events.push(...recallToBadgeEvents(recall.payload, recall.queryId));
    }
    const toolEvent = signalToBadgeEvent(
      recall.signal,
      recall.queryId,
      recall.loopRedirect?.label,
    );
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
      // 0.7.0-rc.4 hardening — warm the PreToolUse cache. Same
      // wiring as the CLI hook in capture-tool-use.ts; without
      // this the SDK runtime path would also leave PreToolUse
      // permanently cache-missing.
      workspacePath: basePath,
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
        const sessionId = input.sessionId ?? defaultSessionId ?? undefined;
        // R1 — thread sessionId as runId so `capture.error` events
        // emitted from inside `captureTurnFromTexts` correlate with
        // the matching retrieval/injection events from beforeRun.
        const result = captureTurnFromTexts(
          conn.store,
          { userText: userBounded, assistantText: assistantBounded },
          sessionId ? { runId: sessionId } : {},
        );
        const attribution = applyInferenceAndEmit(conn.store, assistantBounded, {
          ...(sessionId ? { runId: sessionId } : {}),
          allowOutcomeEmission:
            result.blockId !== null ||
            inferResolvedOutcomeFromTranscript(assistantBounded),
        });
        // markDirty so the next coordinator cycle sees the new
        // analytics events even if the user only calls afterRun
        // (no beforeRun / observeToolBatch on this turn).
        if (
          result.blockId ||
          result.factCount > 0 ||
          attribution.agentUsedEmitted > 0 ||
          attribution.outcomeEmitted > 0
        ) {
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

  // -----------------------------------------------------------------------
  // 0.7.0-rc.6 §rc.6 — context fold SDK surface
  // -----------------------------------------------------------------------

  async function foldContext(input: FoldContextInput): Promise<FoldContextResult> {
    if (closed) throw new Error("runtime closed");
    const basePath = resolveBasePath();
    if (!basePath) {
      return { chunkCount: 0, tokensBefore: 0, tokensAfter: 0, skipped: {} };
    }
    const conn = ensureConnection(basePath);
    if (!conn) {
      return { chunkCount: 0, tokensBefore: 0, tokensAfter: 0, skipped: {} };
    }
    const watermark = conn.store.latestSessionChunkWatermark(input.sessionId);
    const folded = foldTurnsCore({
      sessionId: input.sessionId,
      turns: input.turns,
      existingWatermark: watermark,
    });
    const inserted = conn.store.recordSessionChunks(folded.chunks);
    const skipped: Record<string, number> = {};
    for (const s of folded.skipped) {
      skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
      try {
        conn.store.appendEvent({
          ts: Date.now(),
          queryId: `context-fold-skip-${s.sessionId}-${s.chunkStartTurn}`,
          event: "context.fold_skipped",
          reason: s.reason,
        });
      } catch {
        // best-effort
      }
    }
    if (inserted > 0) markDirty("foldContext");
    return {
      chunkCount: inserted,
      tokensBefore: folded.chunks.reduce((acc, c) => acc + c.tokensBefore, 0),
      tokensAfter: folded.chunks.reduce((acc, c) => acc + c.tokensAfter, 0),
      skipped,
    };
  }

  async function recallChunks(input: RecallChunksInput): Promise<RecallChunksResult> {
    if (closed) throw new Error("runtime closed");
    const basePath = resolveBasePath();
    if (!basePath) return { hits: [] };
    const conn = ensureConnection(basePath);
    if (!conn) return { hits: [] };
    const hits = conn.store.recallSessionChunks(input.sessionId, input.k ?? 3);
    return { hits };
  }

  return {
    beforeRun,
    observeToolBatch: observe,
    saveContext,
    afterRun,
    indexFiles,
    recallFiles: recallFilesMethod,
    foldContext,
    recallChunks,
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
