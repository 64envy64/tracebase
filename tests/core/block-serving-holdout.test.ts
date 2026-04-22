/**
 * Phase 3.2 — BlockServer experimental-holdout hookup.
 *
 * Scope of this file is deliberately narrow. It only exercises the
 * serving-side wiring of `shouldHoldOut` into `BlockServer.recall`:
 * event shape on holdout, no-op paths, interaction with manual
 * shadow, and the formatter contract. Analytics aggregation and
 * dashboard rendering live on separate surfaces covered elsewhere.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  BlockServer,
  formatInjection,
  type RecallV2Result,
} from "../../src/core/block-serving.js";
import { createBlock } from "../../src/core/block.js";
import type { AnalyticsEvent, ReasoningBlock, StoreBlockInput } from "../../src/types.js";

const SAMPLE_BLOCK: StoreBlockInput = {
  trigger: {
    situation: "Tokenizer drops zero-width joiner characters in emoji sequences",
    invariants: {
      language: "python",
      framework: "transformers",
      errorType: "TokenizationError",
    },
  },
  body: {
    mechanism: "upstream normalizer collapses ZWJ before tokenization",
    deadEnds: ["retrain with flat vocabulary"],
    unlock: "preserve ZWJ in the byte-pair encoder input pass",
    verification: "round-trip a curated ZWJ-bearing string through encode/decode",
  },
  provenance: {
    sourceTaskId: "t-zwj-1",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function seedActive(store: BlockStore, input: StoreBlockInput): ReasoningBlock {
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

function retrievalEventFor(store: BlockStore, queryId: string) {
  return store
    .readEvents({ limit: 1_000 })
    .find((e: AnalyticsEvent) => e.event === "retrieval" && e.queryId === queryId);
}

function eventsOf(store: BlockStore, queryId: string): AnalyticsEvent[] {
  return store
    .readEvents({ limit: 1_000 })
    .filter((e: AnalyticsEvent) => e.queryId === queryId);
}

describe("Phase 3.2 — BlockServer experimental-holdout hookup", () => {
  let store: BlockStore;
  let server: BlockServer;

  beforeEach(() => {
    store = makeStore();
    seedActive(store, SAMPLE_BLOCK);
    server = new BlockServer(store);
  });

  it("is a 100% no-op when `experiment` is omitted — identical to pre-Phase-3 behaviour", () => {
    const queryId = "qid-no-experiment";
    const res: RecallV2Result = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
    });
    // Shape is exactly what 3.1 shipped.
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(true);
    expect(res.blocks.some((h) => h.passesGate)).toBe(true);
    // Retrieval event must not carry `controlReason` — legacy shape.
    const retrieval = retrievalEventFor(store, queryId);
    expect(retrieval).toBeDefined();
    expect(retrieval?.event).toBe("retrieval");
    if (retrieval?.event === "retrieval") {
      expect(retrieval.shadow).toBe(false);
      expect(retrieval.controlReason).toBeUndefined();
    }
    // Injection emitted because the query was eligible.
    const injections = eventsOf(store, queryId).filter((e) => e.event === "injection");
    expect(injections.length).toBeGreaterThan(0);
  });

  it("suppresses injection and marks retrieval with controlReason=holdout when rate=1 + fingerprint present", () => {
    const queryId = "qid-holdout";
    const res = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      experiment: {
        rate: 1, // always hold out
        salt: "ws-unit",
        fingerprint: "fp:zwj-tokenizer",
      },
    });
    // The run is treated as shadow: no injection anywhere.
    expect(res.shadow).toBe(true);
    expect(res.shouldInject).toBe(false);
    expect(res.blocks.every((h) => !h.passesGate)).toBe(true);
    expect(res.facts.every((h) => !h.passesGate)).toBe(true);

    const retrieval = retrievalEventFor(store, queryId);
    expect(retrieval).toBeDefined();
    if (retrieval?.event === "retrieval") {
      expect(retrieval.shadow).toBe(true);
      expect(retrieval.controlReason).toBe("holdout");
      // Candidates still recorded — "eligible" remains observable.
      expect(retrieval.candidates.length).toBeGreaterThan(0);
    }

    // No injection events emitted for this query.
    const injectionEvents = eventsOf(store, queryId).filter(
      (e) => e.event === "injection" || e.event === "fact_injection",
    );
    expect(injectionEvents).toEqual([]);

    // Formatter renders empty so the prompt payload and analytics
    // stay one-to-one on a held-out run.
    expect(formatInjection(res)).toBe("");
  });

  it("keeps the manual-shadow path legacy-compatible — no controlReason, no holdout", () => {
    const queryId = "qid-manual-shadow";
    const res = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      shadow: true,
      // Experiment also supplied: manual shadow still wins, no
      // silent upgrade to controlReason=holdout.
      experiment: {
        rate: 1,
        salt: "ws-unit",
        fingerprint: "fp:zwj-tokenizer",
      },
    });
    expect(res.shadow).toBe(true);
    expect(res.shouldInject).toBe(false);
    const retrieval = retrievalEventFor(store, queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.shadow).toBe(true);
      // Critical: undefined, not "holdout". Analytics treats this
      // as legacy diagnostic shadow. Phase 3.3 will only classify
      // controlReason === "holdout" as the causal arm.
      expect(retrieval.controlReason).toBeUndefined();
    }
  });

  it("never triggers holdout when the experiment is disabled (rate=0)", () => {
    const queryId = "qid-rate-zero";
    const res = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      experiment: {
        rate: 0, // shouldHoldOut contract: always returns false
        salt: "ws-unit",
        fingerprint: "fp:zwj-tokenizer",
      },
    });
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(true);
    const retrieval = retrievalEventFor(store, queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.shadow).toBe(false);
      expect(retrieval.controlReason).toBeUndefined();
    }
    // Injection still emitted — disabled experiments must not
    // interrupt serving in any way.
    const injections = eventsOf(store, queryId).filter((e) => e.event === "injection");
    expect(injections.length).toBeGreaterThan(0);
  });

  it("does not mark a no-candidate query as holdout even at rate=1", () => {
    // Query that deliberately matches nothing in the seeded corpus.
    // `eligible` is false, so holdout must not fire.
    const queryId = "qid-no-candidates";
    const res = server.recall({
      text: "xyzzy-nonexistent-token",
      queryId,
      experiment: {
        rate: 1,
        salt: "ws-unit",
        fingerprint: "fp:nothing",
      },
    });
    expect(res.blocks).toEqual([]);
    expect(res.facts).toEqual([]);
    // shadow stays false because eligible=false short-circuits the
    // holdout path. Retrieval is still emitted for the record.
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(false);
    const retrieval = retrievalEventFor(store, queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.shadow).toBe(false);
      expect(retrieval.controlReason).toBeUndefined();
      expect(retrieval.candidates).toEqual([]);
    }
  });

  it("is a safe no-op when experiment is supplied without a fingerprint", () => {
    // Fingerprint is required for deterministic assignment; its
    // absence must not fall back to a random / non-deterministic
    // decision. Serving proceeds as if no experiment were passed.
    const queryId = "qid-no-fingerprint";
    const res = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      experiment: {
        rate: 1,
        salt: "ws-unit",
        // fingerprint deliberately omitted
      },
    });
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(true);
    const retrieval = retrievalEventFor(store, queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.controlReason).toBeUndefined();
    }
  });

  it("empty-string fingerprint is also a silent no-op", () => {
    const queryId = "qid-empty-fingerprint";
    const res = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      experiment: {
        rate: 1,
        salt: "ws-unit",
        fingerprint: "",
      },
    });
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(true);
  });

  it("prompt payload remains empty and no injection rows appear on a held-out eligible run", () => {
    const queryId = "qid-payload-empty";
    const res = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      experiment: {
        rate: 1,
        salt: "ws-unit",
        fingerprint: "fp:payload-test",
      },
    });
    // End-to-end invariant: holdout → no prompt content, no
    // injection event. Even in XML mode — the formatter keys off
    // `shouldInject`, which we already asserted is false.
    expect(formatInjection(res)).toBe("");
    expect(formatInjection(res, { format: "xml" })).toBe("");
    const otherQueryEvents = eventsOf(store, queryId);
    expect(
      otherQueryEvents.every(
        (e) => e.event !== "injection" && e.event !== "fact_injection",
      ),
    ).toBe(true);
  });
});
