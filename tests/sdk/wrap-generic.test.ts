/**
 * `wrapGeneric` — framework-neutral wrapper (PLAN-0.5.4 §3, §8.7).
 *
 * Pins the contract:
 *   - Underlying call always runs and its output passes through
 *     unchanged regardless of TraceBase layer state.
 *   - `onBadge` callbacks throwing synchronously do not break the
 *     wrapped call.
 *   - `injectContext`, `extractOutput`, `observeTools` are all
 *     optional; absence of any of them is a graceful skip rather
 *     than a runtime error.
 *   - When a runtime is bring-your-own, the wrapper does NOT close
 *     it — that's the caller's responsibility.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initConfig } from "../../src/core/config.js";
import { ReasoningLayer } from "../../src/core/engine.js";
import { createRuntime, wrapGeneric } from "../../src/index.js";
import type { BadgeEvent } from "../../src/index.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-wrap-generic-"));
  initConfig(projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function dummyLayer(): ReasoningLayer {
  return {} as unknown as ReasoningLayer;
}

describe("wrapGeneric — happy path", () => {
  it("returns the original call output unchanged", async () => {
    const wrapped = wrapGeneric(
      dummyLayer(),
      async (input: { question: string }) => ({ answer: input.question.toUpperCase() }),
      {
        source: "langchain",
        projectPath: projectDir,
        extractPrompt: (i) => i.question,
      },
    );
    const out = await wrapped({ question: "what is the meaning of life it is 42" });
    expect(out).toEqual({ answer: "WHAT IS THE MEANING OF LIFE IT IS 42" });
  });

  it("forwards BadgeEvents through onBadge when set", async () => {
    const events: BadgeEvent[] = [];
    const wrapped = wrapGeneric(
      dummyLayer(),
      async (input: { question: string }) => ({ answer: "ok" }),
      {
        source: "langchain",
        sessionId: "S-w1",
        projectPath: projectDir,
        extractPrompt: (i) => i.question,
        onBadge: (ev) => events.push(ev),
      },
    );
    // First wire some loop observations so beforeRun can emit a TB
    // LOOP fragment on the next call.
    const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
    await runtime.observeToolBatch({
      sessionId: "S-w1",
      projectPath: projectDir,
      toolCalls: [
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
      ],
    });
    await runtime.close();

    await wrapped({ question: "ok how about the migration runner what should we do exactly" });
    const loop = events.find((e) => e.kind === "loop");
    expect(loop).toBeDefined();
    // 0.7.0-rc.5 §rc.5 — loop badge label format extended to
    // surface resolver output. Either legacy literal or rc.5
    // resolver variants are valid.
    expect(loop!.label).toMatch(
      /▣ TB LOOP\s+(straight × 3 \(Read\)|repeated straight · widen scope|matched #)/,
    );
    expect(loop!.source).toBe("langchain");
  });

  it("respects injectContext when additionalContext is non-empty", async () => {
    let injectedInto: { question: string; ctx: string } | null = null;
    const wrapped = wrapGeneric(
      dummyLayer(),
      async (input: { question: string; ctx?: string }) => {
        injectedInto = input as { question: string; ctx: string };
        return { answer: "ok" };
      },
      {
        source: "generic",
        sessionId: "S-w2",
        projectPath: projectDir,
        extractPrompt: (i) => i.question,
        injectContext: (i, ctx) => ({ ...i, ctx }),
        onBadge: () => {
          // attaching onBadge forces the runtime to materialise so
          // injectContext can fire — w/o onBadge there's no runtime.
        },
      },
    );
    await wrapped({ question: "tell me about something long enough to pass trivial gate easily" });
    // No seeded blocks => additionalContext is empty; injectContext
    // should NOT have been called with empty ctx.
    expect(injectedInto).toEqual({
      question: "tell me about something long enough to pass trivial gate easily",
    });
  });
});

describe("wrapGeneric — failure invariants", () => {
  it("synchronous throw inside onBadge does NOT break the call", async () => {
    const wrapped = wrapGeneric(
      dummyLayer(),
      async (input: string) => `OK:${input}`,
      {
        source: "generic",
        projectPath: projectDir,
        extractPrompt: (i) => i,
        onBadge: () => {
          throw new Error("simulated badge callback failure");
        },
      },
    );
    const out = await wrapped("a long enough prompt to bypass the trivial gate easily");
    expect(out).toBe("OK:a long enough prompt to bypass the trivial gate easily");
  });

  it("call still runs when extractPrompt throws — the underlying call is the user's; we never block it", async () => {
    let called = false;
    const wrapped = wrapGeneric(
      dummyLayer(),
      async (input: string) => {
        called = true;
        return `OK:${input}`;
      },
      {
        source: "generic",
        projectPath: projectDir,
        extractPrompt: () => {
          throw new Error("simulated extractor failure");
        },
        onBadge: () => {
          /* triggers runtime materialisation */
        },
      },
    );
    const out = await wrapped("anything that's reasonably long passes the gate just fine");
    expect(called).toBe(true);
    expect(out).toBe("OK:anything that's reasonably long passes the gate just fine");
  });
});

describe("wrapGeneric — bring-your-own runtime", () => {
  it("uses the explicit runtime when passed", async () => {
    const events: BadgeEvent[] = [];
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      sessionId: "S-byo",
      onBadge: (ev) => events.push(ev),
      source: "claude-agent-sdk",
    });
    const wrapped = wrapGeneric(
      dummyLayer(),
      async (input: string) => `OK:${input}`,
      {
        source: "claude-agent-sdk",
        runtime,
        sessionId: "S-byo",
        projectPath: projectDir,
        extractPrompt: (i) => i,
      },
    );
    await runtime.observeToolBatch({
      sessionId: "S-byo",
      projectPath: projectDir,
      toolCalls: [
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
      ],
    });
    const out = await wrapped("ok now what about the migration runner — long enough now");
    expect(out).toBe("OK:ok now what about the migration runner — long enough now");
    expect(events.find((e) => e.kind === "loop")).toBeDefined();

    await runtime.close();
  });
});
