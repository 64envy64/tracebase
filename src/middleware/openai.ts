import type { ReasoningLayer } from "../core/engine.js";

const WRAPPED = Symbol.for("tracebase.wrapped");

/**
 * OpenAI SDK middleware.
 * Wraps an OpenAI client instance to automatically capture reasoning traces
 * from chat completions.
 *
 * Usage:
 *   import OpenAI from "openai";
 *   import { ReasoningLayer, wrapOpenAI } from "tracebase";
 *
 *   const layer = new ReasoningLayer();
 *   const openai = wrapOpenAI(new OpenAI(), layer);
 *
 *   // Use normally — traces are captured automatically
 *   const response = await openai.chat.completions.create({
 *     model: "gpt-4",
 *     messages: [{ role: "user", content: "Fix the TypeError in app.ts" }],
 *   });
 */
export function wrapOpenAI<T extends object>(client: T, layer: ReasoningLayer): T {
  // Prevent double-wrapping
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
        messages?: Array<{
          role: string;
          content: string | Array<{ type: string; text?: string }>;
        }>;
      } | undefined;

      const start = Date.now();
      let result: unknown;
      let apiError = false;

      try {
        result = await Reflect.apply(target, thisArg, args);
      } catch (err) {
        apiError = true;
        // Store the failure trace before re-throwing
        const messages = params?.messages;
        const lastUser = messages ? [...messages].reverse().find((m) => m.role === "user") : undefined;
        if (lastUser) {
          const content = typeof lastUser.content === "string"
            ? lastUser.content
            : (lastUser.content as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text).join("\n");
          try {
            layer.storeTrace({
              problem: { description: content, tags: ["auto-captured"] },
              solution: {
                summary: `API error: ${err instanceof Error ? err.message : String(err)}`,
                steps: [], outcome: "failure",
              },
              metadata: {
                agent: "openai", model: params?.model,
                durationMs: Date.now() - start, source: "middleware:openai",
              },
            });
          } catch { /* don't mask the original error */ }
        }
        throw err;
      }

      const durationMs = Date.now() - start;
      if (apiError) return result;

      // Extract user message (supports string and content block array)
      const messages = params?.messages;
      if (!messages || messages.length === 0) return result;
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUser) return result;

      const problemText = typeof lastUser.content === "string"
        ? lastUser.content
        : (lastUser.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text).join("\n");
      if (!problemText) return result;

      // Extract response
      const completion = result as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { total_tokens?: number };
      };
      const responseText = completion.choices?.[0]?.message?.content;
      if (!responseText) return result;

      // Detect failure from finish_reason or empty/error content
      const finishReason = completion.choices?.[0]?.finish_reason;
      const isFailure = finishReason === "error" || finishReason === "content_filter";
      const outcome = isFailure ? "failure" as const : "success" as const;

      try {
        layer.storeTrace({
          problem: { description: problemText, tags: ["auto-captured"] },
          solution: {
            summary: responseText.slice(0, 500),
            steps: [], outcome,
          },
          metadata: {
            agent: "openai", model: params?.model,
            tokensUsed: completion.usage?.total_tokens,
            durationMs, source: "middleware:openai",
          },
        });
      } catch {
        // Silent — don't break the user's agent
      }

      return result;
    },
  });

  (client as Record<symbol, unknown>)[WRAPPED] = true;
  return client;
}
