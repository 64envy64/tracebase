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
    // Tiny single-block corpus produces near-zero FTS5 BM25 IDF, so a
    // production-realistic gate (May-2026 default 0.4) would mask the
    // holdout-wiring contract we want to assert here. The eligibility +
    // shadow-vs-treatment semantics are independent of the gate value
    // — explicitly setting gate=0 isolates this file's responsibility.
    server = new BlockServer(store, { gateThreshold: 0 });
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

  it("explicit positive: at least one hit above gate + rate=1 → holdout fires", () => {
    // Baseline confirmation for the semantics change in Phase 3.2.1:
    // when the calibrated probability genuinely clears the gate, a
    // rate=1 experiment still lands this run in the holdout cohort.
    // The two below-gate tests following this one assert the
    // converse — and only their co-presence lets the causal layer
    // trust the cohort.
    // Gate=0 still distinguishes "has eligible candidate" (any hit row
    // returned by FTS) from "no candidate", which is the contrast the
    // converse below-gate tests rely on. We avoid asserting a specific
    // BM25-derived score here — the holdout file owns wiring, not the
    // scoring scale.
    const highGateServer = new BlockServer(store, { gateThreshold: 0 });
    const queryId = "qid-positive-above-gate";
    const res = highGateServer.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      experiment: {
        rate: 1,
        salt: "ws-unit",
        fingerprint: "fp:positive",
      },
    });
    expect(res.shadow).toBe(true);
    expect(res.shouldInject).toBe(false);
    const retrieval = retrievalEventFor(store, queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.controlReason).toBe("holdout");
    }
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

describe("Phase 3.2.1 — holdout eligibility is gate-gated, not retrieval-gated", () => {
  it("retrieved block whose calibrated probability is below gateThreshold is NOT held out", () => {
    // P1 the reviewer flagged: pre-3.2.1 eligibility was just
    // "at least one candidate returned", ignoring the calibrator
    // and gateThreshold. A query whose hits all fall below the
    // gate would not produce an injection in treatment either,
    // so marking it holdout contaminates the control cohort with
    // "nothing-to-compare" queries and biases the causal lift
    // downward. Eligibility must therefore check *would-pass-gate
    // absent shadow*.
    const store = makeStore();
    seedActive(store, SAMPLE_BLOCK);
    // Calibrator floors every hit at 0.1, gateThreshold at 0.5 —
    // the block will be retrieved but never pass the gate.
    const server = new BlockServer(store, {
      calibrator: () => 0.1,
      gateThreshold: 0.5,
    });
    const queryId = "qid-block-below-gate";
    const res = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      experiment: {
        rate: 1, // would hold out if eligibility were raw-retrieval
        salt: "ws-unit",
        fingerprint: "fp:below-gate",
      },
    });
    // Sanity: the block *is* retrieved (raw retrieval succeeded)
    // but it never passed the gate, so shouldInject=false in
    // treatment. Therefore shadow must stay false and the event
    // must not carry controlReason="holdout" — the run simply
    // never was eligible to compare against.
    expect(res.blocks.length).toBeGreaterThan(0);
    expect(res.blocks.every((h) => !h.passesGate)).toBe(true);
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(false);
    const retrieval = retrievalEventFor(store, queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.shadow).toBe(false);
      expect(retrieval.controlReason).toBeUndefined();
    }
  });

  it("retrieved fact whose confidence is below gateThreshold is NOT held out", () => {
    // Parallel regression on the fact side. `FactHit.calibratedProb`
    // is clamped from `fact.confidence`; a low-confidence fact
    // retrieved by FTS still must not count as "gate-eligible" at
    // a higher threshold.
    const store = makeStore();
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "docstrings must follow the google docstring style",
      invariants: {},
      source: { origin: "declared", author: "ci" },
      confidence: 0.3, // below the gateThreshold we pick below
    });
    const server = new BlockServer(store, { gateThreshold: 0.7 });
    const queryId = "qid-fact-below-gate";
    const res = server.recall({
      text: "docstrings google style",
      queryId,
      experiment: {
        rate: 1,
        salt: "ws-unit",
        fingerprint: "fp:fact-below-gate",
      },
    });
    // Fact retrieved, but its calibrated probability (0.3) is
    // below the gateThreshold (0.7). No holdout.
    expect(res.facts.length).toBeGreaterThan(0);
    expect(res.facts.every((h) => !h.passesGate)).toBe(true);
    expect(res.shadow).toBe(false);
    expect(res.shouldInject).toBe(false);
    const retrieval = retrievalEventFor(store, queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.shadow).toBe(false);
      expect(retrieval.controlReason).toBeUndefined();
    }
  });

  it("at least one hit above gate → holdout still applies (positive case is unaffected)", () => {
    // Converse of the two regressions above — makes the trio
    // exhaustive for the eligibility predicate.
    const store = makeStore();
    seedActive(store, SAMPLE_BLOCK);
    const server = new BlockServer(store, {
      calibrator: () => 0.9, // well above default threshold
      gateThreshold: 0.1,
    });
    const queryId = "qid-above-gate-held";
    const res = server.recall({
      text: "tokenizer drops zero-width joiner",
      queryId,
      experiment: {
        rate: 1,
        salt: "ws-unit",
        fingerprint: "fp:above-gate-held",
      },
    });
    expect(res.shadow).toBe(true);
    expect(res.shouldInject).toBe(false);
    const retrieval = retrievalEventFor(store, queryId);
    if (retrieval?.event === "retrieval") {
      expect(retrieval.controlReason).toBe("holdout");
    }
  });
});
