import { readFileSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";
import type { EvalAgent, EvalTask } from "../types.js";

// Load .env manually (no dotenv dependency)
function loadEnv(): Record<string, string> {
  try {
    // Walk up from current file to find .env at project root
    let dir = import.meta.dirname ?? process.cwd();
    let envPath = "";
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, ".env");
      try { readFileSync(candidate); envPath = candidate; break; } catch { /* */ }
      dir = join(dir, "..");
    }
    if (!envPath) return {};
    const content = readFileSync(envPath, "utf-8"); // eslint-disable-line
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }
    return env;
  } catch {
    return {};
  }
}

const ENV = loadEnv();

/**
 * System prompt for the eval agent.
 * The agent is a coding assistant that must diagnose and fix bugs.
 */
const SYSTEM_PROMPT = `You are an expert software engineer. You will be given a bug description.
Diagnose the root cause and provide the fix. Be concise — state the problem and solution directly.
Do not include pleasantries, disclaimers, or unnecessary explanation.`;

/**
 * Real LLM Agent — calls Anthropic or Azure OpenAI APIs.
 *
 * Supports:
 *   - claude-haiku-4-5-20251001
 *   - claude-sonnet-4-6
 *   - claude-opus-4-6
 *   - gpt-5.4-mini (Azure)
 *   - gpt-5.4-nano (Azure)
 *   - gpt-5.3-chat (Azure)
 */
export class LLMAgent implements EvalAgent {
  name: string;
  model: string;
  private provider: "anthropic" | "azure";

  constructor(model: string) {
    this.model = model;
    this.name = model;
    this.provider = model.startsWith("claude") ? "anthropic" : "azure";
  }

  async solve(
    task: EvalTask,
    priorContext?: string,
  ): Promise<{ output: string; tokensUsed: number }> {
    const hasPrior = !!priorContext && priorContext.length > 0;

    // Technique 5 (arxiv 2412.18547): reduce token budget when prior
    // knowledge is available — model should apply, not derive.
    // Baseline gets full budget; augmented gets reduced budget.
    const maxTokens = hasPrior ? 400 : 768;

    if (this.provider === "anthropic") {
      return callAnthropic(this.model, task, priorContext, maxTokens);
    } else {
      return callAzure(this.model, task, priorContext, maxTokens);
    }
  }
}

/**
 * Build the system prompt and user message for the LLM call.
 *
 * When priorContext is available, combines:
 * - Imperative framing (Technique 2): "APPLY DIRECTLY, do not re-derive"
 * - Token budget signaling (Technique 1): "Respond in under N tokens"
 * - Dead-end avoidance (Technique 3): prior solution steers away from failures
 * - Compressed payload (Technique 6): minimal framing overhead
 *
 * Ref: "Token-Budget-Aware LLM Reasoning" (arxiv 2412.18547) — TALE framework
 * Ref: "Optimizing Token Consumption in LLM Code Reasoning" (arxiv 2504.15989)
 */
function buildMessages(
  task: EvalTask,
  priorContext?: string,
): { system: string; userMessage: string } {
  const userMessage =
    `Bug report:\n${task.description}` +
    `\nLanguage: ${task.language}` +
    (task.framework ? `\nFramework: ${task.framework}` : "") +
    (task.errorType ? `\nError type: ${task.errorType}` : "") +
    `\n\nDiagnose the root cause and provide the fix.`;

  if (!priorContext) {
    return { system: SYSTEM_PROMPT, userMessage };
  }

  // Augmented system prompt: inject prior knowledge with imperative framing.
  // Key: the budget constraint ("under 150 words") is the primary token
  // reduction mechanism (TALE framework, 67% reduction in paper).
  const augmentedSystem =
    `${SYSTEM_PROMPT}\n\n` +
    `${priorContext}\n\n` +
    `You have a verified prior solution above. Apply it directly to the current problem. ` +
    `Do not re-derive from scratch or explore alternative approaches. ` +
    `State the root cause in one sentence, then give the fix. Respond in under 150 words.`;

  return { system: augmentedSystem, userMessage };
}

function callAnthropic(model: string, task: EvalTask, priorContext: string | undefined, maxTokens: number): Promise<{ output: string; tokensUsed: number }> {
  const apiKey = ENV.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in .env");

  return new Promise((resolve, reject) => {
    const { system, userMessage } = buildMessages(task, priorContext);
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          if (!data || data.length === 0) {
            reject(new Error(`Anthropic ${model}: empty response`));
            return;
          }
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Anthropic ${model}: ${parsed.error.message}`));
            return;
          }
          const output = parsed.content
            ?.filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join("\n") ?? "";
          const tokensUsed = (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0);
          resolve({ output, tokensUsed });
        } catch (e) {
          // Retry once on parse error (network issue)
          reject(new Error(`Anthropic ${model}: parse error (${data.length} bytes)`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function callAzure(model: string, task: EvalTask, priorContext: string | undefined, maxTokens: number): Promise<{ output: string; tokensUsed: number }> {
  const apiKey = ENV.AZURE_OPENAI_API_KEY;
  const endpoint = ENV.AZURE_OPENAI_ENDPOINT;
  const apiVersion = ENV.AZURE_OPENAI_API_VERSION ?? "2024-12-01-preview";
  if (!apiKey || !endpoint) throw new Error("AZURE_OPENAI_API_KEY or AZURE_OPENAI_ENDPOINT not set in .env");

  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`);

    const { system, userMessage } = buildMessages(task, priorContext);
    const body = JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
      max_completion_tokens: maxTokens,
    });

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Azure ${model}: ${parsed.error.message}`));
            return;
          }
          const output = parsed.choices?.[0]?.message?.content ?? "";
          const tokensUsed = (parsed.usage?.prompt_tokens ?? 0) + (parsed.usage?.completion_tokens ?? 0);
          resolve({ output, tokensUsed });
        } catch (e) {
          reject(new Error(`Azure parse error: ${e}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
