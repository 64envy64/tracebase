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
  /**
   * Stable per-project identifier. Generated by `tracebase init`, preserved
   * across re-inits. Phase 6.0 writes it for local identification and so
   * Phase 6.2+ cloud sync can correlate a local store to a cloud workspace
   * without a separate enrollment step. Core logic never reads it.
   */
  workspaceId?: string;
  /**
   * Local-only HMAC key for tool-argument bucketing (0.5.3 TB TOOL).
   * 32 random bytes, hex-encoded. Used as the secret in
   * `arg_key = HMAC(workspaceSalt, canonical(allowlistedFields))`
   * so the same Read of the same file collides into the same bucket
   * across tool calls — without making the bucket id linkable across
   * workspaces. NEVER leaves the local machine: the cloud allowlist
   * forbids `arg_key`, `arg_summary`, `tool_use_id`, `session_id`, and
   * `batch_id`. Generated lazily on first read for installs created
   * before 0.5.3 — present-from-init for new ones.
   */
  workspaceSalt?: string;
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
  /**
   * Optional hosted control-plane linkage.
   *
   * This augments the local-first store with a remote workspace identity for
   * dashboard install visibility, API-key-scoped enrollment, and future cloud
   * sync. Core recall/store logic remains usable without it.
   */
  cloud?: CloudLinkConfig;
  /** Agent-specific local install target selected by `tracebase init`. */
  install?: InstallConfig;
  /**
   * Experimental-holdout configuration. Optional, default off: a
   * config without this field leaves serving byte-identical to
   * pre-Phase-3 behaviour. See `HoldoutConfig` for the exact
   * semantics and `src/experiments/serving.ts` for how consumers
   * turn it into an `ExperimentInput` for `BlockServer.recall`.
   */
  experiment?: ExperimentConfig;
}

/**
 * Container for per-experiment configuration. Phase 3 only ships
 * `holdout` — the deterministic withhold-from-injection experiment
 * that feeds the causal layer. Future experiments plug in here
 * alongside.
 */
export interface ExperimentConfig {
  holdout?: HoldoutConfig;
}

/**
 * State of the holdout experiment on this local project.
 *
 * The salt is generated once on first enable and preserved across
 * disable → re-enable cycles. Rotating it would re-assign cohorts
 * for every fingerprint, corrupting any causal inference that
 * spans the toggle.
 */
export interface HoldoutConfig {
  /** When false, no query is assigned to the holdout cohort. */
  enabled: boolean;
  /** Holdout rate in (0, 1]. Ignored by serving when `enabled === false`. */
  rate: number;
  /**
   * Deterministic assignment salt, stable for the lifetime of this
   * local project. Generated on first enable and preserved across
   * disable / re-enable.
   */
  salt: string;
  /** ISO timestamp of first-ever enable. Preserved on later re-enables. */
  createdAt: string;
  /** ISO timestamp of the last enable / disable state change. */
  updatedAt: string;
}

export type InstallAgent = "claude-code" | "cursor" | "codex";

export interface InstallConfig {
  /**
   * All adapters wired up by `tracebase init`. A project can have more
   * than one active integration (e.g. Claude Code + Cursor on the same
   * machine). May be an empty array as a deliberate "detached"
   * sentinel after `tracebase remove --keep-store` clears every
   * adapter — this distinguishes an intentional detach from a legacy
   * config (where `install` itself is absent) and lets `status` /
   * `doctor` avoid reinventing a phantom default agent.
   */
  agents: InstallAgent[];
  /**
   * Back-compat: earlier versions stored a single `agent` field. New
   * code should read `agents` instead; this is preserved only so older
   * configs continue to load without migration.
   * @deprecated Use `agents` instead.
   */
  agent?: InstallAgent;
}

