/**
 * `src/sdk/runtime.ts` — framework-neutral SDK surface
 * (PLAN-0.5.4 §8.6).
 *
 * Covers all six methods plus the privacy + lifecycle invariants
 * the spec requires:
 *   - `beforeRun` recalls TRACE/MEMORY/CONTEXT and emits BadgeEvents
 *   - `observeToolBatch` writes sanitised HMAC observations
 *   - next `beforeRun` emits TB TOOL/TB LOOP after repeats
 *   - `saveContext` writes a session digest; same-session beforeRun
 *     recalls it
 *   - `onBadge` throws never break the underlying call
 *   - `afterRun` returns immediately; `flush()` resolves later
 *   - `close()` releases the SQLite handle and is idempotent
 *   - `BadgeEvent` privacy: nothing forbidden ever shows up
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import { ReasoningLayer } from "../../src/core/engine.js";
import { indexWorkspace } from "../../src/core/file-indexer.js";
import { createRuntime } from "../../src/index.js";
import type { BadgeEvent, StoreBlockInput } from "../../src/index.js";

// Shared seed so beforeRun has something to recall.
const PYTEST_BLOCK: StoreBlockInput = {
  trigger: {
    situation: "Pytest collection picks up the wrong package due to sys.path shadow",
    invariants: { language: "python", framework: "pytest" },
  },
  body: {
    mechanism: "an earlier sys.path entry shadows the intended namespace package",
    deadEnds: [],
    unlock: "rename the shadowing module or remove its directory from sys.path",
    verification: "pytest --collect-only shows the intended package",
  },
  provenance: { sourceTaskId: "pytest-1", extractedFrom: "trajectory", distilledBy: "llm" },
};

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-runtime-"));
  initConfig(projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function seedBlock(input: StoreBlockInput): void {
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);
  const b = createBlock(input);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  store.updateBlockStatus(b.id, "active");
  store.close();
}

// The factory takes a ReasoningLayer for forward-compatibility; the
// 0.5.4-§8.6 implementation doesn't use it, so a minimal stub
// satisfies the type without forcing tests to spin up a v1
// TraceStore.
function dummyLayer(): ReasoningLayer {
  return {} as unknown as ReasoningLayer;
}

// ---------------------------------------------------------------------------
// beforeRun
// ---------------------------------------------------------------------------

describe("createRuntime — beforeRun", () => {
  it("returns empty + no events on uninitialised projects", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "tb-runtime-noinit-"));
    try {
      const runtime = createRuntime(dummyLayer(), { projectPath: elsewhere });
      const out = await runtime.beforeRun({
        prompt: "long prompt that would otherwise pass the trivial gate easily",
      });
      expect(out.additionalContext).toBe("");
      expect(out.badgeEvents).toEqual([]);
      await runtime.close();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("returns empty for trivial prompts (under 40 chars)", async () => {
    const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
    const out = await runtime.beforeRun({ prompt: "hi" });
    expect(out.additionalContext).toBe("");
    expect(out.badgeEvents).toEqual([]);
    await runtime.close();
  });

  it("recalls a seeded block and emits a TB TRACE BadgeEvent", async () => {
    seedBlock(PYTEST_BLOCK);
    const events: BadgeEvent[] = [];
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      onBadge: (ev) => events.push(ev),
      source: "openai",
    });
    const out = await runtime.beforeRun({
      prompt: "Pytest collects the wrong package on a fresh clone — sys.path shadow",
    });
    expect(out.additionalContext.length).toBeGreaterThan(0);
    expect(out.queryId).toBeDefined();
    expect(out.badgeEvents.length).toBeGreaterThan(0);
    expect(events.length).toBe(out.badgeEvents.length);

    const trace = events.find((e) => e.kind === "trace")!;
    expect(trace).toBeDefined();
    expect(trace.label).toMatch(/▣ TB TRACE  recalled \d+ pattern\(s\)/);
    expect(trace.count).toBeGreaterThan(0);
    expect(trace.queryId).toBe(out.queryId);
    expect(trace.tokens).toBeGreaterThan(0);
    expect(trace.source).toBe("openai");

    await runtime.close();
  });

  // 0.7.0-rc.3 §rc.3 — file memory bullet, separate from facts.
  it("emits TB MEMORY (memory-files) when indexed files match the prompt", async () => {
    seedBlock(PYTEST_BLOCK);

    // Plant + index a file that overlaps the prompt.
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(
      join(projectDir, "src", "shadowing.ts"),
      "/** sys.path shadow detection helpers */\nexport function detect() {}\n",
    );
    {
      const cfg = loadConfig(projectDir);
      const db = new Database(cfg.storagePath);
      const store = new BlockStore(db);
      indexWorkspace(store, { root: projectDir });
      store.close();
    }

    const events: BadgeEvent[] = [];
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      onBadge: (ev) => events.push(ev),
    });
    const out = await runtime.beforeRun({
      prompt:
        "Pytest collects the wrong package — sys.path shadow detection in our test runner",
    });

    const memFiles = events.find((e) => e.kind === "memory-files");
    expect(memFiles).toBeDefined();
    expect(memFiles!.label).toMatch(/▣ TB MEMORY\s+recalled \d+ file\(s\)/);
    expect(memFiles!.count).toBeGreaterThan(0);
    expect(memFiles!.queryId).toBe(out.queryId);

    // Spec: "separate counters, never merged". The pre-rc.3
    // `memory` (facts) bullet may also fire here if facts also
    // matched, but the kinds MUST be distinct events.
    const memFacts = events.find((e) => e.kind === "memory");
    if (memFacts) {
      expect(memFacts).not.toBe(memFiles);
      expect(memFacts.label).toMatch(/fact\(s\)/);
    }

    await runtime.close();
  });

  // 0.7.0-rc.3 §rc.3 — explicit indexFiles + recallFiles SDK surface.
  describe("indexFiles + recallFiles (rc.3)", () => {
    it("indexFiles populates indexed_files; recallFiles surfaces matches", async () => {
      mkdirSync(join(projectDir, "src"), { recursive: true });
      writeFileSync(
        join(projectDir, "src", "auth.ts"),
        "/** Authentication middleware */\nexport function authenticate() {}\n",
      );
      const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });

      const idx = await runtime.indexFiles({ root: projectDir });
      expect(idx.indexedCount).toBe(1);
      expect(idx.bytesSummarized).toBeGreaterThan(0);
      expect(idx.summarizer).toBe("heuristic");

      const recall = await runtime.recallFiles({ prompt: "authentication middleware" });
      expect(recall.hits.length).toBeGreaterThanOrEqual(1);
      expect(recall.hits[0].relPath).toBe("src/auth.ts");
      expect(recall.hits[0].sizeBytes).toBeGreaterThan(0);

      await runtime.close();
    });

    it("recallFiles returns empty hits on too-short prompt without throwing", async () => {
      const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
      const recall = await runtime.recallFiles({ prompt: "" });
      expect(recall.hits).toEqual([]);
      await runtime.close();
    });

    it("indexFiles on uninitialised project returns empty result, never throws", async () => {
      const elsewhere = mkdtempSync(join(tmpdir(), "tb-runtime-noinit-"));
      try {
        const runtime = createRuntime(dummyLayer(), { projectPath: elsewhere });
        const out = await runtime.indexFiles({ root: elsewhere });
        expect(out.indexedCount).toBe(0);
        expect(out.bytesSummarized).toBe(0);
        await runtime.close();
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it("methods reject after close()", async () => {
      const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
      await runtime.close();
      await expect(runtime.indexFiles({ root: projectDir })).rejects.toThrow(
        /runtime closed/,
      );
      await expect(runtime.recallFiles({ prompt: "anything" })).rejects.toThrow(
        /runtime closed/,
      );
    });
  });

  it("emits TB LOOP after 3 repeated tool observations precede the prompt", async () => {
    seedBlock(PYTEST_BLOCK);
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      sessionId: "S-loop",
    });
    await runtime.observeToolBatch({
      sessionId: "S-loop",
      projectPath: projectDir,
      toolCalls: [
        { toolName: "Read", toolInput: { file_path: join(projectDir, "src/a.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "src/a.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "src/a.ts") } },
      ],
    });
    const out = await runtime.beforeRun({
      prompt: "ok how about the migration runner — anything I should know first?",
    });
    const loop = out.badgeEvents.find((e) => e.kind === "loop");
    expect(loop).toBeDefined();
    // 0.7.0-rc.5 §rc.5 — when recall returns a loopRedirect (which
    // it does whenever a sessionId + signal are present), the badge
    // surfaces the resolver's label. With no matching block / file
    // recall, the resolver produces the static fallback shape:
    // `▣ TB LOOP  repeated <pattern> · widen scope`. Pre-rc.5 the
    // legacy literal-format `straight × 3 (Read)` was the output.
    // Both shapes are valid — this test accepts either so it
    // doesn't flake on dependency-recall ordering.
    expect(loop!.label).toMatch(
      /▣ TB LOOP\s+(straight × 3 \(Read\)|repeated straight · widen scope|matched #)/,
    );
    expect(loop!.count).toBe(3);
    expect(loop!.toolName).toBe("Read");

    await runtime.close();
  });

  it("emits a TB LOOP fragment even on a TRIVIAL prompt when a session is set", async () => {
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      sessionId: "S-loop2",
    });
    await runtime.observeToolBatch({
      sessionId: "S-loop2",
      projectPath: projectDir,
      toolCalls: [
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
      ],
    });
    const out = await runtime.beforeRun({ prompt: "yep" });
    expect(out.additionalContext).toBe("");
    expect(out.badgeEvents.length).toBe(1);
    expect(out.badgeEvents[0]?.kind).toBe("loop");
    await runtime.close();
  });

  it("recalls a saveContext digest in the SAME session", async () => {
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      sessionId: "S-ctx",
    });
    const ctx = await runtime.saveContext({
      sessionId: "S-ctx",
      projectPath: projectDir,
      digest:
        "Recent user questions:\n- Why does pytest fail collection on this clone?\n\nKey points:\n- removing the shadow module restored collection",
    });
    expect(ctx.factId).toBeTruthy();
    const out = await runtime.beforeRun({
      prompt: "remind me what we agreed about the sys.path shadow fix from earlier",
    });
    // The digest is a `session_digest` fact in the same session
    // scope; hierarchical recall surfaces it through the MEMORY
    // channel.
    const memory = out.badgeEvents.find((e) => e.kind === "memory");
    expect(memory).toBeDefined();
    expect(out.additionalContext).toMatch(/sys\.path|shadow/);
    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// observeToolBatch
