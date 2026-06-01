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
  /**
   * Correlation id for the recall that produced this result. Shared by
   * every `RecallResult` from a single `recall()` / `recallAsync()` call.
   * Pass to `feedback({queryId, traceId, helpful})` for unambiguous
   * attribution — the legacy single-arg `feedback(traceId)` falls back
   * to "latest unresolved", which can mis-attribute when the same trace
   * appears in multiple concurrent recalls.
   *
   * Optional only for backward compatibility — every call site that
   * goes through `ReasoningLayer.recall*()` since the May-2026 PR 1
   * populates it.
   */
  queryId?: string;
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
  /**
   * 0.5.9 §3 — optional LLM pricing for `tracebase impact`'s
   * dollar render. The CLI flags (`--price-input-per-1m`,
   * `--price-output-per-1m`) take precedence; this field is the
   * "set once, never type again" path.
   *
   * Both prices in USD per 1M tokens. When BOTH are present
   * `tracebase impact` shows an estimated dollar savings using a
   * 50/50 blend (input/output split is not tracked per-event).
   * When neither is present, dollars are NEVER inferred from a
   * model name — only token counts ship.
   */
  pricing?: PricingConfig;
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
  /**
   * 0.7.0-rc.7 — provider-side prompt-cache integration.
   *
   * Defaults to `{ enabled: true }`. Set `{ enabled: false }` to
   * disable both the Anthropic `cache_control` attachment and the
   * `cache.prompt_hit` event emission in `wrapAnthropic` /
   * `wrapOpenAI`. The aggregator stays correct either way — it
   * counts only what the provider's API actually reported.
   */
  promptCache?: {
    enabled?: boolean;
  };
}

/**
 * Container for per-experiment configuration. Phase 3 only ships
 * `holdout` — the deterministic withhold-from-injection experiment
 * that feeds the causal layer. Future experiments plug in here
 * alongside.
 */
export interface ExperimentConfig {
  holdout?: HoldoutConfig;
  /**
   * May-2026 B1.2 — cascade rollout state. Lives as a sibling of
   * `holdout` under the shared `experiment` namespace so every
   * runtime-tunable experimental knob lives under one roof.
   */
  cascade?: CascadeConfig;
}

/**
 * State of the holdout experiment on this local project.
 *
 * The salt is generated once on first enable and preserved across
 * disable → re-enable cycles. Rotating it would re-assign cohorts
 * for every fingerprint, corrupting any causal inference that
 * spans the toggle.
 */
/**
 * Persistent cascade config — May-2026 B1.2.
 *
 * Lives under `.tracebase/config.json` at `experiment.cascade` and is
 * loaded fresh on every MCP invocation so
 * `tracebase cascade enable|disable|set-rate` takes effect without
 * restarting the server. Mirrors the
 * `HoldoutConfig`-on-disk pattern so the team has one mental model
 * for "runtime-tunable experimental knobs" instead of two.
 *
 * Two layers:
 *   • `rollout` — deterministic gradual rollout of the cascade. Same
 *     SHA256-uint32 semantics as `shouldHoldOut`, so a given query
 *     fingerprint either always sees the cascade or always doesn't,
 *     and ramping `rate` from 0 → 1 is monotonic at the per-query
 *     level. Empty rollout / disabled = sync `recall()` path; the
 *     cascade is invisible to the user.
 *   • `reranker` — which Reranker impl to construct at server boot.
 *     `kind: "noop"` is the default and exercises the cascade
 *     architecture without any network calls; `kind: "cloud"` swaps
 *     in CloudReranker with the endpoint config. `kind: "minilm"` runs
 *     the local ONNX worker; `bge-v2-m3` remains reserved for the larger
 *     quality-preset follow-up.
 *
 * Changing `reranker.kind` / `endpoint` / `apiKey` requires a server
 * restart (the BlockServer captures the reranker reference at
 * construction). Changing `rollout.rate` is hot.
 */
export interface CascadeConfig {
  /** Master switch. When false, the sync recall() path is always used. */
  enabled: boolean;
  /** Deterministic per-query rollout. */
  rollout: {
    /** Rate in [0, 1]. 0 disables, 1 routes every query through the cascade. */
    rate: number;
    /**
     * Per-project salt — must be stable across enable/disable cycles
     * so a query that landed in the cascade arm yesterday stays
     * there today. Generated on first enable, preserved on later
     * state changes (same lifecycle as `HoldoutConfig.salt`).
     */
    salt: string;
  };
  /** Reranker selection. */
  reranker: {
    /**
     * Implementation kind.
     *   • "noop"  — pass-through; identity rerank. Default; zero deps.
     *   • "cloud" — POST to a hosted endpoint via CloudReranker.
     *               Requires `endpoint`; `apiKey` and `model` are
     *               optional pass-throughs.
     *   • "minilm" / "bge-v2-m3" — reserved; land in the local-ONNX
     *               follow-up PR alongside `doctor --fix`.
     */
    kind: "noop" | "cloud" | "minilm" | "bge-v2-m3";
    /** CloudReranker endpoint URL. Required when kind === "cloud". */
    endpoint?: string;
    /** Bearer token for the cloud endpoint. */
    apiKey?: string;
    /** Optional model identifier the cloud endpoint understands. */
    model?: string;
  };
  /** Reranker timeout in ms. Default 300. */
  timeoutMs?: number;
  /** MMR relevance/diversity tradeoff. Default 0.7. */
  mmrLambda?: number;
  /** Pre-reranker over-fetch multiplier. Default 4. */
  fetchMultiplier?: number;
  /** ISO timestamp of first-ever enable. Preserved on later re-enables. */
  createdAt: string;
  /** ISO timestamp of the last state change. */
  updatedAt: string;
}

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

/**
 * 0.5.9 §3 — optional pricing config for `tracebase impact`'s
 * dollar-savings render. Both fields are USD per 1M tokens.
 * The render shows dollars ONLY when both fields resolve to
 * positive numbers (CLI flags win over config; neither set →
 * tokens-only render). Token counts always ship; dollars
 * never come from a model-name lookup.
 */
