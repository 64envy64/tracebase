// ============================================================================
// TraceBase — Core Type Definitions
// ============================================================================

/**
 * A complete reasoning trace: problem + solution + metadata.
 * This is the atomic unit of institutional memory.
 */
export interface ReasoningTrace {
  id: string;
  createdAt: number;
  updatedAt: number;

  problem: Problem;
  solution: Solution;
  metadata: TraceMetadata;
  quality: QualityMetrics;
}

/** The problem that was solved. */
export interface Problem {
  /** Human-readable description of the problem */
  description: string;
  /** Extracted error type (e.g. "TypeError", "ENOENT", "404") */
  errorType?: string;
  /** Raw error message */
  errorMessage?: string;
  /** Stack trace if available */
  stackTrace?: string;
  /** Primary file path involved */
  filePath?: string;
  /** Programming language */
  language?: string;
  /** Framework or library (e.g. "react", "express", "django") */
  framework?: string;
  /** User-defined tags for categorization */
  tags: string[];
  /** Computed structural fingerprint for fast exact matching */
  fingerprint: string;
}

/** The solution that resolved the problem. */
export interface Solution {
  /** One-line summary of what fixed it */
  summary: string;
  /** Ordered steps the agent took to solve the problem */
  steps: SolutionStep[];
  /** Whether the solution actually worked */
  outcome: "success" | "failure" | "partial";
  /** Code diff if applicable */
  diff?: string;
  /** Detailed explanation of why this solution works */
  explanation?: string;
}

/** A single step in a solution. */
export interface SolutionStep {
  type: "analysis" | "action" | "verification";
  description: string;
  toolCall?: ToolCallRecord;
}

/** Record of a tool call made during problem solving. */
export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  output?: string;
}

/** Metadata about how and where the trace was produced. */
export interface TraceMetadata {
  /** Which agent produced this trace */
  agent: string;
  /** LLM model used */
  model?: string;
  /** Tokens consumed solving the problem originally */
  tokensUsed?: number;
  /** Wall-clock time to solve in ms */
  durationMs?: number;
  /** Where the trace came from (e.g. "cli", "middleware:openai", "mcp") */
  source?: string;
  /** Arbitrary user-defined metadata */
  custom?: Record<string, unknown>;
}

/** Tracks how useful a stored trace has been. */
export interface QualityMetrics {
  /** How many times this trace was returned as a recall result */
  recallCount: number;
  /** How many times a user confirmed it was helpful */
  helpfulCount: number;
  /** Timestamp of last recall */
  lastRecalledAt?: number;
  /** Computed quality score 0.0–1.0 (higher = more useful) */
  score: number;
}

// ============================================================================
// Similarity Signal Breakdown
// ============================================================================

/**
 * Per-signal contribution scores for a recall match.
 * Enables diagnostics and adaptive weight learning.
 *
 * Each field is a raw (unnormalized) score from that signal.
 */
export interface SimilaritySignals {
  /** 1.0 if exact fingerprint match, 0.0 otherwise */
  fingerprint: number;
  /** Normalized BM25 full-text search score 0.0–1.0 */
  bm25: number;
  /** Jaccard token overlap 0.0–1.0 */
  jaccard: number;
  /** Structural feature match 0.0–1.0 */
  structural: number;
  /** Cosine embedding similarity 0.0–1.0 (0 if no embeddings) */
  cosine: number;
}

// ============================================================================
// Search / Recall
// ============================================================================

/** Query to find relevant past solutions. */
export interface RecallQuery {
  /** Description of the current problem */
  problem: string;
  /** Optional structured context to improve matching */
  context?: RecallContext;
  /** Max number of results (default: 5) */
  limit?: number;
  /** Minimum similarity score threshold 0.0–1.0 (default: 0.1) */
  minScore?: number;
}

export interface RecallContext {
  filePath?: string;
  language?: string;
  framework?: string;
  errorType?: string;
  tags?: string[];
}

/** A single recall result with its similarity score. */
export interface RecallResult {
  trace: ReasoningTrace;
  /** Combined similarity score, clamped to 0.0–1.0 */
  score: number;
  /** How the match was found */
  matchType: "exact" | "similar" | "related";
  /** Per-signal breakdown for diagnostics and weight learning */
  signals: SimilaritySignals;
}

// ============================================================================
// Configuration
// ============================================================================

