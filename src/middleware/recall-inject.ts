import type { ReasoningLayer } from "../core/engine.js";
import type { RecallInjectConfig, RecallResult, InjectionFormatConfig } from "../types.js";

// ============================================================================
// Recall-Before-Call: shared injection logic
//
// The core optimization loop of TraceBase:
//   User message → recall() → high-confidence match? → inject → LLM call → store
//
// Design principles (Ref: Guu et al., 2020 — REALM; Lewis et al., 2020 — RAG):
//   - High threshold (configurable, default 0.72) to minimize false positives
//   - Skip exact self-references (re-asking = prior solution insufficient)
//   - Only inject outcome:"success" traces
//   - Never mutate user params — always shallow clone
//   - XML content is properly escaped to prevent parsing breakage
// ============================================================================

const DEFAULT_MIN_SCORE = 0.72;
const DEFAULT_MAX_INJECTIONS = 1;

/** Default injection format config — all values configurable. */
const DEFAULT_FORMAT_CONFIG: Required<InjectionFormatConfig> = {
  format: "xml",
  maxSummaryLength: 300,
  maxExplanationLength: 200,
  includeMetrics: false,
};

/** The result of a pre-call recall check. */
export interface InjectionResult {
  /** Formatted text to append to the system prompt */
  text: string;
  /** Source traces that contributed */
  sources: Array<{ traceId: string; score: number; matchType: string }>;
  /** Per-source signal breakdown for weight attribution */
  signalBreakdowns?: Array<{
    traceId: string;
    signals: Record<string, number>;
  }>;
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

  // Read injection format config from the engine
  const formatConfig = layer.config.injection;

