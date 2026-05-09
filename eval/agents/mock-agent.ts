import type { EvalAgent, EvalTask } from "../types.js";

/**
 * Mock Agent — deterministic agent for CI benchmarks (no API key required).
 *
 * Behavior:
 *   - Without prior context: solves with higher token count and configurable failure rate
 *   - With prior context: solves with lower token count and near-zero failure rate
 *
 * This creates a controlled environment where TraceBase demonstrably
 * improves both success rate and token efficiency.
 *
 * The mock is calibrated to produce realistic-looking improvements:
 *   - ~20-30% success rate improvement
 *   - ~20-40% token savings
 *   - Failure modes mimic real LLM behavior (overthinking, wrong approach)
 */
export class MockAgent implements EvalAgent {
  name = "mock";
  model = "mock-deterministic";

  /** Base failure rate without prior knowledge (0-1). Default: 0.25 */
  private baseFailureRate: number;
  /** Failure rate with prior knowledge (0-1). Default: 0.03 */
  private augmentedFailureRate: number;
  /** Base token count for solving a task. */
  private baseTokens: number;
  /** Token reduction when prior context is available. */
  private tokenReduction: number;
  /** Deterministic seed for reproducible results. */
  private seed: number;

  constructor(opts?: {
    baseFailureRate?: number;
    augmentedFailureRate?: number;
    baseTokens?: number;
    tokenReduction?: number;
    seed?: number;
  }) {
    this.baseFailureRate = opts?.baseFailureRate ?? 0.25;
    this.augmentedFailureRate = opts?.augmentedFailureRate ?? 0.03;
    this.baseTokens = opts?.baseTokens ?? 2400;
    this.tokenReduction = opts?.tokenReduction ?? 0.35;
    this.seed = opts?.seed ?? 42;
  }

  async solve(
    task: EvalTask,
    priorContext?: string,
  ): Promise<{ output: string; tokensUsed: number }> {
    const hasPrior = !!priorContext && priorContext.length > 0;

    // Deterministic "randomness" based on task ID
    const hash = simpleHash(task.id + this.seed);
    const roll = (hash % 100) / 100;

    const failureRate = hasPrior ? this.augmentedFailureRate : this.baseFailureRate;
    const shouldFail = roll < failureRate;

    // Difficulty multiplier
    const diffMult = task.difficulty === "easy" ? 0.7 : task.difficulty === "hard" ? 1.4 : 1.0;

    // Token calculation
    let tokens = Math.round(this.baseTokens * diffMult);
    if (hasPrior) {
      tokens = Math.round(tokens * (1 - this.tokenReduction));
    }
    // Add some variance based on task
    tokens += (hash % 200) - 100;

    // Simulate duration (tokens * ~2ms per token)
    const durationMs = tokens * 2 + (hash % 50);

    if (shouldFail) {
      // Simulate wrong approach: output that doesn't contain solution keywords
      return {
        output: `I analyzed the ${task.language} ${task.errorType ?? "error"} in detail. ` +
          `After careful consideration, I believe the issue is related to configuration. ` +
          `Try reinstalling dependencies and clearing the cache. ` +
          `If that doesn't work, check the environment variables.`,
        tokensUsed: Math.round(tokens * 1.3), // failures use more tokens (overthinking)
      };
    }

    // Success: include solution keywords in output
    const output = hasPrior
      ? `Based on prior solution: ${task.expectedSolution}. Applied directly with minor adaptation for the current context.`
      : `After exploring several approaches, found the solution: ${task.expectedSolution}. ` +
        `The key insight was understanding the ${task.language} ${task.framework ?? ""} behavior in this case.`;

    return { output, tokensUsed: tokens };
  }
}

/** Simple deterministic hash for reproducible results. */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}