export interface PricingConfig {
  /** USD cost per 1,000,000 input (prompt) tokens. */
  inputPer1mTokens?: number;
  /** USD cost per 1,000,000 output (completion) tokens. */
  outputPer1mTokens?: number;
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
  | { type: "tokens:tracked"; data: TokenUsageData }
  // May-2026 PR 3 (audit #1) — embedding pipeline failure surfaced
  // instead of silently swallowed. Subscribers (doctor, observability)
  // read this to track the retry queue depth.
  | { type: "embedding:failed"; traceId: string; error: string };

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
   * 0.5.4 SDK runtime opt-in. When set, the wrapper routes through
   * `runtime.beforeRun()` instead of the v1 `performRecall` path,
   * unlocking five-capability parity (TB TRACE / MEMORY / CONTEXT /
   * TOOL / LOOP) for OpenAI / Anthropic clients without changing the
   * wrapper signature.
   */
  runtime?: Runtime;
  /**
   * 0.5.4 BadgeEvent callback. When set without an explicit `runtime`,
   * the wrapper builds an internal runtime lazily so the callback
   * still fires. Throws inside the callback are swallowed and never
   * propagate into the wrapped LLM call.
   */
  onBadge?: (ev: BadgeEvent) => void;
  /** Default session id forwarded into runtime.beforeRun. */
  sessionId?: string;
  /** Project root passed to the runtime. Defaults to `findProjectRoot(cwd)`. */
  projectPath?: string;
  /** BadgeEvent.source attribution. Defaults to `"openai"` / `"anthropic"`. */
  source?: RuntimeSource;
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
  extractedFrom: "trajectory" | "gold_patch" | "manual" | "imported" | "distilled";
  distilledAt: number;
  distilledBy: "llm" | "rule" | "manual";
  distilledWithModel?: string;
  /** Version of the capture pipeline that produced this block (audit). */
  captureVersion?: string;
  /** Version / name of the distiller that produced this block (audit). */
  distillerVersion?: string;
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
// SDK runtime — 0.5.4 framework-neutral surface (PLAN-0.5.4 §3).
//
// Brings five-capability parity (TB TRACE / TB MEMORY / TB CONTEXT /
// TB TOOL / TB LOOP) to non-Claude-Code hosts. The runtime is what
// `wrapOpenAI` / `wrapAnthropic` / `wrapAgent` / `wrapGeneric` build
// on top of; users can also instantiate one directly via
// `createRuntime(layer, options)` for custom integrations.
//
// Privacy invariant (enforced by tests in tests/sdk/badge-event-privacy.test.ts):
//   `BadgeEvent` carries counts + labels + queryId only. NEVER the
//   user prompt, the assistant response, tool_input bodies,
//   tool_response bodies, argSummary, argKey, sessionId, file paths,
//   code, or transcript text. The TypeScript shape itself excludes
//   those keys; assigning an object literal with any of them to
//   `BadgeEvent` is a compile error.
// ============================================================================

// 0.7.0-rc.3 §rc.3 — `memory-files` is the file-memory bullet split
// out from the long-running `memory` (project_facts) bullet so the
// two counters never merge. The spec contract: file count counts
// `indexed_files` rows surfaced by recallFiles; the legacy `memory`
// bullet keeps counting project_facts where `provenance_kind !=
// "indexer"`. Wrappers that route badges by kind get one event per
// bullet rather than a combined number.
export type BadgeEventKind =
  | "trace"
  | "memory"
  | "memory-files"
  | "context"
  | "tool"
  | "loop";

/**
 * One observable event surfaced from the runtime to wrapper-side
 * `onBadge` callbacks. Mirrors the in-process equivalent of the
 * Claude Code `systemMessage` line, decomposed so SDK consumers can
 * route TB TRACE / TB LOOP / etc. independently.
 *
 * **Forbidden keys** (must never appear on this type or be added in
 * a future minor): `prompt`, `response`, `assistantText`,
 * `tool_input`, `tool_response`, `argSummary`, `argKey`, `sessionId`,
 * `file_path`, `path`, `code`, `transcript`. The privacy regression
 * test asserts this set is disjoint from `keyof BadgeEvent`.
 */
export interface BadgeEvent {
  kind: BadgeEventKind;
  /** Human-readable line, e.g. "▣ TB LOOP  straight × 3 (Read)". */
  label: string;
  /** Pattern hits, fact hits, repeated/loop count. Counts only. */
  count?: number;
  /** Tool name on tool / loop kinds. NEVER argSummary / argKey. */
  toolName?: string;
  /** Stable per-call recall id so callers can correlate with their logs. */
  queryId?: string;
  /** Approximate token cost of injected context (recall-side only). */
  tokens?: number;
  /** Wall-clock ms when the wrapper observed the event. */
  ts: number;
  /** Wrapper source: "openai" | "anthropic" | "agent" | "generic" | etc. */
  source?: string;
}

/**
 * Sources we expect wrappers to identify themselves as. Free-form
 * `string` is also accepted on `BadgeEvent.source` so a custom host
 * can attribute its own integration without forking this enum.
 */
export type RuntimeSource =
  | "openai"
  | "anthropic"
  | "agent"
  | "generic"
  | "langchain"
  | "langgraph"
  | "claude-agent-sdk";

export type RuntimeServingProfile = "cost-saver" | "balanced" | "recall-heavy";

export interface CreateRuntimeOptions {
  /** Default session id for runtime methods that don't pass one explicitly. Auto-generated per runtime when omitted. */
  sessionId?: string;
  /** Default project root for runtime methods that don't pass one explicitly. */
  projectPath?: string;
  /** Wrapper attribution for `BadgeEvent.source`. */
  source?: RuntimeSource;
  /**
   * Per-event callback. Throws inside this callback are swallowed and
   * never propagate into the wrapped LLM call. Tests assert this.
   */
  onBadge?: (ev: BadgeEvent) => void;

  /** Per-capability switches. All default to true. */
  enableTrace?: boolean;
  enableMemory?: boolean;
  enableContext?: boolean;
  enableTool?: boolean;
  enableLoop?: boolean;
  /**
   * Prompt-serving profile. Passing ANY explicit profile opts the
   * runtime into the serving-policy stack (cap clamps + file/chunk
   * ROI filters) — independently of the `TRACEBASE_SERVING_ARBITER`
   * env flag, which controls the ROI arbiter and its
   * `arbitration_decision` event emission.
   *
   *   • undefined / null + env unset → policy off, arbiter off
   *     (pre-serving-policy legacy: 1200/4/4/3/3 builder defaults).
   *   • explicit profile + env unset → policy ON (caller's profile),
   *     arbiter off (no `arbitration_decision` events).
   *   • undefined + env="1" → policy ON (cost-saver default),
   *     arbiter ON.
   *   • explicit profile + env="1" → policy ON (caller's profile),
   *     arbiter ON.
   *
   * `recall-heavy` preserves broad legacy-shape recall for debugging
   * or explicit deep-recall sessions.
   */
  servingProfile?: RuntimeServingProfile;

