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
  provenance: TraceProvenance;
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

/**
 * Provenance metadata — tracks where a trace came from and how trusted it is.
 * Enables transparency that cloud-only competitors cannot offer.
 */
export interface TraceProvenance {
  /** Where this trace originated. */
  origin: "local" | "team" | "seed" | "global";
  /** Human or agent who created this trace (e.g., git user, agent name). */
  author?: string;
  /** Users/agents who confirmed this trace via feedback. */
  verifiedBy?: string[];
  /** How many times this trace was successfully applied (injected → positive outcome). */
  appliedCount: number;
  /** Timestamp of last successful application. */
  lastAppliedAt?: number;
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
  /**
   * Temporal freshness 0.0–1.0 (1.0 = just created, decays over time).
   * Exponential decay with configurable half-life.
   * Ref: Campos et al. (2016) "Yake! — Yet Another Keyword Extractor" —
   *      temporal scoring for information freshness.
   * Ref: Li & Croft (2003) — time-based language models for IR.
   */
  freshness: number;
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
  /** Similarity ranking engine tuning. */
  similarity?: SimilarityConfig;
  /** Injection format tuning. */
  injection?: InjectionFormatConfig;
  /** Feature extraction and fingerprinting tuning. */
  features?: FeatureConfig;
  /**
   * Max chars to store from LLM response summary in middleware traces.
   * Higher = more context stored, more storage used.
   * Default: 500
   */
  maxResponseChars?: number;
  /**
   * Jaccard similarity threshold for auto-feedback in middleware.
   * When agent output overlaps with injected solution above this threshold,
   * implicit positive feedback is recorded automatically.
   * Default: 0.3
   */
  autoFeedbackThreshold?: number;
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
// Advanced Engine Configuration
// ============================================================================

/**
 * Configuration for the similarity ranking engine.
 * All thresholds are dynamically tunable — no hardcoded magic numbers.
 */
export interface SimilarityConfig {
  /**
   * Minimum cosine similarity to consider a candidate (0.0–1.0).
   * Ref: Threshold selection for embedding-based retrieval varies by model;
   *      text-embedding-3-small typically uses 0.3–0.4 (OpenAI, 2024).
   * Default: 0.3
   */
  cosineThreshold?: number;
  /**
   * Quality score multiplier range [min, max].
   * Traces with quality.score=0 get min multiplier, score=1 gets max.
   * This implements a soft preference for battle-tested traces.
   * Default: [0.85, 1.15]
   */
  qualityMultiplierRange?: [number, number];
  /**
   * Score threshold for "similar" vs "related" classification.
   * Above this = "similar", below = "related", exact fingerprint = "exact".
   * Default: 0.5
   */
  similarThreshold?: number;
  /**
   * Multiplier for candidate over-fetch in stage 1 retrieval.
   * Higher = more candidates but slower re-ranking.
   * Ref: Bruch et al. (2023) recommend 3–5x for two-stage retrieval.
   * Default: 4
   */
  candidateMultiplier?: number;
  /**
   * Half-life for temporal freshness decay, in days.
   * After this many days, a trace's freshness signal drops to 0.5.
   * Ref: Exponential decay — f(t) = exp(-ln(2) * t / halfLife)
   * Ref: Li & Croft (2003) — time-based language models for IR.
   * Default: 30
   */
  freshnessHalfLifeDays?: number;
  /**
   * BM25 score normalization strategy.
   *
   * "query-level" (default): Normalize relative to batch maximum.
   *   Ref: Zhai & Lafferty (2004). Standard in multi-signal fusion.
   *   Pro: Works correctly regardless of corpus size.
   *   Con: Top result always gets BM25=1.0 (relative, not absolute).
   *
   * "saturation": Absolute normalization via score / (score + k).
   *   Ref: Robertson & Zaragoza (2009) "The Probabilistic Relevance Framework".
   *   Pro: Absolute quality calibration for large corpora.
   *   Con: Near-zero scores for small corpora (BM25 IDF collapses).
   *
   * Default: "query-level"
   */
  bm25Normalization?: "query-level" | "saturation";
  /**
   * Saturation parameter k (only used with "saturation" strategy).
   * Lower k = faster saturation (more scores near 1.0).
   * Higher k = wider spread of normalized scores.
   * Default: 1.5
   */
  bm25SaturationK?: number;
}

/**
 * Configuration for injection formatting.
 * Controls how prior solutions are presented to the LLM.
 */
export interface InjectionFormatConfig {
  /** Output format for injected prior solutions. Default: "xml" */
  format?: "xml" | "json" | "markdown";
  /** Max characters for solution summary. Default: 300 */
  maxSummaryLength?: number;
  /** Max characters for explanation. Default: 200 */
  maxExplanationLength?: number;
  /**
   * Include quality metrics (recall count, helpful rate) in injection.
   * Gives the LLM confidence signal about how proven a solution is.
   * Default: false
   */
  includeMetrics?: boolean;
}

/**
 * Configuration for feature extraction (domain-agnostic fingerprinting).
 * Enables TraceBase to work beyond software engineering — insurance claims,
 * support tickets, financial analysis, or any problem→solution domain.
 */
export interface FeatureConfig {
  /** Weights for structural similarity scoring. All values are relative. */
  structuralWeights?: StructuralWeights;
  /**
   * Custom feature extractors for domain-specific matching.
   *
   * Example — insurance claim type:
   *   { name: "claimType", pattern: /water|fire|theft|liability/i, weight: 4 }
   *
   * Example — severity classification:
   *   { name: "severity", fn: (text) => classifySeverity(text), weight: 3 }
   */
  extractors?: FeatureExtractor[];
  /** Additional stop words to exclude from tokenization. */
  additionalStopWords?: string[];
  /** Additional error type patterns (merged with built-in). */
  additionalErrorPatterns?: Array<{ pattern: RegExp; label: string }>;
  /** Additional framework patterns (merged with built-in). */
  additionalFrameworkPatterns?: Array<{ pattern: RegExp; label: string }>;
}

/** Weights for structural feature matching. All values are relative. */
export interface StructuralWeights {
  errorType?: number;      // default: 4
  language?: number;       // default: 2
  framework?: number;      // default: 2
  fileExtension?: number;  // default: 1
  keywords?: number;       // default: 3
  /** Custom feature weights keyed by extractor name. */
  [key: string]: number | undefined;
}

/**
 * A pluggable feature extractor for domain-specific use cases.
 *
 * Extractors run during fingerprinting and produce features that
 * are used in structural similarity matching with configurable weights.
 */
export interface FeatureExtractor {
  /** Unique name for this extractor (used as feature key and weight key). */
  name: string;
  /** Regex pattern. First capture group used, or full match if no groups. */
  pattern?: RegExp;
  /** Custom extraction function. Takes precedence over pattern. */
  fn?: (text: string, context?: Record<string, unknown>) => string | undefined;
  /** Weight in structural similarity computation. Default: 2 */
  weight?: number;
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
  freshness: BetaParams;
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
  | { type: "recall:skipped"; reason: string; topScore?: number }
  | { type: "tokens:tracked"; data: TokenUsageData };

/**
 * Token usage tracking data — emitted after each LLM call.
 * Enables dashboard ROI metrics and benchmark comparisons.
 */
export interface TokenUsageData {
  /** Tokens reported by the LLM API (if available) */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Estimated injection overhead (tokens added by TraceBase) */
  injectionTokens: number;
  /** Whether a prior solution was injected */
  wasInjected: boolean;
  /** Source of the injected trace */
  injectedTraceId?: string;
  /** LLM model used */
  model?: string;
  /** Response time in ms */
  durationMs: number;
}

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

// ============================================================================
// ReasoningBlock — the atomic memory unit (v2 schema)
//
// A ReasoningBlock is the smallest reusable pattern: trigger + body.
// Retrieval matches ONLY on the trigger. Body is the reward for a match.
// This separates what the query looks like from what gets injected, which
// the whole-trace v1 schema conflated.
//
// Relation to ReasoningTrace: a block is *derived* from one or more traces
// via the distillation pipeline. Traces are raw records; blocks are
// curated reuse units. Both can coexist; traces remain v1-compatible.
// See docs/DESIGN_v2.md Pillar 1 for full rationale.
// ============================================================================

/**
 * The smallest reusable unit of reasoning. See docs/DESIGN_v2.md.
 *
 * Invariants:
 *   - `trigger` is what retrieval matches against.
 *   - `body` is what gets injected when trigger matches.
 *   - Never put body content in trigger fields (contaminates retrieval).
 *   - Never put trigger invariants in body (agent ignores them there).
 */
export interface ReasoningBlock {
  id: string;
  /** Schema version, bumps on breaking change. v1 = first release. */
  version: number;

