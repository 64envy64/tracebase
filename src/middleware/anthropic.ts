import type { ReasoningLayer } from "../core/engine.js";
import type { RecallInjectConfig, Runtime } from "../types.js";
import { jaccardSimilarity } from "../core/fingerprint.js";
import {
  performRecall,
  injectIntoAnthropicSystem,
  type InjectionResult,
} from "./recall-inject.js";
import { createRuntime } from "../sdk/runtime.js";

const WRAPPED = Symbol.for("tracebase.wrapped");

/**
 * Anthropic SDK middleware.
 * Wraps an Anthropic client to:
 *   1. RECALL prior solutions before each LLM call
 *   2. INJECT matches into the system prompt
 *   3. RECORD the result as a trace
 *
 * Works with regular, stream:true, and messages.stream() responses.
 *
 * Usage:
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { ReasoningLayer, wrapAnthropic } from "tracebase-ai";
 *
 *   const layer = new ReasoningLayer();
 *   const anthropic = wrapAnthropic(new Anthropic(), layer, { minScore: 0.72 });
 */
export function wrapAnthropic<T extends object>(
  client: T,
  layer: ReasoningLayer,
  recallConfig?: RecallInjectConfig,
): T {
  if ((client as Record<symbol, unknown>)[WRAPPED]) return client;

  const messages = (client as Record<string, unknown>)["messages"] as
    | Record<string, unknown>
    | undefined;
  if (!messages) return client;

  const injectEnabled = recallConfig?.enabled !== false && recallConfig !== undefined;
  const runtime = resolveAnthropicRuntime(layer, recallConfig);

  // Wrap messages.create
  const originalCreate = messages["create"] as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof originalCreate === "function") {
    messages["create"] = new Proxy(originalCreate, {
      apply: makeApplyHandler(layer, injectEnabled, recallConfig, runtime),
    });
  }

  // Wrap messages.stream (Anthropic SDK helper)
  const originalStream = messages["stream"] as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof originalStream === "function") {
    messages["stream"] = new Proxy(originalStream, {
      apply: makeApplyHandler(layer, injectEnabled, recallConfig, runtime),
    });
  }

  (client as Record<symbol, unknown>)[WRAPPED] = true;
  return client;
}

function resolveAnthropicRuntime(
  layer: ReasoningLayer,
  recallConfig?: RecallInjectConfig,
): Runtime | null {
  if (!recallConfig) return null;
  if (recallConfig.runtime) return recallConfig.runtime;
  if (typeof recallConfig.onBadge !== "function") return null;
  return createRuntime(layer, {
    ...(recallConfig.sessionId ? { sessionId: recallConfig.sessionId } : {}),
    ...(recallConfig.projectPath ? { projectPath: recallConfig.projectPath } : {}),
    source: recallConfig.source ?? "anthropic",
    onBadge: recallConfig.onBadge,
  });
}

function makeApplyHandler(
  layer: ReasoningLayer,
  injectEnabled: boolean,
  recallConfig?: RecallInjectConfig,
  runtime?: Runtime | null,
) {
  return async function apply(
    target: (...args: unknown[]) => Promise<unknown>,
    thisArg: unknown,
    argsList: unknown[],
  ): Promise<unknown> {
    const params = argsList[0] as AnthropicParams | undefined;
    const problemText = extractProblemText(params?.messages);
    const start = Date.now();

    // --- Phase 1: Recall & Inject ---
    let injection: InjectionResult | null = null;
    let modifiedArgs = argsList;

    // 0.5.4 SDK runtime — additive: BadgeEvents fire alongside the
    // legacy recall path.
    if (runtime && problemText && params) {
      try {
        const before = await runtime.beforeRun({
          prompt: problemText,
          ...(recallConfig?.sessionId ? { sessionId: recallConfig.sessionId } : {}),
          ...(recallConfig?.projectPath ? { projectPath: recallConfig.projectPath } : {}),
        });
        if (before.additionalContext.length > 0) {
          const newSystem = injectIntoAnthropicSystem(params.system, before.additionalContext);
          const newParams = { ...params, system: newSystem };
          modifiedArgs = [newParams, ...argsList.slice(1)];
        }
      } catch (err) {
        void err;
      }
    }

    if (injectEnabled && problemText && params) {
      injection = performRecall(layer, problemText, recallConfig!);

      if (injection) {
        const newSystem = injectIntoAnthropicSystem(params.system, injection.text);
        const newParams = { ...params, system: newSystem };
        modifiedArgs = [newParams, ...argsList.slice(1)];
      }
    }

    // --- Phase 2: Call LLM ---
    let result: unknown;
    try {
      result = await Reflect.apply(target, thisArg, modifiedArgs);
    } catch (err) {
      if (problemText) {
        safeStore(layer, problemText,
          `API error: ${err instanceof Error ? err.message : String(err)}`,
          "failure", params?.model, Date.now() - start, undefined, injection);
      }
      throw err;
    }

    // --- Phase 3: Handle streaming ---
    if (result && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
      return wrapAnthropicStream(
        result as AsyncIterable<AnthropicStreamEvent>,
        layer, problemText, params?.model, start, injection,
      );
    }

    // --- Phase 4: Store trace (regular response) ---
    const durationMs = Date.now() - start;
    if (!problemText) return result;

    const response = result as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
      type?: string;
    };

    const responseText = response.content
      ?.filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
    if (!responseText) return result;

    const isFailure = response.type === "error" || response.stop_reason === "error";
    const totalTokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    const maxChars = layer.config.maxResponseChars ?? 500;
    safeStore(layer, problemText, responseText.slice(0, maxChars),
      isFailure ? "failure" : "success",
      params?.model, durationMs, totalTokens || undefined, injection);

    // Emit token tracking event
    emitTokenUsage(layer, injection, response.usage, params?.model, durationMs);

    return result;
  };
}

