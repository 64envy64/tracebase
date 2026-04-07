import type { ReasoningLayer } from "../core/engine.js";
import type { RecallInjectConfig, RecallResult } from "../types.js";

// ============================================================================
// Recall-Before-Call: shared injection logic
//
// The core optimization loop of TraceBase:
//   User message → recall() → high-confidence match? → inject → LLM call → store
//
// Design principles (Ref: Guu et al., 2020 — REALM; Lewis et al., 2020 — RAG):
//   - High threshold (0.72) to minimize false positives
//   - Skip exact self-references (re-asking = prior solution insufficient)
//   - Only inject outcome:"success" traces
//   - Never mutate user params — always shallow clone
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

/** Why an injection was skipped — for observability/metrics. */
export type SkipReason =
  | "no_results"            // recall returned zero results above minScore
  | "filtered_exact_match"  // all results were exact fingerprint matches
  | "filtered_outcome"      // all results had non-success outcome
  | "filtered_combined";    // combination of filters removed all candidates

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

  if (results.length === 0) {
    notifySkipped(layer, "no_results");
    return null;
  }

  const beforeFilter = results.length;
  let filtered = results;

  // Track filter reasons for precise diagnostics
  let exactFiltered = 0;
  let outcomeFiltered = 0;

  if (skipExact) {
    const before = filtered.length;
    filtered = filtered.filter((r) => r.matchType !== "exact");
    exactFiltered = before - filtered.length;
  }

  if (successOnly) {
    const before = filtered.length;
    filtered = filtered.filter((r) => r.trace.solution.outcome === "success");
    outcomeFiltered = before - filtered.length;
  }

  filtered = filtered.slice(0, maxInjections);

  if (filtered.length === 0) {
    // Determine the specific reason
    const reason: SkipReason =
      exactFiltered === beforeFilter ? "filtered_exact_match" :
      outcomeFiltered > 0 && exactFiltered === 0 ? "filtered_outcome" :
      "filtered_combined";
    notifySkipped(layer, reason, results[0]?.score);
    return null;
  }

  notifyInjection(layer, filtered.map((r) => ({
    traceId: r.trace.id,
    score: r.score,
    matchType: r.matchType,
  })));

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
 *
 * Handles system content as both string and content block array
 * (OpenAI's newer multi-part content format).
 */
export function injectIntoOpenAIMessages(
  messages: Array<{ role: string; content: unknown }>,
  injectionText: string,
): Array<{ role: string; content: unknown }> {
  const cloned = [...messages];
  const systemIdx = cloned.findIndex((m) => m.role === "system");

  if (systemIdx >= 0) {
    const existing = cloned[systemIdx]!;
    const currentContent = existing.content;

    let newContent: unknown;
    if (typeof currentContent === "string") {
      // Standard string system message
      newContent = `${currentContent}\n\n${injectionText}`;
    } else if (Array.isArray(currentContent)) {
      // Content block array: [{ type: "text", text: "..." }, ...]
      newContent = [...(currentContent as Array<{ type: string; text?: string }>), { type: "text", text: injectionText }];
    } else {
      // Unknown format — append as string, best effort
      newContent = `${String(currentContent ?? "")}\n\n${injectionText}`;
    }

    cloned[systemIdx] = { ...existing, content: newContent };
  } else {
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
// Internal — Injection formatting
// ============================================================================

function formatInjectionBlock(results: RecallResult[]): string {
  if (results.length === 1) {
    return formatSingleInjection(results[0]!);
  }

  return results
    .map((r, i) => formatSingleInjection(r, i + 1))
    .join("\n\n");
}

function formatSingleInjection(r: RecallResult, index?: number): string {
  const tag = index !== undefined ? `prior_solution_${index}` : "prior_solution";
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
    `<${tag} confidence="${confidence}%" match="${r.matchType}">` +
    `\nA similar problem was previously solved:` +
    `\n${summary}${explanation}${metaLine}` +
    `\nApply this if relevant to the current problem.` +
    `\n</${tag}>`
  );
}
