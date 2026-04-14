import { readFileSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";
import type { AgentStep, ToolCall } from "./types.js";
import type { Sandbox } from "./sandbox.js";

// Load .env
function loadEnv(): Record<string, string> {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 5; i++) {
    try { const c = readFileSync(join(dir, ".env"), "utf-8");
      const env: Record<string, string> = {};
      for (const line of c.split("\n")) {
        const t = line.trim(); if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("="); if (eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1);
      }
      return env;
    } catch { dir = join(dir, ".."); }
  }
  return {};
}
const ENV = loadEnv();

const TOOL_DEFS_ANTHROPIC = [
  {
    name: "readFile",
    description: "Read the contents of a file in the project",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "File path relative to project root" } },
      required: ["path"],
    },
  },
  {
    name: "editFile",
    description: "Replace a file's entire contents with new content",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to project root" },
        content: { type: "string", description: "Complete new file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "runTests",
    description: "Run the test suite and return results. Call this after editing to verify your fix.",
    input_schema: { type: "object" as const, properties: {} },
  },
];

const TOOL_DEFS_OPENAI = TOOL_DEFS_ANTHROPIC.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

const BASE_SYSTEM = `You are an expert software engineer debugging a codebase.
You have access to tools: readFile, editFile, runTests.

Your goal: make all tests pass.

Strategy:
1. Run tests first to see what's failing
2. Read the relevant source file
3. Diagnose the root cause
4. Edit the file to fix the bug
5. Run tests to verify

Use exactly one tool call per step. Be precise and efficient.
When all tests pass, stop.`;

// Augmented system prompt — imported from inject.ts for skip-to-fix strategy
import { AUGMENTED_SYSTEM } from "./inject.js";

/**
 * Run a full agentic trajectory for one fixture.
 *
 * The agent loop: LLM → tool call → execute → append result → repeat.
 * Stops when tests pass or step limit reached.
 */
export async function runAgenticTrajectory(
  model: string,
  sandbox: Sandbox,
  language: "typescript" | "python",
  systemPrompt: string,
  maxSteps: number,
  injection?: string | null,
): Promise<{ steps: AgentStep[]; success: boolean; testOutput: string; stopReason: string }> {
  const provider = model.startsWith("claude") ? "anthropic" : "azure";
  const messages: ConversationMessage[] = [];
  const steps: AgentStep[] = [];
  let success = false;
  let testOutput = "";
  let stopReason = "step_limit";

  // Build system prompt and initial message based on injection availability
  // Key: injection goes in first user message (seen once),
  // NOT in system prompt (would be repeated every step).
  const parts = buildPromptParts(injection);
  const actualSystem = parts.system;
  messages.push({ role: "user", content: parts.initialMessage });

  for (let step = 1; step <= maxSteps; step++) {
    const startMs = Date.now();

    let response: LLMResponse;
    try {
      if (provider === "anthropic") {
        response = await callAnthropicWithTools(model, actualSystem, messages);
      } else {
        response = await callAzureWithTools(model, actualSystem, messages);
      }
    } catch (err) {
      // Retry once on transient errors
      await new Promise((r) => setTimeout(r, 2000));
      try {
        if (provider === "anthropic") {
          response = await callAnthropicWithTools(model, actualSystem, messages);
        } else {
          response = await callAzureWithTools(model, actualSystem, messages);
        }
      } catch {
        stopReason = "error";
        break;
      }
    }

    // Extract tool call
    const toolCall = response.toolCall;
    if (!toolCall) {
      // Model didn't call a tool — it's done or confused
      stopReason = response.text?.includes("DONE") || response.text?.includes("pass") ? "gave_up" : "error";
      steps.push({
        stepNumber: step, toolName: "think",
        toolInput: {}, toolOutput: response.text ?? "",
        inputTokens: response.inputTokens, outputTokens: response.outputTokens,
        durationMs: Date.now() - startMs,
      });
      break;
    }

    // Execute tool
    let toolOutput_: string;
    if (toolCall.name === "readFile") {
      toolOutput_ = sandbox.readFile(String(toolCall.input.path ?? ""));
    } else if (toolCall.name === "editFile") {
      toolOutput_ = sandbox.editFile(String(toolCall.input.path ?? ""), String(toolCall.input.content ?? ""));
    } else if (toolCall.name === "runTests") {
      const result = sandbox.runTests(language);
      toolOutput_ = result.output;
      if (result.passed) {
        success = true;
        testOutput = result.output;
        stopReason = "tests_passed";
      }
    } else {
      toolOutput_ = `Unknown tool: ${toolCall.name}`;
    }

    // Truncate tool output to save context
    if (toolOutput_.length > 3000) {
      toolOutput_ = toolOutput_.slice(0, 1500) + "\n...(truncated)...\n" + toolOutput_.slice(-1500);
    }

    steps.push({
      stepNumber: step,
      toolName: toolCall.name,
      toolInput: toolCall.input,
      toolOutput: toolOutput_.slice(0, 500),
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs: Date.now() - startMs,
    });

    // Append to conversation
    if (provider === "anthropic") {
      messages.push({
        role: "assistant",
        content: response.rawContent,
        toolUseId: toolCall.id,
        toolName: toolCall.name,
      });
      messages.push({
        role: "user",
        toolResultId: toolCall.id,
        content: toolOutput_,
      });
    } else {
      messages.push({
        role: "assistant",
        content: response.text ?? "",
        toolCallId: toolCall.id,
        toolCallName: toolCall.name,
        toolCallArgs: JSON.stringify(toolCall.input),
      });
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: toolOutput_,
      });
    }

    if (success) break;

    // Rate limit protection
    await new Promise((r) => setTimeout(r, 300));
  }

  return { steps, success, testOutput, stopReason };
}

