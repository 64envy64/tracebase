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
import { fingerprint } from "./fingerprint.js";
import { recall as recallSimilar, cosineSimilarity } from "./similarity.js";
import { loadConfig } from "./config.js";
import {
  loadWeightState,
  computeWeights,
  updateWeights,
  type SignalWeights,
} from "./weights.js";

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

export class ReasoningLayer {
  private store: TraceStore;
  private config: TraceBaseConfig;
  private listeners: Map<string, Set<EventHandler>> = new Map();
  private _embeddingProvider?: EmbeddingProvider;
  private closed = false;

  /** LRU cache with TTL: traceId → { signals, timestamp }.
   *  Used by feedback() to attribute signals for weight learning.
   *  Entries expire after 30 minutes to prevent stale attribution. */
  private recallSignalCache = new Map<string, { signals: SimilaritySignals; ts: number }>();
  private static readonly SIGNAL_CACHE_MAX = 1000;
  private static readonly SIGNAL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(config?: Partial<TraceBaseConfig>) {
    // Only read config from disk when needed fields are missing
    if (config?.storagePath) {
      const defaults = loadConfig();
      this.config = { ...defaults, ...config };
    } else {
      const resolved = loadConfig();
      this.config = { ...resolved, ...config };
    }
    this.store = new TraceStore(this.config.storagePath);
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
    const fp = fingerprint(input.problem.description, {
      filePath: input.problem.filePath,
      language: input.problem.language,
      framework: input.problem.framework,
      errorType: input.problem.errorType,
    });

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
    };

    // Store with cached tokens + features for fast recall later
    this.store.store(trace, fp.tokens, fp.features as unknown as Record<string, unknown>);

    // Enforce max traces limit
    if (this.config.maxTraces && this.config.maxTraces > 0) {
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
   */
  recall(query: RecallQuery): RecallResult[] {
    this.ensureOpen();

    // Load adaptive weights from DB
    const weightState = loadWeightState(this.store.rawDb);
    const weights = computeWeights(weightState);

    const results = recallSimilar(this.store, query, weights);

    // Cache signal contributions for later feedback attribution
    for (const result of results) {
      this.cacheSignals(result.trace.id, result.signals);
    }

    this.emit({ type: "trace:recalled", query, results });
    return results;
  }

  /**
   * Store a trace and compute embeddings (async).
   * Same as storeTrace() but also computes + stores vector embeddings
   * when an embedding provider is configured.
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
        }
      } catch {
        // Embedding failure should not fail the store
      }
    }

    return trace;
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

    // Load adaptive weights with cosine enabled
    const weightState = loadWeightState(this.store.rawDb);
    const weights = computeWeights(weightState, true);

    const results = recallSimilar(this.store, query, weights, cosineScores);

    for (const result of results) {
      this.cacheSignals(result.trace.id, result.signals);
    }

    this.emit({ type: "trace:recalled", query, results });
    return results;
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
   * This is the ONLY method that increments recallCount.
   * Also updates adaptive weights via Thompson Sampling.
   */
  feedback(traceId: string, helpful: boolean): void {
    this.ensureOpen();

    // Get signal contributions (from LRU cache with TTL check)
    const cached = this.recallSignalCache.get(traceId);
    const signals = cached && (Date.now() - cached.ts < ReasoningLayer.SIGNAL_CACHE_TTL_MS)
      ? cached.signals
      : undefined;

    // Update quality metrics (increments recallCount + helpfulCount)
    this.store.recordFeedback(traceId, helpful, signals);

    // Update adaptive weights via Thompson Sampling
    if (signals) {
      const weightState = loadWeightState(this.store.rawDb);
      const updated = updateWeights(this.store.rawDb, weightState, signals, helpful);
      const newWeights = computeWeights(updated);

      this.emit({
        type: "weights:updated",
        weights: newWeights as unknown as Record<string, number>,
      });

      // Clean up cache entry after feedback is recorded
      this.recallSignalCache.delete(traceId);
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
    const t = threshold ?? this.config.pruneThreshold ?? 0.05;
    return this.store.prune(t, this.config.maxTraces);
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

  /** Get current adaptive weights. */
  getWeights(): SignalWeights {
    this.ensureOpen();
    const state = loadWeightState(this.store.rawDb);
    return computeWeights(state);
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
      this.store.close();
      this.recallSignalCache.clear();
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
   * This ensures the limit is always enforceable. Ref: audit issue E1.
   */
  private enforceLimit(): void {
    const count = this.store.count();
    const max = this.config.maxTraces!;
    if (count <= max) return;

    this.store.prune(this.config.pruneThreshold ?? 0.05, max);
  }

  /** Cache signal contributions for later feedback attribution (LRU + TTL). */
  private cacheSignals(traceId: string, signals: SimilaritySignals): void {
    // LRU: delete and re-insert to move to end of insertion order
    this.recallSignalCache.delete(traceId);

    // Evict expired or overflow entries
    if (this.recallSignalCache.size >= ReasoningLayer.SIGNAL_CACHE_MAX) {
      const now = Date.now();
      for (const [key, entry] of this.recallSignalCache) {
        if (now - entry.ts > ReasoningLayer.SIGNAL_CACHE_TTL_MS
          || this.recallSignalCache.size >= ReasoningLayer.SIGNAL_CACHE_MAX) {
          this.recallSignalCache.delete(key);
        }
        if (this.recallSignalCache.size < ReasoningLayer.SIGNAL_CACHE_MAX) break;
      }
    }

    this.recallSignalCache.set(traceId, { signals, ts: Date.now() });
  }
}
