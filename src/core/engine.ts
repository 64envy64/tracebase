import { randomUUID } from "node:crypto";
import type {
  TraceBaseConfig,
  TraceBaseEvent,
  RecallQuery,
  RecallResult,
  ReasoningTrace,
  StoreTraceInput,
  StorageStats,
  EventHandler,
  EmbeddingProvider,
  SimilaritySignals,
} from "../types.js";
import { TraceStore } from "./store.js";
import { BlockStore } from "./block-store.js";
import { fingerprint } from "./fingerprint.js";
import { recallWithAllCandidates, cosineSimilarity } from "./similarity.js";
import { loadConfig, findConfigDir, initConfig, resolveProjectBase } from "./config.js";
import {
  loadWeightState,
  computeWeightsMean,
  seededRng,
  type SignalWeights,
} from "./weights.js";
import {
  bucketKeyFor,
  loadContextualBandit,
  sampleContextualWeights,
  updateContextualWeights,
  type BucketContext,
} from "./contextual-bandit.js";
import {
  emitTraceRetrieval,
  emitTraceAgentUsed,
  emitTraceFeedback,
  type TraceRetrievalCandidate,
} from "./analytics.js";

// ============================================================================
// ReasoningLayer — The main public API
//
// Usage:
//   const layer = new ReasoningLayer();
//   const layer = new ReasoningLayer({ storagePath: '...' });
//
//   layer.storeTrace({ problem: {...}, solution: {...} });
//   const results = layer.recall({ problem: "..." });
//   layer.feedback(results[0].trace.id, true);
//   layer.close();
//
// Key design decisions:
//   - recall() does NOT increment recallCount (only feedback() does)
//     to avoid double-counting. Ref: audit issue E2.
//   - storeTrace() checks for near-duplicates via fingerprint.
//   - enforceLimit() uses age-based deletion as fallback when
//     quality-based pruning is insufficient. Ref: audit issue E1.
//   - Adaptive weights are loaded from DB and passed to similarity engine.
//   - Event handlers are wrapped in try/catch to prevent user errors
//     from breaking core operations.
// ============================================================================

/**
 * Thrown by `ReasoningLayer.enforceLimit()` when the post-prune count
 * still exceeds `maxTraces`. Indicates a bug in the prune path
 * (silent SQLite write failure, custom store impl that won't delete)
 * rather than a normal operational condition — fail loudly so callers
 * notice instead of silently growing the DB unbounded. Audit issue #7.
 */
export class EnforceLimitOvershootError extends Error {
  readonly max: number;
  readonly finalCount: number;
  readonly startCount: number;
  constructor(max: number, finalCount: number, startCount: number) {
    super(
      `EnforceLimitOvershootError: post-prune count ${finalCount} still exceeds maxTraces ${max} (was ${startCount}). ` +
        `Pruning did not free enough rows — investigate the TraceStore.prune implementation.`,
    );
    this.name = "EnforceLimitOvershootError";
    this.max = max;
    this.finalCount = finalCount;
    this.startCount = startCount;
  }
}

export class ReasoningLayer {
  private store: TraceStore;
  /**
   * Shared event-log store. Constructed from `TraceStore.rawDb` so V1 and
   * V2 events land in the same `analytics_events` table — see
   * `block-store.ts:11-13` for the explicit coexistence contract.
   *
   * Replaces the pre-May-2026 in-memory `recallSignalCache`: persistent,
   * survives process restart, supports unbounded feedback horizons, and
   * lets the same `(queryId, traceId)` dedup logic the block calibrator
   * already uses (`lifecycle/calibrator.ts:75`) apply to V1 weight
   * updates.
   */
  private blockStore: BlockStore;
  private _config: TraceBaseConfig;
  private listeners: Map<string, Set<EventHandler>> = new Map();
  private _embeddingProvider?: EmbeddingProvider;
  private closed = false;

  /**
   * Lookback window when resolving the legacy `feedback(traceId, helpful)`
   * path. The V1 contract has no queryId, so we look for the most recent
   * `trace_retrieval` event whose `selectedTraceIds` contains the target.
   * If more than one is found within this window without a matching
   * `trace_feedback`, the call is *ambiguous* — we record the feedback
   * with `ambiguous: true`, update quality, but DO NOT update weights.
   *
   * 60 minutes is long enough to cover a typical Claude Code session
   * (multi-step debugging) but short enough that two unrelated recalls
   * from different sessions don't collide. Callers that need exact
   * attribution should use the new `feedback({queryId, traceId, helpful})`
   * form.
   */
  private static readonly LEGACY_FEEDBACK_LOOKBACK_MS = 60 * 60 * 1000;

