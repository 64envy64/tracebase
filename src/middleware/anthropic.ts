import type { ReasoningLayer } from "../core/engine.js";

const WRAPPED = Symbol.for("tracebase.wrapped");

/**
 * Anthropic SDK middleware.
 * Wraps an Anthropic client to automatically capture reasoning traces —
 * both regular and streaming responses.
 *
 * Usage:
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { ReasoningLayer, wrapAnthropic } from "tracebase";
 *
 *   const layer = new ReasoningLayer();
 *   const anthropic = wrapAnthropic(new Anthropic(), layer);
 *
 *   // Regular
 *   await anthropic.messages.create({ model: "claude-sonnet-4-20250514", ... });
 *
 *   // Streaming — trace captured after stream completes
 *   const stream = await anthropic.messages.stream({ ... });
 *   for await (const event of stream) { ... }
 */
export function wrapAnthropic<T extends object>(
  client: T,
  layer: ReasoningLayer,
): T {
  if ((client as Record<symbol, unknown>)[WRAPPED]) return client;

  const messages = (client as Record<string, unknown>)["messages"] as
    | Record<string, unknown>
    | undefined;
  if (!messages) return client;

  // Wrap messages.create
  const originalCreate = messages["create"] as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof originalCreate === "function") {
    messages["create"] = new Proxy(originalCreate, {
      async apply(target, thisArg, args) {
        const params = args[0] as AnthropicParams | undefined;
        const problemText = extractProblemText(params?.messages);
        const start = Date.now();

        let result: unknown;
        try {
          result = await Reflect.apply(target, thisArg, args);
        } catch (err) {
          if (problemText) {
            safeStore(layer, problemText,
              `API error: ${err instanceof Error ? err.message : String(err)}`,
              "failure", params?.model, Date.now() - start, undefined);
          }
          throw err;
        }

        // Streaming via create({ stream: true })
        if (params?.stream && result && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
          return wrapAnthropicStream(
            result as AsyncIterable<AnthropicStreamEvent>,
            layer, problemText, params?.model, start,
          );
        }

        // Regular response
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
          params?.model, durationMs, totalTokens || undefined);

        return result;
      },
    });
  }

  // Also wrap messages.stream if it exists (Anthropic SDK helper)
  const originalStream = messages["stream"] as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof originalStream === "function") {
    messages["stream"] = new Proxy(originalStream, {
      async apply(target, thisArg, args) {
        const params = args[0] as AnthropicParams | undefined;
        const problemText = extractProblemText(params?.messages);
        const start = Date.now();

        let result: unknown;
        try {
          result = await Reflect.apply(target, thisArg, args);
        } catch (err) {
          if (problemText) {
            safeStore(layer, problemText,
              `API error: ${err instanceof Error ? err.message : String(err)}`,
              "failure", params?.model, Date.now() - start, undefined);
          }
          throw err;
        }

        if (result && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
          return wrapAnthropicStream(
            result as AsyncIterable<AnthropicStreamEvent>,
            layer, problemText, params?.model, start,
          );
        }

        return result;
      },
    });
  }

  (client as Record<symbol, unknown>)[WRAPPED] = true;
  return client;
}

// ============================================================================
// Streaming support
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
      model, Date.now() - startTime, totalTokens || undefined);
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
                if (event.type === "content_block_delta" && event.delta?.text) {
                  content += event.delta.text;
                }
                if (event.type === "message_start" && event.message?.usage) {
                  inputTokens = event.message.usage.input_tokens ?? 0;
                }
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
): void {
  try {
    layer.storeTrace({
      problem: { description: problem, tags: ["auto-captured"] },
      solution: { summary, steps: [], outcome },
      metadata: { agent: "anthropic", model, tokensUsed, durationMs, source: "middleware:anthropic" },
    });
  } catch {
    // Silent
  }
}
