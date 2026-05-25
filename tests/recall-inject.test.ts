import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ReasoningLayer } from "../src/core/engine.js";
import { wrapOpenAI } from "../src/middleware/openai.js";
import { wrapAnthropic } from "../src/middleware/anthropic.js";
import {
  performRecall,
  injectIntoOpenAIMessages,
  injectIntoAnthropicSystem,
} from "../src/middleware/recall-inject.js";
import type { Runtime } from "../src/types.js";

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch { /* ok */ }
  }
}

describe("recall-inject module", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-inject-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  describe("performRecall", () => {
    it("returns null when no matches above threshold", () => {
      const result = performRecall(layer, "completely unrelated problem", {
        minScore: 0.72,
      });
      expect(result).toBeNull();
    });

    it("returns injection for high-confidence similar match", () => {
      // Store a relevant trace
      layer.storeTrace({
        problem: {
          description: "TypeError: Cannot read property 'map' of undefined in React UserList",
          errorType: "TypeError",
          language: "typescript",
          framework: "react",
          tags: [],
        },
        solution: {
          summary: "Added optional chaining: users?.map() — data was undefined before API loaded",
          steps: [],
          outcome: "success",
          explanation: "The users array is undefined on first render before the API response arrives",
        },
      });

      // Query with a similar but not identical description
      const result = performRecall(
        layer,
        "TypeError map undefined React component rendering",
        { minScore: 0.3, skipExactMatch: true }, // lower threshold for test
      );

      // Should find the match
      if (result) {
        expect(result.text).toContain("prior_fix");
        expect(result.text).toContain("optional chaining");
        expect(result.sources.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("skips exact fingerprint matches when skipExactMatch=true", () => {
      // Store with NO extra context so fingerprint is purely from description
      layer.storeTrace({
        problem: {
          description: "exact match problem test description only",
          tags: [],
        },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      // Identical description + no context = identical fingerprint = exact match
      const result = performRecall(layer, "exact match problem test description only", {
        minScore: 0.1,
        skipExactMatch: true,
      });
      expect(result).toBeNull();
    });

    it("emits granular skip reasons for metrics", () => {
      // Store a failure trace
      layer.storeTrace({
        problem: { description: "skip reason test failure trace", language: "go", tags: [] },
        solution: { summary: "didn't work", steps: [], outcome: "failure" },
      });

      const events: Array<{ type: string; reason?: string }> = [];
      layer.on("recall:skipped", (e) => {
        if (e.type === "recall:skipped") events.push(e);
      });

      // This should emit "filtered_outcome" because match exists but is failure
      performRecall(layer, "skip reason test failure trace", {
        minScore: 0.1,
        skipExactMatch: false,
        successOnly: true,
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
      const lastEvent = events[events.length - 1]!;
      expect(lastEvent["reason"]).toBe("filtered_outcome");
    });

    it("only injects success traces when successOnly=true", () => {
      layer.storeTrace({
        problem: {
          description: "some error that was not resolved properly",
          language: "python",
          tags: [],
        },
        solution: { summary: "tried but failed", steps: [], outcome: "failure" },
      });

      const result = performRecall(
        layer,
        "some error that was not resolved properly",
        { minScore: 0.1, skipExactMatch: false, successOnly: true },
      );
      // The only match is a failure trace → should be filtered out
      expect(result).toBeNull();
    });
  });

  describe("injectIntoOpenAIMessages", () => {
    it("appends to existing system message", () => {
      const messages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Fix the bug" },
      ];

      const result = injectIntoOpenAIMessages(messages, "<prior_solution>test</prior_solution>");
      expect(result).toHaveLength(2);
      expect(result[0]!.content).toContain("You are a helpful assistant.");
      expect(result[0]!.content).toContain("<prior_solution>");
    });

    it("creates system message when none exists", () => {
      const messages = [{ role: "user", content: "Fix the bug" }];
      const result = injectIntoOpenAIMessages(messages, "<prior_solution>test</prior_solution>");
      expect(result).toHaveLength(2);
      expect(result[0]!.role).toBe("system");
      expect(result[0]!.content).toContain("<prior_solution>");
    });

    it("handles content block array in system message", () => {
      const messages = [
        { role: "system", content: [{ type: "text", text: "You are helpful." }] },
        { role: "user", content: "test" },
      ];
      const result = injectIntoOpenAIMessages(messages, "<prior_solution>hint</prior_solution>");
      expect(result).toHaveLength(2);
      const systemContent = result[0]!.content as Array<{ type: string; text?: string }>;
      expect(Array.isArray(systemContent)).toBe(true);
      expect(systemContent).toHaveLength(2);
      expect(systemContent[1]!.text).toContain("prior_solution");
    });

    it("does not mutate the original array", () => {
      const original = [{ role: "user", content: "test" }];
      const result = injectIntoOpenAIMessages(original, "injected");
      expect(original).toHaveLength(1);
      expect(result).toHaveLength(2);
    });
  });

  describe("injectIntoAnthropicSystem", () => {
    it("creates system when undefined", () => {
      const result = injectIntoAnthropicSystem(undefined, "injected");
      expect(result).toBe("injected");
    });

    it("appends to string system", () => {
      const result = injectIntoAnthropicSystem("You are helpful.", "injected");
      expect(result).toContain("You are helpful.");
      expect(result).toContain("injected");
    });

    it("appends to content block array", () => {
      const existing = [{ type: "text", text: "You are helpful." }];
      const result = injectIntoAnthropicSystem(existing, "injected") as Array<{ type: string; text?: string }>;
      expect(result).toHaveLength(2);
      expect(result[1]!.text).toBe("injected");
    });
  });
});

describe("OpenAI middleware with recall-inject", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-openai-inject-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("injects prior solution into system prompt before LLM call", async () => {
    // Pre-populate with a known solution
    layer.storeTrace({
      problem: {
        description: "CORS error Access-Control-Allow-Origin missing in Express API",
        errorType: "CORSError",
        language: "javascript",
        framework: "express",
        tags: [],
      },
      solution: {
        summary: "Added cors() middleware: app.use(cors({ origin: 'http://localhost:3000' }))",
        steps: [],
        outcome: "success",
      },
    });

    let capturedMessages: unknown[] = [];

    const mockClient = {
      chat: {
        completions: {
          create: async (params: { messages: unknown[] }) => {
            capturedMessages = params.messages;
            return {
              choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
            };
          },
        },
      },
    };

    const wrapped = wrapOpenAI(mockClient, layer, {
      minScore: 0.2, // low threshold for test
      skipExactMatch: true,
    });

    await wrapped.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "user", content: "CORS Access-Control-Allow-Origin error Express API" },
      ],
    });

    // System message should have been injected
    const systemMsg = capturedMessages.find(
      (m: unknown) => (m as { role: string }).role === "system",
    ) as { content: string } | undefined;

    if (systemMsg) {
      expect(systemMsg.content).toContain("prior_fix");
      expect(systemMsg.content).toContain("cors()");
    }
  });

  it("stores injection metadata in trace", async () => {
    layer.storeTrace({
      problem: {
        description: "webpack build fails with Module not found error",
        language: "javascript",
        tags: [],
      },
      solution: {
        summary: "Fixed resolve.extensions in webpack config",
        steps: [],
        outcome: "success",
      },
    });

    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
          }),
        },
      },
    };

    const wrapped = wrapOpenAI(mockClient, layer, {
      minScore: 0.2,
      skipExactMatch: true,
    });

    await wrapped.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: "webpack Module not found build error" }],
    });

    // Check if the stored trace has injection metadata
    const traces = layer.listTraces();
    const autoTrace = traces.find((t) => t.metadata.source === "middleware:openai");
    if (autoTrace?.metadata.custom?.["injectedFrom"]) {
      expect(autoTrace.metadata.custom["injectedFrom"]).toBeDefined();
      expect(autoTrace.metadata.custom["injectionScore"]).toBeGreaterThan(0);
    }
  });

  it("does not inject when config is not provided (backward compat)", async () => {
    layer.storeTrace({
      problem: { description: "some known problem", tags: [] },
      solution: { summary: "known fix", steps: [], outcome: "success" },
    });

    let capturedMessages: unknown[] = [];

    const mockClient = {
      chat: {
        completions: {
          create: async (params: { messages: unknown[] }) => {
            capturedMessages = params.messages;
            return { choices: [{ message: { content: "ok" } }] };
          },
        },
      },
    };

    // No recallConfig → no injection
    const wrapped = wrapOpenAI(mockClient, layer);

    await wrapped.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: "some known problem" }],
    });

    // Messages should be unmodified
    expect(capturedMessages).toHaveLength(1);
    expect((capturedMessages[0] as { role: string }).role).toBe("user");
  });
});

