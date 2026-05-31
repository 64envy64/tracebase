/**
 * Organic runtime capture loop — end-to-end integration (Phase 3).
 *
 * Proves the real runtime path with NO mocks of the core:
 *   solved run → captureTurnFromTexts → durable BlockStore → later recall →
 *   conservative serve → attribution (agent_used + outcome) → calibration feed.
 *
 * Uses the same on-disk-shaped BlockStore the runtime uses (here :memory: for
 * speed; durability across sessions is the same SQLite path). Captures go
 * through the actual heuristic extractor + storeReasoningPattern, not a stub.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { captureTurnFromTexts } from "../../src/runtime/capture-turn.js";
import { fitCalibratorFromEvents } from "../../src/lifecycle/calibrator.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

// A solved-problem turn the heuristic extractor accepts: a substantive problem
// statement + a solution with a mechanism paragraph and an imperative action.
const SOLVED_USER =
  "The pytest suite fails to collect the right package on a fresh clone because an " +
  "earlier sys.path entry shadows the intended namespace package, so imports resolve " +
  "to the wrong module and the tests error out during collection.";
// Two paragraphs (blank-line separated): the extractor takes para 1 as the
// mechanism and para 2 as the unlock when no imperative action line is present.
const SOLVED_ASSISTANT =
  "The root cause is that an earlier sys.path entry exposes a namespace package that " +
  "shadows the intended one, so the pytest collector imports the wrong module during " +
  "collection. Namespace packages merge across sys.path and the first matching entry " +
  "wins, which is why the intended package is never reached.\n\n" +
  "Rename the shadowing module or remove its directory from sys.path before invoking " +
  "pytest, then run pytest collect-only to confirm the intended package is collected. " +
  "Verify by checking the collected test ids reference the correct package path.";

describe("organic capture loop", () => {
  it("1. a solved run produces one recallable block", () => {
    const store = makeStore();
    const out = captureTurnFromTexts(store, { userText: SOLVED_USER, assistantText: SOLVED_ASSISTANT });
    expect(out.blockId).not.toBeNull();
    expect(store.countBlocks("active")).toBe(1);

    const server = new BlockServer(store);
    const recall = server.recall({ text: "pytest suite fails collect package sys path shadows namespace clone" });
    expect(recall.blocks.some((h) => h.block.id === out.blockId)).toBe(true);
  });

  it("2. a trivial / unsolved run does NOT become a reusable block", () => {
    const store = makeStore();
    const out = captureTurnFromTexts(store, {
      userText: "what is the time?",
      assistantText: "It is unclear; I cannot determine the time.",
    });
    expect(out.blockId).toBeNull();
    expect(store.countBlocks("active")).toBe(0);
  });

  it("3. duplicate capture collapses safely (no second block)", () => {
    const store = makeStore();
    const a = captureTurnFromTexts(store, { userText: SOLVED_USER, assistantText: SOLVED_ASSISTANT });
    const b = captureTurnFromTexts(store, { userText: SOLVED_USER, assistantText: SOLVED_ASSISTANT });
    expect(a.blockId).not.toBeNull();
    expect(b.isNew).toBe(false);
    expect(store.countBlocks("active")).toBe(1);
  });

  it("4. privacy leakage is rejected (no block, run continues)", () => {
    const store = makeStore();
    const leakyAssistant =
      "The root cause is a stale cache layer that returns prior results because the cache " +
      "key omits the deploy version, so old entries keep being served indefinitely after " +
      "every deploy until they happen to expire on their own much later.\n\n" +
      "Clear the cache key prefix on deploy and re-run. Here is the patch:\n" +
      "--- a/src/cache.py\n+++ b/src/cache.py\nVerify the cache miss rate returns to baseline.";
    const out = captureTurnFromTexts(store, { userText: SOLVED_USER, assistantText: leakyAssistant });
    expect(out.blockId).toBeNull();
    expect(store.countBlocks("active")).toBe(0);
  });

  it("5. a later similar query injects the captured block", () => {
    const store = makeStore();
    captureTurnFromTexts(store, { userText: SOLVED_USER, assistantText: SOLVED_ASSISTANT });
    const server = new BlockServer(store);
    const r = server.recall({ text: "pytest suite fails collect package sys path shadows namespace clone" });
    expect(r.shouldInject).toBe(true);
    expect(r.servingDecision?.action).toBe("inject");
  });

  it("6. an unrelated query abstains", () => {
    const store = makeStore();
    captureTurnFromTexts(store, { userText: SOLVED_USER, assistantText: SOLVED_ASSISTANT });
    const server = new BlockServer(store);
    const r = server.recall({ text: "how do I center a div in css flexbox layout" });
    expect(r.shouldInject).toBe(false);
    expect(r.servingDecision?.action).toBe("abstain");
  });

  it("7. an attributed outcome reaches calibration storage (trains on evidenceConfidence)", () => {
    const store = makeStore();
    captureTurnFromTexts(store, { userText: SOLVED_USER, assistantText: SOLVED_ASSISTANT });
    const server = new BlockServer(store); // emitEvents: true by default
    const r = server.recall({ text: "pytest suite fails collect package sys path shadows namespace clone" });
    expect(r.shouldInject).toBe(true);
    const injected = r.blocks.find((h) => h.passesGate)!;

    // Close the loop: the agent used the block and the task resolved.
    store.appendEvent({
      ts: 10, queryId: r.queryId, event: "agent_used",
      blockId: injected.block.id, matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit",
    });
    store.appendEvent({ ts: 11, queryId: r.queryId, event: "outcome", resolved: true, control: false });

    // The injection event the server emitted carries evidenceConfidence; the
    // calibrator trains on it (the attributed outcome reached calibration).
    const model = fitCalibratorFromEvents(store, { minSample: 1 });
    expect(model).not.toBeNull();
    expect(model!.featureVersion).toBe(1);
    expect(model!.n).toBeGreaterThanOrEqual(1);
  });
});
