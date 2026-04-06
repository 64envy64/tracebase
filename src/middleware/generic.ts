import type { ReasoningLayer } from "../core/engine.js";
import type { StoreTraceInput, SolutionStep } from "../types.js";

/**
 * Generic middleware for wrapping any agent function.
 *
 * Usage:
 *   const layer = new ReasoningLayer();
 *   const wrapped = wrapAgent(layer, myAgentFn, { agent: "my-agent" });
 *   const result = await wrapped("Fix the bug in auth.ts");
 *
 * The wrapper:
 * 1. Checks for existing solutions via recall()
 * 2. Augments the input with prior knowledge
 * 3. Runs the agent function
 * 4. Stores the resulting trace
 */
export interface WrapOptions {
  /** Name of the agent */
  agent: string;
  /** LLM model name */
  model?: string;
  /** Whether to auto-recall before execution */
  autoRecall?: boolean;
  /** Whether to auto-store after execution */
  autoStore?: boolean;
  /** Max recall results to inject */
  recallLimit?: number;
  /** Extract problem description from input */
  extractProblem?: (input: string) => string;
  /** Extract solution from output */
  extractSolution?: (output: string) => { summary: string; steps: SolutionStep[] };
}

export interface WrappedResult<T> {
  /** The original agent's output */
  output: T;
  /** Prior solutions that were found (if autoRecall) */
  priorSolutions: string[];
  /** ID of the stored trace (if autoStore) */
  traceId?: string;
}

const DEFAULT_OPTIONS: Required<
  Pick<WrapOptions, "autoRecall" | "autoStore" | "recallLimit">
> = {
  autoRecall: true,
  autoStore: true,
  recallLimit: 3,
};

/**
 * Wrap a simple agent function (string → string) with reasoning layer.
 */
export function wrapAgent(
  layer: ReasoningLayer,
  agentFn: (input: string, priorContext?: string) => Promise<string>,
  options: WrapOptions,
): (input: string) => Promise<WrappedResult<string>> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return async (input: string): Promise<WrappedResult<string>> => {
    const problem = opts.extractProblem ? opts.extractProblem(input) : input;
    let priorContext = "";
    const priorSolutions: string[] = [];

    // Step 1: Recall prior solutions
    if (opts.autoRecall) {
      const results = layer.recall({
        problem,
        limit: opts.recallLimit,
        minScore: 0.2,
      });

      if (results.length > 0) {
        priorSolutions.push(
          ...results.map((r) => r.trace.solution.summary),
        );

        priorContext =
          "\n\n--- Prior solutions from institutional memory ---\n" +
          results
            .map(
              (r, i) =>
                `${i + 1}. [${r.matchType}, score: ${r.score.toFixed(2)}] ${r.trace.solution.summary}` +
                (r.trace.solution.explanation
                  ? `\n   ${r.trace.solution.explanation}`
                  : ""),
            )
            .join("\n") +
          "\n--- End prior solutions ---\n";
      }
    }

    // Step 2: Run the agent
    const start = Date.now();
    const output = await agentFn(input, priorContext || undefined);
    const durationMs = Date.now() - start;

    // Step 3: Store the trace
    let traceId: string | undefined;
    if (opts.autoStore) {
      const solution = opts.extractSolution
        ? opts.extractSolution(output)
        : { summary: output.slice(0, 500), steps: [] as SolutionStep[] };

      const trace = layer.storeTrace({
        problem: {
          description: problem,
          tags: [],
        },
        solution: {
          ...solution,
          outcome: "success",
        },
        metadata: {
          agent: opts.agent,
          model: opts.model,
          durationMs,
          source: "middleware:generic",
        },
      } satisfies StoreTraceInput);

      traceId = trace.id;
    }

    return { output, priorSolutions, traceId };
  };
}
