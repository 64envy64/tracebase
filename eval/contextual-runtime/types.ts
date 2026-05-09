/**
 * 0.7.1 Contextual Runtime — pilot harness types
 *
 * The pilot measures TraceBase against three counterfactuals on the
 * same fixture corpus:
 *   - off              : no memory at all
 *   - naive-cache      : Jaccard token-overlap baseline (no gate)
 *   - tracebase        : full TraceBase serving stack
 *   - tracebase-holdout: TraceBase with experimental holdout forced on
 *                        every query (control arm of the same engine)
 *
 * Lift between `tracebase` and `tracebase-holdout` is the engine's
 * own causal estimate. Lift between `tracebase` and `naive-cache`
 * isolates the value of retrieval + calibration + outcome feedback
 * over a "we have memory at all" baseline. The `off` cohort exists
 * to anchor both.
 */

/** Identifier for a single experimental arm. */
export type Condition =
  | "off"
  | "naive-cache"
  | "tracebase"
  | "tracebase-holdout";

/**
 * Per-run metric — one row per (fixture, condition) cell.
 */
export interface RunMetric {
  runId: string;
  fixtureId: string;
  /** Coarse class for grouping similar failures (currently fixture id). */
  failureClass: string;
  condition: Condition;
  /** queryId returned by `beforeTask`. Only set for tracebase* arms. */
  queryId?: string;
  resolved: boolean;
  durationMs: number;
  steps: number;
  tokens: number;
  /** Block ids the harness saw injected for this run. */
  injectedIds: string[];
  /** Block ids credited to this run by `recordOutcome`. */
  usedIds: string[];
  /** True if injection appears to have caused a regression vs baseline. */
  regressed?: boolean;
  /**
   * True when the loop was driven by the deterministic stub instead of
   * a real LLM (no Anthropic key available, or `--simulated` set).
   * Reports MUST surface this so a reader doesn't conflate the two.
   */
  simulated: boolean;
  /** True when this run consumed a non-empty injection. */
  hadInjection: boolean;
  /** True when the query landed in a holdout / shadow control arm. */
  shadow?: boolean;
  /** Why the run stopped (success / step limit / error). */
  stopReason: "resolved" | "step_limit" | "error" | "no_injection";
}

/** Aggregated metrics for one condition across the fixture set. */
export interface ConditionAggregates {
  condition: Condition;
  n: number;
  resolved: number;
  resolvedRate: number;
  avgDurationMs: number;
  medianDurationMs: number;
  avgTokens: number;
  avgSteps: number;
  regressedRate: number;
  /** Share of runs where ANY injection was emitted. */
  injectionRate: number;
  /** Share of injected runs where at least one injected id was credited. */
  usedAfterInjectionRate: number;
}

/**
 * Causal lift of the `tracebase` arm against one comparator.
 *
 * `durationDeltaMs` is `tracebase.avgDuration - comparator.avgDuration`;
 * negative = TraceBase faster (the headline integration metric).
 * `resolvedLiftPP` is in absolute percentage points, not relative
 * percent — same convention as `usage-metrics.ts` causal cohorts.
 *
 * `null` durationDelta means at least one arm has zero runs (cohort
 * too small) so a difference is undefined rather than zero.
 */
export interface CausalLift {
  vs: "off" | "naive-cache" | "tracebase-holdout";
  resolvedLiftPP: number;
  durationDeltaMs: number | null;
  cohortSize: { tracebase: number; comparator: number };
}

/**
 * Capture-loop accounting. Surfaces the "capture junk/reject rate"
 * so a reviewer can see how often the pre-seed loop collapsed onto
 * existing patterns or got rejected by the capture gate. Without
 * this number a high `resolvedRate` could be confused with a high
 * junk-acceptance rate.
 */
export interface CaptureSummary {
  /** Patterns successfully landed via `capturePattern` during pre-seed. */
  patternsCapturedPreSeed: number;
  /** Total `capturePattern` attempts during pre-seed. */
  capturesAttempted: number;
  /** Attempts that returned a stored / reinforced pattern. */
  capturesAccepted: number;
  /** Attempts rejected by the capture gate. */
  capturesRejected: number;
  /** capturesRejected / capturesAttempted. */
  captureRejectRate: number;
}

/** Top-level pilot report. */
export interface PilotReport {
  protocol: "tracebase.contextual_runtime.v1";
  /** ISO 8601 timestamp the report was generated at. */
  generatedAt: string;
  /**
   * `anthropic` if the loop ran against the real Claude API, `stub`
   * if no API key was available and the deterministic stub driver
   * was used. Conflating the two would make the headline numbers
   * meaningless — the report surfaces this at the top level.
   */
  driver: "anthropic" | "stub";
  fixtureCount: number;
  conditions: Condition[];
  aggregates: ConditionAggregates[];
  causal: CausalLift[];
  capture: CaptureSummary;
  /** Per-run metrics. Privacy: never includes raw model output. */
  runs: RunMetric[];
}

/** Fixture shape consumed by the runner. */
export interface PilotFixture {
  id: string;
  language: string;
  errorType?: string;
  description: string;
  /** Reference seed (used for stub-driver heuristic + naive corpus). */
  seed: {
    situation: string;
    unlock: string;
    deadEnds: string[];
  };
}