export interface TraceBaseConfig {
  /** Path to SQLite database file */
  storagePath: string;
  /** Embedding provider configuration */
  embeddings?: EmbeddingConfig;
  /** Maximum traces to store (0 = unlimited, default: 100_000) */
  maxTraces?: number;
  /** Auto-prune traces below this quality score (default: 0.05) */
  pruneThreshold?: number;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

export interface EmbeddingConfig {
  provider: "local" | "openai" | "custom";
  model?: string;
  apiKey?: string;
  dimensions?: number;
  customFn?: (text: string) => Promise<number[]>;
}

/** Embedding provider interface — pluggable backends. */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

// ============================================================================
// Adaptive Weights (Thompson Sampling)
// ============================================================================

/**
 * Beta distribution parameters for one similarity signal.
 * Ref: Thompson (1933), "On the likelihood that one unknown probability
 *      exceeds another in view of the evidence of two samples."
 *
 * Posterior mean = alpha / (alpha + beta).
 */
export interface BetaParams {
  alpha: number;
  beta: number;
}

/** Persisted state for adaptive weight learning. */
export interface AdaptiveWeightState {
  bm25: BetaParams;
  jaccard: BetaParams;
  structural: BetaParams;
  cosine: BetaParams;
  updatedAt: number;
  feedbackCount: number;
}

// ============================================================================
// Events
// ============================================================================

export type TraceBaseEvent =
  | { type: "trace:stored"; trace: ReasoningTrace }
  | { type: "trace:recalled"; query: RecallQuery; results: RecallResult[] }
  | { type: "trace:pruned"; traceId: string; reason: string }
  | { type: "trace:updated"; traceId: string }
  | { type: "trace:deduplicated"; existingId: string; newFingerprint: string }
  | { type: "quality:updated"; traceId: string; metrics: QualityMetrics }
  | { type: "weights:updated"; weights: Record<string, number> }
  | { type: "recall:injected"; traceId: string; score: number; matchType: string }
  | { type: "recall:skipped"; reason: string; topScore?: number };

export type EventHandler = (event: TraceBaseEvent) => void;

// ============================================================================
// Storage Statistics
// ============================================================================

export interface StorageStats {
  totalTraces: number;
  successfulTraces: number;
  failedTraces: number;
  partialTraces: number;
  avgQualityScore: number;
  totalRecalls: number;
  totalHelpful: number;
  topLanguages: Array<{ language: string; count: number }>;
  topFrameworks: Array<{ framework: string; count: number }>;
  topErrorTypes: Array<{ errorType: string; count: number }>;
  oldestTrace?: number;
  newestTrace?: number;
  dbSizeBytes: number;
}

// ============================================================================
// Input types (for creating traces without computed fields)
// ============================================================================

export interface StoreTraceInput {
  problem: Omit<Problem, "fingerprint">;
  solution: Solution;
  metadata?: Partial<TraceMetadata>;
}

// ============================================================================
// Recall-Before-Call Injection Config
// ============================================================================

/**
 * Configuration for automatic recall-before-call in SDK middlewares.
 * When enabled, the middleware queries institutional memory before each LLM call
 * and injects high-confidence prior solutions into the system prompt.
 *
 * This is the core optimization loop:
 *   user message → recall() → match found? → inject hint → LLM call → store trace
 */
export interface RecallInjectConfig {
  /** Enable recall-before-call. Default: true when config is provided. */
  enabled?: boolean;
  /**
   * Minimum similarity score to inject a prior solution (0.0–1.0).
   * Higher = fewer but more precise injections. Default: 0.72
   *
   * At 0.72, the practical effect is that only traces with strong multi-signal
   * agreement (BM25 + Jaccard + structural) pass — which in practice filters
   * out weak "related" matches. Note: the exact matchType boundary depends
   * on quality multiplier (0.85–1.15), so this is a score threshold, not a
   * matchType guarantee.
   */
  minScore?: number;
  /** Maximum prior solutions to inject per call. Default: 1 */
  maxInjections?: number;
  /**
   * Skip injecting exact fingerprint matches (same problem = user is re-asking).
   * Default: true — avoids circular injection.
   */
  skipExactMatch?: boolean;
  /** Only inject traces with outcome "success". Default: true */
  successOnly?: boolean;
  /** Optional context to improve matching quality. */
  context?: RecallContext;
}
