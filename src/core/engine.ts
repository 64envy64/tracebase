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
} from "../types.js";
import { TraceStore } from "./store.js";
import { fingerprint } from "./fingerprint.js";
import { recall as recallSimilar, type SimilarityConfig } from "./similarity.js";
import { loadConfig } from "./config.js";

// ============================================================================
// ReasoningLayer — The main public API
//
// Usage:
//   const layer = new ReasoningLayer();                    // auto-detect config
//   const layer = new ReasoningLayer({ storagePath: '...' }); // explicit
//
//   await layer.store({ problem: {...}, solution: {...} });
//   const results = await layer.recall({ problem: "..." });
// ============================================================================

export class ReasoningLayer {
  private store: TraceStore;
  private config: TraceBaseConfig;
  private listeners: Map<string, Set<EventHandler>> = new Map();
  private embeddingProvider?: EmbeddingProvider;
  private closed = false;

  constructor(config?: Partial<TraceBaseConfig>) {
    const resolved = loadConfig();
    this.config = { ...resolved, ...config };
    this.store = new TraceStore(this.config.storagePath);
  }

  // --------------------------------------------------------------------------
  // Core API
  // --------------------------------------------------------------------------

  /**
   * Store a new reasoning trace.
   * Computes the fingerprint automatically.
   */
  storeTrace(input: StoreTraceInput): ReasoningTrace {
    this.ensureOpen();

    // Compute fingerprint
    const fp = fingerprint(input.problem.description, {
      filePath: input.problem.filePath,
      language: input.problem.language,
      framework: input.problem.framework,
      errorType: input.problem.errorType,
    });

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

    this.store.store(trace);

    // Enforce max traces limit
    if (this.config.maxTraces && this.config.maxTraces > 0) {
      this.enforceLimit();
    }

    this.emit({ type: "trace:stored", trace });
    return trace;
  }

  /**
   * Recall relevant past solutions for a given problem.
   * This is the main entry point for "has this been solved before?"
   */
  recall(query: RecallQuery): RecallResult[] {
    this.ensureOpen();

    const similarityConfig: SimilarityConfig = {
      useEmbeddings: !!this.embeddingProvider,
    };

    const results = recallSimilar(this.store, query, similarityConfig);

    // Record recalls for quality tracking
    for (const result of results) {
      this.store.recordRecall(result.trace.id);
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
   * This improves future recall quality.
   */
  feedback(traceId: string, helpful: boolean): void {
    this.ensureOpen();
    this.store.recordRecall(traceId, helpful);

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
    const count = this.store.prune(t);
    return count;
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

  // --------------------------------------------------------------------------
  // Embedding support
  // --------------------------------------------------------------------------

  /** Set a custom embedding provider for semantic search. */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
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
    // Specific handlers
    this.listeners.get(event.type)?.forEach((h) => h(event));
    // Wildcard handlers
    this.listeners.get("*")?.forEach((h) => h(event));
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Close the database connection and release resources. */
  close(): void {
    if (!this.closed) {
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

  private enforceLimit(): void {
    const count = this.store.count();
    const max = this.config.maxTraces!;
    if (count > max) {
      // Prune lowest quality traces to get back under limit
      this.store.prune(this.config.pruneThreshold ?? 0.05);
    }
  }
}
