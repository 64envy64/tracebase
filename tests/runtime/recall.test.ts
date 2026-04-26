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
  RECALL_PATH_DRAIN_MAX_FILES,
  RECALL_PATH_DRAIN_TIME_MS,
  type HoldoutLoader,
} from "../../src/runtime/recall.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { enqueuePending, indexWorkspace } from "../../src/core/file-indexer.js";
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

// ---------------------------------------------------------------------------
// 0.7.0-rc.3 — file memory recall integration
// ---------------------------------------------------------------------------

describe("recallForPrompt — file memory integration", () => {
  it("renders the <file_memory> section when files match the prompt", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, PYTEST_BLOCK);

      // Plant + index a file the prompt overlaps.
      mkdirSync(join(basePath, "src"), { recursive: true });
      writeFileSync(
        join(basePath, "src", "shadowing.ts"),
        "/** Pytest sys.path shadowing detection helpers */\nexport function detectShadow() {}\n",
      );
      // Run indexer directly so the FTS row exists before recall.
      indexWorkspace(store, { root: basePath });

      const result = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
      });

      expect(result.payload.text).toContain("<file_memory>");
      expect(result.payload.text).toContain("</file_memory>");
      expect(result.payload.fileIds).toContain("src/shadowing.ts");
      expect(result.payload.bytesAvoided).toBeGreaterThan(0);
    });
  });

  it("emits file_memory.recalled with aggregate fields when files surface", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, PYTEST_BLOCK);
      mkdirSync(join(basePath, "src"), { recursive: true });
      writeFileSync(
        join(basePath, "src", "shadowing.ts"),
        "/** sys.path shadow detection */\nexport function fn() {}\n",
      );
      indexWorkspace(store, { root: basePath });

      recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "sys.path shadow long enough to pass the gate without being trivial",
        basePath,
        sessionId: null,
      });

      const events = store.readEvents({ eventType: "file_memory.recalled" });
      expect(events.length).toBe(1);
      if (events[0]!.event !== "file_memory.recalled") return;
      expect(events[0]!.fileIds).toContain("src/shadowing.ts");
      expect(events[0]!.tokensInjected).toBeGreaterThan(0);
      expect(events[0]!.bytesAvoided).toBeGreaterThan(0);
    });
  });

  it("does NOT emit file_memory.recalled when no files clear the gate", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, PYTEST_BLOCK);
      // No files indexed → recallFiles returns empty → no event.
      recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — long enough prompt",
        basePath,
        sessionId: null,
      });
      const events = store.readEvents({ eventType: "file_memory.recalled" });
      expect(events.length).toBe(0);
    });
  });

  // 0.7.0-rc.3 hardening — P1 regression. File memory must inject
  // even when no block/fact recall hits, as long as the recall
  // isn't in the holdout/shadow arm.
  it("renders file_memory section when ONLY indexed files match (no blocks, no facts)", () => {
    withFreshStore((store, server, basePath) => {
      // No block seeded — shouldInject will be false.
      mkdirSync(join(basePath, "src"), { recursive: true });
      writeFileSync(
        join(basePath, "src", "auth.ts"),
        "/** Authentication middleware for the gateway */\nexport function authenticate() {}\n",
      );
      indexWorkspace(store, { root: basePath });

      const result = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "How does our authentication middleware sign requests at the gateway?",
        basePath,
        sessionId: null,
      });

      // No block recall hit → blockIds empty, factIds empty, but
      // fileIds populated and the section renders.
      expect(result.payload.blockIds).toEqual([]);
      expect(result.payload.factIds).toEqual([]);
      expect(result.payload.fileIds).toContain("src/auth.ts");
      expect(result.payload.hasContent).toBe(true);
      expect(result.payload.text).toContain("<file_memory>");
      expect(result.payload.text).toContain("Relevant file context:");

      // file_memory.recalled DOES fire even though shouldInject
      // was false at the block/fact layer.
      const events = store.readEvents({ eventType: "file_memory.recalled" });
      expect(events.length).toBe(1);
      if (events[0]!.event !== "file_memory.recalled") return;
      expect(events[0]!.fileIds).toContain("src/auth.ts");
      // file-only payload — the per-section token cost equals or
      // is just below the full payload total.
      expect(events[0]!.tokensInjected).toBeGreaterThan(0);
    });
  });

  // 0.7.0-rc.3 hardening — P2 regression. tokensInjected on the
  // file_memory.recalled event MUST be the section-only cost,
  // not the full payload total. Verify with a mixed recall where
  // both a block AND a file land.
  it("file_memory.recalled.tokensInjected counts only the file section, not blocks", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, PYTEST_BLOCK);

      mkdirSync(join(basePath, "src"), { recursive: true });
      writeFileSync(
        join(basePath, "src", "shadowing.ts"),
        "/** sys.path shadow detection */\nexport function fn() {}\n",
      );
      indexWorkspace(store, { root: basePath });

      const result = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
      });

      // Mixed recall: block + file both surface.
      expect(result.payload.blockIds.length).toBeGreaterThan(0);
      expect(result.payload.fileIds.length).toBeGreaterThan(0);

      const events = store.readEvents({ eventType: "file_memory.recalled" });
      expect(events.length).toBe(1);
      if (events[0]!.event !== "file_memory.recalled") return;
      // Section cost MUST be strictly less than the full payload
      // tokens — pre-hardening this was equal because we wrote
      // payload.tokensEstimate to the event.
      expect(events[0]!.tokensInjected).toBeGreaterThan(0);
      expect(events[0]!.tokensInjected).toBeLessThan(result.payload.tokensEstimate);
    });
  });

  // 0.7.0-rc.3 hardening — shadow recalls suppress file_memory
  // even when files match. Holdout cohort must stay clean.
  //
  // Note: BlockServer's holdout assignment requires
  // `wouldInjectAbsentShadow` — i.e. at least one block/fact
  // would have passed the gate. We seed a matching block to
  // drive that condition, then 100% holdout-rate forces every
  // fingerprint into the control arm.
  it("holdout/shadow recall suppresses file_memory section + emits no event", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, PYTEST_BLOCK);

      mkdirSync(join(basePath, "src"), { recursive: true });
      writeFileSync(
        join(basePath, "src", "shadowing.ts"),
        "/** sys.path shadow detection */\nexport function fn() {}\n",
      );
      indexWorkspace(store, { root: basePath });

      const FORCED_SHADOW: HoldoutLoader = () => ({
        enabled: true,
        rate: 1, // 100% — every fingerprint lands in the cohort
        salt: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const result = recallForPrompt(server, store, FORCED_SHADOW, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
      });

      expect(result.raw.shadow).toBe(true);
      expect(result.payload.fileIds).toEqual([]);
      expect(result.payload.text).toBe("");
      expect(result.payload.hasContent).toBe(false);
      const events = store.readEvents({ eventType: "file_memory.recalled" });
      expect(events.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.6 — chunk-based context compression integration
// ---------------------------------------------------------------------------

describe("recallForPrompt — context fold integration (rc.6)", () => {
  function makeChunkPair() {
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 16; i++) {
      turns.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `meaty chunk content turn ${i} with auth gateway middleware payment retries `.repeat(
          5,
        ),
      });
    }
    return turns;
  }

  it("renders <context_fold> section when chunks exist for the session", async () => {
    const { foldTurns } = await import("../../src/core/context-fold.js");
    withFreshStore((store, server, basePath) => {
      const sessionId = "S-fold";
      // Plant 16 turns of meaty content → 2 chunks worth.
      const turns = makeChunkPair();
      const folded = foldTurns({ sessionId, turns, existingWatermark: -1 });
      expect(folded.chunks.length).toBe(2);
      store.recordSessionChunks(folded.chunks);

      const out = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "auth gateway middleware payment retries — what does the loop look like",
        basePath,
        sessionId,
      });

      expect(out.payload.text).toContain("<context_fold>");
      expect(out.payload.text).toContain("</context_fold>");
      expect(out.payload.contextFoldRanges.length).toBeGreaterThan(0);
      expect(out.payload.contextFoldTokensBefore).toBeGreaterThan(0);
      expect(out.payload.contextFoldTokensAfter).toBeGreaterThan(0);
    });
  });

  it("badge numbers match SUM(tokens_before/after) over rendered chunks (within ±1)", async () => {
    const { foldTurns } = await import("../../src/core/context-fold.js");
    withFreshStore((store, server, basePath) => {
      const sessionId = "S-badge";
      const turns = makeChunkPair();
      const folded = foldTurns({ sessionId, turns, existingWatermark: -1 });
      store.recordSessionChunks(folded.chunks);

      const out = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "another long enough prompt to pass the trivial gate",
        basePath,
        sessionId,
      });

      // Pull the same rows back via the public API and verify
      // payload sums match within ±1 token (rounding slack on
      // the small char-clamping the renderer does).
      const rendered = store.recallSessionChunks(sessionId, 3);
      // The payload's contextFoldRanges shows what the budget
      // actually retained — that's the set we sum.
      const renderedByRange = new Map(
        rendered.map((r) => [`${r.chunkStartTurn}-${r.chunkEndTurn}`, r]),
      );
      let expectedBefore = 0;
      let expectedAfter = 0;
      for (const r of out.payload.contextFoldRanges) {
        const row = renderedByRange.get(`${r.start}-${r.end}`);
        if (row) {
          expectedBefore += row.tokensBefore;
          expectedAfter += row.tokensAfter;
        }
      }
      expect(Math.abs(out.payload.contextFoldTokensBefore - expectedBefore)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(out.payload.contextFoldTokensAfter - expectedAfter)).toBeLessThanOrEqual(
        1,
      );
    });
  });

  it("cross-session recall: chunks from session A do NOT leak into session B's prompt", async () => {
    const { foldTurns } = await import("../../src/core/context-fold.js");
    withFreshStore((store, server, basePath) => {
      const turnsA = makeChunkPair();
      const fA = foldTurns({ sessionId: "S-A", turns: turnsA, existingWatermark: -1 });
      store.recordSessionChunks(fA.chunks);

      const out = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "another long enough prompt to pass the trivial gate",
        basePath,
        sessionId: "S-B",
      });

      expect(out.payload.contextFoldRanges).toEqual([]);
      expect(out.payload.text).not.toContain("<context_fold>");
    });
  });

  it("missing sessionId on options → no chunk recall, no <context_fold> in payload", async () => {
    const { foldTurns } = await import("../../src/core/context-fold.js");
    withFreshStore((store, server, basePath) => {
      const turns = makeChunkPair();
      const folded = foldTurns({ sessionId: "S-fold", turns, existingWatermark: -1 });
      store.recordSessionChunks(folded.chunks);

      const out = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "another long enough prompt to pass the trivial gate",
        basePath,
        // sessionId intentionally omitted
      });
      expect(out.payload.contextFoldRanges).toEqual([]);
      expect(out.payload.text).not.toContain("<context_fold>");
    });
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.5 hardening — semantic-loop dedupe keys on intent_key
// ---------------------------------------------------------------------------

