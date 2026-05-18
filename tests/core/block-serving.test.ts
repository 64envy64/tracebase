import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  BlockServer,
  formatInjection,
  identityCalibrator,
  type Calibrator,
} from "../../src/core/block-serving.js";
import { createBlock } from "../../src/core/block.js";
import type { StoreBlockInput, ReasoningBlock } from "../../src/types.js";
import type { Reranker, RerankerCandidate } from "../../src/core/reranker.js";

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

const PY_BLOCK: StoreBlockInput = {
  trigger: {
    situation: "Metaclass iterates members using inspect.isfunction which skips properties",
    invariants: {
      language: "python",
      framework: "astropy",
      errorType: "MissingDocstring",
      apiSurface: ["inspect.isfunction"],
    },
  },
  body: {
    mechanism: "property objects are descriptors not functions",
    deadEnds: ["UniqueBodyTokenXYZ add property-specific branch"],
    unlock: "use inspect.isdatadescriptor to cover both",
    verification: "class with method + property inherits docstrings",
  },
  provenance: {
    sourceTaskId: "astropy__astropy-7166",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

const TS_BLOCK: StoreBlockInput = {
  trigger: {
    situation: "React useEffect missing dependency causes stale closure on event handler",
    invariants: {
      language: "typescript",
      framework: "react",
      errorType: "StaleClosure",
      apiSurface: ["react.useEffect"],
    },
  },
  body: {
    mechanism: "effect captures first render's state",
    deadEnds: ["wrap handler in useCallback without deps"],
    unlock: "move state into ref or list it in deps array",
    verification: "click handler reads latest state after update",
  },
  provenance: {
    sourceTaskId: "react-sample-1",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

// ---------------------------------------------------------------------------
// Retrieval + prefilter
// ---------------------------------------------------------------------------

describe("BlockServer — retrieval", () => {
  let store: BlockStore;
  let server: BlockServer;

  beforeEach(() => {
    store = makeStore();
    server = new BlockServer(store);
  });

  it("returns a block matching free-text query", () => {
    storeActive(store, PY_BLOCK);
    const out = server.recall({ text: "metaclass inspect iterates" });
    expect(out.blocks.length).toBe(1);
    expect(out.blocks[0].block.trigger.invariants.language).toBe("python");
    expect(out.blocks[0].score).toBeGreaterThan(0);
  });

  it("hard-prefilters by language invariant", () => {
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    // "useEffect stale closure react" matches TS_BLOCK but we filter to python.
    const py = server.recall({
      text: "useEffect stale closure",
      invariants: { language: "python" },
    });
    expect(py.blocks.length).toBe(0); // TS block excluded; PY doesn't match tokens
    const ts = server.recall({
      text: "useEffect stale closure",
      invariants: { language: "typescript" },
    });
    expect(ts.blocks.length).toBe(1);
    expect(ts.blocks[0].block.trigger.invariants.language).toBe("typescript");
  });

  it("keeps blocks with no invariant when query sets one", () => {
    // A block with no language restriction should still match a typed query.
    const nolang: StoreBlockInput = {
      trigger: {
        situation: "generic distinctive-token error recovery",
        invariants: {}, // no language
      },
      body: {
        mechanism: "no mechanism",
        deadEnds: [],
        unlock: "a",
        verification: "b",
      },
      provenance: {
        sourceTaskId: "generic-1",
        extractedFrom: "trajectory",
        distilledBy: "llm",
      },
    };
    storeActive(store, nolang);
    const out = server.recall({
      text: "distinctive-token",
      invariants: { language: "python" },
    });
    expect(out.blocks.length).toBe(1);
  });

  it("does NOT match on body-only tokens (trigger-only scoring)", () => {
    storeActive(store, PY_BLOCK);
    // UniqueBodyTokenXYZ appears only in body.deadEnds, never in trigger.
    const out = server.recall({ text: "UniqueBodyTokenXYZ" });
    expect(out.blocks.length).toBe(0);
  });

  it("never returns candidate-status blocks", () => {
    const b = createBlock(PY_BLOCK);
    b.status = "candidate";
    store.storeBlock(b);
    // No origin ref attached → stays candidate → must not surface.
    const out = server.recall({ text: "metaclass inspect" });
    expect(out.blocks.length).toBe(0);
  });

  it("never returns demoted blocks", () => {
    const b = storeActive(store, PY_BLOCK);
    // Detach the origin ref → block demotes to candidate.
    const refs = store.listCaseRefs(b.id, "origin");
    store.detachCaseRef(refs[0].id);
    expect(store.getBlock(b.id)!.status).toBe("candidate");
    const out = server.recall({ text: "metaclass inspect" });
    expect(out.blocks.length).toBe(0);
  });

  it("attaches case refs to each hit, limited by refLimit", () => {
    const b = storeActive(store, PY_BLOCK);
    // Add two more supporting refs.
    store.attachCaseRef({
      blockId: b.id, traceId: "t-2", role: "supporting", evidenceQuality: "moderate",
    });
    store.attachCaseRef({
      blockId: b.id, traceId: "t-3", role: "supporting", evidenceQuality: "weak",
    });
    const out = server.recall({ text: "metaclass inspect", refLimit: 2 });
    expect(out.blocks[0].refs.length).toBe(2);
  });

  it("ranking is deterministic across calls", () => {
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const q = { text: "missing error" };
    const a = server.recall(q);
    const b = server.recall(q);
    expect(a.blocks.map((h) => h.block.id)).toEqual(b.blocks.map((h) => h.block.id));
    expect(a.blocks.map((h) => h.score)).toEqual(b.blocks.map((h) => h.score));
  });

  it("respects limit", () => {
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const out = server.recall({ text: "missing error stale closure", limit: 1 });
    expect(out.blocks.length).toBe(1);
  });

  it("apiSurface prefilter rejects blocks whose api set has no overlap", () => {
    storeActive(store, PY_BLOCK); // apiSurface=["inspect.isfunction"]
    storeActive(store, TS_BLOCK); // apiSurface=["react.useEffect"]
    // Query specifies a different API surface entirely.
    const out = server.recall({
      text: "metaclass react useEffect inspect",
      invariants: { apiSurface: ["numpy.ndarray.__array_ufunc__"] },
    });
    expect(out.blocks.length).toBe(0);
  });

  it("apiSurface prefilter keeps blocks whose api set overlaps", () => {
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const out = server.recall({
      text: "metaclass react useEffect inspect",
      invariants: { apiSurface: ["react.useEffect"] },
    });
    expect(out.blocks.length).toBe(1);
    expect(out.blocks[0].block.trigger.invariants.apiSurface).toContain("react.useEffect");
  });

  it("apiSurface prefilter keeps blocks that set no api surface", () => {
    const noapi: StoreBlockInput = {
      trigger: {
        situation: "generic distinctive-token error recovery",
        invariants: { language: "python" }, // no apiSurface
      },
      body: {
        mechanism: "x",
        deadEnds: [],
        unlock: "u",
        verification: "v",
      },
      provenance: {
        sourceTaskId: "gen-1", extractedFrom: "trajectory", distilledBy: "llm",
      },
    };
    storeActive(store, noapi);
    const out = server.recall({
      text: "distinctive-token",
      invariants: { apiSurface: ["something.else"] },
    });
    expect(out.blocks.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gate + calibrator
// ---------------------------------------------------------------------------

describe("BlockServer — gate + calibrator", () => {
  let store: BlockStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("shouldInject is true by default when hits exist", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    const out = server.recall({ text: "metaclass inspect" });
    expect(out.shouldInject).toBe(true);
  });

  it("shouldInject is false when no hits", () => {
    const server = new BlockServer(store);
    const out = server.recall({ text: "nothing here matches" });
    expect(out.shouldInject).toBe(false);
  });

  it("shouldInject is false when query is shadow", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    const out = server.recall({ text: "metaclass inspect", shadow: true });
    expect(out.shouldInject).toBe(false);
    // But hits are still returned for reporting.
    expect(out.blocks.length).toBeGreaterThan(0);
  });

  it("custom calibrator changes calibratedProb", () => {
    storeActive(store, PY_BLOCK);
    const lowCalibrator: Calibrator = () => 0.1;
    const server = new BlockServer(store, { calibrator: lowCalibrator });
    const out = server.recall({ text: "metaclass inspect" });
    expect(out.blocks[0].calibratedProb).toBe(0.1);
  });

  it("gate threshold blocks injection when calibratedProb below", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, {
      calibrator: () => 0.3,
      gateThreshold: 0.8,
    });
    const out = server.recall({ text: "metaclass inspect" });
    expect(out.blocks.length).toBe(1);
    expect(out.shouldInject).toBe(false);
  });

  it("identity calibrator is a passthrough", () => {
    expect(identityCalibrator(0.5, {} as ReasoningBlock)).toBe(0.5);
    expect(identityCalibrator(1.0, {} as ReasoningBlock)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("BlockServer — events", () => {
  let store: BlockStore;

  beforeEach(() => { store = makeStore(); });

  it("emits one retrieval event per recall", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    server.recall({ text: "metaclass inspect" });
    const evs = store.readEvents({ eventType: "retrieval" });
    expect(evs.length).toBe(1);
    expect(evs[0].event).toBe("retrieval");
  });

  it("emits an injection event per hit above gate", () => {
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const server = new BlockServer(store);
    server.recall({ text: "missing stale" });
    const evs = store.readEvents({ eventType: "injection" });
    expect(evs.length).toBeGreaterThan(0);
    for (const ev of evs) {
      expect(ev.event).toBe("injection");
    }
  });

  it("shadow query emits retrieval with shadow=true but no injection events", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    server.recall({ text: "metaclass inspect", shadow: true });
    const retrievals = store.readEvents({ eventType: "retrieval" });
    expect(retrievals.length).toBe(1);
    const r = retrievals[0];
    if (r.event === "retrieval") expect(r.shadow).toBe(true);
    const injections = store.readEvents({ eventType: "injection" });
    expect(injections.length).toBe(0);
  });

  it("emitEvents=false suppresses events", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { emitEvents: false });
    server.recall({ text: "metaclass inspect" });
    expect(store.countEvents()).toBe(0);
  });

  it("runId is recorded on events when supplied", () => {
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store);
    server.recall({ text: "metaclass inspect", runId: "bench-1" });
    const byRun = store.readEvents({ runId: "bench-1" });
    expect(byRun.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Facts retrieval
// ---------------------------------------------------------------------------

describe("BlockServer — facts retrieval", () => {
  it("returns scoped facts alongside blocks", () => {
    const store = makeStore();
    const server = new BlockServer(store);

    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "repo:myorg/app",
      factType: "convention",
      statement: "metaclass tests live under tests/meta/",
      invariants: { language: "python" },
      source: { origin: "declared", author: "alice" },
    });
    store.storeFact({
      scope: "repo:other",
      factType: "convention",
      statement: "unrelated fact in another scope",
      invariants: {},
      source: { origin: "declared" },
    });

    const out = server.recall({
      text: "metaclass",
      scope: "repo:myorg/app",
      invariants: { language: "python" },
    });
    // The scoped matching fact appears.
    expect(out.facts.some((f) => f.fact.scope === "repo:myorg/app")).toBe(true);
    // The other-scope fact is filtered out.
    expect(out.facts.some((f) => f.fact.scope === "repo:other")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Injection formatter
// ---------------------------------------------------------------------------

describe("formatInjection", () => {
  it("returns empty string on empty result", () => {
    const out = formatInjection({
      queryId: "q", shadow: false, blocks: [], facts: [], shouldInject: false,
    });
    expect(out).toBe("");
  });

  it("markdown framing is declarative-hypothesis, not imperative", () => {
    const store = makeStore();
    const b = storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { emitEvents: false });
    const out = server.recall({ text: "metaclass inspect" });
    const md = formatInjection(out);
    // Contains hypothesis framing.
    expect(md.toLowerCase()).toContain("hypothes");
    // Does not contain imperative stock phrases like "do this" or "apply this fix".
    expect(md.toLowerCase()).not.toMatch(/\bdo this\b|\bapply this fix\b|\byou must\b/);
    // Audit line present.
    expect(md).toContain(b.id);
  });

  it("xml format emits <hypothesis> tags", () => {
    const store = makeStore();
    storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { emitEvents: false });
    const out = server.recall({ text: "metaclass inspect" });
    const xml = formatInjection(out, { format: "xml" });
    expect(xml).toContain("<prior_reasoning>");
    expect(xml).toContain("<hypothesis ");
    expect(xml).toContain("</hypothesis>");
  });

  it("includeAudit=false hides block ids", () => {
    const store = makeStore();
    const b = storeActive(store, PY_BLOCK);
    const server = new BlockServer(store, { emitEvents: false });
    const out = server.recall({ text: "metaclass inspect" });
    const md = formatInjection(out, { includeAudit: false });
    expect(md).not.toContain(b.id);
  });

  it("includeFacts=false omits facts section", () => {
    const store = makeStore();
    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "global",
      factType: "preference",
      statement: "favor small PRs",
      invariants: {},
      source: { origin: "declared" },
    });
    const server = new BlockServer(store, { emitEvents: false });
    const out = server.recall({ text: "metaclass inspect" });
    const md = formatInjection(out, { includeFacts: false });
    expect(md).not.toContain("favor small PRs");
  });
});

// ---------------------------------------------------------------------------
// Gate / payload contract — prompt content must equal injection events.
// ---------------------------------------------------------------------------

describe("Gate/payload contract — passesGate drives both formatter and events", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("formatInjection renders only facts whose calibratedProb clears the gate", () => {
    storeActive(store, PY_BLOCK);
    // Two facts sharing tokens with the query; one high conf, one low.
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "metaclass inspect high-conf unique-fact-hi",
      invariants: {},
      source: { origin: "declared" },
      confidence: 0.9,
    });
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "metaclass inspect low-conf unique-fact-lo",
      invariants: {},
      source: { origin: "declared" },
      confidence: 0.1,
    });
    const server = new BlockServer(store, { gateThreshold: 0.8 });
    const out = server.recall({ text: "metaclass inspect" });

    // Both facts come back in the result for debugging …
    expect(out.facts.length).toBe(2);
    const hi = out.facts.find((f) => f.calibratedProb >= 0.8)!;
    const lo = out.facts.find((f) => f.calibratedProb < 0.8)!;
    expect(hi.passesGate).toBe(true);
    expect(lo.passesGate).toBe(false);

    // … but only the above-gate fact appears in the rendered prompt.
    const md = formatInjection(out);
    expect(md).toContain("unique-fact-hi");
    expect(md).not.toContain("unique-fact-lo");
  });

  it("one-to-one correspondence: fact_injection events === rendered facts", () => {
    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "global", factType: "convention",
      statement: "metaclass inspect token-hi one",
      invariants: {}, source: { origin: "declared" }, confidence: 0.9,
    });
    store.storeFact({
      scope: "global", factType: "convention",
      statement: "metaclass inspect token-lo two",
      invariants: {}, source: { origin: "declared" }, confidence: 0.2,
    });
    const server = new BlockServer(store, { gateThreshold: 0.5 });
    const out = server.recall({ text: "metaclass inspect" });
    const md = formatInjection(out);

    const factEvents = store.readEvents({ eventType: "fact_injection" });
    expect(factEvents.length).toBe(1);
    // The one emitted event is for the fact that ALSO appears in the prompt.
    const emittedId = (factEvents[0] as { factId: string }).factId;
    const renderedFact = out.facts.find((f) => f.passesGate)!;
    expect(emittedId).toBe(renderedFact.fact.id);
    expect(md).toContain(renderedFact.fact.statement);
  });

  it("formatInjection returns empty string on shadow queries even with hits", () => {
    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "global", factType: "convention",
      statement: "metaclass inspect shadow-fact anchor",
      invariants: {}, source: { origin: "declared" }, confidence: 0.95,
    });
    const server = new BlockServer(store);
    const out = server.recall({ text: "metaclass inspect", shadow: true });

    // Hits returned for debug view but flagged non-rendering.
    expect(out.blocks.length).toBeGreaterThan(0);
    expect(out.blocks.every((h) => h.passesGate === false)).toBe(true);
    expect(out.facts.every((h) => h.passesGate === false)).toBe(true);
    expect(out.shouldInject).toBe(false);

    // Prompt is empty; no injection events were emitted either.
    expect(formatInjection(out)).toBe("");
    expect(store.readEvents({ eventType: "injection" }).length).toBe(0);
    expect(store.readEvents({ eventType: "fact_injection" }).length).toBe(0);
  });

  it("block injection events match rendered blocks one-to-one under a strict calibrator", () => {
    // Two blocks, only one passes a high gate via a custom calibrator.
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const strict: Calibrator = (_score, b) =>
      b.trigger.invariants.language === "python" ? 0.95 : 0.1;
    const server = new BlockServer(store, { calibrator: strict, gateThreshold: 0.5 });
    const out = server.recall({ text: "metaclass inspect useEffect stale" });

    const renderedCount = out.blocks.filter((h) => h.passesGate).length;
    const events = store.readEvents({ eventType: "injection" });
    expect(renderedCount).toBe(events.length);

    const md = formatInjection(out);
    for (const h of out.blocks) {
      if (h.passesGate) {
        expect(md).toContain(h.block.trigger.situation);
      } else {
        expect(md).not.toContain(h.block.trigger.situation);
      }
    }
  });

  it("xml formatter also obeys passesGate", () => {
    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "global", factType: "convention",
      statement: "metaclass inspect xml-lo should-not-leak",
      invariants: {}, source: { origin: "declared" }, confidence: 0.1,
    });
    const server = new BlockServer(store, { gateThreshold: 0.8 });
    const out = server.recall({ text: "metaclass inspect" });
    const xml = formatInjection(out, { format: "xml" });
    expect(xml).not.toContain("should-not-leak");
    // Facts section omitted entirely when no fact passes.
    expect(xml).not.toContain("<project_facts>");
  });

  it("when no hit passes the gate, formatter returns empty regardless of candidate count", () => {
    storeActive(store, PY_BLOCK);
    store.storeFact({
      scope: "global", factType: "convention",
      statement: "metaclass inspect nope one",
      invariants: {}, source: { origin: "declared" }, confidence: 0.1,
    });
    const server = new BlockServer(store, {
      calibrator: () => 0.1, // force blocks below gate
      gateThreshold: 0.8,
    });
    const out = server.recall({ text: "metaclass inspect" });
    expect(out.blocks.length).toBeGreaterThan(0);
    expect(out.facts.length).toBeGreaterThan(0);
    expect(out.shouldInject).toBe(false);
    expect(formatInjection(out)).toBe("");
  });
});

