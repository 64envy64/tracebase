// ============================================================================
// TraceBase — Public SDK API
//
// Your agents never solve the same problem twice.
// https://tracebase.com
// ============================================================================

// Core engine
export { ReasoningLayer } from "./core/engine.js";

// Storage
export { TraceStore } from "./core/store.js";
export type { CachedTraceRow } from "./core/store.js";

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
  EmbeddingConfig,
  EmbeddingProvider,
  TraceBaseEvent,
  EventHandler,
  StorageStats,
  StoreTraceInput,
  SimilaritySignals,
  BetaParams,
  AdaptiveWeightState,
} from "./types.js";