  /**
   * Background aggregate-metrics sync. Defaults to `true` iff
   * `.tracebase/config.json` carries a `cloud.workspaceId`. Setting
   * `false` here disables the coordinator regardless of cloud link
   * state — useful for tests and air-gapped deployments.
   */
  autoSync?: boolean;
  /** Debounce window. Default 30 000 ms. Restarts on every markDirty. */
  syncDebounceMs?: number;
  /** Max coalesce window. Default 300 000 ms (5 min). Forces a send. */
  syncMaxIntervalMs?: number;
}

export interface BeforeRunInput {
  /** User prompt the upstream LLM call is about to receive. */
  prompt: string;
  /** Overrides `CreateRuntimeOptions.sessionId` for this call only. */
  sessionId?: string;
  /** Overrides `CreateRuntimeOptions.projectPath` for this call only. */
  projectPath?: string;
  /** Overrides `CreateRuntimeOptions.servingProfile` for this call only. */
  servingProfile?: RuntimeServingProfile;
}

export interface BeforeRunResult {
  /**
   * Pre-prompt context to inject into the LLM call. Empty string when
   * recall returned nothing or the prompt was trivial — wrappers may
   * still inject the empty string into a `system` message slot or
   * skip injection entirely; the runtime makes no assumption.
   */
  additionalContext: string;
  /** TB TRACE / MEMORY / CONTEXT / TOOL / LOOP events for this call. */
  badgeEvents: BadgeEvent[];
  /** Stable id for `record_reasoning_outcome` later, when present. */
  queryId?: string;
}

export interface AfterRunInput {
  userText: string;
  assistantText: string;
  sessionId?: string;
  projectPath?: string;
}

export interface ObserveToolBatchInput {
  sessionId: string;
  /** Workspace root the call ran against. Alias: `cwd`. */
  projectPath?: string;
  /** Per-call shape mirrors PostToolBatch's `tool_calls`. */
  toolCalls: Array<{
    toolName: string;
    /** Raw tool input. Sanitiser only reads named fields per tool. */
    toolInput: unknown;
    toolUseId?: string;
    outcome?: ToolObservationOutcome;
  }>;
}

export interface ObserveToolBatchResult {
  /** Number of `tool_observations` rows persisted in this batch. */
  recorded: number;
}

export interface SaveContextInput {
  sessionId: string;
  projectPath?: string;
  /**
   * Either `turns` (raw user/assistant chunks — runtime extracts a
   * deterministic digest, no paraphrase) or `digest` (caller-supplied
   * text — runtime bound + leakage-scans before storing). Caller
   * passes one or the other; passing both prefers `digest`.
   */
  turns?: Array<{ role: "user" | "assistant"; content: string }>;
  digest?: string;
}

export interface SaveContextResult {
  /** Stored project_facts row id, or null on no-op (empty / leakage / TTL). */
  factId: string | null;
}

export interface Runtime {
  /**
   * SDK equivalent of Claude Code's `UserPromptSubmit` hook.
   * Recalls TRACE + MEMORY + same-session CONTEXT facts, runs the
   * tool-loop detector against the previous turn's
   * `tool_observations`, emits BadgeEvents to `onBadge`, and returns
   * the additional context for the wrapper to inject.
   */
  beforeRun(input: BeforeRunInput): Promise<BeforeRunResult>;

  /**
   * SDK equivalent of `Stop`. Best-effort, async — returns
   * immediately to the caller; the actual capture runs on the
   * runtime's queue. Use `flush()` to wait in tests / enterprise
   * shutdown.
   */
  afterRun(input: AfterRunInput): Promise<void>;

  /**
   * SDK equivalent of `PostToolBatch`. Persists one
   * `tool_observations` row per call in a single SQLite transaction
   * after sanitising each `tool_input` through the per-tool
   * projection. Never reads `tool_response`.
   */
  observeToolBatch(input: ObserveToolBatchInput): Promise<ObserveToolBatchResult>;

  /**
   * SDK equivalent of `PreCompact`. Stores a session-scoped digest
   * with TTL so the next `beforeRun` in the same session can recall
   * across the compaction boundary.
   */
  saveContext(input: SaveContextInput): Promise<SaveContextResult>;

  /**
   * Wait for queued capture jobs and any pending sync attempt to
   * resolve. Idempotent. Tests rely on this. Enterprise shutdown
   * paths should call it before exit.
   */
  flush(): Promise<void>;

  /**
   * 0.7.0-rc.3 §rc.3 — explicit indexer pass.
   *
   * Walks the workspace under the documented budget (defaults
   * `{ timeMs: 30000, maxFiles: 5000, maxBytesScan: 64 MiB }`) and
   * upserts `indexed_files`. Returns aggregate counts only —
   * never paths / hashes / summaries (those stay local).
   *
   * `tracebase init` calls this automatically; SDK consumers call
   * it directly when they want to refresh the index outside the
   * init flow (e.g. after a large checkout / git pull).
   */
  indexFiles(input: IndexFilesInput): Promise<IndexFilesResult>;

  /**
   * 0.7.0-rc.3 §rc.3 — direct file-memory recall.
   *
   * Equivalent of `beforeRun`'s file recall, exposed for callers
   * that want the hits without the full block + fact + tool path.
   * FTS5 over `indexed_files(summary, symbols)`. Top-K bounded
   * (default 3, hard ceiling 10).
   */
  recallFiles(input: RecallFilesInput): Promise<RecallFilesResult>;

  /**
   * 0.7.0-rc.6 §rc.6 — chunk-based context compression.
   *
   * Folds a `{role, content}[]` turn list into rolling chunks
   * (8 turns or ≥ 4k tokens, whichever first). Same-session-only;
   * the next `beforeRun` for the same session can recall the
   * chunks via `recallChunks` (and they auto-inject under
   * `<context_fold>` from `beforeRun`).
   *
   * Watermark is read from `session_chunks.MAX(chunk_end_turn)`,
   * so passing the same `turns` twice is idempotent — the second
   * call sees its own writes and folds nothing new.
   */
  foldContext(input: FoldContextInput): Promise<FoldContextResult>;

  /**
   * 0.7.0-rc.6 §rc.6 — direct chunk recall.
   *
   * SAME-SESSION ONLY. Cross-session recall is structurally
   * impossible — the SQL filters on `session_id`.
   */
  recallChunks(input: RecallChunksInput): Promise<RecallChunksResult>;