  trigger: BlockTrigger;
  body: BlockBody;
  provenance: BlockProvenance;
  stats: BlockStats;
  quality: BlockQuality;
  embeddings?: BlockEmbeddings;

  createdAt: number;
  updatedAt: number;
  /**
   * Lifecycle state. See docs/DESIGN_v2.md §L2 + §L6 for transitions.
   *
   * - candidate: distilled but not yet promoted (no origin case ref yet,
   *              or has not passed leakage guards + fingerprint dedupe).
   *              Never served. Visible to audit / distillation replay.
   * - active:    eligible for retrieval and injection. Requires at least
   *              one linked BlockCaseRef with role="origin".
   * - demoted:   observed to be unhelpful or counterproductive; kept for
   *              audit but never served. Repair loop may promote back.
   * - merged:    superseded by another block with the same trigger
   *              fingerprint. Kept as a provenance node; never served.
   * - retired:   permanently obsolete. Kept only for reference chains.
   */
  status: "candidate" | "active" | "demoted" | "merged" | "retired";
}

/**
 * Trigger: what a query must look like to match this block.
 * Retrieval compares trigger to the current query. Body is excluded from
 * similarity scoring.
 */
export interface BlockTrigger {
  /** Compressed pattern description, ≤ 40 words. */
  situation: string;
  /**
   * Hard pre-filter. If a field is set, retrieval rejects queries whose
   * corresponding query-invariant is present and different.
   * Unset = no filter on that dimension.
   */
  invariants: BlockInvariants;
  /** Tokens extracted from `situation` + `invariants` for BM25. */
  keywords: string[];
  /** sha256 of canonical `invariants || sorted(keywords)`. Dedupe key. */
  fingerprint: string;
}

export interface BlockInvariants {
  language?: string;
  framework?: string;
  errorType?: string;
  /** Specific public APIs implicated (e.g. `["numpy.ndarray.__array_ufunc__"]`). */
  apiSurface?: string[];
}

/**
 * Body: the reusable reasoning itself. Only seen by the agent after the
 * trigger has matched.
 */
export interface BlockBody {
  /** Root cause structure. */
  mechanism: string;
  /** Approaches that look plausible but fail; prevents wasted exploration. */
  deadEnds: string[];
  /** The key insight, ≤ 30 words. */
  unlock: string;
  /** How the agent confirms the fix actually worked (e.g. reproduction test). */
  verification: string;
}

/**
 * How this block came to exist. Mandatory — un-sourced blocks cannot be
 * audited or drift-diagnosed.
 */
export interface BlockProvenance {
  sourceTaskId: string;
  sourceAgent?: string;
  sourceModel?: string;
  extractedFrom: "trajectory" | "gold_patch" | "manual" | "imported";
  distilledAt: number;
  distilledBy: "llm" | "rule" | "manual";
  distilledWithModel?: string;
  /** Link back to the full trace if retained. */
  parentTraceId?: string;
}

/**
 * Raw counts populated by the analytics pipeline. Do NOT derive retrieval
 * confidence directly from these; that is `quality.confidence`'s job,
 * which is calibrated separately.
 */
export interface BlockStats {
  timesRetrieved: number;
  timesInjected: number;
  timesAgentUsed: number;
  timesHelpful: number;
  timesCounterproductive: number;
  lastUsedAt?: number;
  cumulativeTokensSaved: number;
  cumulativeStepsSaved: number;
}

/**
 * Calibrated priors used by retrieval serving (Pillar 3).
 * Separate from stats so that calibration can be re-fit without touching
 * raw counts.
 */
export interface BlockQuality {
  /** Posterior mean P(helpful). Starts at 0.5 until calibrated. */
  confidence: number;
  /** Wilson 95% lower bound; used for tie-breaking. */
  wilsonLowerBound: number;
  /** Which isotonic-regression cohort this confidence came from. */
  calibrationCohort?: string;
}

export interface BlockEmbeddings {
  /** Situation-field embedding (for query → trigger similarity). */
  situationVec?: Float32Array;
  /** Unlock-field embedding (for cross-block dedup / clustering). */
  unlockVec?: Float32Array;
  model: string;
}

/** Input for creating a new block; computed fields filled by the distiller. */
export interface StoreBlockInput {
  trigger: Omit<BlockTrigger, "fingerprint" | "keywords">;
  body: BlockBody;
  provenance: Omit<BlockProvenance, "distilledAt">;
}

// ============================================================================
// BlockCaseRef — evidence linking a block to its source cases (L3).
//
// Every `active` block MUST have at least one ref with role="origin".
// This is how we avoid "block is the single source of truth": the block
// is always auditable against its evidence cases.
// See docs/DESIGN_v2.md §L3 for the integrity rules.
// ============================================================================

export type BlockCaseRole =
  /** Block was distilled from this case. Required on ≥ 1 ref per active block. */
  | "origin"
  /** Case later confirmed the block's mechanism in a different task. */
  | "supporting"
  /** Case contradicted the block; used by repair loop to drive demotion. */
  | "counter"
  /** Referenced trace no longer exists; block quarantined until re-linked. */
  | "orphan";

export type EvidenceQuality = "strong" | "moderate" | "weak";

export interface BlockCaseRef {
  id: string;
  blockId: string;
  /** References ReasoningTrace.id in the episodic substrate (L1). */
  traceId: string;
  role: BlockCaseRole;
  /** Distiller / verifier's confidence that this case instantiates the block. */
  evidenceQuality: EvidenceQuality;
  /**
   * Optional pointer into the trace for audit (e.g. step index or a file
   * path inside the trajectory where the unlock happened).
   */
  locator?: string;
  createdAt: number;
}

// ============================================================================
// ProjectFact — semantic / project memory (L4).
//
// Facts are NOT reasoning patterns. They are durable statements about a
// concrete artifact, repo, or team preference. Retrieved in parallel to
// blocks but by scope + invariants, not by trigger match.
// See docs/DESIGN_v2.md §L4 for retrieval semantics and lifecycle.
// ============================================================================

export type ProjectFactType =
  | "convention"      // "tests go in tests/, not __tests__/"
  | "schema"          // "users.email is UNIQUE NOT NULL"
  | "repo_fact"       // "build command is `pnpm build`"
  | "architecture"    // "auth lives in services/auth/, not middleware/"
  | "preference";     // "favor small PRs over big ones"

export type ProjectFactStatus = "active" | "stale" | "retired";

export interface ProjectFactSource {
  origin: "observed" | "declared" | "imported";
  /** If observed, the trace from which it was inferred. */
  traceId?: string;
  /** If declared, who declared it. */
  author?: string;
  /** Optional reference: file path, commit sha, URL, etc. */
  reference?: string;
}

export interface ProjectFact {
  id: string;
  version: number;
  /**
   * Scope: dotted path, most-specific first. More-specific scopes
   * override less-specific ones at retrieval time.
   * Examples: "repo:myorg/app", "team:payments", "global".
   */
  scope: string;
  factType: ProjectFactType;
  /** The fact itself, ≤ 60 words, declarative. */
  statement: string;
  /** Same invariants structure as blocks, used as hard prefilter. */
  invariants: BlockInvariants;
  source: ProjectFactSource;
  /** Posterior confidence 0..1 (0.5 prior before verification). */
  confidence: number;
  /** Last time this fact was confirmed still true. */
  lastVerifiedAt: number;
  createdAt: number;
  updatedAt: number;
  status: ProjectFactStatus;
}

/** Input for creating a new project fact; computed fields filled by storage. */
export interface StoreProjectFactInput {
  scope: string;
  factType: ProjectFactType;
  statement: string;
  invariants: BlockInvariants;
  source: ProjectFactSource;
  /** Optional override of default 0.5 prior. */
  confidence?: number;
}

// ============================================================================
// Analytics events (Pillar 4) — append-only log records
//
// Emitted to a JSONL sink; aggregated into SQL views by the analytics
// pipeline. Each event is self-contained; consumers need no shared state.
// ============================================================================

export type AnalyticsEvent =
  | RetrievalEvent
  | InjectionEvent
  | AgentUsedEvent
  | OutcomeEvent;

interface EventBase {
  ts: number;
  queryId: string;
  /**
   * Optional correlation id for grouping events produced by a single
   * evaluation / benchmark / user session. Preserved by storage,
   * JSONL export, and aggregation filters. May be provided via the
   * event object directly or via `appendEvent`'s `extra` param — if
   * both are given, the `extra` value wins.
   */
  runId?: string;
}

export interface RetrievalEvent extends EventBase {
  event: "retrieval";
  candidates: Array<{ blockId: string; score: number }>;
  /** Whether this query is in the shadow control group (no injection will fire). */
  shadow: boolean;
}

export interface InjectionEvent extends EventBase {
  event: "injection";
  blockId: string;
  score: number;
  /** Calibrated probability of helpful, if calibrator has been fit. */
  calibratedProb?: number;
}

export interface AgentUsedEvent extends EventBase {
  event: "agent_used";
  blockId: string;
  /** How we detected the agent actually followed the block. */
  matchSignal: "jaccard" | "embedding" | "explicit";
  matchScore: number;
}

export interface OutcomeEvent extends EventBase {
  event: "outcome";
  resolved: boolean;
  /** True if an inverse-counterfactual suggests the injection caused a regression. */
  regressed?: boolean;
  tokens?: number;
  steps?: number;
  /** True if this query was a shadow control (no injection was shown). */
  control: boolean;
}
