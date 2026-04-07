import type { ReasoningLayer } from "../core/engine.js";
import type { RecallInjectConfig } from "../types.js";
import {
  performRecall,
  injectIntoOpenAIMessages,
  notifyInjection,
  notifySkipped,
  type InjectionResult,
} from "./recall-inject.js";

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
 *   import { ReasoningLayer, wrapOpenAI } from "tracebase";
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
          notifyInjection(layer, injection.sources);
        } else {
          notifySkipped(layer, "no_match_above_threshold");
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
        usage?: { total_tokens?: number };
      };
      const responseText = completion.choices?.[0]?.message?.content;
      if (!responseText) return result;

      const finishReason = completion.choices?.[0]?.finish_reason;
      const outcome = finishReason === "error" || finishReason === "content_filter"
        ? "failure" as const : "success" as const;

      safeStore(layer, problemText, responseText.slice(0, 500), outcome,
        params?.model, durationMs, completion.usage?.total_tokens, injection);

      return result;
    },
  });

  (client as Record<symbol, unknown>)[WRAPPED] = true;
  return client;
}

// ============================================================================
// Streaming
// ============================================================================

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { total_tokens?: number };
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
  let stored = false;

  const storeOnEnd = () => {
    if (stored || !problemText || !content) return;
    stored = true;
    const outcome = finishReason === "error" ? "failure" as const : "success" as const;
    safeStore(layer, problemText, content.slice(0, 500), outcome,
      model, Date.now() - startTime, totalTokens, injection);
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
                if (chunk.usage) totalTokens = chunk.usage.total_tokens;
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
  } catch {
    // Silent
  }
}
