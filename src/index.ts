// ============================================================================
// TraceBase — Public SDK API
//
// Your agents never solve the same problem twice.
// https://tracebase.ink
// ============================================================================

// Core engine
export { ReasoningLayer } from "./core/engine.js";

// Storage
export { TraceStore } from "./core/store.js";
export type { CachedTraceRow } from "./core/store.js";

// Embedding providers
export { createOpenAIEmbeddings } from "./embeddings/openai.js";

// Adaptive weights (Thompson Sampling)
export { loadWeightState, computeWeights } from "./core/weights.js";
export type { SignalWeights } from "./core/weights.js";

// Fingerprinting & similarity
export {
  fingerprint,
  jaccardSimilarity,
  structuralSimilarity,
} from "./core/fingerprint.js";
export { recall, cosineSimilarity } from "./core/similarity.js";

// Configuration
export {
  loadConfig,
  initConfig,
  findConfigDir,
  isInitialized,
  defaultConfig,
} from "./core/config.js";

// Middleware
export { wrapAgent } from "./middleware/generic.js";
export { wrapOpenAI } from "./middleware/openai.js";
export { wrapAnthropic } from "./middleware/anthropic.js";
export { performRecall, injectIntoOpenAIMessages, injectIntoAnthropicSystem } from "./middleware/recall-inject.js";

// Knowledge Base utilities
export { writeJsonl, readJsonl, toJsonl, fromJsonl } from "./kb/jsonl.js";

// ReasoningBlock primitives (v2 schema — see docs/DESIGN_v2.md)
export {
  createBlock,
  extractKeywords,
  canonicalTrigger,
  fingerprintTrigger,
  detectLeakage,
  bumpStat,
  wilsonLowerBound,
  refreshWilson,
  BLOCK_SCHEMA_VERSION,
  DEFAULT_BLOCK_CONFIDENCE,
} from "./core/block.js";

// v2 storage foundation (Phase 1 — see docs/DESIGN_v2.md)
export {
  BlockStore,
  LeakageError,
  BlockIntegrityError,
  expandScopeHierarchy,
  scopeSpecificity,
} from "./core/block-store.js";
export type {
  BlockStoreOptions,
  ListBlocksOptions,
  FactSearchQuery,
  EventReadOptions,
} from "./core/block-store.js";

// v2 serving base (Phase 2 — see docs/DESIGN_v2.md §L5)
export { BlockServer, identityCalibrator, formatInjection } from "./core/block-serving.js";
export type {
  BlockRecallQuery,
  BlockHit,
  FactHit,
  RecallV2Result,
  Calibrator,
  BlockServerOptions,
  InjectionFormatOptions,
} from "./core/block-serving.js";

// v2 lifecycle repair (Phase 5 — see docs/DESIGN_v2.md §L6)
export { LifecycleRepair } from "./lifecycle/repair.js";
export type {
  LifecycleRepairOptions,
  LifecycleSyncReport,
  LifecycleDemotionAction,
  LifecycleActionReport,
  LifecycleRunReport,
} from "./lifecycle/repair.js";

// v2 isotonic calibrator + serving integration (Phase 5.2)
export {
  fitIsotonic,
  predictIsotonic,
  isMonotone,
} from "./lifecycle/isotonic.js";
export type { IsotonicModel } from "./lifecycle/isotonic.js";
export {
  BLOCK_CALIBRATOR_NAME,
  fitCalibratorFromEvents,
  fitAndSaveBlockCalibrator,
  loadBlockCalibrator,
  isotonicCalibrator,
  identityBlockCalibrator,
} from "./lifecycle/calibrator.js";
export type { FitCalibratorOptions } from "./lifecycle/calibrator.js";