describe("recallForPrompt — semantic-loop dedupe (P1 hardening)", () => {
  it("cross-alias rotation: grep → rg with same intent_key triggers anti-self-loop", () => {
    withFreshStore((store, server, basePath) => {
      // Seed a block whose situation/keywords match the
      // auth_token search query.
      seedBlock(store, {
        trigger: {
          situation: "search for the auth_token symbol across the codebase",
          invariants: { language: "typescript" },
        },
        body: {
          mechanism: "auth token symbol lives in src/auth.ts",
          deadEnds: [],
          unlock: "open src/auth.ts and grep export instead of re-running",
          verification: "confirm src/auth.ts is the canonical source",
        },
        provenance: {
          sourceTaskId: "auth-1",
          extractedFrom: "trajectory",
          distilledBy: "llm",
        },
      });

      const sessionId = "S-cross-alias";
      // Plant 3 grep observations: same argSummary shape (so they
      // also collapse under the FIRST argKey-keyed detector pass
      // — this exercises the dedupe path that matches anyway, then
      // re-asserts on rotation that the dedupe now keys on
      // intent_key per the fix).
      //
      // To get the SECOND pass (intent_key-keyed) firing, the
      // alias variants must have DIFFERENT argKeys but the SAME
      // intent_key. We force this by recording observations whose
      // argSummary differs (Grep vs rg form) but normalises
      // identically.
      store.recordToolObservations([
        {
          sessionId,
          batchId: null,
          batchOrder: 0,
          toolUseId: null,
          toolName: "Grep",
          argSummary: "Grep('auth_token')",
          argKey: "k_grep_1",
          outcome: "ok",
        },
        {
          sessionId,
          batchId: null,
          batchOrder: 1,
          toolUseId: null,
          toolName: "Grep",
          argSummary: "Grep('auth-token')",
          argKey: "k_grep_2",
          outcome: "ok",
        },
        {
          sessionId,
          batchId: null,
          batchOrder: 2,
          toolUseId: null,
          toolName: "Grep",
          argSummary: "Grep('auth.token')",
          argKey: "k_grep_3",
          outcome: "ok",
        },
      ]);

      // First call: 3 grep observations, all distinct argKeys but
      // identical intent_keys → first-pass detector misses (3
      // distinct argKeys), second-pass (intent_key) catches the
      // straight signal. Resolver fires matched.
      const first = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Long enough prompt about the auth token search loop",
        basePath,
        sessionId,
      });
      expect(first.signal.kind).not.toBe("none");
      expect(first.loopRedirect?.kind).toBe("matched");
      expect(first.loopRedirect?.anchorKind).toBe("block");

      // Now rotate: simulate the agent doing one more attempt with
      // a DIFFERENT alias (rg). New argKey, same intent_key.
      store.recordToolObservations([
        {
          sessionId,
          batchId: null,
          batchOrder: 3,
          toolUseId: null,
          toolName: "ripgrep",
          argSummary: "rg('auth[_-]token')",
          argKey: "k_rg_1",
          outcome: "ok",
        },
      ]);

      const second = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Long enough prompt about the auth token search loop",
        basePath,
        sessionId,
      });
      expect(second.signal.kind).not.toBe("none");
      // Pre-fix: resolver dedupes on raw argKey (k_rg_1, never seen
      // before) → fires matched again. Post-fix: resolver dedupes
      // on intent_key → seen on the first call → falls back with
      // anti-self-loop reason.
      expect(second.loopRedirect?.kind).toBe("fallback");
      expect(second.loopRedirect?.fallbackReason).toBe("anti-self-loop");

      // Third rotation with yet another alias — still anti-self-loop.
      store.recordToolObservations([
        {
          sessionId,
          batchId: null,
          batchOrder: 4,
          toolUseId: null,
          toolName: "ag",
          argSummary: "ag('auth.token')",
          argKey: "k_ag_1",
          outcome: "ok",
        },
      ]);
      const third = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Long enough prompt about the auth token search loop",
        basePath,
        sessionId,
      });
      expect(third.loopRedirect?.kind).toBe("fallback");
      expect(third.loopRedirect?.fallbackReason).toBe("anti-self-loop");
    });
  });

  // 0.7.0-rc.5 hardening 2 — P1 regression. Pre-fix the FIRST-pass
  // (raw argKey) detector still fired on the older same-argKey
  // entries when the agent rotated to an equivalent alias at the
  // tail; the semantic-pass detector was skipped because raw !=
  // none, and the resolver dedupe-keyed on the rotated raw
  // argKey, surfacing the SAME matched anchor twice.
  it("3 identical Grep calls matched, then ONE equivalent rg rotation triggers anti-self-loop", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, {
        trigger: {
          situation: "search for the auth_token symbol across the codebase",
          invariants: { language: "typescript" },
        },
        body: {
          mechanism: "auth token symbol lives in src/auth.ts",
          deadEnds: [],
          unlock: "open src/auth.ts and grep export instead of re-running",
          verification: "confirm src/auth.ts is the canonical source",
        },
        provenance: {
          sourceTaskId: "auth-3",
          extractedFrom: "trajectory",
          distilledBy: "llm",
        },
      });

      const sessionId = "S-raw-then-alias";

      // Step 1: 3 IDENTICAL Greps. Same argSummary, same raw argKey.
      // The first-pass (raw) detector fires straight on these.
      // Pre- and post-fix: matched anchor on first call.
      store.recordToolObservations([
        {
          sessionId,
          batchId: null,
          batchOrder: 0,
          toolUseId: null,
          toolName: "Grep",
          argSummary: "Grep('auth_token')",
          argKey: "k_grep_identical",
          outcome: "ok",
        },
        {
          sessionId,
          batchId: null,
          batchOrder: 1,
          toolUseId: null,
          toolName: "Grep",
          argSummary: "Grep('auth_token')",
          argKey: "k_grep_identical",
          outcome: "ok",
        },
        {
          sessionId,
          batchId: null,
          batchOrder: 2,
          toolUseId: null,
          toolName: "Grep",
          argSummary: "Grep('auth_token')",
          argKey: "k_grep_identical",
          outcome: "ok",
        },
      ]);

      const first = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "auth token search going in circles",
        basePath,
        sessionId,
      });
      expect(first.signal.kind).not.toBe("none");
      expect(first.loopRedirect?.kind).toBe("matched");

      // Step 2: append ONE rg call. Different raw argKey, same
      // semantic intent_key as the Greps. The window now looks
      // like [Grep, Grep, Grep, rg].
      //
      // Pre-fix flow:
      //   - raw detector: walks back from rg → grep mismatch →
      //     no straight; duplicate detector: Grep count=3 ≥ 2 →
      //     fires duplicate signal (kind="duplicate", count=3,
      //     toolName="Grep")
      //   - signal != none → semantic detector SKIPPED
      //   - resolver gets raw observations → lastObs.argKey =
      //     "k_rg_new" (rotated, fresh) → dedupe miss → matched
      //     fires AGAIN (BUG)
      //
      // Post-fix flow:
      //   - raw detector: same as above, fires duplicate
      //   - semantic detector ALSO runs (no longer gated on raw=none)
      //   - semantic detector sees 4 same intent_keys in a row → straight
      //   - semantic_signal != none → signal = semantic_signal AND
      //     observationsForResolver = semantic obs
      //   - resolver gets semantic observations → lastObs.argKey =
      //     "search:auth token" (intent_key) → dedupe HIT (recorded
      //     by first call) → fallback with anti-self-loop reason
      store.recordToolObservations([
        {
          sessionId,
          batchId: null,
          batchOrder: 3,
          toolUseId: null,
          toolName: "ripgrep",
          argSummary: "rg('auth[_-]token')",
          argKey: "k_rg_new",
          outcome: "ok",
        },
      ]);

      const second = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "auth token search going in circles",
        basePath,
        sessionId,
      });
      expect(second.signal.kind).not.toBe("none");
      expect(second.loopRedirect?.kind).toBe("fallback");
      expect(second.loopRedirect?.fallbackReason).toBe("anti-self-loop");
    });
  });

  it("dedupe still scoped per-session: the same intent_key in a fresh session matches", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, {
        trigger: {
          situation: "search for the auth_token symbol across the codebase",
          invariants: { language: "typescript" },
        },
        body: {
          mechanism: "auth token symbol lives in src/auth.ts",
          deadEnds: [],
          unlock: "open src/auth.ts and grep export instead of re-running",
          verification: "confirm src/auth.ts is the canonical source",
        },
        provenance: {
          sourceTaskId: "auth-2",
          extractedFrom: "trajectory",
          distilledBy: "llm",
        },
      });

      const seed = (sessionId: string) => {
        store.recordToolObservations([
          {
            sessionId,
            batchId: null,
            batchOrder: 0,
            toolUseId: null,
            toolName: "Grep",
            argSummary: "Grep('auth_token')",
            argKey: `k1-${sessionId}`,
            outcome: "ok",
          },
          {
            sessionId,
            batchId: null,
            batchOrder: 1,
            toolUseId: null,
            toolName: "Grep",
            argSummary: "Grep('auth-token')",
            argKey: `k2-${sessionId}`,
            outcome: "ok",
          },
          {
            sessionId,
            batchId: null,
            batchOrder: 2,
            toolUseId: null,
            toolName: "Grep",
            argSummary: "Grep('auth.token')",
            argKey: `k3-${sessionId}`,
            outcome: "ok",
          },
        ]);
      };

      seed("S-A");
      const a = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Long enough prompt about the auth token search loop",
        basePath,
        sessionId: "S-A",
      });
      expect(a.loopRedirect?.kind).toBe("matched");

      // Different session → dedupe must NOT carry over.
      seed("S-B");
      const b = recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Long enough prompt about the auth token search loop",
        basePath,
        sessionId: "S-B",
      });
      expect(b.loopRedirect?.kind).toBe("matched");
    });
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.2 hardening — recall-path drain budget cap
// ---------------------------------------------------------------------------