// ============================================================================
// May-2026 B1 cascade — cross-encoder reranker + MMR diversity.
// ============================================================================
describe("BlockServer — recallAsync cascade (B1)", () => {
  function makeServerWithReranker(reranker?: Reranker, lambda = 0.7) {
    const store = makeStore();
    // Seed 6 blocks: 3 near-duplicate React blocks + 3 distinct topics.
    const reactDup1: StoreBlockInput = {
      trigger: {
        situation: "react useEffect dependency array missing causes stale state",
        invariants: { language: "typescript", framework: "react" },
      },
      body: {
        mechanism: "closure captures initial state",
        deadEnds: [],
        unlock: "add value to dependency array",
        verification: "state updates reflect across renders",
      },
      provenance: { sourceTaskId: "react-stale-1", extractedFrom: "trajectory", distilledBy: "llm" },
    };
    const reactDup2: StoreBlockInput = {
      ...reactDup1,
      trigger: {
        situation: "react useEffect missing dependency causing stale closure on state",
        invariants: { language: "typescript", framework: "react" },
      },
      provenance: { sourceTaskId: "react-stale-2", extractedFrom: "trajectory", distilledBy: "llm" },
    };
    const reactDup3: StoreBlockInput = {
      ...reactDup1,
      trigger: {
        situation: "react useEffect stale state when dependency array empty array []",
        invariants: { language: "typescript", framework: "react" },
      },
      provenance: { sourceTaskId: "react-stale-3", extractedFrom: "trajectory", distilledBy: "llm" },
    };
    const diverseA: StoreBlockInput = {
      trigger: {
        situation: "python typer command nested subcommand registration import",
        invariants: { language: "python" },
      },
      body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
      provenance: { sourceTaskId: "typer-1", extractedFrom: "trajectory", distilledBy: "llm" },
    };
    const diverseB: StoreBlockInput = {
      trigger: {
        situation: "rust serde untagged enum variant fallback default",
        invariants: { language: "rust" },
      },
      body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
      provenance: { sourceTaskId: "serde-1", extractedFrom: "trajectory", distilledBy: "llm" },
    };
    const diverseC: StoreBlockInput = {
      trigger: {
        situation: "go context deadline exceeded grpc client transport closing",
        invariants: { language: "go" },
      },
      body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
      provenance: { sourceTaskId: "grpc-1", extractedFrom: "trajectory", distilledBy: "llm" },
    };

    storeActive(store, reactDup1);
    storeActive(store, reactDup2);
    storeActive(store, reactDup3);
    storeActive(store, diverseA);
    storeActive(store, diverseB);
    storeActive(store, diverseC);

    return new BlockServer(store, {
      emitEvents: false,
      ...(reranker ? { reranker } : {}),
      mmrLambda: lambda,
      cascadeFetchMultiplier: 4,
    });
  }

  it("recallAsync returns same shape as recall (default NoopReranker, λ=1.0)", async () => {
    const store = makeStore();
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const server = new BlockServer(store, { emitEvents: false, mmrLambda: 1.0 });
    const out = await server.recallAsync({ text: "metaclass inspect iterates" });
    expect(out.queryId).toBeDefined();
    expect(out.blocks.length).toBeGreaterThan(0);
    expect(out.shouldInject).toBeDefined();
  });

  it("MMR vs pure-relevance produces a different ordering on near-duplicate pool", async () => {
    // The 3 react duplicates dominate FTS for this query; the diverse
    // blocks score zero and don't enter the candidate pool. That's the
    // realistic case where MMR matters: choosing AMONG near-duplicates
    // in the same topic, not pulling in unrelated topics.
    //
    // λ=1.0 → MMR is a no-op (sort by relevance).
    // λ=0.0 → pure diversity. Greedy picks the most-rel block first,
    //        then the LEAST similar remaining block, etc. The result
    //        order MUST differ from pure relevance unless all three
    //        candidates happen to be equidistant — which they aren't.
    const srvRel = makeServerWithReranker(undefined, 1.0);
    const srvMmr = makeServerWithReranker(undefined, 0.0);
    const query = { text: "react useEffect stale state dependency", limit: 3 };
    const relOut = await srvRel.recallAsync(query);
    const mmrOut = await srvMmr.recallAsync(query);

    // Both should surface all three react blocks; MMR with low λ must
    // produce a different order. This is the direct cascade-affecting-
    // ordering check, not the "diversity wins over relevance" check
    // which only holds when alternative topics enter the pool.
    expect(relOut.blocks.length).toBe(3);
    expect(mmrOut.blocks.length).toBe(3);
    const relOrder = relOut.blocks.map((h) => h.block.id).join("|");
    const mmrOrder = mmrOut.blocks.map((h) => h.block.id).join("|");
    expect(mmrOrder).not.toBe(relOrder);
  });

  it("custom reranker reorders the top-K by its scores", async () => {
    // Reranker that strongly prefers the second candidate, regardless
    // of upstream BM25 score.
    const reranker: Reranker = {
      name: "test-reranker",
      async score(_q, cands) {
        // Boost any candidate whose triggerText mentions "rust"
        return cands.map((c: RerankerCandidate) =>
          /\brust\b/i.test(c.triggerText) ? 0.99 : 0.01,
        );
      },
    };
    const server = makeServerWithReranker(reranker, 1.0); // disable MMR to isolate rerank effect
    const out = await server.recallAsync({
      text: "fallback variant for serialization",
      limit: 3,
    });
    expect(out.blocks.length).toBeGreaterThan(0);
    // The rust block (serde) should now be first thanks to the reranker.
    expect(out.blocks[0]!.block.trigger.invariants.language).toBe("rust");
  });

  it("reranker timeout falls back to pre-rerank order — recall still succeeds", async () => {
    const slowReranker: Reranker = {
      name: "slow-reranker",
      async score(_q, cands) {
        // Far longer than the 50ms timeout below.
        await new Promise((r) => setTimeout(r, 200));
        return cands.map(() => 0.5);
      },
    };
    const store = makeStore();
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const server = new BlockServer(store, {
      emitEvents: false,
      reranker: slowReranker,
      rerankerTimeoutMs: 50,
      mmrLambda: 1.0,
    });
    const start = Date.now();
    const out = await server.recallAsync({ text: "metaclass inspect" });
    const elapsed = Date.now() - start;
    expect(out.blocks.length).toBeGreaterThan(0);
    // Must respect the timeout budget (with generous slack for slow CI).
    expect(elapsed).toBeLessThan(180);
  });

  it("reranker that throws is contained — recall path never propagates the error", async () => {
    const brokenReranker: Reranker = {
      name: "broken",
      async score() {
        throw new Error("model session crashed");
      },
    };
    const store = makeStore();
    storeActive(store, PY_BLOCK);
    storeActive(store, TS_BLOCK);
    const server = new BlockServer(store, {
      emitEvents: false,
      reranker: brokenReranker,
      mmrLambda: 1.0,
    });
    const out = await server.recallAsync({ text: "metaclass inspect" });
    expect(out.blocks.length).toBeGreaterThan(0);
  });

  // ---------- B1.1 hardening regressions ----------

  it("B1.1 P1 #1: MMR uses rerankerScore as relevance, NOT pre-rerank BM25", async () => {
    // Pre-hardening: MMR fell back to BM25 score for relevance, so a
    // cross-encoder that flipped the ranking was overruled by MMR.
    // Now MMR uses rerankerScore when present.
    //
    // Setup: two blocks. BM25 ranks A above B (because the query
    // matches A's trigger more heavily). The reranker inverts that —
    // it scores B much higher. With λ=1.0 (relevance-only MMR), the
    // final order MUST be [B, A] because rerankerScore dominates.
    const store = makeStore();
    const blockA: StoreBlockInput = {
      trigger: {
        situation: "alpha bravo charlie delta echo foxtrot",
        invariants: {},
      },
      body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
      provenance: { sourceTaskId: "a-task", extractedFrom: "trajectory", distilledBy: "llm" },
    };
    const blockB: StoreBlockInput = {
      trigger: {
        situation: "alpha bravo",
        invariants: {},
      },
      body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
      provenance: { sourceTaskId: "b-task", extractedFrom: "trajectory", distilledBy: "llm" },
    };
    const a = storeActive(store, blockA);
    const b = storeActive(store, blockB);

    const inverter: Reranker = {
      name: "inverter",
      async score(_q, cands) {
        // Score B high, A low — exactly the opposite of BM25.
        return cands.map((c) => (c.blockId === b.id ? 0.99 : 0.01));
      },
    };
    const server = new BlockServer(store, {
      emitEvents: false,
      reranker: inverter,
      mmrLambda: 1.0,
    });
    const out = await server.recallAsync({
      text: "alpha bravo charlie delta",
      limit: 2,
    });
    expect(out.blocks.length).toBe(2);
    expect(out.blocks[0]!.block.id).toBe(b.id);
    expect(out.blocks[1]!.block.id).toBe(a.id);
    // BlockHit carries the reranker score for telemetry.
    expect(out.blocks[0]!.rerankerScore).toBeCloseTo(0.99, 5);
    expect(out.blocks[0]!.rerankerRank).toBe(1);
    expect(out.blocks[1]!.rerankerScore).toBeCloseTo(0.01, 5);
    expect(out.blocks[1]!.rerankerRank).toBe(2);
  });

  it("B1.1 P2 #2: retrieval event carries pre-cascade slate + cascade telemetry", async () => {
    const store = makeStore();
    // Need at least 3 distinct stored blocks so the slate is non-trivial.
    storeActive(store, {
      trigger: { situation: "ruby rails activerecord callback after_commit", invariants: {} },
      body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
      provenance: { sourceTaskId: "rb-1", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    storeActive(store, {
      trigger: { situation: "ruby rails activerecord transaction nested savepoint", invariants: {} },
      body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
      provenance: { sourceTaskId: "rb-2", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    storeActive(store, {
      trigger: { situation: "ruby rails activerecord scope chaining merge override", invariants: {} },
      body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
      provenance: { sourceTaskId: "rb-3", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    const reranker: Reranker = {
      name: "test-cloud",
      async score(_q, cands) { return cands.map(() => 0.5); },
    };
    const events: import("../../src/types.js").RetrievalEvent[] = [];
    const server = new BlockServer(store, {
      reranker,
      mmrLambda: 0.7,
      cascadeFetchMultiplier: 4,
      sideSink: (ev) => {
        if (ev.event === "retrieval") events.push(ev);
      },
    });
    const out = await server.recallAsync({
      text: "ruby rails activerecord",
      limit: 2,
    });
    expect(out.blocks.length).toBeGreaterThan(0);
    expect(events.length).toBe(1);
    const ev = events[0]!;

    // Cascade telemetry stamped.
    expect(ev.rerankerName).toBe("test-cloud");
    expect(ev.rerankerFellBack).toBe(false);
    expect(ev.mmrLambda).toBe(0.7);
    expect(ev.cascadePolicyId).toBe("linear+rerank+mmr.v1");

    // Pre-cascade slate present and STRICTLY LARGER than the top-K
    // — that's the whole point: B3 replay needs every counter-factual.
    expect(ev.preCascadeSlate).toBeDefined();
    expect(ev.preCascadeSlate!.length).toBeGreaterThan(ev.candidates.length);

    // Each candidate carries the reranker score it earned.
    for (const c of ev.candidates) {
      expect(c.rerankerScore).toBeCloseTo(0.5, 6);
      expect(c.rerankerRank).toBeGreaterThanOrEqual(1);
    }
  });

  it("B1.1 P1 #2 telemetry: retrieval event records reranker fallback reason on timeout", async () => {
    const slowReranker: Reranker = {
      name: "slow",
      async score(_q, _c, opts) {
        return await new Promise<number[] | null>((resolve) => {
          const t = setTimeout(() => resolve(_c.map(() => 0.5)), 500);
          opts?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            resolve(null);
          });
        });
      },
    };
    // The cascade short-circuits with ≤1 candidate (no work for a
    // reranker), so seed enough overlapping blocks that FTS returns
    // multiple candidates for the test query.
    const store = makeStore();
    for (const marker of ["alpha", "bravo", "charlie", "delta"]) {
      storeActive(store, {
        trigger: { situation: `timeout regression marker ${marker} foo bar baz`, invariants: {} },
        body: { mechanism: "x", deadEnds: [], unlock: "y", verification: "z" },
        provenance: { sourceTaskId: `t-${marker}`, extractedFrom: "trajectory", distilledBy: "llm" },
      });
    }
    const events: import("../../src/types.js").RetrievalEvent[] = [];
    const server = new BlockServer(store, {
      reranker: slowReranker,
      rerankerTimeoutMs: 50,
      mmrLambda: 1.0,
      sideSink: (ev) => {
        if (ev.event === "retrieval") events.push(ev);
      },
    });
    await server.recallAsync({ text: "timeout regression marker foo bar baz" });
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.rerankerFellBack).toBe(true);
    expect(ev.rerankerFallbackReason).toBe("timeout");
    // No rerankerScore stamped on candidates when we fell back.
    for (const c of ev.candidates) {
      expect(c.rerankerScore).toBeUndefined();
    }
  });
});