// v2 distillation (Phase 4 — see docs/DESIGN_v2.md §L2 "Pillar 2")
export { DistillationPipeline } from "./distillation/pipeline.js";
export type {
  DistillationPipelineOptions,
  DistillationResult,
  RejectionReason,
} from "./distillation/pipeline.js";
export {
  extractTrajectory,
  findUnlockStep,
  mineDeadEnds,
  summarizeDeadEnd,
} from "./distillation/heuristics.js";
export type {
  TrajectoryStep,
  ExtractedTrajectory,
} from "./distillation/heuristics.js";
export {
  validateCandidate,
  failedChecks,
  SCHEMA_LIMITS,
} from "./distillation/validator.js";
export type { ValidateOptions } from "./distillation/validator.js";
export {
  AnthropicDistiller,
  MockDistiller,
  DistillerError,
  DEFAULT_DISTILL_MODEL,
  QUALITY_DISTILL_MODEL,
} from "./distillation/llm-distiller.js";
export type {
  LlmDistiller,
  DistillerInput,
  DistillerOutput,
  AnthropicDistillerOptions,
  AnthropicMessagesLike,
} from "./distillation/llm-distiller.js";
export { noopVerifier } from "./distillation/verifier.js";
export type {
  Verifier,
  VerifyOptions,
  VerificationResult,
  VerdictStatus,
} from "./distillation/verifier.js";

// v2 held-out self-verify runner (Phase 4.5)
export {
  HeldOutVerifier,
  StaticTaskPicker,
  MockAgentRunner,
  invariantsMatch,
  isHeldOutFrom,
  validateTaskForBlock,
  formatBlockForVerification,
  reverifyBlock,
} from "./distillation/held-out-verifier.js";
export type {
  VerificationTask,
  AgentRunArgs,
  AgentRunResult,
  AgentRunner,
  TaskPicker,
  HeldOutVerifierOptions,
} from "./distillation/held-out-verifier.js";

// v2 analytics (Phase 3 — see docs/DESIGN_v2.md §L6)
export {
  JsonlEventSink,
  EventEmitter,
  exportEventsToJsonl,
  importEventsFromJsonl,
  emitAgentUsed,
  emitFactAgentUsed,
  emitOutcome,
  computeAggregates,
} from "./core/analytics.js";
export type {
  SideSink,
  AggregateCounts,
  RetrievalSplit,
  OutcomeSplit,
  AggregateRates,
  AggregateFunnel,
  PerBlockStats,
  PerFactStats,
  AggregateIntegrity,
  EventAggregates,
  AggregateOptions,
} from "./core/analytics.js";

// Phase 1 — UsageMetrics (event-log-derived, dashboard-consumable).
export {
  computeUsageMetrics,
  USAGE_ESTIMATE_TAG,
} from "./analytics/usage-metrics.js";

// Phase 3 — deterministic experimental holdout assignment.
export {
  shouldHoldOut,
  CONTROL_REASON_HOLDOUT,
  CONTROL_REASON_SHADOW,
} from "./experiments/holdout.js";
export type {
  UsageMetrics,
  UsageObserved,
  UsageEstimated,
  UsageEstimate,
  UsageIntegrity,
  UsageWindow,
  UsageScope,
  ComputeUsageMetricsOptions,
} from "./analytics/usage-metrics.js";

// Types — re-export everything
export type {
  ReasoningTrace,
  Problem,
  Solution,
  SolutionStep,
  ToolCallRecord,
  TraceMetadata,
  QualityMetrics,
  RecallQuery,
  RecallContext,
  RecallResult,
  TraceBaseConfig,
  InstallAgent,
  InstallConfig,
  EmbeddingConfig,
  EmbeddingProvider,
  TraceBaseEvent,
  EventHandler,
  StorageStats,
  StoreTraceInput,
  SimilaritySignals,
  BetaParams,
  AdaptiveWeightState,
  TraceProvenance,
  RecallInjectConfig,
  TokenUsageData,
  SimilarityConfig,
  InjectionFormatConfig,
  FeatureConfig,
  StructuralWeights,
  FeatureExtractor,
  // v2 block schema
  ReasoningBlock,
  BlockTrigger,
  BlockBody,
  BlockInvariants,
  BlockProvenance,
  BlockStats,
  BlockQuality,
  BlockEmbeddings,
  StoreBlockInput,
  // v2 evidence / linkage (L3)
  BlockCaseRef,
  BlockCaseRole,
  EvidenceQuality,
  // v2 semantic / project memory (L4)
  ProjectFact,
  ProjectFactType,
  ProjectFactStatus,
  ProjectFactSource,
  StoreProjectFactInput,
  // v2 analytics events
  AnalyticsEvent,
  RetrievalEvent,
  InjectionEvent,
  AgentUsedEvent,
  OutcomeEvent,
  FactInjectionEvent,
  FactAgentUsedEvent,
  // v2 distillation + verification hooks (Phase 4)
  ValidationReport,
  ValidationCheck,
  BlockVerification,
  VerificationStatus,
} from "./types.js";
