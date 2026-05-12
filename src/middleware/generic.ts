import type { ReasoningLayer } from "../core/engine.js";
import type {
  BadgeEvent,
  Runtime,
  RuntimeSource,
  StoreTraceInput,
  SolutionStep,
} from "../types.js";
import { createRuntime } from "../sdk/runtime.js";

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
  /** Minimum recall score threshold. Default: 0.2 */
  minScore?: number;
  /** Extract problem description from input */
  extractProblem?: (input: string) => string;
  /** Extract solution from output */
  extractSolution?: (output: string) => { summary: string; steps: SolutionStep[] };

  // 0.5.4 SDK runtime opt-in (PLAN-0.5.4 §3, §8.7).
  /**
   * Bring-your-own runtime. When set, the wrapper routes through it
   * (BadgeEvent emission + same-session digest recall + tool-loop
   * detection) alongside the existing v1 recall — both fire, the
   * runtime augments the picture without replacing the legacy path.
   */
  runtime?: Runtime;
  /**
   * Per-event callback. When set without an explicit `runtime`, the
   * wrapper builds an internal lazy runtime so the callback still
   * fires. Throws inside the callback are swallowed and never
   * propagate into the wrapped agent call.
   */
  onBadge?: (ev: BadgeEvent) => void;
  /** Default session id forwarded into runtime methods. */
  sessionId?: string;
  /** Project root passed to the runtime. */
  projectPath?: string;
  /** BadgeEvent.source attribution. Defaults to `"agent"`. */
  source?: RuntimeSource;
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
  const runtime = resolveRuntime(layer, options, "agent");

  return async (input: string): Promise<WrappedResult<string>> => {
    const problem = opts.extractProblem ? opts.extractProblem(input) : input;
    let priorContext = "";
    const priorSolutions: string[] = [];

    // 0.5.4 SDK runtime path — additive: runs alongside the legacy
    // recall below. The runtime contributes BadgeEvents
    // (TB TRACE / TB MEMORY / TB CONTEXT / TB TOOL / TB LOOP) and
    // its `additionalContext` is appended to the prior-context block
    // the agent sees. Failures inside the runtime never break the
    // wrapped call.
    if (runtime) {
      try {
        const before = await runtime.beforeRun({
          prompt: problem,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        });
        if (before.additionalContext.length > 0) {
          priorContext += `\n\n${before.additionalContext}\n`;
        }
      } catch (err) {
        void err; // never break the wrapped call
      }
    }

    // Step 1: Recall prior solutions (legacy v1 path — preserved)
    if (opts.autoRecall) {
      const results = layer.recall({
        problem,
        limit: opts.recallLimit,
        minScore: opts.minScore ?? 0.2,
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
          "\n--- End prior solutions ---\n" +
          priorContext; // append runtime content if any
      }
    }

    // Step 2: Run the agent
    const start = Date.now();
    const output = await agentFn(input, priorContext || undefined);
    const durationMs = Date.now() - start;

    // 0.5.4 — async best-effort capture queued via the runtime.
    if (runtime) {
      try {
        await runtime.afterRun({
          userText: problem,
          assistantText: output,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.projectPath ? { projectPath: options.projectPath } : {}),
        });
      } catch (err) {
        void err;
      }
    }

    // Step 3: Store the trace (legacy v1 path — preserved)
    let traceId: string | undefined;
    if (opts.autoStore) {
      const solution = opts.extractSolution
        ? opts.extractSolution(output)
        : { summary: output.slice(0, layer.config.maxResponseChars ?? 500), steps: [] as SolutionStep[] };

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

// ---------------------------------------------------------------------------
// 0.5.4 §8.7 — wrapGeneric: framework-neutral hook for LangChain /
// LangGraph / custom runtimes. Mirrors wrapAgent's lifecycle but
// with explicit input/output extractors so callers can hook into
// frameworks whose call shape isn't string → string.
// ---------------------------------------------------------------------------

export interface WrapGenericOptions<TIn, TOut> {
  /** BadgeEvent.source attribution. */
  source: RuntimeSource;
  sessionId?: string;
  projectPath?: string;

  /** Pull the user-facing prompt out of the framework input. */
  extractPrompt: (input: TIn) => string;
  /**
   * Optional: inject `additionalContext` (from `runtime.beforeRun`)
   * into the framework input. When omitted, context is NOT injected
   * — useful when the framework has its own context plumbing and the
   * caller just wants BadgeEvents.
   */
  injectContext?: (input: TIn, additionalContext: string) => TIn;
  /** Optional: pull the assistant text out of the framework output. */
  extractOutput?: (output: TOut) => string;
  /**
   * Optional: derive tool calls observed during this LLM call from
   * the input/output pair. Returned calls are passed to
   * `runtime.observeToolBatch`. Most frameworks won't expose this;
   * leave undefined to skip — TB TOOL / TB LOOP then activates only
   * once observeToolBatch is wired manually.
   */
  observeTools?: (input: TIn, output: TOut) => Array<{
    toolName: string;
    toolInput: unknown;
    toolUseId?: string;
    outcome?: "ok" | "error" | "unknown";
  }>;
  /** Per-event BadgeEvent callback. */
  onBadge?: (ev: BadgeEvent) => void;
  /** Bring-your-own runtime. Default: build one lazily. */
  runtime?: Runtime;
}

/**
 * Wrap a generic async call with the SDK runtime lifecycle.
 *
 * Example (LangChain Runnable):
 * ```ts
 *   const wrappedInvoke = wrapGeneric(layer, chain.invoke.bind(chain), {
 *     source: "langchain",
 *     extractPrompt: (input) => input.input,
 *     onBadge: (ev) => console.log(ev.label),
 *   });
 * ```
 *
 * Failure invariant: TraceBase failures (recall, badge emission,
 * observation, capture) never break the wrapped call. The original
 * `call(input)` result is returned unchanged.
 */
export function wrapGeneric<TIn, TOut>(
  layer: ReasoningLayer,
  call: (input: TIn) => Promise<TOut>,
  options: WrapGenericOptions<TIn, TOut>,
): (input: TIn) => Promise<TOut> {
  const explicitRuntime = options.runtime ?? null;

  return async (input: TIn): Promise<TOut> => {
    const runtime = explicitRuntime ?? resolveRuntime(layer, options, options.source);
    let modifiedInput = input;
    try {
      if (runtime) {
        try {
          const promptText = options.extractPrompt(input);
          const before = await runtime.beforeRun({
            prompt: promptText,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
          if (
            before.additionalContext.length > 0 &&
            typeof options.injectContext === "function"
          ) {
            modifiedInput = options.injectContext(input, before.additionalContext);
          }
        } catch (err) {
          void err; // never break the wrapped call
        }
      }

      const output = await call(modifiedInput);

      if (runtime) {
        try {
          if (typeof options.observeTools === "function" && options.sessionId) {
            const toolCalls = options.observeTools(input, output);
            if (toolCalls.length > 0) {
              await runtime.observeToolBatch({
                sessionId: options.sessionId,
                ...(options.projectPath ? { projectPath: options.projectPath } : {}),
                toolCalls,
              });
            }
          }
          if (typeof options.extractOutput === "function") {
            await runtime.afterRun({
              userText: options.extractPrompt(input),
              assistantText: options.extractOutput(output),
              ...(options.sessionId ? { sessionId: options.sessionId } : {}),
              ...(options.projectPath ? { projectPath: options.projectPath } : {}),
            });
          }
        } catch (err) {
          void err;
        }
      }

      return output;
    } finally {
      if (!explicitRuntime && runtime) {
        try {
          await runtime.close();
        } catch {
          // best-effort cleanup for the implicit convenience runtime
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime the wrapper should use. Returns the explicit
 * runtime if the caller passed one; otherwise builds a lazy
 * runtime if `onBadge` is set; otherwise returns null (legacy path).
 *
 * The lazy runtime owns its own SQLite handle, so callers using
 * many wrappers should pass an explicit shared runtime to avoid
 * opening N connections. The lazy form is a convenience for
 * one-shot scripts.
 */
function resolveRuntime(
  layer: ReasoningLayer,
  options: {
    runtime?: Runtime;
    onBadge?: (ev: BadgeEvent) => void;
    sessionId?: string;
    projectPath?: string;
    source?: RuntimeSource;
  },
  defaultSource: RuntimeSource,
): Runtime | null {
  if (options.runtime) return options.runtime;
  if (typeof options.onBadge !== "function") return null;
  return createRuntime(layer, {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    source: options.source ?? defaultSource,
    onBadge: options.onBadge,
  });
}
