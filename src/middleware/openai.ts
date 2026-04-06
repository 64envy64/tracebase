import type { ReasoningLayer } from "../core/engine.js";

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
        messages?: Array<{ role: string; content: string }>;
      } | undefined;

      const start = Date.now();
      const result = await Reflect.apply(target, thisArg, args);
      const durationMs = Date.now() - start;

      // Extract problem from the last user message
      const messages = params?.messages;
      if (!messages || messages.length === 0) return result;

      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUser) return result;

      // Extract response
      const completion = result as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      const responseText = completion.choices?.[0]?.message?.content;
      if (!responseText) return result;

      // Store trace asynchronously (don't block the response)
      try {
        layer.storeTrace({
          problem: {
            description: lastUser.content,
            tags: ["auto-captured"],
          },
          solution: {
            summary: responseText.slice(0, 500),
            steps: [],
            outcome: "success",
          },
          metadata: {
            agent: "openai",
            model: params?.model,
            tokensUsed: completion.usage?.total_tokens,
            durationMs,
            source: "middleware:openai",
          },
        });
      } catch {
        // Silent failure — don't break the user's agent
      }

      return result;
    },
  });

  return client;
}
