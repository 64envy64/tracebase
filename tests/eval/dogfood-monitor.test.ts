/**
 * Tests for runtime dogfood observability: recurring-family fingerprint +
 * the dogfood monitor's counts, query-level quality, privacy, and the locked
 * readiness gate (READY only when truly met).
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { captureTurnFromTexts } from "../../src/runtime/capture-turn.js";
import { fingerprintText, clusterFamilies } from "../../src/eval/family-fingerprint.js";
import { buildDogfoodReport } from "../../scripts/reasoning-precision/dogfood-monitor.js";

describe("family fingerprint", () => {
  it("is deterministic and order-invariant over the same salient term set", () => {
    const base = "coercion string numbers precision large decimals overflow";
    const reversed = base.split(" ").reverse().join(" ");
    expect(fingerprintText(base)).toBe(fingerprintText(base));
    expect(fingerprintText(base)).toBe(fingerprintText(reversed));
  });
  it("distinguishes unrelated problem classes", () => {
    expect(fingerprintText("coercion string numbers precision large decimals overflow"))
      .not.toBe(fingerprintText("timeout socket abort signal handler leak duplicate"));
  });
  it("clusterFamilies counts recurring families (size >= 2)", () => {
    const blocks = [
      { id: "b1", trigger: { situation: "coercion string numbers precision large decimals overflow" }, body: {} },
      { id: "b2", trigger: { situation: "overflow decimals large precision numbers string coercion" }, body: {} },
      { id: "b3", trigger: { situation: "timeout socket abort signal handler leak duplicate" }, body: {} },
    ];
    const fam = clusterFamilies(blocks);
    expect(fam.totalBlocks).toBe(3);
    expect(fam.families).toBe(2);
    expect(fam.recurringFamilies).toBe(1);
    expect(fam.largestFamilySize).toBe(2);
  });
});

const USER =
  "The pytest suite fails to collect the right package on a fresh clone because an " +
  "earlier sys.path entry shadows the intended namespace package, so imports resolve " +
  "to the wrong module and the tests error out during collection.";
const ASSISTANT =
  "The root cause is that an earlier sys.path entry exposes a namespace package that " +
  "shadows the intended one, so the pytest collector imports the wrong module during " +
  "collection. The first matching entry wins.\n\n" +
  "Rename the shadowing module or remove its directory from sys.path before invoking " +
  "pytest, then run pytest collect-only to confirm the intended package is collected.";

describe("dogfood monitor", () => {
  it("empty store → NOT READY with capture + recurring-family blockers", () => {
    const store = new BlockStore(new Database(":memory:"));
    const r = buildDogfoodReport(store);
    expect(r.store.captured).toBe(0);
    expect(r.ready).toBe(false);
    expect(r.privacy.rawPromptsStored).toBe(0);
    expect(r.families.familiesWithHoldoutOutcomes).toBe(0);
    expect(r.blockers.some((b) => b.startsWith("capturedRuntime"))).toBe(true);
    expect(r.blockers.some((b) => b.includes("recurring-families: 0"))).toBe(true);
    store.close();
  });

  it("one captured + injected + attributed block → counts + query-level precision, still NOT READY at N=1", () => {
    const store = new BlockStore(new Database(":memory:"));
    const cap = captureTurnFromTexts(store, { userText: USER, assistantText: ASSISTANT });
    expect(cap.blockId).not.toBeNull();
    const server = new BlockServer(store);
    const rec = server.recall({ text: "pytest suite fails collect package sys path shadows namespace clone" });
    const blockId = rec.blocks.find((h) => h.passesGate)!.block.id;
    store.appendEvent({ ts: 10, queryId: rec.queryId, event: "agent_used", blockId, matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit" });
    store.appendEvent({ ts: 11, queryId: rec.queryId, event: "outcome", resolved: true, control: false });

    const r = buildDogfoodReport(store);
    expect(r.store.runtimeCaptured).toBe(1);
    expect(r.quality.firedQueries).toBe(1);
    expect(r.quality.correctFires).toBe(1);
    expect(r.quality.precisionAtFire).toBe(1);
    expect(r.store.precisionReady).toBe(1);
    // Volume gate not met at N=1 → READY must remain false (gate truly enforced).
    expect(r.ready).toBe(false);
    expect(r.gate.capturedRuntime.pass).toBe(false);
    expect(r.gate.precisionReady.pass).toBe(false);
    store.close();
  });
});
