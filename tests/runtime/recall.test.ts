/**
 * `src/runtime/recall.ts` — direct coverage of the pure recall core
 * extracted from `inject-context` in PLAN-0.5.4 §8.2.
 *
 * The CLI hook tests in `tests/cli/inject-context.test.ts` already
 * exercise this code through the inject-context envelope. These
 * tests pin the function's contract directly, since the SDK
 * runtime (§8.6) will call it without going through inject-context
 * — so a regression that only `inject-context.test.ts` catches
 * could still ship a broken SDK.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { createBlock } from "../../src/core/block.js";
import { loadBlockCalibrator } from "../../src/lifecycle/calibrator.js";
import {
  recallForPrompt,
  shouldQueryForPrompt,
  MIN_PROMPT_CHARS,
  type HoldoutLoader,
} from "../../src/runtime/recall.js";
import type { StoreBlockInput } from "../../src/types.js";

const NO_HOLDOUT: HoldoutLoader = () => null;

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
  provenance: {
    sourceTaskId: "pytest-1",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

function withFreshStore(fn: (store: BlockStore, server: BlockServer, basePath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "tb-recall-core-"));
  try {
    const cfg = initConfig(dir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    const server = new BlockServer(store, {
      calibrator: loadBlockCalibrator(store),
      emitEvents: false,
      gateThreshold: 0,
    });
    try {
      fn(store, server, dir);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedBlock(store: BlockStore, input: StoreBlockInput): string {
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
  return b.id;
}

describe("shouldQueryForPrompt", () => {
  it(`returns false for prompts shorter than MIN_PROMPT_CHARS (${MIN_PROMPT_CHARS})`, () => {
    expect(shouldQueryForPrompt("hi")).toBe(false);
    expect(shouldQueryForPrompt("thanks")).toBe(false);
    expect(shouldQueryForPrompt("a".repeat(MIN_PROMPT_CHARS - 1))).toBe(false);
  });

  it("returns true at the boundary and beyond", () => {
    expect(shouldQueryForPrompt("a".repeat(MIN_PROMPT_CHARS))).toBe(true);
    expect(shouldQueryForPrompt("a".repeat(MIN_PROMPT_CHARS + 50))).toBe(true);
  });

  it("treats SessionStart the same way (length-only gate)", () => {
    expect(shouldQueryForPrompt("hi", "SessionStart")).toBe(false);
    expect(shouldQueryForPrompt("a".repeat(MIN_PROMPT_CHARS), "SessionStart")).toBe(true);
  });
});

describe("recallForPrompt — match path", () => {
  it("returns hasContent=true and writes retrieval + injection events on a real match", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, PYTEST_BLOCK);

      const result = recallForPrompt(store === store ? server : server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
        tokenBudget: 1200,
      });

      expect(result.hasContent).toBe(true);
      expect(result.payload.blockIds.length).toBeGreaterThan(0);
      expect(result.queryId).toBe(result.payload.queryId);

      // Detector signal is `none` without a sessionId.
      expect(result.signal.kind).toBe("none");

      // Retrieval + injection events landed in analytics_events.
      const events = store.readEvents({ queryId: result.queryId, limit: 100 });
      expect(events.some((e) => e.event === "retrieval")).toBe(true);
      expect(events.some((e) => e.event === "injection")).toBe(true);
    });
  });

  it("emits TB LOOP signal when 3 identical observations precede the prompt", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, PYTEST_BLOCK);
      store.recordToolObservations([
        { sessionId: "S-loop", batchOrder: 0, toolName: "Read", argSummary: "x", argKey: "kA" },
        { sessionId: "S-loop", batchOrder: 1, toolName: "Read", argSummary: "x", argKey: "kA" },
        { sessionId: "S-loop", batchOrder: 2, toolName: "Read", argSummary: "x", argKey: "kA" },
      ]);
      const result = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "ok now what about the migration runner — anything specific to know?",
        basePath,
        sessionId: "S-loop",
      });
      expect(result.signal.kind).toBe("straight");
      expect(result.signal.count).toBe(3);
      expect(result.signal.toolName).toBe("Read");
    });
  });
});

describe("recallForPrompt — no-match path", () => {
  it("returns hasContent=false on an empty store", () => {
    withFreshStore((store, server, basePath) => {
      const result = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "something completely unrelated to anything in the empty store at all",
        basePath,
      });
      expect(result.hasContent).toBe(false);
      expect(result.payload.blockIds).toEqual([]);
      // Retrieval event still landed (so analytics show the gate fired).
      const events = store.readEvents({ queryId: result.queryId, limit: 10 });
      expect(events.some((e) => e.event === "retrieval")).toBe(true);
      // No injection event when no content survived the budget.
      expect(events.some((e) => e.event === "injection")).toBe(false);
    });
  });
});

describe("recallForPrompt — toggles", () => {
  it("enableToolDetection: false skips the detector even with observations present", () => {
    withFreshStore((store, server, basePath) => {
      store.recordToolObservations([
        { sessionId: "S-x", batchOrder: 0, toolName: "Read", argSummary: "x", argKey: "kA" },
        { sessionId: "S-x", batchOrder: 1, toolName: "Read", argSummary: "x", argKey: "kA" },
        { sessionId: "S-x", batchOrder: 2, toolName: "Read", argSummary: "x", argKey: "kA" },
      ]);
      const result = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "another long enough prompt to pass the trivial gate handily",
        basePath,
        sessionId: "S-x",
        enableToolDetection: false,
      });
      expect(result.signal.kind).toBe("none");
    });
  });

  it("toolWindowSize narrows the detector input", () => {
    withFreshStore((store, server, basePath) => {
      // 6 rows: A,A,A,B,B,B. Default window=6 → straight on B (count=3).
      // Window=3 → still B,B,B → straight on B.
      // Window=2 → only last two B,B → duplicate not straight.
      store.recordToolObservations([
        { sessionId: "S-w", batchOrder: 0, toolName: "Read", argSummary: "x", argKey: "kA" },
        { sessionId: "S-w", batchOrder: 1, toolName: "Read", argSummary: "x", argKey: "kA" },
        { sessionId: "S-w", batchOrder: 2, toolName: "Read", argSummary: "x", argKey: "kA" },
        { sessionId: "S-w", batchOrder: 3, toolName: "Grep", argSummary: "y", argKey: "kB" },
        { sessionId: "S-w", batchOrder: 4, toolName: "Grep", argSummary: "y", argKey: "kB" },
        { sessionId: "S-w", batchOrder: 5, toolName: "Grep", argSummary: "y", argKey: "kB" },
      ]);
      const def = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "another long enough prompt to pass the trivial gate easily",
        basePath,
        sessionId: "S-w",
      });
      expect(def.signal.kind).toBe("straight");
      expect(def.signal.toolName).toBe("Grep");

      const narrow = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "another long enough prompt to pass the trivial gate easily",
        basePath,
        sessionId: "S-w",
        toolWindowSize: 2,
      });
      // Last 2 are B,B — that's only 2, not enough for straight (≥3).
      expect(narrow.signal.kind).toBe("duplicate");
    });
  });
});
