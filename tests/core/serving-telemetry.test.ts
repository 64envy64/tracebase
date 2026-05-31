/**
 * Serving-decision telemetry (Phase 1).
 *
 * Every recall — inject, abstain, or zero-hit — must stamp a privacy-safe
 * `serving` record on the retrieval event: queryHash (never the raw prompt),
 * corpus/candidate counts, evidence + margin + calibrated prob, the decision +
 * reason, feature/calibrator versions, latency, and injected block ids.
 * Pre-telemetry events (no `serving`) must remain readable, and a stale
 * calibrator version must fall back safely (covered in calibrator.test.ts).
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { createBlock } from "../../src/core/block.js";
import type { ReasoningBlock, StoreBlockInput, RetrievalEvent } from "../../src/types.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function storeActive(store: BlockStore, input: StoreBlockInput): ReasoningBlock {
  const b = createBlock(input);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  return store.updateBlockStatus(b.id, "active")!;
}

function mk(id: string, situation: string): StoreBlockInput {
  return {
    trigger: { situation, invariants: {} },
    body: { mechanism: `${id} mechanism`, deadEnds: [], unlock: `${id} unlock`, verification: `${id} check` },
    provenance: { sourceTaskId: id, extractedFrom: "trajectory", distilledBy: "llm" },
  };
}

function lastServing(store: BlockStore): RetrievalEvent["serving"] {
  const evs = store.readEvents({ eventType: "retrieval" }) as RetrievalEvent[];
  return evs[evs.length - 1]?.serving;
}

describe("serving telemetry — per recall", () => {
  it("inject: records decision, injected ids, versions, latency, corpus/candidate counts", () => {
    const store = makeStore();
    storeActive(store, mk("b1", "metaclass registration conflict in abstract base class"));
    const server = new BlockServer(store);
    const r = server.recall({ text: "metaclass registration conflict abstract", scope: "repo:org/app" });

    const s = lastServing(store)!;
    expect(s).toBeDefined();
    expect(s.decision).toBe("inject");
    expect(s.reason).toBe("injected");
    expect(s.injectedBlockIds.length).toBe(1);
    expect(s.injectedBlockIds[0]).toBe(r.blocks[0]!.block.id);
    expect(s.corpusSize).toBe(1);
    expect(s.candidateCount).toBeGreaterThanOrEqual(1);
    expect(s.evidenceConfidence).toBeGreaterThan(0.4);
    expect(s.featureVersion).toBe(1);
    expect(s.calibratorVersion).toBe("identity");
    expect(s.latencyMs).toBeGreaterThanOrEqual(0);
    expect(s.scope).toBe("repo:org/app");
  });

  it("queryHash is present and never embeds the raw prompt", () => {
    const store = makeStore();
    storeActive(store, mk("b2", "kubernetes pod scheduling affinity"));
    const server = new BlockServer(store);
    server.recall({ text: "supersecretphrase kubernetes scheduling" });
    const s = lastServing(store)!;
    expect(s.queryHash.startsWith("q_")).toBe(true);
    expect(s.queryHash).not.toContain("supersecretphrase");
  });

  it("weak abstain: decision=abstain, reason=weak_evidence, no injected ids", () => {
    const store = makeStore();
    storeActive(store, mk("b3", "color theme palette tokens"));
    const server = new BlockServer(store);
    // ≥4 informative tokens ⇒ FTS OR; only "color" matches the block, so it
    // is retrieved (candidate ≥ 1) but the evidence is a single weak token.
    server.recall({ text: "color related thoughts from the wider team" });
    const s = lastServing(store)!;
    expect(s.candidateCount).toBeGreaterThanOrEqual(1);
    expect(s.decision).toBe("abstain");
    expect(s.reason).toBe("weak_evidence");
    expect(s.injectedBlockIds).toEqual([]);
  });

  it("ambiguous abstain: reason=ambiguous_margin", () => {
    const store = makeStore();
    storeActive(store, mk("b4a", "color theme dark mode toggle"));
    storeActive(store, mk("b4b", "color theme dark mode switch"));
    const server = new BlockServer(store);
    server.recall({ text: "color theme dark mode" });
    const s = lastServing(store)!;
    expect(s.decision).toBe("abstain");
    expect(s.reason).toBe("ambiguous_margin");
    expect(s.injectedBlockIds).toEqual([]);
  });

  it("zero-hit abstain: candidateCount=0, reason=no_candidates, corpus still counted", () => {
    const store = makeStore();
    storeActive(store, mk("b5", "metaclass registration conflict"));
    const server = new BlockServer(store);
    server.recall({ text: "zzqq xyzzy nonexistent flumph" });
    const s = lastServing(store)!;
    expect(s.candidateCount).toBe(0);
    expect(s.decision).toBe("abstain");
    expect(s.reason).toBe("no_candidates");
    expect(s.corpusSize).toBe(1);
  });

  it("calibratorVersion reflects a wired calibrator", () => {
    const store = makeStore();
    storeActive(store, mk("b6", "isotonic calibrator regression fitting curve"));
    const server = new BlockServer(store, { calibrator: (c) => c, calibratorVersion: 1 });
    server.recall({ text: "isotonic calibrator regression" });
    expect(lastServing(store)!.calibratorVersion).toBe(1);
  });

  it("back-compat: a pre-telemetry retrieval event (no serving) is still readable", () => {
    const store = makeStore();
    store.appendEvent({
      ts: 1, queryId: "legacy-1", event: "retrieval",
      candidates: [{ blockId: "x", score: 0.5 }], shadow: false,
    });
    const evs = store.readEvents({ eventType: "retrieval" }) as RetrievalEvent[];
    expect(evs.length).toBe(1);
    expect(evs[0]!.serving).toBeUndefined();
  });
});