  /**
   * Release the SQLite handle and clear sync timers. Idempotent.
   * Subsequent runtime method calls reject with a clear error.
   */
  close(): Promise<void>;
}

// ----------------------------------------------------------------------------
// 0.7.0-rc.3 §rc.3 — file memory I/O types.
//
// Both shapes intentionally exclude path / hash / content fields
// from the wire; only counts surface to the cloud allowlist
// (USAGE_FILE_INDEX_SPEC + USAGE_FILE_MEMORY_SPEC).
// ----------------------------------------------------------------------------

export interface IndexFilesInput {
  /** Workspace root. Required. */
  root: string;
  /** Optional budget overrides; missing fields fall back to spec defaults. */
  budget?: {
    timeMs?: number;
    maxFiles?: number;
    maxBytesScan?: number;
  };
  /** Per-file size cap, default 256 KiB. */
  maxBytes?: number;
  /** Summarizer label written on each indexed_files row. Default 'heuristic'. */
  summarizer?: "heuristic" | "embedding" | "llm";
}

export interface IndexFilesResult {
  indexedCount: number;
  bytesSummarized: number;
  durationMs: number;
  pendingFilesCount: number;
  pendingDirsCount: number;
  /** Reason → count map; never carries paths. */
  skipped: Record<string, number>;
  summarizer: "heuristic" | "embedding" | "llm";
}

export interface RecallFilesInput {
  /** Free-text prompt. Empty / too-short prompts return [] without throwing. */
  prompt: string;
  /** Top-K cap (default 3, hard ceiling 10). */
  k?: number;
}

export interface RecallFilesResult {
  /** Hits in bm25 score order. May be empty. */
  hits: Array<{
    relPath: string;
    summary: string;
    /** JSON-encoded symbols payload; parseable. */
    symbols: string;
    language: string | null;
    sizeBytes: number;
    score: number;
  }>;
}

// ----------------------------------------------------------------------------
// 0.7.0-rc.6 §rc.6 — context-fold SDK I/O.
// ----------------------------------------------------------------------------

export interface FoldContextInput {
  sessionId: string;
  /** `{role, content}` turn list, oldest-first. Skipped when empty. */
  turns: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
}

export interface FoldContextResult {
  /** Number of NEW chunks persisted by this call. */
  chunkCount: number;
  /** Sum of `tokens_before` across the new chunks. */
  tokensBefore: number;
  /** Sum of `tokens_after` across the new chunks. */
  tokensAfter: number;
  /** Reason → count map; never carries paths or summaries. */
  skipped: Record<string, number>;
}

export interface RecallChunksInput {
  sessionId: string;
  /** Top-K cap (default 3). Recall is scoped to the same session only. */
  k?: number;
}

export interface RecallChunksResult {
  /** Oldest-first within the K-window. May be empty. */
  hits: Array<{
    chunkStartTurn: number;
    chunkEndTurn: number;
    summary: string;
    tokensBefore: number;
    tokensAfter: number;
  }>;
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
  | FactAgentUsedEvent
  // Trace-domain events (May-2026 PR 1) — V1 attribution via persistent
  // event log. Parallel to block_* / fact_* events; never mixed.
  | TraceRetrievalEvent
  | TraceAgentUsedEvent
  | TraceFeedbackEvent
  // 0.7.0-rc.1 — store-side rejection event. Emitted when the
  // prompt-injection guard rejects a write. rc.1 is the only rc
  // that actually emits this; later rcs (file indexer, chunk
  // summary, import) reuse the same event kind from their own
  // surfaces.
  | StoreInjectionRejectedEvent
  // 0.7.0-rc.2..rc.7 — type-only scaffolding. The emitter for each
  // event kind lands in the rc that introduces the corresponding
  // capability. Listing them here in rc.1 lets the cloud allowlist
  // (§rc.1 §Ground) lock the per-kind aggregate spec without a
  // forward dependency on later rc code.
  | FileIndexCompletedEvent
  | FileIndexSkippedEvent
  | FileMemoryRecalledEvent
  | ToolSupervisionWarnedEvent
  | ToolSupervisionSuppressedEvent
  | ToolSupervisionAllowedAfterEditEvent
  | ToolSupervisionCacheHitEvent
  | ToolSupervisionWouldBlockEvent
  | LoopRedirectedEvent
  | LoopFallbackEvent
  | ContextFoldedEvent
  | ContextFoldSkippedEvent
  | CachePromptHitEvent
  // May-2026 — every-run-learning signals.
  | CalibratorRefitEvent
  | DriftInjectionEvent
  // May-2026 C4 — lifecycle: a block transitioned active → demoted
  // via the memory-health gate. Emitted exactly once per
  // demotion; carries the reason codes and component breakdown
  // so the dashboard can show *why* memory shrank.
  | BlockDemotedEvent
  // May-2026 C4-runtime — one event per arbiter decision. Emitted
  // ONLY when TRACEBASE_SERVING_ARBITER=1; default path produces
  // zero of these (byte-for-byte identity when the env is unset).
  | ArbitrationDecisionEvent
  // R1 (May-2026) — capture-path failure telemetry. Emitted whenever
  // the Stop hook or SDK afterRun swallows an error from pattern /
  // fact extraction or storage. Replaces the previous stderr-only
  // behaviour so the dashboard can show *why* captures fail
  // (validation, leakage, store error) instead of pretending nothing
  // went wrong.
  | CaptureErrorEvent
  // Router V2 (rollout=shadow) — one event per recall comparing the served V1
  // decision with the side-by-side V2-family decision on the SAME candidate
  // slate. Privacy-safe (queryHash + opaque block ids + counts; no prompt /
  // body / path). Local-only: never part of the cloud UsageMetrics aggregate.
  | RouterShadowComparisonEvent
  // Phase C hybrid retrieval (TRACEBASE_REASONING_RETRIEVAL=shadow) — one event
  // per recall comparing the sparse FTS slate with the fused sparse⊕semantic
  // slate (and the decision on each). Privacy-safe + local-only, same contract.
  | RetrievalHybridComparisonEvent;

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

/**
 * Privacy-safe serving-decision telemetry, stamped on EVERY retrieval event
 * (inject, abstain, and zero-hit alike). Carries the gate's inputs + outputs
 * so an offline aggregator can report fire-rate, precision@fire, abstention
 * reasons, latency, and calibration coverage WITHOUT persisting the raw prompt
 * (only `queryHash`). Optional on the event for back-compat with pre-telemetry
 * rows — old readers ignore it, and old rows simply lack it.
 */
export interface ServingTelemetry {
  /** Correlates with the retrieval event's queryId. */
  retrievalId: string;
  /** Non-reversible hash of the prompt — never the raw text. */
  queryHash: string;
  /** Optional retrieval scope (e.g. "repo:org/app"). */
  scope?: string;
  /** Active blocks in the store at decision time. */
  corpusSize: number;
  /** Candidates the ranker returned for the decision. */
  candidateCount: number;
  /** Top candidate's absolute evidence confidence. */
  evidenceConfidence: number;
  /** Top-vs-second evidence margin. */
  margin: number;
  /** Calibrated P(helpful) for the top candidate. */
  calibratedProb: number;
  /** Whether the layer injected or abstained. */
  decision: "inject" | "abstain";
  /** Abstention reason, or "injected". */
  reason: string;
  /** Serving feature-schema version. */
  featureVersion: number;
  /** Calibrator model version, or "identity" when unfitted. */
  calibratorVersion: number | "identity";
  /** Wall-clock recall latency in ms. */
  latencyMs: number;
  /** Block IDs actually injected (empty on abstain / shadow). */
  injectedBlockIds: string[];
}

export interface RetrievalEvent extends EventBase {
  event: "retrieval";
  /** Serving-decision telemetry (Phase 1). Optional for back-compat. */
  serving?: ServingTelemetry;
  /**
   * Top-K block candidates AFTER the full cascade
   * (BM25 → rerank → MMR). `rerankerScore` + `rerankerRank` are
   * present when the cross-encoder ran successfully and absent
   * when the reranker was NoopReranker or fell back — exactly
   * the signal B3 replay-screening needs to distinguish "reranker
   * influenced this slot" from "BM25 won by default".
   */
  candidates: Array<{
    blockId: string;
    score: number;
    rerankerScore?: number;
    rerankerRank?: number;
  }>;
  /**
   * The full pre-cascade slate (every BM25 candidate scored by the
   * linear ranker) — added by May-2026 B1.1 hardening. Required by
   * B3 replay-screening: without the counter-factuals the harness
   * cannot evaluate "could a different policy have picked something
   * better than the actual top-K". Optional only for backward
   * compatibility with pre-B1.1 events.
   */
  preCascadeSlate?: Array<{ blockId: string; score: number }>;
  /**
   * Cascade telemetry — stamped by May-2026 B1.1.
   *
   * `rerankerName`           which Reranker impl ran
   * `rerankerFellBack`       true when the cascade collapsed to BM25
   * `rerankerFallbackReason` why we fell back (timeout / error / null / empty / validation)
   * `mmrLambda`              relevance/diversity tradeoff used
   * `cascadePolicyId`        e.g. "linear+rerank+mmr.v1" — change
   *                          this string when the cascade semantics
   *                          change so historical events can be
   *                          replayed honestly.
   */
  rerankerName?: string;
  rerankerFellBack?: boolean;
  rerankerFallbackReason?: "timeout" | "error" | "null" | "empty" | "validation";
  mmrLambda?: number;
  cascadePolicyId?: string;
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
  /**
   * 0.5.7 §C — token cost of the additionalContext that landed on
   * this query. Sum across the analytics window equals the total
   * injection-side tokens spent in the period; the dashboard +
   * `tracebase impact` subtract this from `causal.tokensLift.value`
   * to compute `netTokenImpact` — the honest "is the layer
   * arithmetically positive?" metric.
   *
   * Optional. Absent on legacy retrieval events; absent when the
   * payload had no content (`hasContent === false`); 0 is also a
   * valid value when nothing matched the gate.
   */
  injectedTokensEstimate?: number;
  /**
   * Runtime profile that shaped the final prompt payload. Local-only
   * diagnostic: lets impact/debug views distinguish compact ROI serving
   * from broader recall modes without inspecting prompt text.
   */
  injectionProfile?: "cost-saver" | "balanced" | "recall-heavy";
  /** Token estimate split by rendered section. */
  injectedSectionTokensEstimate?: {
    priorPatterns: number;
    facts: number;
    fileMemory: number;
    contextFold: number;
  };
  /** Count of rendered items by mechanism. */
  injectedItemCounts?: {
    blocks: number;
    facts: number;
    files: number;
    chunks: number;
  };
}

export interface InjectionEvent extends EventBase {
  event: "injection";
  blockId: string;
  score: number;
  /** Calibrated probability of helpful, if calibrator has been fit. */
  calibratedProb?: number;
  /**
   * Absolute evidence confidence (serving-confidence feature v1) the gate
   * consumed for this injection. Optional for back-compat with pre-migration
   * events. The block calibrator trains ONLY on events carrying this field,
   * so legacy max-normalized rank-score events never pollute the v1 curve.
   */
  evidenceConfidence?: number;
  /** Serving feature-schema version this injection's evidence was computed under. */
  featureVersion?: number;
}

export interface AgentUsedEvent extends EventBase {
  event: "agent_used";
  blockId: string;
  /** How we detected the agent actually followed the block. */
  matchSignal: "jaccard" | "embedding" | "explicit";
  matchScore: number;
  /**
   * May-2026 C2 — evidence strength classifier. Optional for back-
   * compat with pre-C2 events; present on every new emission.
   *
   * "explicit" — record_reasoning_outcome attested directly.
   * "strong"   — concrete corroboration (diff touched the recalled
   *              file, tool args matched an anchor, loop redirect
   *              followed by behavioural shift, post-redirect test
   *              success).
   * "moderate" — transcript Jaccard above the inference threshold
   *              (today's default agent_used surface).
   * "weak"     — score near the inference floor; logged for
   *              observability, must NOT count toward §L6 helpful.
   *
   * The strict helpful definition (`injection ∧ agent_used ∧
   * outcome.resolved`) is tightened in C2 to require strength ≥
   * "moderate" — weak evidence never closes the loop on its own.
   */
  evidenceStrength?: "explicit" | "strong" | "moderate" | "weak";
  /**
   * Optional taxonomy of WHY this attribution fired. Lets dashboards
   * split agent_used emissions by mechanism without parsing the
   * matchSignal heuristically. Mirrors the AttributionKind union in
   * `src/runtime/attribution-evidence.ts`.
   */
  evidenceKind?:
    | "record_reasoning_outcome"
    | "diff_touches_recalled_file"
    | "tool_path_matches_memory"
    | "answer_mentions_injected_anchor"
    | "loop_redirect_followed"
    | "test_or_command_success_after_redirect";
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
  /**
   * Provenance of the resolution claim. Absent or `"explicit"` means
   * the outcome was reported through the canonical path (MCP
   * `record_reasoning_outcome` call or SDK middleware) — the agent
   * itself attested to the result. `"inferred"` means the Stop-hook
   * transcript-attribution layer wrote the outcome based on heuristics
   * (the agent didn't explicitly self-report).
   *
   * Downstream analytics split these so `helpfulRuns` (which counts
   * both) and `verifiedHelpfulRuns` (explicit only) can be reported
   * side by side — preventing a soft inferred outcome from
   * masquerading as a grader-verified resolution.
   *
   * Backwards-compat: absent === `"explicit"`. Events written before
   * this field existed are treated as explicit.
   */
  attribution?: "explicit" | "inferred";
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

// ----------------------------------------------------------------------------
// Trace-level events (V1 attribution bridge).
//
// V1 ReasoningLayer (`src/core/engine.ts`) historically attributed feedback
// to weights through an in-memory `recallSignalCache` with a 30-min TTL and
// best-effort LRU eviction. Long-horizon feedback was silently dropped, the
// cache was lost on process restart, and concurrent retrievals could not
// disambiguate which recall a feedback call targeted.
//
// PR 1 of the May-2026 modernization swaps that cache for a persistent
// event log shared with V2. Recall emits `trace_retrieval`; feedback emits
// `trace_feedback` (and `trace_agent_used` when the caller can attest to
// explicit use). Weight updates read the signals back from the latest
// matching `trace_retrieval` event.
//
// Parallel to block_* / fact_* events; never mixed at consumption (the
// calibrator and OPE harness filter by event-type prefix).
// ----------------------------------------------------------------------------

/**
 * Emitted by V1 `ReasoningLayer.recall()` (and `recallAsync()`). Carries
 * the candidate set scored for this query, the sampled weight vector that
 * produced the ranking, and enough metadata for off-policy screening to
 * replay the ranking deterministically.
 */
export interface TraceRetrievalEvent extends EventBase {
  event: "trace_retrieval";
  /**
   * Every candidate that contributed to the ranked set, paired with its
   * per-signal scores. Recorded for the whole candidate set (not just the
   * top-K returned) so off-policy screening has true slate-level
   * information rather than just the observed selection.
   */
  candidates: Array<{
    traceId: string;
    score: number;
    signals: {
      fingerprint: number;
      bm25: number;
      jaccard: number;
      structural: number;
      cosine: number;
      freshness: number;
    };
  }>;
  /**
   * The weight vector actually used to score this query — drawn via
   * Thompson Sampling from the Beta posteriors in PR 2. Required for
   * off-policy importance weighting in B3.
   */
  sampledWeights: {
    bm25: number;
    jaccard: number;
    structural: number;
    cosine: number;
    freshness: number;
  };
  /**
   * Identifier of the ranking policy: `"linear.mean.v1"` for the legacy
   * posterior-mean weights, `"linear.ts.v1"` once PR 2 lands the sampled
   * variant, `"linear.contextual.bucketed.v1"` for B2.
   */
  rankerVersion: string;
  /**
   * RNG seed used by the policy when drawing weights. Lets B3's replay
   * compute exact propensity ratios against historical decisions.
   * Optional because legacy code paths writing this event before B3
   * never source one.
   */
  seed?: number;
  /**
   * Query-level context features. Bucket key for B2 (hierarchical
   * contextual bandit). Optional because legacy V1 callers may not
   * surface every field, and OPE treats missing buckets as the global
   * prior.
   */
  context?: {
    language?: string;
    framework?: string;
    errorType?: string;
    corpusSize?: number;
    /**
     * May-2026 B2 — bucket key from the contextual bandit
     * (`bucketKeyFor(context)`). Logged so off-policy replay knows
     * which bucket's effective posterior was sampled, and so
     * diagnostic surfaces can show per-bucket divergence over time.
     * Absent on pre-B2 events; present on every recall after the
     * bandit lands.
     */
    bucketKey?: string;
  };
  /**
   * The traceIds actually returned to the caller as the top-K (subset of
   * `candidates`). Recorded so weight updates and OPE can distinguish
   * "scored but not shown" from "scored and shown".
   */
  selectedTraceIds: string[];
}

/**
 * Emitted by V1 `ReasoningLayer.feedback()` when the caller can attest
 * the agent followed a specific recalled trace. `matchSignal: "explicit"`
 * for legacy `feedback(traceId, helpful=true)` calls (the user told us);
 * `"jaccard"` / `"embedding"` reserved for future inferred attribution.
 */
export interface TraceAgentUsedEvent extends EventBase {
  event: "trace_agent_used";
  traceId: string;
  matchSignal: "jaccard" | "embedding" | "explicit";
  matchScore: number;
}

/**
 * Emitted by V1 `ReasoningLayer.feedback()` to close the loop on a
 * `trace_retrieval`. Item-level feedback — "was THIS recalled trace
 * useful" — not task-level outcome ("did the run resolve"). V1 cannot
 * observe task resolution; conflating these is the category error that
 * `trace_outcome` (rejected naming) would have introduced.
 *
 * `attribution: "explicit"` when the user called `feedback()` directly;
 * future inferred-feedback paths (e.g. Stop-hook transcript inference
 * for trace-domain) can set `"inferred"`.
 */
export interface TraceFeedbackEvent extends EventBase {
  event: "trace_feedback";
  /** The specific trace the feedback targeted. */
  traceId: string;
  /** Did this specific retrieved trace help? Not task-level resolution. */
  helpful: boolean;
  attribution?: "explicit" | "inferred";
  /**
   * Set when `feedback(traceId, helpful)` could not be unambiguously
   * matched to a single open `trace_retrieval` (the same traceId appears
   * in multiple recent recalls without an intervening feedback). The
   * event is logged for visibility but the weight-update driver
   * (`updateWeightsFromTraceFeedbackEvents`) MUST skip ambiguous rows —
   * better to under-attribute than to mis-attribute across concurrent
   * recalls.
   */
  ambiguous?: boolean;
}

// ----------------------------------------------------------------------------
// 0.7.0 telemetry event kinds (PLAN-0.7 §rc.1 Ground).
//
// These are append-only analytics records, mirrored to the cloud only
// as aggregates via `src/cli/cloud-allowlist.ts`. Privacy invariants:
//   - paths, fileIds, sessionIds, argKeys, anchorIds, raw toolNames,
//     bodies, prompts NEVER leave the local DB.
//   - Cloud receives only counts + family-bucket sums.
//
// rc.1 wires only `StoreInjectionRejectedEvent` (emitted by the
// prompt-injection guard in `src/core/guard.ts`). The remaining
// types are type-only scaffolds for rc.2..rc.7; listing them here
// gives the cloud allowlist a complete catalogue from day 1, so
// later rcs add behavior without re-opening the privacy review.
// ----------------------------------------------------------------------------

/**
 * The prompt-injection guard rejected a write. `surface` names the
 * storage path (block / fact / imported / indexer / fold), and
 * `patternName` is one of the named patterns from
 * `PROMPT_INJECTION_PATTERNS` in `src/core/guard.ts` —
 * `"role-override"`, `"persona-flip"`, etc.
 */
export interface StoreInjectionRejectedEvent extends EventBase {
  event: "store.injection_rejected";
  surface: "block" | "fact" | "imported" | "indexer" | "fold";
  patternName: string;
}

/** rc.2 — file indexer finished a (budget-bounded) walk. */
export interface FileIndexCompletedEvent extends EventBase {
  event: "file_index.completed";
  fileCount: number;
  bytesSummarized: number;
  durationMs: number;
  summarizer: "heuristic" | "embedding" | "llm";
  /** Pending-queue size at the end of the walk. */
  pending: number;
}

/** rc.2 — a file was skipped during indexing. */
export interface FileIndexSkippedEvent extends EventBase {
  event: "file_index.skipped";
  /** `"binary"`, `"too-large"`, `"gitignore"`, `"unparseable"`, etc. */
  reason: string;
  /**
   * Repo-relative path of the skipped file. Local-only — the cloud
   * allowlist drops this and ships only `reasonCount` grouped by
   * reason.
   */
  path?: string;
}

/** rc.3 — file-memory recall fired and contributed to an injection. */
export interface FileMemoryRecalledEvent extends EventBase {
  event: "file_memory.recalled";
  fileIds: string[];
  tokensInjected: number;
  bytesAvoided: number;
}

/** rc.4 — pre-tool warn fired on a duplicate-shaped tool call. */
export interface ToolSupervisionWarnedEvent extends EventBase {
  event: "tool_supervision.warned";
  argKey: string;
  toolName: string;
  mode: "warn" | "block";
}

/** rc.4 — pre-tool warn was suppressed (warn-once-per-arg-per-session). */
export interface ToolSupervisionSuppressedEvent extends EventBase {
  event: "tool_supervision.suppressed";
  argKey: string;
  toolName: string;
  /**
   * 0.7.0-rc.7 hardening — true iff the strict-mode block decision
   * fired alongside this suppressed warn (safe-read families in
   * strict mode). Suppressed events with `blocked: false` mean only
   * the BADGE was deduped — the duplicate tool still executed, so
   * mechanism-savings must NOT credit them as token savings.
   *
   * Optional for backward compatibility: pre-hardening events are
   * read as `blocked === undefined` and the aggregator treats that
   * as `false` (warn-mode dedupe = zero token savings).
   */
  blocked?: boolean;
}

/**
 * 0.9.x hardened supervision — emitted when the mtime-bypass branch
 * fires (Read-family safe-read whose target file's mtime is newer than
 * every prior matching observation in the session window). The tool is
 * allowed through as a legitimate post-edit re-read; no badge, no block.
 */
export interface ToolSupervisionAllowedAfterEditEvent extends EventBase {
  event: "tool_supervision.allowed_after_edit";
  argKey: string;
  toolName: string;
  mode: "warn" | "soft" | "strict";
}

/**
 * 0.9.x hardened supervision — emitted when the soft-redirect tier
 * serves a prior-output reference (`decision:"block"` with reason text
 * directing the agent to the prior output). Fires alongside `warned`
 * (mode: "block") on the same call; both events count as one
 * tier-ladder firing in aggregators.
 */
export interface ToolSupervisionCacheHitEvent extends EventBase {
  event: "tool_supervision.cache_hit";
  argKey: string;
  toolName: string;
  mode: "warn" | "soft" | "strict";
  /** Number of prior matching observations (>=2 by construction). */
  priorDupCount: number;
}

/**
 * 0.9.x hardened supervision — counterfactual telemetry: emitted when
 * the current mode did NOT block but `mode=strict` would have (i.e.
 * `priorDupCount >= 4`). Lets the dashboard show "strict would have
 * gated N more calls here" without changing the agent's trajectory.
 */
export interface ToolSupervisionWouldBlockEvent extends EventBase {
  event: "tool_supervision.would_block";
  argKey: string;
  toolName: string;
  mode: "warn" | "soft" | "strict";
}

/**
 * rc.5 — loop redirect fired with a recall-backed anchor.
 *
 * `signal` mirrors the existing `ToolPatternKind` vocabulary
 * (`duplicate` / `straight` / `pingpong` / `none`) — same shape
 * the detector returns, same shape the cloud allowlist accepts.
 * `none` never lands here (the resolver only runs on non-`none`
 * signals) but the union allows it for type-cleanliness so a
 * future caller doesn't need a re-narrowing layer.
 */
export interface LoopRedirectedEvent extends EventBase {
  event: "loop.redirected";
  signal: "duplicate" | "pingpong" | "straight" | "none";
  anchorId: string;
  anchorKind: "block" | "file";
  confidence: number;
}

/** rc.5 — loop signal saw no confident hit; static fallback emitted. */
export interface LoopFallbackEvent extends EventBase {
  event: "loop.fallback";
  signal: "duplicate" | "pingpong" | "straight" | "none";
  reason: "no-hit" | "low-confidence" | "anti-self-loop";
}

/** rc.6 — chunk fold landed a `<context_fold>` summary. */
export interface ContextFoldedEvent extends EventBase {
  event: "context.folded";
  sessionId: string;
  /** Inclusive turn-range identifier; e.g. "10-17". */
  chunkRange: string;
  tokensBefore: number;
  tokensAfter: number;
  summarizer: "heuristic" | "embedding" | "llm";
}

/** rc.6 — fold was skipped (no new turns / hash collision / etc). */
export interface ContextFoldSkippedEvent extends EventBase {
  event: "context.fold_skipped";
  reason: "no-new-turns" | "hash-collision" | "leakage" | "injection" | "below-threshold";
}

/** rc.7 — provider reported a prefix-cache hit. */
export interface CachePromptHitEvent extends EventBase {
  event: "cache.prompt_hit";
  surface: "anthropic" | "openai";
  tokensSaved: number;
}

/**
 * Emitted by the auto-refit loop in `src/lifecycle/calibrator-refit.ts`
 * when a fresh isotonic model lands in `calibrator_models` and the
 * BlockServer hot-swaps. The dashboard counts these to surface "the
 * calibrator improved N times this week" — a directly human-readable
 * "every run teaches the next run" signal.
 */
export interface CalibratorRefitEvent extends EventBase {
  event: "calibrator_refit";
  /** Number of `outcome` events accumulated since the previous fit. */
  freshOutcomes: number;
  /** `fittedAt` stamped on the new model. */
  fittedAt: number;
}

/**
 * Emitted when a drift signal (tool-loop / pingpong / duplicate)
 * triggered a forced recall on the NEXT UserPromptSubmit. Distinct from
 * `loop.redirected` (which fires when the redirect label is composed)
 * — `drift_injection` fires when the widened+relaxed recall actually
 * surfaced patterns for the agent to use. Counts to "auto-recoveries
 * this week" on the dashboard.
 */
export interface DriftInjectionEvent extends EventBase {
  event: "drift_injection";
  signalKind: "straight" | "pingpong" | "duplicate";
  /** Number of patterns the widened/relaxed recall surfaced. */
  patternsInjected: number;
  /** Gate threshold applied — usually lower than production. */
  gateThreshold: number;
}

/**
 * May-2026 C4 — a block was demoted (status active → demoted) by
 * the memory-health gate. Emitted from `tracebase memory health
 * --apply` ONLY when the block landed in `report.wouldDemote` —
 * i.e. composite health ≤ threshold AND at least one reason code
 * fired (the cold-start floor and stale-guard in C3.1 keep this
 * honest).
 *
 * The event is lifecycle, not query-bound — `queryId` is the
 * synthetic constant `"lifecycle:memory-health"` so it satisfies
 * the `EventBase` contract without polluting per-query analytics.
 * The dashboard's aggregator treats this id as a sentinel.
 *
 * Payload privacy: NO raw triggers, bodies, transcripts, prompts,
 * or paths. Only the block id, scalar component values, and the
 * reason-code enum (already a closed vocabulary in C3).
 */
export interface BlockDemotedEvent extends EventBase {
  event: "block_demoted";
  blockId: string;
  /** Composite health number at demotion time. */
  health: number;
  /** Threshold the report ran against. */
  demotionThreshold: number;
  /** Demotion reason codes (closed enum from C3). Always non-empty. */
  reasons: ReadonlyArray<
    | "low_wilson_lb"
    | "high_counterproductive"
    | "stale"
    | "duplicate"
    | "generic"
    | "negative_roi"
  >;
  /** Per-component breakdown — exact same shape as MemoryHealthComponents. */
  components: {
    wilsonLb: number;
    counterproductiveRate: number;
    stalePenalty: number;
    duplicationPenalty: number;
    genericnessPenalty: number;
    negativeRoiPenalty: number;
  };
  /** Observed labeled-trial count — for at-a-glance sample-size context. */
  labeledTrials: number;
}

/**
 * May-2026 C4-runtime — one event per `serving-arbiter` decision
 * when the arbiter is enabled. Default path (env unset) emits ZERO
 * of these; the legacy filter / payload-builder runs unchanged.
 *
 * Carries enough to reproduce the math without the prompt: which
 * capability the candidate came from, which closed-vocab `action`
 * and `reason` fired, the scalar `expectedNetTokens`, calibrated
 * probability, and the ranker score that fed in. The candidate
 * `sourceId` is the existing block / fact id (already public in
 * other analytics rows). NO raw triggers, bodies, prompts,
 * transcripts, or paths.
 */
export interface ArbitrationDecisionEvent extends EventBase {
  event: "arbitration_decision";
  capability:
    | "reasoning_reuse"
    | "file_memory"
    | "loop_redirect"
    | "tool_supervision"
    | "context_fold"
    | "context_pruning";
  /** Stable id within the arbitration pass (caller's choice). */
  candidateId: string;
  /**
   * Existing public id of the underlying artefact — block id or
   * fact id today. Optional so future capabilities (loop redirect,
   * tool supervision) can omit it cleanly.
   */
  sourceId?: string;
  action: "inject" | "suppress" | "shadow";
  reason:
    | "positive_roi"
    | "budget"
    | "low_confidence"
    | "stale"
    | "duplicate"
    | "profile_cap"
    | "holdout";
  /** scoreCandidate(c) output at decision time. */
  expectedNetTokens: number;
  /** Calibrator output that fed the arbiter, in [0, 1]. */
  calibratedProb: number;
  /** Per-capability ranker score, in [0, 1]. */
  relevanceScore: number;
  /** Injection cost as estimated by the wiring layer. */
  injectionTokens: number;
}

/**
 * R1 (May-2026) — capture-path failure telemetry.
 *
 * The Stop hook and SDK `runtime.afterRun()` both run pattern and
 * fact extraction + storage on a hot, never-throwing path: callers
 * must NEVER bubble. Before R1 each catch was a `process.stderr.write`
 * and nothing else, so the dashboard had no way to surface "captures
 * are failing" — `agent_used` would silently stay at zero with no
 * trail back to the cause.
 *
 * After R1 every swallowed error also emits this event so the
 * existing `events` CLI, `impact` aggregator, and dashboard funnel
 * can show capture failures alongside the success metrics. The
 * stderr line is kept for dev visibility.
 *
 * `phase` identifies WHICH stage failed; `reason` is the closed
 * vocabulary the dashboard groups by. `message` is the bounded
 * Error.message (max 200 chars) — no transcripts, no candidate
 * bodies, no paths. Privacy-safe by construction since we never
 * emit caller-supplied text from the extraction inputs.
 */
export interface CaptureErrorEvent extends EventBase {
  event: "capture.error";
  phase: "fact_extraction" | "pattern_store" | "fact_store" | "attribution_inference";
  reason: "validation" | "unknown";
  /** Bounded to 200 chars to keep payload size predictable. */
  message: string;
}

/** How the served V1 decision and the shadow V2-family decision compared. */
export type RouterShadowAgreement =
  | "agree_abstain"
  | "agree_inject_same"
  | "agree_inject_diff"
  | "v1_only_inject"
  | "v2_only_inject";

/**
 * Closed-enum reason the shadow V2 decision fell open to V1. CLOSED on purpose:
 * a raw exception message could embed an absolute path / secret / prompt
 * fragment, which must never reach analytics_events, reports, cloud payloads,
 * or committed fixtures. The raw message is surfaced (if at all) only on
 * ephemeral stderr behind TRACEBASE_DEBUG.
 */
export type RouterShadowFallback = "error" | "validation" | "timeout" | "unknown";

/**
 * Router V2 shadow comparison — emitted once per recall when
 * `TRACEBASE_REASONING_ROUTER=shadow`. Records the served V1 decision next to
 * the side-by-side V2-family decision computed on the SAME bounded candidate
 * slate. Privacy-safe by construction: a non-reversible `queryHash`, opaque
 * block ids, and counts only — no prompt, body, code, or path. LOCAL-ONLY:
 * this event is never part of the cloud `UsageMetrics` aggregate (the cloud
 * allowlist drops anything shaped like it; see tests/cli/cloud-allowlist.test).
 */
export interface RouterShadowComparisonEvent extends EventBase {
  event: "router.shadow_comparison";
  queryHash: string;
  corpusSize: number;
  candidateCount: number;