// ---------------------------------------------------------------------------

describe("createRuntime — observeToolBatch", () => {
  it("persists rows; bodies never reach storage", async () => {
    const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
    const out = await runtime.observeToolBatch({
      sessionId: "S-obs",
      projectPath: projectDir,
      toolCalls: [
        { toolName: "Read", toolInput: { file_path: join(projectDir, "src/foo.ts") } },
        { toolName: "Bash", toolInput: { command: "npm run build && cat /etc/passwd" } },
      ],
    });
    expect(out.recorded).toBe(2);

    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath, { readonly: true });
    const store = new BlockStore(db, { skipMigrate: true });
    const rows = store.recentToolObservations("S-obs", 10);
    store.close();
    expect(rows.map((r) => r.argSummary)).toEqual(["Read(src/foo.ts)", "Bash(npm)"]);
    const all = rows.map((r) => `${r.argSummary}|${r.argKey}`).join("|");
    expect(all).not.toContain("/etc/passwd");
    expect(all).not.toContain("npm run build");

    await runtime.close();
  });

  it("returns recorded:0 with enableTool=false AND enableLoop=false", async () => {
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      enableTool: false,
      enableLoop: false,
    });
    const out = await runtime.observeToolBatch({
      sessionId: "S-disabled",
      projectPath: projectDir,
      toolCalls: [
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
      ],
    });
    expect(out.recorded).toBe(0);
    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// saveContext
// ---------------------------------------------------------------------------

describe("createRuntime — saveContext", () => {
  it("stores a caller-supplied digest with TTL", async () => {
    const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
    const out = await runtime.saveContext({
      sessionId: "S-d",
      projectPath: projectDir,
      digest:
        "Recent user questions:\n- Where does the cli vitest suite live?\n\nDiscussion topics:\n- Recall budget",
    });
    expect(out.factId).toBeTruthy();
    await runtime.close();
  });

  it("rejects a digest that triggers the leakage scanner", async () => {
    const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
    const out = await runtime.saveContext({
      sessionId: "S-leak",
      projectPath: projectDir,
      digest: "found the leak here:\n/Users/alice/.aws/credentials\nlong enough to count",
    });
    expect(out.factId).toBeNull();
    await runtime.close();
  });

  it("turns→digest path is wired (long enough turns produce a digest)", async () => {
    const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
    const turns = [
      { role: "user" as const, content: "What's the pytest collection issue with sys.path on this fresh clone of the repo?" },
      {
        role: "assistant" as const,
        content:
          "## Diagnosis\n\nThe shadowing helper sits earlier in sys.path than the intended package.\n\n## Fix\n\n- Remove the shadow directory from sys.path\n- Or rename the helper module\n\n## Verify\n\nRun `pytest --collect-only` and confirm only the intended package is listed.",
      },
    ];
    const out = await runtime.saveContext({
      sessionId: "S-turns",
      projectPath: projectDir,
      turns,
    });
    expect(out.factId).toBeTruthy();
    await runtime.close();
  });

  it("returns factId:null with enableContext=false", async () => {
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      enableContext: false,
    });
    const out = await runtime.saveContext({
      sessionId: "S-off",
      projectPath: projectDir,
      digest: "Recent user questions:\n- anything\n\nKey points:\n- something long enough to pass",
    });
    expect(out.factId).toBeNull();
    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// afterRun + flush + close
// ---------------------------------------------------------------------------

describe("createRuntime — afterRun lifecycle", () => {
  it("returns immediately; flush() awaits queued work", async () => {
    const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
    const t0 = Date.now();
    await runtime.afterRun({
      userText: "ask about migration",
      assistantText: "answer with detail",
      sessionId: "S-after",
    });
    // afterRun should return without awaiting the queued capture
    // work. The threshold is generous (3000 ms vs the wallclock
    // of the synchronous body — first-use SQLite migration plus
    // captureTurnFromTexts heuristic + parallel test concurrency
    // can spike well past the bench's warm p95) so the assertion
    // proves "queued, not blocking" rather than benching absolute
    // latency. The bench harness covers absolute timings.
    expect(Date.now() - t0).toBeLessThan(3_000);
    // flush() must resolve cleanly even when queued jobs were no-ops.
    await runtime.flush();
    await runtime.close();
  });

  it("close() is idempotent; subsequent runtime calls reject", async () => {
    const runtime = createRuntime(dummyLayer(), { projectPath: projectDir });
    await runtime.close();
    await runtime.close(); // second close is a no-op, no throw
    await expect(
      runtime.beforeRun({ prompt: "long enough prompt to bypass the trivial gate" }),
    ).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------
// onBadge guarantees
// ---------------------------------------------------------------------------

describe("createRuntime — onBadge throw", () => {
  it("synchronous throw inside onBadge does NOT break the call", async () => {
    seedBlock(PYTEST_BLOCK);
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      onBadge: () => {
        throw new Error("simulated user callback failure");
      },
    });
    // Should resolve normally; the throw is swallowed.
    const out = await runtime.beforeRun({
      prompt: "Pytest collects the wrong package on a fresh clone — sys.path shadow",
    });
    expect(out.additionalContext.length).toBeGreaterThan(0);
    expect(out.badgeEvents.length).toBeGreaterThan(0);
    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// BadgeEvent privacy — runtime emits only allowed fields
// ---------------------------------------------------------------------------

describe("createRuntime — BadgeEvent privacy", () => {
  const FORBIDDEN = [
    "prompt",
    "response",
    "userText",
    "assistantText",
    "tool_input",
    "tool_response",
    "toolInput",
    "toolResponse",
    "argSummary",
    "argKey",
    "sessionId",
    "session_id",
    "file_path",
    "filePath",
    "path",
    "code",
    "transcript",
    "transcriptPath",
  ];

  it("none of the forbidden keys ever appear on emitted BadgeEvents", async () => {
    seedBlock(PYTEST_BLOCK);
    const events: BadgeEvent[] = [];
    const runtime = createRuntime(dummyLayer(), {
      projectPath: projectDir,
      sessionId: "S-priv",
      onBadge: (ev) => events.push(ev),
    });
    // Generate every BadgeEvent kind we can in one fixture.
    await runtime.observeToolBatch({
      sessionId: "S-priv",
      projectPath: projectDir,
      toolCalls: [
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
        { toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } },
      ],
    });
    await runtime.beforeRun({
      prompt: "Pytest collects the wrong package on a fresh clone — sys.path shadow",
    });
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      for (const k of FORBIDDEN) {
        expect(Object.hasOwn(ev as object, k)).toBe(false);
      }
    }
    await runtime.close();
  });
});
