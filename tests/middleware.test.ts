import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ReasoningLayer } from "../src/core/engine.js";
import { wrapOpenAI } from "../src/middleware/openai.js";
import { wrapAnthropic } from "../src/middleware/anthropic.js";
import { wrapAgent } from "../src/middleware/generic.js";

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch { /* ok */ }
  }
}

describe("OpenAI middleware", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-mw-openai-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("captures successful completions", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "Fixed the bug" }, finish_reason: "stop" }],
            usage: { total_tokens: 150 },
          }),
        },
      },
    };

    const wrapped = wrapOpenAI(mockClient, layer);
    await wrapped.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: "Fix TypeError in UserList" }],
    });

    expect(layer.count()).toBe(1);
    const traces = layer.listTraces();
    expect(traces[0]!.problem.description).toBe("Fix TypeError in UserList");
    expect(traces[0]!.solution.outcome).toBe("success");
    expect(traces[0]!.metadata.agent).toBe("openai");
  });

  it("captures API errors as failure traces", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => { throw new Error("Rate limit exceeded"); },
        },
      },
    };

    const wrapped = wrapOpenAI(mockClient, layer);
    await expect(
      wrapped.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: "Fix the bug" }],
      }),
    ).rejects.toThrow("Rate limit exceeded");

    expect(layer.count()).toBe(1);
    const traces = layer.listTraces();
    expect(traces[0]!.solution.outcome).toBe("failure");
    expect(traces[0]!.solution.summary).toContain("Rate limit");
  });

  it("prevents double-wrapping", () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: "ok" } }] }),
        },
      },
    };

    const wrapped1 = wrapOpenAI(mockClient, layer);
    const wrapped2 = wrapOpenAI(wrapped1, layer);
    expect(wrapped1).toBe(wrapped2);
  });

  it("handles content block arrays", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
          }),
        },
      },
    };

    const wrapped = wrapOpenAI(mockClient, layer);
    await wrapped.chat.completions.create({
      model: "gpt-4",
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Fix the error" }],
      }],
    });

    expect(layer.count()).toBe(1);
    expect(layer.listTraces()[0]!.problem.description).toBe("Fix the error");
  });
});

describe("Anthropic middleware", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-mw-anthropic-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("captures successful messages", async () => {
    const mockClient = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "Fixed the null pointer" }],
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: "end_turn",
        }),
      },
    };

    const wrapped = wrapAnthropic(mockClient, layer);
    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Debug the crash" }],
    });

    expect(layer.count()).toBe(1);
    const traces = layer.listTraces();
    expect(traces[0]!.solution.outcome).toBe("success");
    expect(traces[0]!.metadata.tokensUsed).toBe(150);
  });

  it("captures API errors as failure", async () => {
    const mockClient = {
      messages: {
        create: async () => { throw new Error("Overloaded"); },
      },
    };

    const wrapped = wrapAnthropic(mockClient, layer);
    await expect(
      wrapped.messages.create({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Help" }],
      }),
    ).rejects.toThrow("Overloaded");

    expect(layer.count()).toBe(1);
    expect(layer.listTraces()[0]!.solution.outcome).toBe("failure");
  });

  it("prevents double-wrapping", () => {
    const mockClient = {
      messages: {
        create: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    };

    const wrapped1 = wrapAnthropic(mockClient, layer);
    const wrapped2 = wrapAnthropic(wrapped1, layer);
    expect(wrapped1).toBe(wrapped2);
  });
});

describe("Generic agent wrapper", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-mw-generic-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("wraps an agent function with auto-recall and auto-store", async () => {
    const agent = async (input: string, _prior?: string) => `Solved: ${input}`;
    const wrapped = wrapAgent(layer, agent, { agent: "test-agent" });

    const result = await wrapped("Fix login bug");
    expect(result.output).toBe("Solved: Fix login bug");
    expect(result.traceId).toBeDefined();
    expect(layer.count()).toBe(1);
  });

  it("injects prior solutions when available", async () => {
    // Store a trace first
    layer.storeTrace({
      problem: { description: "login session expired too early", tags: [] },
      solution: { summary: "Extended session TTL to 24h", steps: [], outcome: "success" },
    });

    let receivedContext = "";
    const agent = async (_input: string, prior?: string) => {
      receivedContext = prior ?? "";
      return "Done";
    };

    const wrapped = wrapAgent(layer, agent, { agent: "test" });
    const result = await wrapped("login session expired too early");

    expect(receivedContext).toContain("Prior solutions");
    expect(result.priorSolutions.length).toBeGreaterThanOrEqual(1);
  });

  it("respects autoRecall=false", async () => {
    const agent = async (input: string, prior?: string) => {
      expect(prior).toBeUndefined();
      return "Done";
    };

    const wrapped = wrapAgent(layer, agent, {
      agent: "test",
      autoRecall: false,
    });

    const result = await wrapped("test");
    expect(result.priorSolutions).toEqual([]);
  });

  it("respects autoStore=false", async () => {
    const agent = async () => "Done";
    const wrapped = wrapAgent(layer, agent, {
      agent: "test",
      autoStore: false,
    });

    await wrapped("test");
    expect(layer.count()).toBe(0);
  });
});
