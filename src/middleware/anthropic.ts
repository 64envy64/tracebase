import type { ReasoningLayer } from "../core/engine.js";
import type { RecallInjectConfig } from "../types.js";
import {
  performRecall,
  injectIntoAnthropicSystem,
  type InjectionResult,
} from "./recall-inject.js";

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

  // Wrap messages.create
  const originalCreate = messages["create"] as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof originalCreate === "function") {
    messages["create"] = new Proxy(originalCreate, {
      apply: makeApplyHandler(layer, injectEnabled, recallConfig),
    });
  }

  // Wrap messages.stream (Anthropic SDK helper)
  const originalStream = messages["stream"] as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof originalStream === "function") {
    messages["stream"] = new Proxy(originalStream, {
      apply: makeApplyHandler(layer, injectEnabled, recallConfig),
    });
  }

  (client as Record<symbol, unknown>)[WRAPPED] = true;
  return client;
}

function makeApplyHandler(
  layer: ReasoningLayer,
  injectEnabled: boolean,
  recallConfig?: RecallInjectConfig,
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

    safeStore(layer, problemText, responseText.slice(0, 500),
      isFailure ? "failure" : "success",
      params?.model, durationMs, totalTokens || undefined, injection);

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
    safeStore(layer, problemText, content.slice(0, 500),
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
  } catch {
    // Silent
  }
}