// ============================================================================
// Streaming
// ============================================================================

interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number };
}

function wrapAnthropicStream(
  stream: AsyncIterable<AnthropicStreamEvent>,
  layer: ReasoningLayer,
  problemText: string | null,
  model: string | undefined,
  startTime: number,
  injection: InjectionResult | null,
): unknown {
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let isError = false;
  let stored = false;

  const storeOnEnd = () => {
    if (stored || !problemText || !content) return;
    stored = true;
    const totalTokens = inputTokens + outputTokens;
    const maxChars = layer.config.maxResponseChars ?? 500;
    safeStore(layer, problemText, content.slice(0, maxChars),
      isError ? "failure" : "success",
      model, Date.now() - startTime, totalTokens || undefined, injection);
  };

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return function () {
          const iterator = (target as AsyncIterable<AnthropicStreamEvent>)[Symbol.asyncIterator]();
          return {
            async next(): Promise<IteratorResult<AnthropicStreamEvent>> {
              const result = await iterator.next();
              if (result.done) {
                storeOnEnd();
              } else {
                const event = result.value;
                if (event.type === "content_block_delta" && event.delta?.text) content += event.delta.text;
                if (event.type === "message_start" && event.message?.usage) inputTokens = event.message.usage.input_tokens ?? 0;
                if (event.type === "message_delta") {
                  if (event.delta?.stop_reason === "error") isError = true;
                  if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
                }
              }
              return result;
            },
            async return(value?: unknown): Promise<IteratorResult<AnthropicStreamEvent>> {
              storeOnEnd();
              if (typeof (iterator as { return?: Function }).return === "function") {
                return (iterator as AsyncIterator<AnthropicStreamEvent>).return!(value);
              }
              return { done: true, value: undefined as unknown as AnthropicStreamEvent };
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ============================================================================
// Helpers
// ============================================================================

interface AnthropicParams {
  model?: string;
  stream?: boolean;
  system?: string | Array<{ type: string; text?: string }>;
  messages?: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
}

function extractProblemText(
  messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>,
): string | null {
  if (!messages || messages.length === 0) return null;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;

  const text = typeof lastUser.content === "string"
    ? lastUser.content
    : lastUser.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");

  return text || null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function emitTokenUsage(
  layer: ReasoningLayer,
  injection: InjectionResult | null,
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
  model: string | undefined,
  durationMs: number,
): void {
  try {
    const total = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
    layer.notify({
      type: "tokens:tracked",
      data: {
        promptTokens: usage?.input_tokens,
        completionTokens: usage?.output_tokens,
        totalTokens: total || undefined,
        injectionTokens: injection ? estimateTokens(injection.text) : 0,
        wasInjected: injection !== null && injection.sources.length > 0,
        injectedTraceId: injection?.sources[0]?.traceId,
        model,
        durationMs,
      },
    });
  } catch {
    // Silent
  }
}

function safeStore(
  layer: ReasoningLayer,
  problem: string,
  summary: string,
  outcome: "success" | "failure",
  model: string | undefined,
  durationMs: number,
  tokensUsed: number | undefined,
  injection: InjectionResult | null,
): void {
  try {
    const custom: Record<string, unknown> = {};
    if (injection && injection.sources.length > 0) {
      custom["injectedFrom"] = injection.sources[0]!.traceId;
      custom["injectionScore"] = injection.sources[0]!.score;
    }

    layer.storeTrace({
      problem: { description: problem, tags: ["auto-captured"] },
      solution: { summary, steps: [], outcome },
      metadata: {
        agent: "anthropic",
        model,
        tokensUsed,
        durationMs,
        source: "middleware:anthropic",
        custom: Object.keys(custom).length > 0 ? custom : undefined,
      },
    });

    if (injection && injection.sources.length > 0 && outcome === "success") {
      autoFeedback(layer, summary, injection);
    }
  } catch {
    // Silent
  }
}

function autoFeedback(
  layer: ReasoningLayer,
  agentOutput: string,
  injection: InjectionResult,
): void {
  try {
    const threshold = layer.config.autoFeedbackThreshold ?? 0.3;
    const outputTokens = agentOutput.toLowerCase().split(/\s+/).filter(Boolean);
    const injectionTokens = injection.text.toLowerCase().split(/\s+/).filter(Boolean);
    const similarity = jaccardSimilarity(outputTokens, injectionTokens);

    if (similarity >= threshold) {
      for (const source of injection.sources) {
        layer.feedback(source.traceId, true);
      }
    }
  } catch {
    // Silent
  }
}
