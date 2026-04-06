import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ReasoningLayer } from "../src/core/engine.js";
import { wrapOpenAI } from "../src/middleware/openai.js";
import { wrapAnthropic } from "../src/middleware/anthropic.js";

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch { /* ok */ }
  }
}

// Helper: create an async iterable from an array of chunks
async function* asyncChunks<T>(chunks: T[]): AsyncIterable<T> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("OpenAI streaming middleware", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-stream-openai-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("captures traces from streaming completions", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Fixed " }, finish_reason: null }] },
      { choices: [{ delta: { content: "the bug" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 100 } },
    ];

    const mockClient = {
      chat: {
        completions: {
          create: async (params: { stream?: boolean }) => {
            if (params.stream) return asyncChunks(chunks);
            return { choices: [{ message: { content: "ok" } }] };
          },
        },
      },
    };

    const wrapped = wrapOpenAI(mockClient, layer);
    const stream = await wrapped.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: "Fix the streaming bug" }],
      stream: true,
    }) as AsyncIterable<unknown>;

    // Consume the stream
    const collected: unknown[] = [];
    for await (const chunk of stream) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(3);
    expect(layer.count()).toBe(1);

    const traces = layer.listTraces();
    expect(traces[0]!.problem.description).toBe("Fix the streaming bug");
    expect(traces[0]!.solution.summary).toBe("Fixed the bug");
    expect(traces[0]!.solution.outcome).toBe("success");
  });

  it("handles stream interruption gracefully", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Partial " }, finish_reason: null }] },
      { choices: [{ delta: { content: "response" }, finish_reason: null }] },
    ];

    const mockClient = {
      chat: {
        completions: {
          create: async () => asyncChunks(chunks),
        },
      },
    };

    const wrapped = wrapOpenAI(mockClient, layer);
    const stream = await wrapped.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: "Test interruption" }],
      stream: true,
    }) as AsyncIterable<unknown>;

    // Consume fully (stream ends without finish_reason="stop")
    for await (const _chunk of stream) { /* consume */ }

    expect(layer.count()).toBe(1);
    expect(layer.listTraces()[0]!.solution.summary).toBe("Partial response");
  });
});

describe("Anthropic streaming middleware", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-stream-anthropic-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("captures traces from streaming messages", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 0 } } },
      { type: "content_block_start", content_block: { type: "text", text: "" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "The fix " } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "is done" } },
      { type: "content_block_stop" },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ];

    const mockClient = {
      messages: {
        create: async (params: { stream?: boolean }) => {
          if (params.stream) return asyncChunks(events);
          return {
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };

    const wrapped = wrapAnthropic(mockClient, layer);
    const stream = await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Fix the Anthropic streaming issue" }],
      stream: true,
    }) as AsyncIterable<unknown>;

    const collected: unknown[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toHaveLength(7);
    expect(layer.count()).toBe(1);

    const traces = layer.listTraces();
    expect(traces[0]!.problem.description).toBe("Fix the Anthropic streaming issue");
    expect(traces[0]!.solution.summary).toBe("The fix is done");
    expect(traces[0]!.metadata.tokensUsed).toBe(80); // 50 input + 30 output
  });
});