export interface CloudLinkConfig {
  /** Hosted TraceBase control-plane origin, e.g. https://tracebase.app */
  apiUrl: string;
  /** Remote hosted workspace UUID. Separate from local project workspaceId. */
  workspaceId: string;
  /** Human-readable hosted workspace slug for UX / install status. */
  workspaceSlug?: string;
  /**
   * Hosted installation UUID of the primary adapter.
   * @deprecated Use `installationIds` for multi-agent attribution. This
   *   field is still populated with the primary agent's id so older
   *   CLI releases keep working; new code should read `installationIds`.
   */
  installationId?: string;
  /**
   * Hosted installation UUID per local adapter. Each agent in
   * `install.agents` gets its own cloud installation row so usage
   * samples and the dashboard can attribute per-agent.
   * Keys are `InstallAgent` strings; values are cloud UUIDs.
   */
  installationIds?: Partial<Record<InstallAgent, string>>;
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
/**
 * Discriminator for procedural blocks (L2).
 *
 * - "success": distilled from a SOLVED trajectory. The body describes a
 *   reusable fix — `mechanism` is the root cause, `unlock` is the
 *   pivotal insight, `verification` is how to confirm the fix. This is
 *   the only kind the pre-failure-lane codebase produced.
 * - "pitfall": distilled from a FAILED trajectory. The body describes
 *   a recurring dead-end pattern — `mechanism` is the misleading
 *   intuition that trapped the agent, `deadEnds` are the concrete
 *   ways the trap manifests, `unlock` is the corrective redirect out
 *   of the trap, `verification` is the falsification check that tells
 *   you you're on the false path. `guardrails` are early signals that
 *   SHOULD stop the agent before it commits to the wrong direction.
 *
 * Retrieval / serving semantics for `pitfall` blocks are not expanded
 * in this change: they are stored as `status: "candidate"` and never
 * promoted to `active` automatically. A future phase wires held-out
 * verification into promotion. See docs/DESIGN_v2.md §L2 and the
 * failure-distillation lane in src/distillation/pipeline.ts.
 */
export type BlockKind = "success" | "pitfall";

export interface ReasoningBlock {
  id: string;
  /** Schema version, bumps on breaking change. v1 = first release. */
  version: number;
  /**
   * Discriminator between success-derived blocks and failure-derived
   * pitfall blocks. See `BlockKind` for semantics. Treat as required;
   * legacy rows persisted before the field existed are rehydrated as
   * "success" by the store.
   */
  kind: BlockKind;

  trigger: BlockTrigger;
  body: BlockBody;
  provenance: BlockProvenance;
  stats: BlockStats;
  quality: BlockQuality;
  embeddings?: BlockEmbeddings;
  /**
   * Orthogonal to `status`: whether this block has been independently
   * verified on a held-out task by an external verifier. Phase 4 ships
   * this as metadata only ({status: "unverified"} default); Phase 4.5
   * introduces the real verifier that flips `pending` → `verified` /
   * `disproved`. A `verified` flag is not required for serving.
   */
  verification?: BlockVerification;

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
  /**
   * For `kind = "success"`: root-cause structure of the bug.
   * For `kind = "pitfall"`: the misleading intuition the agent followed
   * when walking into the trap (why the false path looked plausible).
   */
  mechanism: string;
  /**
   * Approaches that look plausible but fail; prevents wasted exploration.
   * Required to be non-empty (≥ 1 entry) when `kind = "pitfall"` — a
   * pitfall block without a concrete dead-end carries no signal.
   */
  deadEnds: string[];
  /**
   * The key insight, ≤ 30 words.
   * For `kind = "success"`: the pivotal step that solved the problem.
   * For `kind = "pitfall"`: the corrective redirect — what to do
   * instead to leave the false path.
   */
  unlock: string;
  /**
   * For `kind = "success"`: how to confirm the fix actually worked
   * (e.g. a reproduction test).
   * For `kind = "pitfall"`: the falsification check — how to recognize
   * that the current approach is on the false path and must be abandoned.
   */
  verification: string;
  /**
   * Early warning signals. Each entry ≤ 20 words; at most 3 entries.
   * Optional on success blocks, meaningful on pitfall blocks as the
   * "if you see X, stop" guard before the agent commits to the wrong
   * direction. Leakage regex applies to each entry.
   */
  guardrails?: string[];
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
  /**
   * Distiller's own 0..1 self-reported confidence that the extracted
   * pattern is clean and reusable (not task-specific noise). Immutable
   * snapshot at distillation time; calibrator output lives in
   * `quality.confidence` instead.
   */
  distillationConfidence?: number;
  /**
   * Structural validation report captured at distillation time.
   * Immutable. See ValidationReport for the shape of individual checks.
   */
  validationReport?: ValidationReport;
}

/**
 * A single structural check run by the distillation validator. Names
 * are namespaced by check family (e.g. "leakage:patch-hunk",
 * "schema:situation-length").
 */
export interface ValidationCheck {
  name: string;
  passed: boolean;
  reason?: string;
}

/**
 * Report of all structural checks run by the distillation validator on
 * a candidate block. Stored in `BlockProvenance.validationReport` as
 * an audit trail — never mutated after creation.
 */
export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheck[];
  /** Epoch ms at validation time. */
  checkedAt: number;
}