describe("recallForPrompt — drain budget cap (P2 hardening)", () => {
  it("drain cap constants match the documented bench-friendly slice", () => {
    // The §0.7 stable bench targets UserPromptSubmit p95 ≤ 150ms.
    // The recall-path drain MUST be a small slice of that — not the
    // §rc.2 default 50/200. These constants are the contract that
    // future bench gates rely on; if a future commit relaxes the
    // cap, this test catches it.
    expect(RECALL_PATH_DRAIN_MAX_FILES).toBeLessThanOrEqual(20);
    expect(RECALL_PATH_DRAIN_TIME_MS).toBeLessThanOrEqual(50);
  });

  it("queues many pending rows but indexes at most RECALL_PATH_DRAIN_MAX_FILES per recall", () => {
    withFreshStore((store, server, basePath) => {
      seedBlock(store, PYTEST_BLOCK);

      // Plant 30 files + queue them all as file-pending. A single
      // recall call should drain at most RECALL_PATH_DRAIN_MAX_FILES
      // of them, not all 30.
      mkdirSync(join(basePath, "src"), { recursive: true });
      for (let i = 0; i < 30; i++) {
        writeFileSync(
          join(basePath, "src", `f${i}.ts`),
          `/** file ${i} */\nexport const x${i} = ${i};\n`,
        );
        enqueuePending(store, `src/f${i}.ts`, "file", 1);
      }

      const before = store.rawDb
        .prepare("SELECT COUNT(*) AS c FROM indexed_files")
        .get() as { c: number };
      expect(before.c).toBe(0);

      recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — long enough prompt to pass the gate",
        basePath,
        sessionId: null,
      });

      const after = store.rawDb
        .prepare("SELECT COUNT(*) AS c FROM indexed_files")
        .get() as { c: number };
      // The drain processed AT MOST the cap. (May be less if file
      // I/O ran into the time budget first, which is the whole
      // point of the cap — recall path stays bounded.)
      expect(after.c).toBeGreaterThan(0);
      expect(after.c).toBeLessThanOrEqual(RECALL_PATH_DRAIN_MAX_FILES);
    });
  });
});