  constructor(config?: Partial<TraceBaseConfig>) {
    // Auto-init: if no .tracebase/ exists and no explicit path given,
    // silently create it. Zero friction — first `new ReasoningLayer()`
    // just works without requiring `tracebase init` first.
    if (!config?.storagePath && !findConfigDir()) {
      initConfig(resolveProjectBase(process.cwd()));
    }

    const resolved = loadConfig();
    this._config = { ...resolved, ...config };
    this.store = new TraceStore(this._config.storagePath);
    // Share the TraceStore's better-sqlite3 handle so V1 and V2 see the
    // same `analytics_events` table without two open connections. The
    // BlockStore's migration is idempotent and cheap when the V2 schema
    // is already in place.
    this.blockStore = new BlockStore(this.store.rawDb);
  }

  /** Read-only access to engine configuration (used by middleware). */
  get config(): Readonly<TraceBaseConfig> {
    return this._config;
  }

  // --------------------------------------------------------------------------
  // Core API
  // --------------------------------------------------------------------------

  /**
   * Store a new reasoning trace.
   * Computes fingerprint + caches tokens/features automatically.
   * Deduplicates: if a trace with the same fingerprint exists, returns
   * the existing trace and emits trace:deduplicated instead.
   */
  storeTrace(input: StoreTraceInput): ReasoningTrace {
    this.ensureOpen();

    // Validate outcome at runtime (guards against untyped JSON input)
    const validOutcomes = new Set(["success", "failure", "partial"]);
    if (!validOutcomes.has(input.solution.outcome)) {
      throw new Error(
        `Invalid outcome "${input.solution.outcome}". Must be "success", "failure", or "partial".`,
      );
    }

    // Compute fingerprint (also produces tokens + features for caching)
    const fp = fingerprint(
      input.problem.description,
      {
        filePath: input.problem.filePath,
        language: input.problem.language,
        framework: input.problem.framework,
        errorType: input.problem.errorType,
      },
      this._config.features,
    );

    // Near-duplicate detection: same fingerprint = same problem
    const existingId = this.store.existsByFingerprint(fp.hash);
    if (existingId) {
      const existing = this.store.getById(existingId);
      if (existing) {
        this.emit({
          type: "trace:deduplicated",
          existingId,
          newFingerprint: fp.hash,
        });
        return existing;
      }
    }

    const now = Date.now();
    const trace: ReasoningTrace = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      problem: {
        ...input.problem,
        fingerprint: fp.hash,
      },
      solution: input.solution,
      metadata: {
        agent: input.metadata?.agent ?? "unknown",
        model: input.metadata?.model,
        tokensUsed: input.metadata?.tokensUsed,
        durationMs: input.metadata?.durationMs,
        source: input.metadata?.source ?? "sdk",
        custom: input.metadata?.custom,
      },
      quality: {
        recallCount: 0,
        helpfulCount: 0,
        score: 0.5,
      },
      provenance: {
        origin: "local",
        author: input.metadata?.agent ?? "unknown",
        appliedCount: 0,
      },
    };

    // Store with cached tokens + features for fast recall later
    this.store.store(trace, fp.tokens, fp.features as unknown as Record<string, unknown>);

    // Enforce max traces limit
    if (this._config.maxTraces && this._config.maxTraces > 0) {
      this.enforceLimit();
    }