/**
 * Lifecycle of verification separately from the block's own status.
 * A block may be `active` (served) but `unverified`; Phase 4.5 adds a
 * real verifier that advances the status based on held-out task runs.
 */
export type VerificationStatus = "unverified" | "pending" | "verified" | "disproved";

export interface BlockVerification {
  status: VerificationStatus;
  /** Name of the verifier that produced the current status. */
  verifier?: string;
  /** Last time verification was attempted / updated. Epoch ms. */
  verifiedAt?: number;
  /** Task ID used for verification (e.g. a held-out benchmark case). */
  taskId?: string;
  /** Free-text explanation (used on pending / disproved). */
  reason?: string;
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
  /**
   * Discriminator between success-derived blocks and failure-derived
   * pitfall blocks. Optional for backwards-compatible call sites —
   * `createBlock` defaults unset inputs to `"success"` so pre-failure
   * callers continue to produce success blocks byte-identically.
   */
  kind?: BlockKind;
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
  | "preference"      // "favor small PRs over big ones"
  | "file_semantic"   // "tests live under tests/cli/*.test.ts" — 0.5.0 TB MEMORY bucket
  | "session_digest"; // bounded deterministic digest of a Claude Code session before compaction — 0.5.2 TB CONTEXT bucket

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
  /**
   * Optional absolute expiry timestamp (epoch ms). When set, the
   * doctor sweep retires the fact once `Date.now() > ttlUntilAt`.
   * Used by `session_digest` facts to cap their lifetime at ~14
   * days; omitted for durable facts that never expire.
   */
  ttlUntilAt?: number;
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
  /**
   * Optional TTL in days. Storage converts this to an absolute
   * `ttlUntilAt = createdAt + ttlDays * 86_400_000` at write time.
   * `0` / negative / undefined = no expiry.
   */
  ttlDays?: number;
}

// ============================================================================
// ToolObservation — 0.5.3 TB TOOL / TB LOOP substrate.
//
// One row per completed tool call observed via Claude Code's
// `PostToolBatch` hook. Bodies are NEVER stored (tool_input is
// sanitised down to allowlisted fields; tool_response is ignored).
// `arg_key` is the HMAC bucket the next UserPromptSubmit hook reads
// to detect duplicate calls / loops / ping-pong without ever seeing
// the literal arguments.
//
// Privacy invariant (enforced by the cloud allowlist):
//   `tool_observations` rows NEVER ship to the control plane.
//   Aggregates (duplicate_count / loop_count / family_counts) may.
// ============================================================================

export type ToolObservationOutcome = "ok" | "error" | "unknown";

