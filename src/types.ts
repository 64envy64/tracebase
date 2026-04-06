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
  [key: string]: unknown;
}

/** A single recall result with its similarity score. */
export interface RecallResult {
  trace: ReasoningTrace;
  /** Combined similarity score 0.0–1.0 */
  score: number;
  /** How the match was found */
  matchType: "exact" | "similar" | "related";
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
// Events
// ============================================================================

export type TraceBaseEvent =
  | { type: "trace:stored"; trace: ReasoningTrace }
  | { type: "trace:recalled"; query: RecallQuery; results: RecallResult[] }
  | { type: "trace:pruned"; traceId: string; reason: string }
  | { type: "trace:updated"; traceId: string }
  | { type: "quality:updated"; traceId: string; metrics: QualityMetrics };

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
