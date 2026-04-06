import type { ReasoningLayer } from "../core/engine.js";

const WRAPPED = Symbol.for("tracebase.wrapped");

/**
 * OpenAI SDK middleware.
 * Wraps an OpenAI client to automatically capture reasoning traces
 * from chat completions — both regular and streaming responses.
 *
 * Usage:
 *   import OpenAI from "openai";
 *   import { ReasoningLayer, wrapOpenAI } from "tracebase";
 *
 *   const layer = new ReasoningLayer();
 *   const openai = wrapOpenAI(new OpenAI(), layer);
 *
 *   // Regular — trace captured automatically
 *   await openai.chat.completions.create({ model: "gpt-4", messages: [...] });
 *
 *   // Streaming — trace captured after stream completes
 *   const stream = await openai.chat.completions.create({ model: "gpt-4", messages: [...], stream: true });
 *   for await (const chunk of stream) { ... }
 */
export function wrapOpenAI<T extends object>(client: T, layer: ReasoningLayer): T {
  if ((client as Record<symbol, unknown>)[WRAPPED]) return client;

  const chat = (client as Record<string, unknown>)["chat"] as
    | Record<string, unknown>
    | undefined;
  if (!chat?.["completions"]) return client;

  const completions = chat["completions"] as Record<string, unknown>;
  const originalCreate = completions["create"] as (...args: unknown[]) => Promise<unknown>;
  if (typeof originalCreate !== "function") return client;

  completions["create"] = new Proxy(originalCreate, {
    async apply(target, thisArg, args) {
      const params = args[0] as {
        model?: string;
        stream?: boolean;
        messages?: Array<{
          role: string;
          content: string | Array<{ type: string; text?: string }>;
        }>;
      } | undefined;

      const problemText = extractUserMessage(params?.messages);
      const start = Date.now();

      // --- Handle API errors ---
      let result: unknown;
      try {
        result = await Reflect.apply(target, thisArg, args);
      } catch (err) {
        if (problemText) {
          safeStore(layer, problemText, `API error: ${err instanceof Error ? err.message : String(err)}`,
            "failure", params?.model, Date.now() - start, undefined, "middleware:openai");
        }
        throw err;
      }

      // --- Streaming response ---
      if (params?.stream && result && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
        return wrapStream(
          result as AsyncIterable<StreamChunk>,
          layer, problemText, params?.model, start,
        );
      }

      // --- Regular response ---
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
        params?.model, durationMs, completion.usage?.total_tokens, "middleware:openai");

      return result;
    },
  });

  (client as Record<symbol, unknown>)[WRAPPED] = true;
  return client;
}

// ============================================================================
// Streaming support
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
      model, Date.now() - startTime, totalTokens, "middleware:openai");
  };

  // Proxy preserves all properties of the original stream (e.g., .controller, .toReadableStream())
  // while intercepting async iteration to collect content.
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
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) content += delta.content;
                if (chunk.choices?.[0]?.finish_reason) {
                  finishReason = chunk.choices[0].finish_reason;
                }
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
  source: string,
): void {
  try {
    layer.storeTrace({
      problem: { description: problem, tags: ["auto-captured"] },
      solution: { summary, steps: [], outcome },
      metadata: { agent: "openai", model, tokensUsed, durationMs, source },
    });
  } catch {
    // Silent — never break the user's agent
  }
}