export interface ToolObservation {
  id: string;
  /** Wall-clock ms when the observation was recorded. */
  ts: number;
  /** Stable Claude Code session id (dedup window scope). */
  sessionId: string;
  /**
   * Optional batch correlation id. Live PostToolBatch payloads do
   * not carry one today, so this stays null in practice — kept on
   * the schema for forward-compat.
   */
  batchId: string | null;
  /** 0-indexed position within the originating tool batch. */
  batchOrder: number;
  /** Claude Code's per-call id (`toolu_…`); used for dedup. */
  toolUseId: string | null;
  /** "Read", "Grep", "Bash", … */
  toolName: string;
  /** Human-readable, allowlisted-fields-only normalisation. */
  argSummary: string;
  /** HMAC(workspaceSalt, canonical(allowlistedFields)). */
  argKey: string;
  /** Outcome class; "unknown" when the host doesn't surface one. */
  outcome: ToolObservationOutcome;
  /** Pointer to a prior observation that subsumes this one (future use). */
  redundantOf: string | null;
  createdAt: number;
}

export interface RecordToolObservationInput {
  sessionId: string;
  batchId?: string | null;
  batchOrder: number;
  toolUseId?: string | null;
  toolName: string;
  argSummary: string;
  argKey: string;
  outcome?: ToolObservationOutcome;
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
  | OutcomeEvent
  | FactInjectionEvent
  | FactAgentUsedEvent;

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
  /** Fact candidates retrieved alongside procedural blocks (may be empty). */
  factCandidates?: Array<{ factId: string; score: number }>;
  /** Whether this query is in the control arm (no injection will fire). */
  shadow: boolean;
  /**
   * When `shadow === true`, why this query is in the control arm.
   * Phase 3 introduces a second control source alongside the existing
   * manual / diagnostic shadow:
   *   - "shadow"  — manual or legacy diagnostic shadow. This is the
   *                 default for every `shadow: true` event written
   *                 before Phase 3; analytics treat it as
   *                 diagnostic-only, never as causal proof.
   *   - "holdout" — deterministic experimental holdout keyed by the
   *                 query fingerprint. Only this cohort is eligible
   *                 for a causal assisted-vs-control comparison.
   *
   * Undefined on non-shadow queries and on legacy shadow events that
   * predate this field. Analytics must treat an undefined
   * `controlReason` on a `shadow: true` event as `"shadow"` for
   * back-compat.
   */
  controlReason?: "shadow" | "holdout";
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
  /**
   * Wall-clock time the run took, in milliseconds. Optional because
   * older telemetry never carried it; Phase 1 usage analytics uses
   * it to derive an estimated `latencySavedMs` when both a treatment
   * and shadow arm are populated.
   */
  durationMs?: number;
  /** True if this query was a shadow control (no injection was shown). */
  control: boolean;
}

// ----------------------------------------------------------------------------
// Fact-level events (L4 first-class analytics). ProjectFact is memory in its
// own right, with its own retrieval path, its own lifecycle, and therefore
// its own helpful/counterproductive attribution. Parallel to block events,
// never mixed — facts and blocks are orthogonal.
// ----------------------------------------------------------------------------

/**
 * Emitted when a retrieved ProjectFact passes the gate and is included in
 * the injection payload for a query. Analogous to InjectionEvent but for
 * the semantic (L4) layer.
 */
export interface FactInjectionEvent extends EventBase {
  event: "fact_injection";
  factId: string;
  score: number;
  calibratedProb?: number;
}

/**
 * Emitted when the agent's output provides observable evidence it used a
 * ProjectFact (e.g. mentioned it by id, or its statement overlaps the
 * agent's reasoning). Mirrors AgentUsedEvent but for facts.
 */
export interface FactAgentUsedEvent extends EventBase {
  event: "fact_agent_used";
  factId: string;
  matchSignal: "jaccard" | "embedding" | "explicit";
  matchScore: number;
}