  return {
    text: formatInjectionBlock(filtered, formatConfig),
    sources: filtered.map((r) => ({
      traceId: r.trace.id,
      score: r.score,
      matchType: r.matchType,
    })),
    signalBreakdowns: filtered.map((r) => ({
      traceId: r.trace.id,
      signals: { ...r.signals },
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
// Injection formatting — XML, JSON, Markdown
// ============================================================================

/**
 * Escape XML special characters to prevent injection parsing breakage.
 * Handles &, <, >, ", ' per XML 1.0 spec.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resolveFormatConfig(
  overrides?: InjectionFormatConfig,
): Required<InjectionFormatConfig> {
  return {
    format: overrides?.format ?? DEFAULT_FORMAT_CONFIG.format,
    maxSummaryLength: overrides?.maxSummaryLength ?? DEFAULT_FORMAT_CONFIG.maxSummaryLength,
    maxExplanationLength: overrides?.maxExplanationLength ?? DEFAULT_FORMAT_CONFIG.maxExplanationLength,
    includeMetrics: overrides?.includeMetrics ?? DEFAULT_FORMAT_CONFIG.includeMetrics,
  };
}

function formatInjectionBlock(
  results: RecallResult[],
  formatConfig?: InjectionFormatConfig,
): string {
  const cfg = resolveFormatConfig(formatConfig);

  if (results.length === 1) {
    return formatSingle(results[0]!, cfg);
  }

  return results
    .map((r, i) => formatSingle(r, cfg, i + 1))
    .join("\n\n");
}

function formatSingle(
  r: RecallResult,
  cfg: Required<InjectionFormatConfig>,
  index?: number,
): string {
  switch (cfg.format) {
    case "json":
      return formatAsJson(r, cfg, index);
    case "markdown":
      return formatAsMarkdown(r, cfg, index);
    case "xml":
    default:
      return formatAsXml(r, cfg, index);
  }
}

function formatAsXml(
  r: RecallResult,
  cfg: Required<InjectionFormatConfig>,
  index?: number,
): string {
  const tag = index !== undefined ? `prior_solution_${index}` : "prior_solution";
  const confidence = (r.score * 100).toFixed(0);
  const summary = escapeXml(r.trace.solution.summary.slice(0, cfg.maxSummaryLength));
  const explanation = r.trace.solution.explanation
    ? `\n${escapeXml(r.trace.solution.explanation.slice(0, cfg.maxExplanationLength))}`
    : "";

  const meta = [
    r.trace.problem.language,
    r.trace.problem.framework,
    r.trace.problem.errorType,
  ].filter(Boolean).join(", ");
  const metaLine = meta ? `\nContext: ${escapeXml(meta)}` : "";

  const metricsLine = cfg.includeMetrics
    ? `\nVerified: ${r.trace.quality.helpfulCount}/${r.trace.quality.recallCount} helpful, score ${r.trace.quality.score.toFixed(2)}`
    : "";

  const prov = r.trace.provenance;
  const provenanceParts: string[] = [];
  if (prov?.origin && prov.origin !== "local") provenanceParts.push(`origin: ${prov.origin}`);
  if (prov?.author) provenanceParts.push(`by: ${escapeXml(prov.author)}`);
  if (prov?.appliedCount && prov.appliedCount > 0) provenanceParts.push(`applied ${prov.appliedCount}x`);
  const provenanceLine = provenanceParts.length > 0 ? `\nProvenance: ${provenanceParts.join(", ")}` : "";

  return (
    `<${tag} confidence="${confidence}%" match="${r.matchType}">` +
    `\nA similar problem was previously solved:` +
    `\n${summary}${explanation}${metaLine}${metricsLine}${provenanceLine}` +
    `\nApply this if relevant to the current problem.` +
    `\n</${tag}>`
  );
}

function formatAsJson(
  r: RecallResult,
  cfg: Required<InjectionFormatConfig>,
  index?: number,
): string {
  const obj: Record<string, unknown> = {
    type: "prior_solution",
    ...(index !== undefined && { index }),
    confidence: parseFloat((r.score * 100).toFixed(1)),
    matchType: r.matchType,
    summary: r.trace.solution.summary.slice(0, cfg.maxSummaryLength),
  };

  if (r.trace.solution.explanation) {
    obj.explanation = r.trace.solution.explanation.slice(0, cfg.maxExplanationLength);
  }

  const meta = [r.trace.problem.language, r.trace.problem.framework, r.trace.problem.errorType].filter(Boolean);
  if (meta.length > 0) obj.context = meta;

  if (cfg.includeMetrics) {
    obj.metrics = {
      helpfulCount: r.trace.quality.helpfulCount,
      recallCount: r.trace.quality.recallCount,
      qualityScore: r.trace.quality.score,
    };
  }

  const prov = r.trace.provenance;
  if (prov && (prov.author || prov.appliedCount > 0)) {
    obj.provenance = {
      ...(prov.origin !== "local" && { origin: prov.origin }),
      ...(prov.author && { author: prov.author }),
      ...(prov.appliedCount > 0 && { appliedCount: prov.appliedCount }),
    };
  }

  return JSON.stringify(obj, null, 2);
}

function formatAsMarkdown(
  r: RecallResult,
  cfg: Required<InjectionFormatConfig>,
  index?: number,
): string {
  const header = index !== undefined ? `### Prior Solution ${index}` : "### Prior Solution";
  const confidence = (r.score * 100).toFixed(0);
  const summary = r.trace.solution.summary.slice(0, cfg.maxSummaryLength);
  const explanation = r.trace.solution.explanation
    ? `\n> ${r.trace.solution.explanation.slice(0, cfg.maxExplanationLength)}`
    : "";

  const meta = [r.trace.problem.language, r.trace.problem.framework, r.trace.problem.errorType].filter(Boolean);
  const metaLine = meta.length > 0 ? `\n**Context:** ${meta.join(", ")}` : "";

  const metricsLine = cfg.includeMetrics
    ? `\n**Verified:** ${r.trace.quality.helpfulCount}/${r.trace.quality.recallCount} helpful (score: ${r.trace.quality.score.toFixed(2)})`
    : "";

  const prov = r.trace.provenance;
  const provenanceParts: string[] = [];
  if (prov?.author) provenanceParts.push(`by ${prov.author}`);
  if (prov?.appliedCount && prov.appliedCount > 0) provenanceParts.push(`applied ${prov.appliedCount}x`);
  const provenanceLine = provenanceParts.length > 0 ? `\n**Source:** ${provenanceParts.join(", ")}` : "";

  return `${header} (${confidence}% confidence, ${r.matchType})\n${summary}${explanation}${metaLine}${metricsLine}${provenanceLine}\n*Apply this if relevant to the current problem.*`;
}
