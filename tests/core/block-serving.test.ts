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
