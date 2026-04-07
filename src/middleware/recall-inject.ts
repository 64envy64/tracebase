import type { ReasoningLayer } from "../core/engine.js";
import type { RecallInjectConfig, RecallResult } from "../types.js";

// ============================================================================
// Recall-Before-Call: shared injection logic
//
// Used by both OpenAI and Anthropic middleware to query institutional memory
// before each LLM call and inject high-confidence prior solutions.
//
// Design principles:
//   - High threshold (0.72) to avoid false positives
//   - Skip exact self-references (user is re-asking → prior solution didn't work)
//   - Only inject successful traces
//   - Never mutate the user's original params — always shallow clone
//   - Minimal token overhead (~50-80 tokens per injection)
// ============================================================================

const DEFAULT_MIN_SCORE = 0.72;
const DEFAULT_MAX_INJECTIONS = 1;

/** The result of a pre-call recall check. */
export interface InjectionResult {
  /** Formatted text to append to the system prompt */
  text: string;
  /** Source traces that contributed */
  sources: Array<{ traceId: string; score: number; matchType: string }>;
}

/**
 * Perform recall and determine if an injection should happen.
 * Returns null if no high-confidence match found.
 */
export function performRecall(
  layer: ReasoningLayer,
  problemText: string,
  config: RecallInjectConfig,
): InjectionResult | null {
  const minScore = config.minScore ?? DEFAULT_MIN_SCORE;
  const maxInjections = config.maxInjections ?? DEFAULT_MAX_INJECTIONS;
  const skipExact = config.skipExactMatch ?? true;
  const successOnly = config.successOnly ?? true;

  // Over-fetch to account for post-filtering
  const results = layer.recall({
    problem: problemText,
    minScore,
    limit: maxInjections + 3,
    context: config.context,
  });

  if (results.length === 0) return null;

  // Post-filter
  let filtered = results;

  if (skipExact) {
    filtered = filtered.filter((r) => r.matchType !== "exact");
  }

  if (successOnly) {
    filtered = filtered.filter((r) => r.trace.solution.outcome === "success");
  }

  filtered = filtered.slice(0, maxInjections);

  if (filtered.length === 0) return null;

  return {
    text: formatInjectionBlock(filtered),
    sources: filtered.map((r) => ({
      traceId: r.trace.id,
      score: r.score,
      matchType: r.matchType,
    })),
  };
}

/**
 * Inject prior solution text into an OpenAI-format messages array.
 * Returns a NEW array — never mutates the input.
 */
export function injectIntoOpenAIMessages(
  messages: Array<{ role: string; content: unknown }>,
  injectionText: string,
): Array<{ role: string; content: unknown }> {
  const cloned = [...messages];
  const systemIdx = cloned.findIndex((m) => m.role === "system");

  if (systemIdx >= 0) {
    // Append to existing system message
    const existing = cloned[systemIdx]!;
    cloned[systemIdx] = {
      ...existing,
      content: `${String(existing.content)}\n\n${injectionText}`,
    };
  } else {
    // Prepend new system message
    cloned.unshift({ role: "system", content: injectionText });
  }

  return cloned;
}

/**
 * Inject prior solution text into Anthropic's system parameter.
 * Returns the new system value.
 */
export function injectIntoAnthropicSystem(
  existingSystem: string | Array<{ type: string; text?: string }> | undefined,
  injectionText: string,
): string | Array<{ type: string; text?: string }> {
  if (existingSystem === undefined || existingSystem === null) {
    return injectionText;
  }

  if (typeof existingSystem === "string") {
    return `${existingSystem}\n\n${injectionText}`;
  }

  // Content block array
  return [...existingSystem, { type: "text", text: injectionText }];
}

/**
 * Notify the engine about injection events (for observability).
 */
export function notifyInjection(
  layer: ReasoningLayer,
  sources: InjectionResult["sources"],
): void {
  for (const s of sources) {
    layer.notify({
      type: "recall:injected",
      traceId: s.traceId,
      score: s.score,
      matchType: s.matchType,
    });
  }
}

export function notifySkipped(
  layer: ReasoningLayer,
  reason: string,
  topScore?: number,
): void {
  layer.notify({
    type: "recall:skipped",
    reason,
    topScore,
  });
}

// ============================================================================
// Internal
// ============================================================================

function formatInjectionBlock(results: RecallResult[]): string {
  if (results.length === 1) {
    return formatSingleInjection(results[0]!);
  }

  // Multiple injections
  return results
    .map((r, i) => `${formatSingleInjection(r, i + 1)}`)
    .join("\n\n");
}

function formatSingleInjection(r: RecallResult, index?: number): string {
  const prefix = index !== undefined ? ` #${index}` : "";
  const confidence = (r.score * 100).toFixed(0);
  const summary = r.trace.solution.summary.slice(0, 300);
  const explanation = r.trace.solution.explanation
    ? `\n${r.trace.solution.explanation.slice(0, 200)}`
    : "";

  const meta = [
    r.trace.problem.language,
    r.trace.problem.framework,
    r.trace.problem.errorType,
  ].filter(Boolean).join(", ");
  const metaLine = meta ? `\nContext: ${meta}` : "";

  return (
    `<prior_solution${prefix} confidence="${confidence}%" match="${r.matchType}">` +
    `\nA similar problem was previously solved:` +
    `\n${summary}${explanation}${metaLine}` +
    `\nApply this if relevant to the current problem.` +
    `\n</prior_solution${prefix}>`
  );
}