/**
 * Build system prompt and initial user message.
 *
 * Key insight from Context Rot research (Chroma 2025, arxiv 2510.05381):
 * Injection in system prompt gets multiplied across every step.
 * Instead, use AUGMENTED_SYSTEM (skip-to-fix strategy) and put the
 * injection directive in the first user message (seen once, not repeated).
 */
export function buildPromptParts(injection?: string | null): {
  system: string;
  initialMessage: string;
} {
  if (!injection) {
    return {
      system: BASE_SYSTEM,
      initialMessage: "The tests are failing. Fix the bug. Start by running the tests.",
    };
  }

  return {
    system: AUGMENTED_SYSTEM,
    initialMessage: `${injection}\n\nThe tests are failing. Apply the known fix. Start by reading the source file.`,
  };
}

// ============================================================================
// Internal — API calls with tool use
// ============================================================================

interface ConversationMessage {
  role: string;
  content: unknown;
  toolUseId?: string;
  toolName?: string;
  toolResultId?: string;
  toolCallId?: string;
  toolCallName?: string;
  toolCallArgs?: string;
}

interface LLMResponse {
  text?: string;
  toolCall?: ToolCall;
  inputTokens: number;
  outputTokens: number;
  rawContent?: unknown;
}

function callAnthropicWithTools(
  model: string, system: string, messages: ConversationMessage[],
): Promise<LLMResponse> {
  const apiKey = ENV.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  // Convert to Anthropic API format.
  // Anthropic tool-use requires:
  // - assistant messages with content: [{ type: "tool_use", id, name, input }]
  // - user messages with content: [{ type: "tool_result", tool_use_id, content }]
  const fixedMessages: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.content && typeof m.content !== "string") {
      // This is a raw Anthropic content array (from previous response)
      fixedMessages.push({ role: "assistant", content: m.content });
    } else if (m.toolResultId) {
      // Tool result — must be wrapped in content array
      fixedMessages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolResultId, content: String(m.content) }],
      });
    } else {
      fixedMessages.push({ role: m.role, content: String(m.content) });
    }
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model, max_tokens: 2048, system,
      tools: TOOL_DEFS_ANTHROPIC,
      messages: fixedMessages,
    });

    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: {
        "Content-Type": "application/json", "x-api-key": apiKey,
        "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(data);
          if (p.error) { reject(new Error(`Anthropic: ${p.error.message}`)); return; }

          const content = p.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
          const textBlock = content?.find((b) => b.type === "text");
          const toolBlock = content?.find((b) => b.type === "tool_use");

          resolve({
            text: textBlock?.text,
            toolCall: toolBlock ? {
              id: toolBlock.id!,
              name: toolBlock.name as ToolCall["name"],
              input: toolBlock.input ?? {},
            } : undefined,
            inputTokens: p.usage?.input_tokens ?? 0,
            outputTokens: p.usage?.output_tokens ?? 0,
            rawContent: content,
          });
        } catch (e) { reject(new Error(`Anthropic parse: ${e}`)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function callAzureWithTools(
  model: string, system: string, messages: ConversationMessage[],
): Promise<LLMResponse> {
  const apiKey = ENV.AZURE_OPENAI_API_KEY;
  const endpoint = ENV.AZURE_OPENAI_ENDPOINT;
  const version = ENV.AZURE_OPENAI_API_VERSION ?? "2024-12-01-preview";
  if (!apiKey || !endpoint) throw new Error("Azure env not set");

  // Convert to OpenAI format
  const apiMessages: Array<Record<string, unknown>> = [
    { role: "system", content: system },
  ];
  for (const m of messages) {
    if (m.role === "tool") {
      apiMessages.push({ role: "tool", tool_call_id: m.toolCallId, content: String(m.content) });
    } else if (m.role === "assistant" && m.toolCallId) {
      apiMessages.push({
        role: "assistant", content: m.content || null,
        tool_calls: [{ id: m.toolCallId, type: "function", function: { name: m.toolCallName, arguments: m.toolCallArgs } }],
      });
    } else {
      apiMessages.push({ role: m.role, content: String(m.content) });
    }
  }

  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/openai/deployments/${model}/chat/completions?api-version=${version}`);
    const body = JSON.stringify({
      messages: apiMessages, max_completion_tokens: 2048,
      tools: TOOL_DEFS_OPENAI,
    });

    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: "POST",
      headers: {
        "Content-Type": "application/json", "api-key": apiKey,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(data);
          if (p.error) { reject(new Error(`Azure: ${p.error.message}`)); return; }

          const choice = p.choices?.[0];
          const tc = choice?.message?.tool_calls?.[0];

          resolve({
            text: choice?.message?.content,
            toolCall: tc ? {
              id: tc.id,
              name: tc.function.name as ToolCall["name"],
              input: JSON.parse(tc.function.arguments || "{}"),
            } : undefined,
            inputTokens: p.usage?.prompt_tokens ?? 0,
            outputTokens: p.usage?.completion_tokens ?? 0,
          });
        } catch (e) { reject(new Error(`Azure parse: ${e}`)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