    this.emit({ type: "trace:stored", trace });
    return trace;
  }

  /**
   * Recall relevant past solutions for a given problem.
   *
   * NOTE: This does NOT modify recall counts. Only feedback() does.
   * This avoids the double-counting bug (recall + feedback both incrementing).
   *
   * Persistent attribution: emits a `trace_retrieval` event so a later
   * `feedback()` call can correlate signals → weight update without
   * keeping in-memory state. The event log survives process restart and
   * has no TTL; the legacy `feedback(traceId)` form falls back to a
   * 60-minute lookback for ambiguity detection.
   */
  recall(query: RecallQuery): RecallResult[] {
    this.ensureOpen();

    // May-2026 B2 — sample weights from the contextual bandit. The
    // hierarchical empirical-Bayes layer collapses to the global
    // posterior for unseen buckets, so existing test fixtures see
    // identical behaviour; per-context divergence only emerges once
    // bucket-local feedback accumulates. The seed is the public
    // correlation point — log it so off-policy screening can replay
    // the exact draw later.
    const { weights, seed, bucketKey } = this.drawWeights(
      this.contextFor(query),
      /*hasEmbeddings*/ false,
    );

    const { results, allCandidates } = recallWithAllCandidates(
      this.store,
      query,
      weights,
      undefined,
      this._config.similarity,
      this._config.features,
    );

    const queryId = this.recordTraceRetrieval(
      query,
      results,
      allCandidates,
      weights,
      /*hasEmbeddings*/ false,
      seed,
      bucketKey,
    );
    const stamped = results.map((r) => ({ ...r, queryId }));
    this.emit({ type: "trace:recalled", query, results: stamped });
    return stamped;
  }

  /**
   * Store a trace and compute embeddings (async).
   * Same as storeTrace() but also computes + stores vector embeddings
   * when an embedding provider is configured.
   *
   * May-2026 PR 3 (audit #1): embedding failures are no longer silently
   * swallowed. Each failure:
   *   1. Enqueues the trace into `pending_embeddings` for retry.
   *   2. Emits an `embedding:failed` event so observers / `doctor` can
   *      surface the failure rate.
   * On each successful async store, we also opportunistically drain a
   * small batch from the pending queue — cheap, bounded, self-healing.
   * `doctor --fix` forces a full synchronous drain.
   */
  async storeTraceAsync(input: StoreTraceInput): Promise<ReasoningTrace> {
    const trace = this.storeTrace(input);

    if (this._embeddingProvider) {
      try {
        const embeddings = await this._embeddingProvider.embedBatch([
          input.problem.description,
          input.solution.summary,
        ]);
        if (embeddings.length === 2) {
          this.store.storeEmbeddings(trace.id, embeddings[0]!, embeddings[1]!);
        } else {
          this.store.enqueuePendingEmbedding(
            trace.id,
            `embedBatch returned ${embeddings.length} vectors, expected 2`,
          );
          this.emit({
            type: "embedding:failed",
            traceId: trace.id,
            error: `embedBatch returned ${embeddings.length} vectors, expected 2`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.store.enqueuePendingEmbedding(trace.id, message);
        this.emit({
          type: "embedding:failed",
          traceId: trace.id,
          error: message,
        });
      }

      // Opportunistic drain — bounded so a long backlog can't make a
      // single store() call O(N). `doctor --fix` exists for full drains.
      await this.drainPendingEmbeddings(/*maxBatch*/ 8);
    }

    return trace;
  }

  /**
   * Drain up to `maxBatch` pending embedding rows. Each row that
   * re-embeds successfully is removed; failures bump the attempt counter
   * so subsequent runs can back off (or `doctor` can surface stuck rows).
   *
   * Returns the number of rows that were successfully embedded. Never
   * throws — drain failures should not break the caller's path.
   */
  async drainPendingEmbeddings(maxBatch: number = 32): Promise<number> {
    if (!this._embeddingProvider) return 0;
    let succeeded = 0;
    const pending = this.store.listPendingEmbeddings(maxBatch);
    for (const row of pending) {
      const trace = this.store.getById(row.traceId);
      if (!trace) {
        // Trace deleted between enqueue and drain — drop the stale row.
        this.store.removePendingEmbedding(row.traceId);
        continue;
      }
      try {
        const embeddings = await this._embeddingProvider.embedBatch([
          trace.problem.description,
          trace.solution.summary,
        ]);
        if (embeddings.length === 2) {
          this.store.storeEmbeddings(trace.id, embeddings[0]!, embeddings[1]!);
          this.store.removePendingEmbedding(trace.id);
          succeeded++;
        } else {
          this.store.bumpPendingEmbeddingAttempt(
            trace.id,
            `embedBatch returned ${embeddings.length} vectors, expected 2`,
          );
        }
      } catch (err) {
        this.store.bumpPendingEmbeddingAttempt(
          trace.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return succeeded;
  }

  /** Count pending embedding entries — used by `doctor` health check. */
  pendingEmbeddingsCount(): number {
    this.ensureOpen();
    return this.store.countPendingEmbeddings();
  }

  /**
   * Recall with semantic embedding similarity (async).
   * Uses all signals including cosine similarity when embeddings are available.
   * Falls back to sync recall() when no embedding provider is set.
   */
  async recallAsync(query: RecallQuery): Promise<RecallResult[]> {
    this.ensureOpen();

    if (!this._embeddingProvider) {
      return this.recall(query);
    }

    // Compute query embedding
    const queryEmbedding = await this._embeddingProvider.embed(query.problem);

    // Compute cosine similarity against all stored embeddings
    const embeddedTraces = this.store.getAllWithEmbeddings();
    const cosineScores = new Map<string, number>();
    for (const { trace, problemEmbedding } of embeddedTraces) {
      const sim = cosineSimilarity(queryEmbedding, problemEmbedding);
      if (sim > 0) {
        cosineScores.set(trace.id, sim);
      }
    }

    // Sample weights from the contextual bandit with cosine enabled.
    const { weights, seed, bucketKey } = this.drawWeights(
      this.contextFor(query),
      /*hasEmbeddings*/ true,
    );

    const { results, allCandidates } = recallWithAllCandidates(
      this.store,
      query,
      weights,
      cosineScores,
      this._config.similarity,
      this._config.features,
    );

    const queryId = this.recordTraceRetrieval(
      query,
      results,
      allCandidates,
      weights,
      /*hasEmbeddings*/ true,
      seed,
      bucketKey,
    );
    const stamped = results.map((r) => ({ ...r, queryId }));
    this.emit({ type: "trace:recalled", query, results: stamped });
    return stamped;
  }

  /**
   * Full-text search through stored traces.
   * Unlike recall(), this does a direct text search without similarity scoring.
   */
  search(query: string, limit = 10): ReasoningTrace[] {
    this.ensureOpen();
    return this.store.searchFts(query, limit).map((r) => r.trace);
  }

  /**
   * Provide feedback that a recalled trace was helpful or not.
   *
   * Preferred form: `feedback({ queryId, traceId, helpful })` — exact
   * attribution using the `queryId` from `RecallResult.queryId`.
   *
   * Legacy form: `feedback(traceId, helpful)` — best-effort. Resolves to
   * the most recent unresolved `trace_retrieval` event whose
   * `selectedTraceIds` contains this trace within the last 60 minutes.
   * If multiple unresolved candidates exist, quality is updated but
   * **weights are NOT**: better to under-attribute than to mis-attribute
   * across concurrent recalls. The resulting `trace_feedback` event
   * carries `ambiguous: true` for observability.
   *
   * This is the ONLY method that increments recallCount. Weight updates
   * happen via Thompson Sampling on the Beta posterior in `weights.ts`.
   */
  feedback(traceId: string, helpful: boolean): void;
  feedback(args: { queryId: string; traceId: string; helpful: boolean }): void;
  feedback(
    arg1: string | { queryId: string; traceId: string; helpful: boolean },
    arg2?: boolean,
  ): void {
    this.ensureOpen();

    const useStructured = typeof arg1 === "object";
    const traceId = useStructured ? arg1.traceId : arg1;
    const helpful = useStructured ? arg1.helpful : (arg2 as boolean);
    const explicitQueryId = useStructured ? arg1.queryId : undefined;

    const resolved = this.resolveFeedbackContext(traceId, explicitQueryId);

    // Audit #5 (PR 1 review P1) — duplicate-call guard.
    // The legacy path gets this for free via the exclusion logic in
    // `resolveFeedbackContext` (a queryId is dropped from candidates
    // once it has a matching `trace_feedback`). The structured path
    // resolves by queryId directly and so must check explicitly. The
    // entire call no-ops when the (queryId, traceId) pair was already
    // credited — no double-count of recallCount/helpfulCount, no
    // duplicate event, no double weight update.
    if (resolved.alreadyCredited) {
      return;
    }

    // Update quality metrics (increments recallCount + helpfulCount).
    // Audit P1 (PR 1 review): when attribution is ambiguous we still
    // record quality (the user's vote counts), but we MUST NOT feed
    // (signals, helpful) into the `feedback_signals` learning table
    // — those rows would mis-attribute against whichever retrieval we
    // happened to pick from the ambiguous set. Pass `undefined` for
    // signals so the row is "quality only".
    this.store.recordFeedback(
      traceId,
      helpful,
      resolved.ambiguous ? undefined : resolved.signals,
    );

    // Persist the feedback to the event log. `ambiguous: true` signals
    // to the weight-update driver that this row should not be credited.
    // `trace_feedback` is item-level — "was THIS retrieved trace useful"
    // — not task-level outcome ("did the run resolve"). V1 has no way
    // to observe task resolution; conflating these would have been a
    // category error.
    if (resolved.queryId) {
      if (helpful && !resolved.ambiguous) {
        // Explicit attribution: caller is telling us this trace was
        // used. Emit `trace_agent_used` so downstream consumers can
        // compute helpful-with-attribution exactly as they do for
        // block events. Skipped on ambiguous: we don't know which
        // retrieval the agent actually consumed.
        emitTraceAgentUsed(this.blockStore, {
          queryId: resolved.queryId,
          traceId,
          matchSignal: "explicit",
          matchScore: 1,
        });
      }
      emitTraceFeedback(this.blockStore, {
        queryId: resolved.queryId,
        traceId,
        helpful,
        attribution: "explicit",
        ...(resolved.ambiguous ? { ambiguous: true } : {}),
      });
    }

    // Update adaptive weights ONLY when attribution is unambiguous.
    // Ambiguous resolution (multiple open retrievals containing this
    // traceId) → skip weight update. Missing signals (no matching
    // retrieval event found at all, e.g. cross-process restart with
    // pre-PR-1 history) → also skip; the trace exists but we have no
    // contribution data to credit.
    if (resolved.signals && !resolved.ambiguous) {
      // B2 — update both the global posterior AND the bucket-local
      // observation counters. `updateContextualWeights` writes both
      // atomically so a partial update can't desync the layers.
      const { global, contextual } = loadContextualBandit(this.store.rawDb);
      const updated = updateContextualWeights(
        this.store.rawDb,
        global,
        contextual,
        resolved.bucketContext ?? {},
        resolved.signals,
        helpful,
      );
      // Emit the posterior MEAN of the updated GLOBAL state (not a
      // fresh sample, not the bucket-conditional mean) so observers
      // see a stable "model thinks X" snapshot. Bucket-level views
      // live in `tracebase explain` / B3, not in the event emitter.
      const newWeights = computeWeightsMean(updated.global);
      this.emit({
        type: "weights:updated",
        weights: newWeights as unknown as Record<string, number>,
      });
    }

    const trace = this.store.getById(traceId);
    if (trace) {
      this.emit({
        type: "quality:updated",
        traceId,
        metrics: trace.quality,
      });
    }
  }

  /** Get a trace by ID. */
  getTrace(id: string): ReasoningTrace | null {
    this.ensureOpen();
    return this.store.getById(id);
  }

  /** Delete a trace by ID. */
  deleteTrace(id: string): boolean {
    this.ensureOpen();
    return this.store.delete(id);
  }

  /** List recent traces with pagination. */
  listTraces(limit = 20, offset = 0): ReasoningTrace[] {
    this.ensureOpen();
    return this.store.listRecent(limit, offset);
  }

  /** Emit a TraceBaseEvent (used by middleware for injection notifications). */
  notify(event: TraceBaseEvent): void {
    this.emit(event);
  }

  /** Get aggregate storage statistics. */
  stats(): StorageStats {
    this.ensureOpen();
    return this.store.stats();
  }

  /**
   * Remove low-quality traces.
   * Returns the number of traces pruned.
   */
  prune(threshold?: number): number {
    this.ensureOpen();
    const t = threshold ?? this._config.pruneThreshold ?? 0.05;
    return this.store.prune(t, this._config.maxTraces);
  }

  /** Export all traces as JSON-serializable array. */
  exportAll(): ReasoningTrace[] {
    this.ensureOpen();
    return this.store.exportAll();
  }

  /** Import traces from an array. Returns count of newly imported traces. */
  importTraces(traces: ReasoningTrace[]): number {
    this.ensureOpen();
    return this.store.importTraces(traces);
  }

  /** Total number of stored traces. */
  count(): number {
    this.ensureOpen();
    return this.store.count();
  }

  /**
   * Get the current posterior-mean weights — the "what does the model
   * think the average weight of each signal is" snapshot. Deterministic.
   *
   * NOTE: This is NOT what the recall path uses. Recall draws a fresh
   * Thompson sample each query (`sampleWeights`); the mean is just a
   * stable readout for diagnostics, telemetry, and `tracebase explain`.
   */
  getWeights(): SignalWeights {
    this.ensureOpen();
    const state = loadWeightState(this.store.rawDb);
    return computeWeightsMean(state);
  }

  // --------------------------------------------------------------------------
  // Embedding support
  // --------------------------------------------------------------------------

  /** Set a custom embedding provider for semantic search. */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this._embeddingProvider = provider;
  }

  /** Get the current embedding provider. */
  get embeddingProvider(): EmbeddingProvider | undefined {
    return this._embeddingProvider;
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  /** Subscribe to events. Returns an unsubscribe function. */
  on(type: TraceBaseEvent["type"] | "*", handler: EventHandler): () => void {
    const key = type;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(handler);
    return () => this.listeners.get(key)?.delete(handler);
  }

  private emit(event: TraceBaseEvent): void {
    // Wrap each handler in try/catch so user errors don't break core ops
    const invoke = (h: EventHandler) => {
      try {
        h(event);
      } catch {
        // Silently swallow handler errors
      }
    };

    this.listeners.get(event.type)?.forEach(invoke);
    this.listeners.get("*")?.forEach(invoke);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Close the database connection and release resources. */
  close(): void {
    if (!this.closed) {
      // The BlockStore shares TraceStore's better-sqlite3 handle, so
      // closing TraceStore tears down both. Calling blockStore.close()
      // separately would double-close and throw.
      this.store.close();
      this.closed = true;
    }
  }

  /** Get the underlying store (for advanced use). */
  get rawStore(): TraceStore {
    return this.store;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("ReasoningLayer has been closed");
    }
  }

  /**
   * Enforce the maxTraces limit.
   * Strategy 1: Quality-based pruning (remove low-quality recalled traces).
   * Strategy 2: Age-based deletion (remove oldest, regardless of quality).
   *
   * Post-prune invariant: `count <= max`. If somehow violated (a custom
   * `TraceStore.prune` impl that refuses to delete, a SQLite write that
   * silently failed, etc.), throw `EnforceLimitOvershootError` rather
   * than silently exceeding the limit. Addresses audit issue #7.
   */
  private enforceLimit(): void {
    const max = this._config.maxTraces!;
    const startCount = this.store.count();
    if (startCount <= max) return;

    this.store.prune(this._config.pruneThreshold ?? 0.05, max);

    const finalCount = this.store.count();
    if (finalCount > max) {
      throw new EnforceLimitOvershootError(max, finalCount, startCount);
    }
  }

  /**
   * Draw a fresh Thompson sample of the weight vector for the next
   * recall, conditioned on the query's BucketContext.
   *
   * B2 contextual layer (`contextual-bandit.ts`) wraps the global
   * Beta posterior with an empirical-Bayes per-(language, framework,
   * errorType) bucket. A bucket with zero observations samples from
   * the global posterior (identical mean, slightly tighter spread
   * thanks to the κ prior strength), so cold-start behaviour matches
   * pre-B2 exactly. Buckets diverge only when their own observation
   * counters dominate κ ≈ 10.
   *
   * Returns the sample plus the 32-bit seed AND the bucket key. The
   * caller logs all three onto the `trace_retrieval` event payload —
   * the seed lets off-policy screening replay deterministically; the
   * bucket key lets diagnostic surfaces (and B3) join feedback rows
   * to the posterior that produced them.
   */
  private drawWeights(
    context: BucketContext,
    hasEmbeddings: boolean,
  ): { weights: SignalWeights; seed: number; bucketKey: string } {
    // Crypto-random 32-bit seed — non-deterministic by default; tests
    // and OPE pass a seeded RNG to override this branch entirely
    // (future hook on the constructor; in PR 2 the public API is
    // implicit production-only).
    const seed = (Math.random() * 0x100000000) >>> 0;
    const rng = seededRng(seed);
    const { global, contextual } = loadContextualBandit(this.store.rawDb);
    const weights = sampleContextualWeights(global, contextual, context, {
      hasEmbeddings,
      rng,
    });
    return { weights, seed, bucketKey: bucketKeyFor(context) };
  }

  /**
   * Emit a `trace_retrieval` event for the just-completed recall.
   *
   * Returns the freshly-minted `queryId` so the caller can stamp it on
   * the `RecallResult[]` it returns to the user. Downstream `feedback()`
   * calls correlate by that id.
   *
   * `candidates` carries the FULL scored slate (every row that survived
   * the candidate-collection step, before `minScore` filter and `limit`
   * slice). `selectedTraceIds` carries just the top-K actually returned
   * to the caller. PR 1 review P2 #2 flagged that the original draft
   * only logged the survivors — that breaks B3 replay-screening because
   * the policy under evaluation can't see counter-factuals.
   *
   * `rankerVersion` is `"linear.ts.v1"` for the May-2026 PR 2 Thompson-
   * sampled weights. The version string is part of the off-policy
   * replay contract — never change a name retroactively, always
   * introduce a new one when the policy semantics change.
   */
  private recordTraceRetrieval(
    query: RecallQuery,
    results: RecallResult[],
    allCandidates: RecallResult[],
    weights: SignalWeights,
    hasEmbeddings: boolean,
    seed?: number,
    bucketKey?: string,
  ): string {
    const queryId = randomUUID();
    const candidates: TraceRetrievalCandidate[] = allCandidates.map((r) => ({
      traceId: r.trace.id,
      score: r.score,
      signals: {
        fingerprint: r.signals.fingerprint,
        bm25: r.signals.bm25,
        jaccard: r.signals.jaccard,
        structural: r.signals.structural,
        cosine: r.signals.cosine,
        freshness: r.signals.freshness,
      },
    }));
    const sampledWeights = {
      bm25: weights.bm25,
      jaccard: weights.jaccard,
      structural: weights.structural,
      cosine: weights.cosine,
      freshness: weights.freshness,
    };
    const context = query.context
      ? {
          ...(query.context.language !== undefined ? { language: query.context.language } : {}),
          ...(query.context.framework !== undefined ? { framework: query.context.framework } : {}),
          ...(query.context.errorType !== undefined ? { errorType: query.context.errorType } : {}),
          corpusSize: this.store.count(),
          ...(bucketKey !== undefined ? { bucketKey } : {}),
        }
      : { corpusSize: this.store.count(), ...(bucketKey !== undefined ? { bucketKey } : {}) };
    try {
      emitTraceRetrieval(this.blockStore, {
        queryId,
        candidates,
        sampledWeights,
        rankerVersion: "linear.ts.v1",
        selectedTraceIds: results.map((r) => r.trace.id),
        ...(seed !== undefined ? { seed } : {}),
        context,
      });
    } catch {
      // Emission must never break the recall path. A failed event write
      // means we silently lose attribution for this query — strictly
      // better than throwing on the user-facing API. PR 2 surfaces the
      // failed-emission count via `doctor`.
    }
    // Reference `hasEmbeddings` for the future B1 cascade where this
    // matters for cosine candidate inclusion; not used in PR 1 since
    // the weight vector itself encodes embedding-availability via the
    // `computeWeights(state, hasEmbeddings)` re-normalization.
    void hasEmbeddings;
    return queryId;
  }

  /**
   * Resolve the `(queryId, signals)` context for a `feedback()` call.
   *
   * - Structured form `feedback({queryId, traceId, helpful})`: walks
   *   straight to the named `trace_retrieval` event. Returns
   *   `alreadyCredited: true` if a `trace_feedback` row already exists
   *   for the `(queryId, traceId)` pair — the caller must no-op.
   * - Legacy form `feedback(traceId, helpful)`: scans the last
   *   `LEGACY_FEEDBACK_LOOKBACK_MS` of `trace_retrieval` events,
   *   filters to those whose `selectedTraceIds` contains the target,
   *   then excludes any that already have a matching `trace_feedback`.
   *   If exactly one remains → that's the attribution. If more than one
   *   remains → ambiguous (signals returned for observability but the
   *   caller MUST skip weight updates AND drop signals when persisting
   *   to `feedback_signals`).
   */
  private resolveFeedbackContext(
    traceId: string,
    explicitQueryId: string | undefined,
  ): {
    queryId?: string;
    signals?: SimilaritySignals;
    bucketContext?: BucketContext;
    ambiguous?: boolean;
    alreadyCredited?: boolean;
  } {
    const lookbackStart = Date.now() - ReasoningLayer.LEGACY_FEEDBACK_LOOKBACK_MS;
    let events;
    try {
      events = this.blockStore.readEvents({
        eventType: ["trace_retrieval", "trace_feedback"],
        ...(explicitQueryId ? { queryId: explicitQueryId } : { afterTs: lookbackStart }),
        limit: 5000,
      });
    } catch {
      return {};
    }

    // Pull the BucketContext off a retrieval event's `context` payload
    // so the feedback path can credit the right contextual bucket.
    // Pre-B2 events have no language/framework/errorType in context;
    // we fall back to an empty context which collapses to the
    // "everything-is-anonymous" bucket.
    const bucketFromEvent = (ev: { context?: Record<string, unknown> }): BucketContext => {
      const c = ev.context;
      if (!c) return {};
      const ctx: BucketContext = {};
      if (typeof c.language === "string") ctx.language = c.language;
      if (typeof c.framework === "string") ctx.framework = c.framework;
      if (typeof c.errorType === "string") ctx.errorType = c.errorType;
      return ctx;
    };

    if (explicitQueryId) {
      // Exact-match path. First scan for an existing trace_feedback for
      // this (queryId, traceId) pair — if present, the caller already
      // counted this feedback once; no-op the entire call.
      for (const ev of events) {
        if (
          ev.event === "trace_feedback" &&
          ev.queryId === explicitQueryId &&
          ev.traceId === traceId
        ) {
          return { alreadyCredited: true };
        }
      }
      // Then resolve the candidate row from the retrieval.
      for (const ev of events) {
        if (ev.event !== "trace_retrieval") continue;
        if (ev.queryId !== explicitQueryId) continue;
        const cand = ev.candidates.find((c) => c.traceId === traceId);
        if (!cand) continue;
        return {
          queryId: explicitQueryId,
          signals: cand.signals,
          bucketContext: bucketFromEvent(ev),
        };
      }
      // queryId given but no matching retrieval event found — treat as
      // no-attribution. Caller will update quality but not weights.
      return {};
    }

    // Legacy path: ambiguous-attribution guard.
    // Find every `trace_retrieval` (within the lookback) that lists
    // `traceId` in its `selectedTraceIds`, then strike out those that
    // already have a `trace_feedback` row.
    const feedbackQueryIds = new Set<string>();
    for (const ev of events) {
      if (ev.event === "trace_feedback" && ev.traceId === traceId) {
        feedbackQueryIds.add(ev.queryId);
      }
    }
    const candidates: Array<{
      queryId: string;
      signals: SimilaritySignals;
      bucketContext: BucketContext;
    }> = [];
    for (const ev of events) {
      if (ev.event !== "trace_retrieval") continue;
      if (feedbackQueryIds.has(ev.queryId)) continue;
      if (!ev.selectedTraceIds.includes(traceId)) continue;
      const cand = ev.candidates.find((c) => c.traceId === traceId);
      if (!cand) continue;
      candidates.push({
        queryId: ev.queryId,
        signals: cand.signals,
        bucketContext: bucketFromEvent(ev),
      });
    }

    if (candidates.length === 0) {
      return {};
    }
    if (candidates.length === 1) {
      const c = candidates[0]!;
      return { queryId: c.queryId, signals: c.signals, bucketContext: c.bucketContext };
    }
    // Ambiguous: prefer the most recent retrieval for the feedback row's
    // queryId so observability tooling can join it back, but flag the
    // skip so the weight driver bails out.
    const last = candidates[candidates.length - 1]!;
    return {
      queryId: last.queryId,
      signals: last.signals,
      bucketContext: last.bucketContext,
      ambiguous: true,
    };
  }

  /** Extract a BucketContext from a RecallQuery — light coercion only. */
  private contextFor(query: RecallQuery): BucketContext {
    const ctx: BucketContext = {};
    if (query.context?.language) ctx.language = query.context.language;
    if (query.context?.framework) ctx.framework = query.context.framework;
    if (query.context?.errorType) ctx.errorType = query.context.errorType;
    return ctx;
  }
}
