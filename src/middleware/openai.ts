import type { ReasoningLayer } from "../core/engine.js";
import type { RecallInjectConfig, Runtime } from "../types.js";
import { jaccardSimilarity } from "../core/fingerprint.js";
import {
  performRecall,
  injectIntoOpenAIMessages,
  type InjectionResult,
} from "./recall-inject.js";
import { createRuntime } from "../sdk/runtime.js";
import {
  extractOpenAICachedTokens,
  appendPromptCacheHit,
} from "./prompt-cache.js";

const WRAPPED = Symbol.for("tracebase.wrapped");

/**
 * OpenAI SDK middleware.
 * Wraps an OpenAI client to:
 *   1. RECALL prior solutions before each LLM call (when recallConfig provided)
 *   2. INJECT high-confidence matches into the system prompt
 *   3. RECORD the result as a trace after the call completes
 *
 * Works with both regular and streaming responses.
 *
 * Usage:
 *   import OpenAI from "openai";
 *   import { ReasoningLayer, wrapOpenAI } from "tracebase-ai";
 *
 *   const layer = new ReasoningLayer();
 *   const openai = wrapOpenAI(new OpenAI(), layer, { minScore: 0.72 });
 *
 *   // Each call now: recall → inject hint (if found) → call LLM → store trace
 *   await openai.chat.completions.create({ model: "gpt-4o", messages: [...] });
 */
