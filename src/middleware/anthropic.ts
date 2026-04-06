import type { ReasoningLayer } from "../core/engine.js";

/**
 * Anthropic SDK middleware.
 * Wraps an Anthropic client to automatically capture reasoning traces.
 *
 * Usage:
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { ReasoningLayer, wrapAnthropic } from "tracebase";
 *
 *   const layer = new ReasoningLayer();
 *   const anthropic = wrapAnthropic(new Anthropic(), layer);
 *
 *   // Use normally — traces are captured automatically
 *   const msg = await anthropic.messages.create({
 *     model: "claude-sonnet-4-20250514",
 *     max_tokens: 1024,
 *     messages: [{ role: "user", content: "Fix the bug" }],
 *   });
 */
export function wrapAnthropic<T extends object>(
  client: T,
  layer: ReasoningLayer,
): T {
  const messages = (client as Record<string, unknown>)["messages"] as
    | Record<string, unknown>
    | undefined;
  if (!messages) return client;

  const originalCreate = messages["create"] as (...args: unknown[]) => Promise<unknown>;
  if (typeof originalCreate !== "function") return client;

  messages["create"] = new Proxy(originalCreate, {
    async apply(target, thisArg, args) {
      const params = args[0] as {
        model?: string;
        messages?: Array<{
          role: string;
          content: string | Array<{ type: string; text?: string }>;
        }>;
      } | undefined;

      const start = Date.now();
      const result = await Reflect.apply(target, thisArg, args);
      const durationMs = Date.now() - start;

      // Extract problem from the last user message
      const msgs = params?.messages;
      if (!msgs || msgs.length === 0) return result;

      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (!lastUser) return result;

      // Handle string or content block array
      const problemText =
        typeof lastUser.content === "string"
          ? lastUser.content
          : lastUser.content
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join("\n");

      if (!problemText) return result;

      // Extract response text
      const response = result as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const responseText = response.content
        ?.filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");

      if (!responseText) return result;

      const totalTokens =
        (response.usage?.input_tokens ?? 0) +
        (response.usage?.output_tokens ?? 0);

      // Store trace (don't block response)
      try {
        layer.storeTrace({
          problem: {
            description: problemText,
            tags: ["auto-captured"],
          },
          solution: {
            summary: responseText.slice(0, 500),
            steps: [],
            outcome: "success",
          },
          metadata: {
            agent: "anthropic",
            model: params?.model,
            tokensUsed: totalTokens || undefined,
            durationMs,
            source: "middleware:anthropic",
          },
        });
      } catch {
        // Silent failure
      }

      return result;
    },
  });

  return client;
}
