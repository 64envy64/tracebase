/**
 * Dogfood manifest + progress report (Phase 5, Step 2).
 *
 * A real captured + injected + attributed block surfaces as one precision-ready
 * organic entry; the manifest is privacy-safe (distilled situation + queryHash,
 * never the raw prompt).
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { captureTurnFromTexts } from "../../src/runtime/capture-turn.js";
import { buildDogfoodManifest, manifestToJsonl } from "../../src/eval/dogfood-manifest.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

const SECRET_USER =
  "The pytest suite fails to collect the right package on a fresh clone because an " +
  "earlier sys.path entry shadows the intended namespace package SUPERSECRETTOKEN, so " +
  "imports resolve to the wrong module and the tests error out during collection.";
const SOLVED_ASSISTANT =
  "The root cause is that an earlier sys.path entry exposes a namespace package that " +
  "shadows the intended one, so the pytest collector imports the wrong module during " +
  "collection. The first matching entry wins, which is why the intended package is " +
  "never reached.\n\n" +
  "Rename the shadowing module or remove its directory from sys.path before invoking " +
  "pytest, then run pytest collect-only to confirm the intended package is collected.";

describe("buildDogfoodManifest", () => {
  it("reports a captured + injected + attributed runtime block as precision-ready", () => {
    const store = makeStore();
    const cap = captureTurnFromTexts(store, { userText: SECRET_USER, assistantText: SOLVED_ASSISTANT });
    expect(cap.blockId).not.toBeNull();

    const server = new BlockServer(store);
    const r = server.recall({ text: "pytest suite fails collect package sys path shadows namespace clone" });
    expect(r.shouldInject).toBe(true);
    const blockId = r.blocks.find((h) => h.passesGate)!.block.id;

    // Attribute a resolved outcome.
    store.appendEvent({ ts: 10, queryId: r.queryId, event: "agent_used", blockId, matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit" });
    store.appendEvent({ ts: 11, queryId: r.queryId, event: "outcome", resolved: true, control: false });

    const m = buildDogfoodManifest(store);
    expect(m.summary.captured).toBe(1);
    expect(m.summary.runtimeCaptured).toBe(1);
    expect(m.summary.imported).toBe(0);
    expect(m.summary.fired).toBe(1);
    expect(m.summary.attributed).toBe(1);
    expect(m.summary.precisionReady).toBe(1);

    const e = m.entries[0]!;
    expect(e.extractedFrom).toBe("trajectory");
    expect(e.distilledBy).toBe("rule");
    expect(e.captureVersion).toBe("capture-heuristic-1");
    expect(e.injections).toBe(1);
    expect(e.attributedResolved).toBe(1);
    expect(e.queryHashes.length).toBe(1);
    expect(e.queryHashes[0]!.startsWith("q_")).toBe(true);
    expect(e.leakClean).toBe(true);
  });

  it("manifest is privacy-safe: no raw prompt text or secrets", () => {
    const store = makeStore();
    captureTurnFromTexts(store, { userText: SECRET_USER, assistantText: SOLVED_ASSISTANT });
    const jsonl = manifestToJsonl(buildDogfoodManifest(store));
    // The raw user-prompt secret must never appear in the manifest.
    expect(jsonl).not.toContain("SUPERSECRETTOKEN");
    // The distilled situation (privacy-scanned trigger) is present + useful.
    expect(jsonl.length).toBeGreaterThan(0);
  });
});