export function wrapOpenAI<T extends object>(
  client: T,
  layer: ReasoningLayer,
  recallConfig?: RecallInjectConfig,
): T {
  if ((client as Record<symbol, unknown>)[WRAPPED]) return client;

  const chat = (client as Record<string, unknown>)["chat"] as
    | Record<string, unknown>
    | undefined;
  if (!chat?.["completions"]) return client;

  const completions = chat["completions"] as Record<string, unknown>;
  const originalCreate = completions["create"] as (...args: unknown[]) => Promise<unknown>;
  if (typeof originalCreate !== "function") return client;

  const injectEnabled = recallConfig?.enabled !== false && recallConfig !== undefined;
  const runtime = resolveOpenAIRuntime(layer, recallConfig);

  completions["create"] = new Proxy(originalCreate, {
    async apply(target, thisArg, argsList) {
      const params = argsList[0] as OpenAIParams | undefined;
      const problemText = extractUserMessage(params?.messages);
      const start = Date.now();

      // --- Phase 1: Recall & Inject ---
      let injection: InjectionResult | null = null;
      let modifiedArgs = argsList;

      if (injectEnabled && problemText && params?.messages) {
        injection = performRecall(layer, problemText, recallConfig!);

        if (injection) {
          // Shallow-clone params, inject into messages — never mutate originals
          const newMessages = injectIntoOpenAIMessages(params.messages, injection.text);
          const newParams = { ...params, messages: newMessages };
          modifiedArgs = [newParams, ...argsList.slice(1)];
          // Events (recall:injected / recall:skipped) emitted inside performRecall
        }
      }

      // 0.5.4 SDK runtime — additive: BadgeEvents fire alongside the
      // legacy recall path. The runtime's `additionalContext` is
      // appended to the OpenAI system slot when present so TB MEMORY
      // / TB CONTEXT facts surface to the model. Failures inside the
      // runtime never break the wrapped call.
      if (runtime && problemText && params?.messages) {
        try {
          const before = await runtime.beforeRun({
            prompt: problemText,
            ...(recallConfig?.sessionId ? { sessionId: recallConfig.sessionId } : {}),
            ...(recallConfig?.projectPath ? { projectPath: recallConfig.projectPath } : {}),
          });
          if (before.additionalContext.length > 0) {
            const baseMessages = (modifiedArgs[0] as OpenAIParams).messages ?? params.messages;
            const newMessages = injectIntoOpenAIMessages(baseMessages, before.additionalContext);
            const newParams = { ...(modifiedArgs[0] as OpenAIParams), messages: newMessages };
            modifiedArgs = [newParams, ...modifiedArgs.slice(1)];
          }
        } catch (err) {
          void err;
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
      if (params?.stream && result && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
        return wrapStream(
          result as AsyncIterable<StreamChunk>,
          layer, problemText, params?.model, start, injection,
        );
      }

      // --- Phase 4: Store trace (regular response) ---
      const durationMs = Date.now() - start;
      if (!problemText) return result;

      const completion = result as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: {
          total_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          cached_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      const responseText = completion.choices?.[0]?.message?.content;
      if (!responseText) return result;

      const finishReason = completion.choices?.[0]?.finish_reason;
      const outcome = finishReason === "error" || finishReason === "content_filter"
        ? "failure" as const : "success" as const;

      const maxChars = layer.config.maxResponseChars ?? 500;
      safeStore(layer, problemText, responseText.slice(0, maxChars), outcome,
        params?.model, durationMs, completion.usage?.total_tokens, injection);

      // Emit token tracking event
      emitTokenUsage(layer, injection, completion.usage, params?.model, durationMs);

      // 0.7.0-rc.7 — provider-reported prompt cache hit. OpenAI
      // auto-caches deterministic prefixes on supported models; the
      // savings show up under `usage.prompt_tokens_details.
      // cached_tokens`. We never estimate from message length.
      const cachedTokens = extractOpenAICachedTokens(completion.usage);
      if (cachedTokens > 0) {
        appendPromptCacheHit(layer, "openai", cachedTokens);
      }

      // 0.5.4 — runtime.afterRun queued; never blocks the return.
      if (runtime) {
        runtime
          .afterRun({
            userText: problemText,
            assistantText: responseText.slice(0, maxChars),
            ...(recallConfig?.sessionId ? { sessionId: recallConfig.sessionId } : {}),
            ...(recallConfig?.projectPath ? { projectPath: recallConfig.projectPath } : {}),
          })
          .catch(() => {
            // never break the wrapped call
          });
      }

      return result;
    },
  });

  (client as Record<symbol, unknown>)[WRAPPED] = true;
  return client;
}

/**
 * Resolve the runtime the OpenAI wrapper should use for BadgeEvent
 * emission + same-session digest recall + tool-loop detection.
 * Returns the explicit runtime if the caller passed one; otherwise
 * builds a lazy runtime when `onBadge` is set; otherwise returns
 * null (legacy path only).
 */
function resolveOpenAIRuntime(
  layer: ReasoningLayer,
  recallConfig?: RecallInjectConfig,
): Runtime | null {
  if (!recallConfig) return null;
  if (recallConfig.runtime) return recallConfig.runtime;
  if (typeof recallConfig.onBadge !== "function") return null;
  return createRuntime(layer, {
    ...(recallConfig.sessionId ? { sessionId: recallConfig.sessionId } : {}),
    ...(recallConfig.projectPath ? { projectPath: recallConfig.projectPath } : {}),
    source: recallConfig.source ?? "openai",
    onBadge: recallConfig.onBadge,
  });
}

// ============================================================================
// Streaming
// ============================================================================

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    total_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function wrapStream(
  stream: AsyncIterable<StreamChunk>,
  layer: ReasoningLayer,
  problemText: string | null,
  model: string | undefined,
  startTime: number,
  injection: InjectionResult | null,
): unknown {
  let content = "";
  let finishReason: string | null = null;
  let totalTokens: number | undefined;
  let cachedTokens = 0;
  let stored = false;

  const storeOnEnd = () => {
    if (stored || !problemText || !content) return;
    stored = true;
    const outcome = finishReason === "error" ? "failure" as const : "success" as const;
    const maxChars = layer.config.maxResponseChars ?? 500;
    safeStore(layer, problemText, content.slice(0, maxChars), outcome,
      model, Date.now() - startTime, totalTokens, injection);
    // 0.7.0-rc.7 — provider-reported cache hit. The OpenAI streaming
    // SDK delivers `usage` in the trailing chunk when
    // `stream_options.include_usage` is on; if not requested,
    // `cachedTokens` stays 0 and no event fires.
    if (cachedTokens > 0) {
      appendPromptCacheHit(layer, "openai", cachedTokens);
    }
  };

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return function () {
          const iterator = (target as AsyncIterable<StreamChunk>)[Symbol.asyncIterator]();
          return {
            async next(): Promise<IteratorResult<StreamChunk>> {
              const result = await iterator.next();
              if (result.done) {
                storeOnEnd();
              } else {
                const chunk = result.value;
                if (chunk.choices?.[0]?.delta?.content) content += chunk.choices[0].delta.content;
                if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
                if (chunk.usage) {
                  totalTokens = chunk.usage.total_tokens;
                  const seen = extractOpenAICachedTokens(chunk.usage);
                  if (seen > 0) cachedTokens = seen;
                }
              }
              return result;
            },
            async return(value?: unknown): Promise<IteratorResult<StreamChunk>> {
              storeOnEnd();
              if (typeof (iterator as { return?: Function }).return === "function") {
                return (iterator as AsyncIterator<StreamChunk>).return!(value);
              }
              return { done: true, value: undefined as unknown as StreamChunk };
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

interface OpenAIParams {
  model?: string;
  stream?: boolean;
  messages?: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
}

function extractUserMessage(
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

/**
 * Estimate token count for a string (rough: 1 token ≈ 4 chars for English).
 * Used for injection overhead estimation when exact counts aren't available.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function emitTokenUsage(
  layer: ReasoningLayer,
  injection: InjectionResult | null,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  model: string | undefined,
  durationMs: number,
): void {
  try {
    layer.notify({
      type: "tokens:tracked",
      data: {
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
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
        agent: "openai",
        model,
        tokensUsed,
        durationMs,
        source: "middleware:openai",
        custom: Object.keys(custom).length > 0 ? custom : undefined,
      },
    });

    // Auto-feedback: if the agent's output aligns with the injected solution,
    // generate implicit positive feedback (weighted at reduced strength).
    // This enables the system to learn without manual feedback() calls.
    if (injection && injection.sources.length > 0 && outcome === "success") {
      autoFeedback(layer, summary, injection);
    }
  } catch {
    // Silent
  }
}

/**
 * Auto-feedback: compare agent output to injected solution.
 * If Jaccard overlap > 0.3, the agent likely used the injected knowledge →
 * treat as implicit positive feedback.
 *
 * Weight: auto-feedback is treated at reduced confidence vs. manual feedback,
 * because the agent may have reached the same conclusion independently.
 * The feedback signal is the actual signal that was recalled, so Thompson
 * Sampling can attribute the success to the right signals.
 *
 * Threshold 0.3 chosen conservatively — only triggers when output
 * clearly mirrors the injected solution, not for tangential overlaps.
 */
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
    // Silent — auto-feedback failure should never affect the main flow
  }
}