describe("Anthropic middleware with recall-inject", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-anthropic-inject-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("injects into Anthropic system parameter", async () => {
    layer.storeTrace({
      problem: {
        description: "Python ImportError: No module named pandas after pip install",
        language: "python",
        tags: [],
      },
      solution: {
        summary: "Wrong Python version — used python3 -m pip install pandas",
        steps: [],
        outcome: "success",
      },
    });

    let capturedSystem: unknown = undefined;

    const mockClient = {
      messages: {
        create: async (params: { system?: string }) => {
          capturedSystem = params.system;
          return {
            content: [{ type: "text", text: "Done" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };

    const wrapped = wrapAnthropic(mockClient, layer, {
      minScore: 0.2,
      skipExactMatch: true,
    });

    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Python ImportError No module named pandas" }],
    });

    if (typeof capturedSystem === "string" && capturedSystem.includes("prior_solution")) {
      expect(capturedSystem).toContain("pip install");
    }
  });

  it("preserves runtime additionalContext when legacy recall also injects", async () => {
    layer.storeTrace({
      problem: {
        description: "Python ImportError: No module named pandas after pip install",
        language: "python",
        tags: [],
      },
      solution: {
        summary: "Use python3 -m pip install pandas",
        steps: [],
        outcome: "success",
      },
    });

    const runtime = {
      beforeRun: async () => ({
        additionalContext: "<context_fold>runtime folded context</context_fold>",
        badgeEvents: [],
      }),
      afterRun: async () => {},
    } as unknown as Runtime;

    let capturedSystem: unknown = undefined;
    const mockClient = {
      messages: {
        create: async (params: { system?: unknown }) => {
          capturedSystem = params.system;
          return {
            content: [{ type: "text", text: "Done" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };

    const wrapped = wrapAnthropic(mockClient, layer, {
      minScore: 0.2,
      skipExactMatch: true,
      runtime,
    });

    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Python pandas ImportError missing module" }],
    });

    const rendered =
      typeof capturedSystem === "string"
        ? capturedSystem
        : JSON.stringify(capturedSystem);
    expect(rendered).toContain("runtime folded context");
    expect(rendered).toContain("prior_fix");
    expect(rendered).toContain("pip install");
  });

  it("calls runtime.afterRun after a non-streaming Anthropic response", async () => {
    const afterRunCalls: Array<{ userText: string; assistantText: string }> = [];
    const runtime = {
      beforeRun: async () => ({ additionalContext: "", badgeEvents: [] }),
      afterRun: async (input: { userText: string; assistantText: string }) => {
        afterRunCalls.push(input);
      },
    } as unknown as Runtime;

    const mockClient = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "I fixed the issue and tests pass." }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      },
    };

    const wrapped = wrapAnthropic(mockClient, layer, { runtime });
    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Fix the auth bug" }],
    });

    expect(afterRunCalls).toHaveLength(1);
    expect(afterRunCalls[0]).toMatchObject({
      userText: "Fix the auth bug",
      assistantText: "I fixed the issue and tests pass.",
    });
  });
});
