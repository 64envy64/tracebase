/**
 * Eval Framework — Type Definitions
 *
 * Self-contained benchmark system for measuring TraceBase's impact on
 * LLM task performance. Measures success rate, token savings, and time.
 */

/** A single evaluation task (one problem to solve). */
export interface EvalTask {
  id: string;
  description: string;
  language: string;
  framework?: string;
  errorType?: string;
  difficulty: "easy" | "medium" | "hard";
  /** Keywords that must appear in a correct solution */
  solutionKeywords: string[];
  /** The known correct solution summary */
  expectedSolution: string;
  tags: string[];
}

/** Result of running one task through an agent. */
export interface TaskRun {
  taskId: string;
  success: boolean;
  tokensUsed: number;
  durationMs: number;
  agentOutput: string;
  recallHit: boolean;
  injectedScore?: number;
}

/** Aggregated metrics across all tasks for one condition. */
export interface ConditionMetrics {
  totalTasks: number;
  successCount: number;
  successRate: number;
  avgTokens: number;
  medianTokens: number;
  avgDurationMs: number;
  totalTokens: number;
}

/** Full benchmark results — baseline vs augmented. */
export interface BenchmarkResults {
  timestamp: number;
  agentName: string;
  model?: string;
  taskCount: number;
  baseline: ConditionMetrics;
  augmented: ConditionMetrics;
  delta: {
    successRateDelta: number;      // percentage points
    tokenSavingsPercent: number;   // 0-100
    timeReductionPercent: number;  // 0-100
    recallHitRate: number;         // 0-1
    avgInjectionConfidence: number;
  };
  perTask: Array<{
    taskId: string;
    baseline: TaskRun;
    augmented: TaskRun;
  }>;
}

/** Agent interface — pluggable backends. */
export interface EvalAgent {
  name: string;
  model?: string;
  solve(task: EvalTask, priorContext?: string): Promise<{
    output: string;
    tokensUsed: number;
  }>;
}
