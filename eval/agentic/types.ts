/**
 * Agentic Evaluation Framework — Type Definitions
 *
 * Research-grade trajectory-level benchmark.
 * Measures multi-step agent performance with/without TraceBase injection.
 *
 * Ref methodology: ReasonBlocks whitepaper — SWE-bench Verified evaluation
 * with trajectory metrics (steps, tokens, accuracy via test verification).
 */

/** A single step in an agentic trajectory. */
export interface AgentStep {
  stepNumber: number;
  toolName: "readFile" | "editFile" | "runTests" | "think";
  toolInput: Record<string, unknown>;
  toolOutput: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** Complete trajectory for one fixture. */
export interface Trajectory {
  fixtureId: string;
  steps: AgentStep[];
  totalSteps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  success: boolean;
  testOutput: string;
  stopReason: "tests_passed" | "step_limit" | "error" | "gave_up";
  /** Whether a prior pattern was injected at step 0 */
  injected: boolean;
  injectionScore?: number;
}

/** Per-fixture results: baseline vs augmented. */
export interface FixtureResult {
  fixtureId: string;
  baseline: Trajectory;
  augmented: Trajectory;
  /** (baseline_steps - augmented_steps) / baseline_steps. Only meaningful when both succeed. */
  stepSave: number | null;
  /** (baseline_tokens - augmented_tokens) / baseline_tokens. Only meaningful when both succeed. */
  tokenSave: number | null;
}

/** Aggregate metrics across all fixtures for one condition. */
export interface AggregateMetrics {
  fixtureCount: number;
  accuracy: number;
  avgSteps: number;
  medianSteps: number;
  avgTokens: number;
  medianTokens: number;
  totalTokens: number;
}

/** Delta between baseline and augmented conditions. */
export interface TrajectoryDelta {
  accuracyDeltaPP: number;
  accuracyGainRelative: number;
  avgStepSave: number;
  avgTokenSave: number;
  peakTokenSave: number;
  peakStepSave: number;
  recallHitRate: number;
}

/** Full benchmark results for one model. */
export interface AgenticBenchmarkResults {
  timestamp: number;
  model: string;
  fixtureCount: number;
  maxSteps: number;
  baseline: AggregateMetrics;
  augmented: AggregateMetrics;
  delta: TrajectoryDelta;
  perFixture: FixtureResult[];
}

/**
 * 3-field distillate seed (Format D).
 * Ref: ReasonBlocks whitepaper — "situation, dead ends, unlock"
 *
 * - situation: What the problem pattern looks like
 * - deadEnds: Approaches that fail and why (steers model AWAY from wasting tokens)
 * - unlock: The key insight that resolves it (minimal, under 30 words)
 */
export interface DistillateSeed {
  situation: string;
  deadEnds: string;
  unlock: string;
}

/** Fixture metadata. */
export interface FixtureMeta {
  id: string;
  language: "typescript" | "python";
  difficulty: "easy" | "medium" | "hard";
  bugType: string;
  description: string;
  tags: string[];
}

/** Tool call from LLM response. */
export interface ToolCall {
  id: string;
  name: "readFile" | "editFile" | "runTests";
  input: Record<string, unknown>;
}
