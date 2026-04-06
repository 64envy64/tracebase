import type { ReasoningLayer } from "../core/engine.js";

const WRAPPED = Symbol.for("tracebase.wrapped");

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
  // Prevent double-wrapping
  if ((client as Record<symbol, unknown>)[WRAPPED]) return client;

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
      let result: unknown;

      try {
        result = await Reflect.apply(target, thisArg, args);
      } catch (err) {
        // Capture API failures
        const problemText = extractProblemText(params?.messages);
        if (problemText) {
          try {
            layer.storeTrace({
              problem: { description: problemText, tags: ["auto-captured"] },
              solution: {
                summary: `API error: ${err instanceof Error ? err.message : String(err)}`,
                steps: [], outcome: "failure",
              },
              metadata: {
                agent: "anthropic", model: params?.model,
                durationMs: Date.now() - start, source: "middleware:anthropic",
              },
            });
          } catch { /* don't mask */ }
        }
        throw err;
      }

      const durationMs = Date.now() - start;
      const problemText = extractProblemText(params?.messages);
      if (!problemText) return result;

      // Extract response text
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

      // Detect failure: error type or stop_reason
      const isFailure = response.type === "error" || response.stop_reason === "error";
      const outcome = isFailure ? "failure" as const : "success" as const;

      const totalTokens =
        (response.usage?.input_tokens ?? 0) +
        (response.usage?.output_tokens ?? 0);

      try {
        layer.storeTrace({
          problem: { description: problemText, tags: ["auto-captured"] },
          solution: {
            summary: responseText.slice(0, 500),
            steps: [], outcome,
          },
          metadata: {
            agent: "anthropic", model: params?.model,
            tokensUsed: totalTokens || undefined,
            durationMs, source: "middleware:anthropic",
          },
        });
      } catch {
        // Silent
      }

      return result;
    },
  });

  (client as Record<symbol, unknown>)[WRAPPED] = true;
  return client;
}

function extractProblemText(
  messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>,
): string | null {
  if (!messages || messages.length === 0) return null;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;

  const text =
    typeof lastUser.content === "string"
      ? lastUser.content
      : lastUser.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n");

  return text || null;
}