  // Served decision (V1 in shadow mode).
  v1Action: "inject" | "abstain";
  v1Reason: string;
  v1TopBlockId?: string;
  v1Confidence: number;
  v1Margin: number;
  v1FeatureVersion: number;
  v1LatencyMs: number;

  // Side-by-side V2-family decision (computed, never served in shadow mode).
  v2Action: "inject" | "abstain";
  v2Reason: string;
  v2TopBlockId?: string;
  v2Confidence: number;
  v2Margin: number;
  v2FeatureVersion: number;
  v2LatencyMs: number;
  /** Extra wall-clock the shadow V2 decision added (the overhead of shadow mode). */
  v2OverheadMs: number;

  agreement: RouterShadowAgreement;

  // Family signals from the V2 decision.
  resolverName: string;
  familyCount: number;
  topFamilySupport: number;
  topFamilySourceDiversity: number;
  topFamilyContradiction: number;
  runnerUpFamilyConfidence: number;
  familyMargin: number;
  /** Transitive bridge merges the resolver refused on this slate. */
  bridgesPrevented: number;

  /** Body fields the V2 privacy guard redacted across the candidate slate. */
  redactedFieldCount: number;

  /**
   * Closed-enum reason the V2 decision fell open to V1. Never a raw exception
   * message (which could leak a path/secret/prompt). Set only on fallback.
   */
  v2FallbackReason?: RouterShadowFallback;
}

/** Closed-enum outcome of the semantic provider call (never a raw error). */
export type RetrievalFallback = "none" | "unavailable" | "timeout" | "error";

/** How the sparse-slate decision compared to the hybrid-slate decision. */
export type RetrievalDecisionAgreement =
  | "agree_abstain"
  | "agree_inject_same"
  | "agree_inject_diff"
  | "sparse_only_inject"
  | "hybrid_only_inject";

/**
 * Phase C hybrid retrieval comparison — emitted once per recall when
 * `TRACEBASE_REASONING_RETRIEVAL=shadow`. Compares the served sparse-FTS slate
 * with the fused sparse⊕semantic slate and the decision each produces. Privacy-
 * safe by construction: a non-reversible `queryHash`, opaque block ids, counts,
 * and closed enums only — NO raw query, body, vector, path, or exception text.
 * LOCAL-ONLY: never part of the cloud `UsageMetrics` aggregate.
 */
export interface RetrievalHybridComparisonEvent extends EventBase {
  event: "retrieval.hybrid_comparison";
  queryHash: string;
  corpusSize: number;
  /** Name of the semantic provider (e.g. "deterministic-local"); never a vendor secret. */
  provider: string;
  /** Closed-enum outcome of the provider call. */
  fallback: RetrievalFallback;
  /** Wall-clock of the semantic provider call. */
  providerLatencyMs: number;
  /** Total hybrid overhead (provider + fusion + the two side decisions). */
  hybridLatencyMs: number;

  // Slate shape.
  sparseSlateSize: number;
  semanticSlateSize: number;
  /** Distinct blocks in the fused slate (before the top-N cut). */
  hybridSlateSize: number;
  /** Blocks in BOTH sparse and semantic lists. */
  overlap: number;
  /** Blocks only the semantic provider surfaced (the recall lever). */
  semanticOnly: number;
  /** Rank movement of the served (top-N) fused slate vs the sparse order. */
  rankMovement: number;

  // Decision comparison (the configured serving mode applied to each slate).
  sparseAction: "inject" | "abstain";
  hybridAction: "inject" | "abstain";
  sparseTopBlockId?: string;
  hybridTopBlockId?: string;
  decisionAgreement: RetrievalDecisionAgreement;
  /** Serving feature version of the decision (1 = V1, 2 = V2-family). */
  featureVersion: number;
}
