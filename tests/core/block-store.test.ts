import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlockStore,
  LeakageError,
  BlockIntegrityError,
  expandScopeHierarchy,
  scopeSpecificity,
} from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import type {
  ReasoningBlock,
  StoreBlockInput,
  StoreProjectFactInput,
  AnalyticsEvent,
} from "../../src/types.js";

const SAMPLE: StoreBlockInput = {
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
    mechanism: "property objects are descriptors, not functions",
    deadEnds: ["add property-specific branch", "iterate descriptor internals"],
    unlock: "use inspect.isdatadescriptor to cover both",
    verification: "class with method + property inherits docstrings from parent",
  },
  provenance: {
    sourceTaskId: "astropy__astropy-7166",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

const SAMPLE_B: StoreBlockInput = {
  trigger: {
    situation: "Reading ambiguous header RST with no column widths",
    invariants: {
      language: "python",
      framework: "astropy",
      errorType: "IndexError",
      apiSurface: ["astropy.io.ascii.rst"],
    },
  },
  body: {
    mechanism: "the RST reader falls back to whitespace-delimited mode",
    deadEnds: ["tweak regex for the delimiter line"],
    unlock: "pass header_rows explicitly when constructing the reader",
    verification: "round-trip a small table with explicit header_rows",
  },
  provenance: {
    sourceTaskId: "astropy__astropy-14182",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

function makeStore(): BlockStore {
  const db = new Database(":memory:");
  return new BlockStore(db);
}

// ---------------------------------------------------------------------------
// Block CRUD
// ---------------------------------------------------------------------------

describe("BlockStore — block CRUD", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("stores and retrieves a candidate block", () => {
    const b = createBlock(SAMPLE);
    b.status = "candidate";
    store.storeBlock(b);
    const got = store.getBlock(b.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(b.id);
    expect(got!.status).toBe("candidate");
    expect(got!.trigger.fingerprint).toBe(b.trigger.fingerprint);
    expect(got!.trigger.keywords).toEqual(b.trigger.keywords);
    expect(got!.body.deadEnds).toEqual(b.body.deadEnds);
    expect(got!.trigger.invariants.apiSurface).toEqual(["inspect.isfunction"]);
  });

  it("findBlockByFingerprint returns the block", () => {
    const b = createBlock(SAMPLE);
    b.status = "candidate";
    store.storeBlock(b);
    const got = store.findBlockByFingerprint(b.trigger.fingerprint);
    expect(got?.id).toBe(b.id);
  });

  it("rejects insert as active without origin ref", () => {
    const b = createBlock(SAMPLE);
    // createBlock defaults status to "active"; pre-check at insert time.
    expect(() => store.storeBlock(b)).toThrow(BlockIntegrityError);
  });

  it("rejects duplicate fingerprint on second insert", () => {
    const b1 = createBlock(SAMPLE);
    b1.status = "candidate";
    store.storeBlock(b1);
    const b2 = createBlock(SAMPLE);
    b2.status = "candidate";
    expect(b2.id).not.toBe(b1.id);
    expect(b2.trigger.fingerprint).toBe(b1.trigger.fingerprint);
    expect(() => store.storeBlock(b2)).toThrow(BlockIntegrityError);
  });

  it("rejects block with leaked diff header", () => {
    const b = createBlock({
      ...SAMPLE,
      body: {
        ...SAMPLE.body,
        unlock: "Apply:\n--- a/astropy/utils.py\n+++ b/astropy/utils.py",
      },
    });
    b.status = "candidate";
    expect(() => store.storeBlock(b)).toThrow(LeakageError);
  });

  it("rejects block with pytest id leak", () => {
    const b = createBlock({
      ...SAMPLE,
      body: {
        ...SAMPLE.body,
        verification: "run test_rst.py::test_rst_with_header_rows",
      },
    });
    b.status = "candidate";
    expect(() => store.storeBlock(b)).toThrow(LeakageError);
  });

  it("lists blocks filtered by status", () => {
    const a = createBlock(SAMPLE); a.status = "candidate";
    const b = createBlock(SAMPLE_B); b.status = "candidate";
    store.storeBlock(a);
    store.storeBlock(b);
    expect(store.listBlocks({ status: "candidate" }).length).toBe(2);
    expect(store.listBlocks({ status: "active" }).length).toBe(0);
  });

  it("countBlocks honors optional status filter", () => {
    const a = createBlock(SAMPLE); a.status = "candidate";
    store.storeBlock(a);
    expect(store.countBlocks()).toBe(1);
    expect(store.countBlocks("candidate")).toBe(1);
    expect(store.countBlocks("active")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle + origin-ref invariant
// ---------------------------------------------------------------------------

describe("BlockStore — lifecycle + origin ref invariant", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("cannot promote to active without origin ref", () => {
    const b = createBlock(SAMPLE); b.status = "candidate";
    store.storeBlock(b);
    expect(() => store.updateBlockStatus(b.id, "active"))
      .toThrow(BlockIntegrityError);
  });

  it("promotes to active once origin ref attached", () => {
    const b = createBlock(SAMPLE); b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id,
      traceId: "trace-1",
      role: "origin",
      evidenceQuality: "strong",
    });
    const promoted = store.updateBlockStatus(b.id, "active");
    expect(promoted?.status).toBe("active");
  });

  it("detaching the only origin ref demotes active block to candidate", () => {
    const b = createBlock(SAMPLE); b.status = "candidate";
    store.storeBlock(b);
    const ref = store.attachCaseRef({
      blockId: b.id,
      traceId: "trace-1",
      role: "origin",
      evidenceQuality: "strong",
    });
    store.updateBlockStatus(b.id, "active");
    expect(store.getBlock(b.id)!.status).toBe("active");

    const ok = store.detachCaseRef(ref.id);
    expect(ok).toBe(true);
    expect(store.getBlock(b.id)!.status).toBe("candidate");
  });

  it("detaching a supporting ref does not change block status", () => {
    const b = createBlock(SAMPLE); b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-1", role: "origin", evidenceQuality: "strong",
    });
    const sup = store.attachCaseRef({
      blockId: b.id, traceId: "trace-2", role: "supporting", evidenceQuality: "moderate",
    });
    store.updateBlockStatus(b.id, "active");

    store.detachCaseRef(sup.id);
    expect(store.getBlock(b.id)!.status).toBe("active");
  });

  it("orphanMissingRefs flips refs and demotes active blocks", () => {
    const b = createBlock(SAMPLE); b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-1", role: "origin", evidenceQuality: "strong",
    });
    store.updateBlockStatus(b.id, "active");

    const n = store.orphanMissingRefs(new Set()); // no known traces
    expect(n).toBeGreaterThan(0);
    expect(store.getBlock(b.id)!.status).toBe("candidate");
    expect(store.listCaseRefs(b.id, "orphan").length).toBe(1);
    expect(store.listCaseRefs(b.id, "origin").length).toBe(0);
  });

  it("cascades case refs on block delete", () => {
    const b = createBlock(SAMPLE); b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-1", role: "origin", evidenceQuality: "strong",
    });
    expect(store.listCaseRefs(b.id).length).toBe(1);
    store.deleteBlock(b.id);
    expect(store.listCaseRefs(b.id).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe("BlockStore — merge", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("merges stats and retires loser", () => {
    const winner = createBlock(SAMPLE);
    winner.status = "candidate";
    store.storeBlock(winner);
    // Second block with same trigger but inserted via a different path: we
    // bypass the fingerprint guard by inserting with a mutated fingerprint,
    // then writing back, because the usual guard rejects duplicates.
    // Here we simulate the merge scenario by pre-adjusting the loser's id.
    const loserInput = createBlock(SAMPLE);
    loserInput.status = "candidate";
    // Temporarily mutate the fingerprint to store two rows, then restore.
    const realFp = loserInput.trigger.fingerprint;
    loserInput.trigger.fingerprint = realFp + "-mutant";
    store.storeBlock(loserInput);
    // Patch back the fingerprint directly so the merge precondition holds.
    (store as unknown as { rawDb: Database.Database }).rawDb
      .prepare("UPDATE reasoning_blocks SET trig_fingerprint = ? WHERE id = ?")
      .run(realFp, loserInput.id);

    // Bump some stats on loser to verify they flow to winner.
    const loser = store.getBlock(loserInput.id)!;
    loser.stats.timesRetrieved = 7;
    loser.stats.timesHelpful = 3;
    loser.stats.cumulativeTokensSaved = 1000;
    store.replaceBlock(loser);

    const out = store.mergeBlocks(winner.id, loser.id);
    expect(out.loser.status).toBe("merged");
    expect(out.winner.stats.timesRetrieved).toBe(7);
    expect(out.winner.stats.timesHelpful).toBe(3);
    expect(out.winner.stats.cumulativeTokensSaved).toBe(1000);
  });

  it("rejects merge of blocks with different fingerprints", () => {
    const a = createBlock(SAMPLE); a.status = "candidate"; store.storeBlock(a);
    const b = createBlock(SAMPLE_B); b.status = "candidate"; store.storeBlock(b);
    expect(() => store.mergeBlocks(a.id, b.id)).toThrow(BlockIntegrityError);
  });
});

// ---------------------------------------------------------------------------
// Project facts
// ---------------------------------------------------------------------------

describe("BlockStore — project facts", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  const FACT: StoreProjectFactInput = {
    scope: "repo:myorg/app",
    factType: "schema",
    statement: "users.email is UNIQUE NOT NULL",
    invariants: { language: "sql" },
    source: { origin: "observed", traceId: "trace-x" },
  };

  it("stores and retrieves a fact", () => {
    const f = store.storeFact(FACT);
    expect(f.id).toBeTruthy();
    expect(f.status).toBe("active");
    const got = store.getFact(f.id);
    expect(got?.statement).toBe(FACT.statement);
    expect(got?.invariants.language).toBe("sql");
  });

  it("dedupes by (scope, factType, normalized statement)", () => {
    const a = store.storeFact(FACT);
    const b = store.storeFact({
      ...FACT,
      // Different whitespace / case — should still dedupe.
      statement: "  USERS.EMAIL is unique not null  ",
    });
    expect(b.id).toBe(a.id);
    expect(store.countFacts()).toBe(1);
  });

  it("searchFacts filters by scope + fact type", () => {
    store.storeFact(FACT);
    store.storeFact({
      scope: "repo:myorg/app",
      factType: "preference",
      statement: "favor small PRs",
      invariants: {},
      source: { origin: "declared", author: "alice" },
    });
    const only = store.searchFacts({ scope: "repo:myorg/app", factType: "schema" });
    expect(only.length).toBe(1);
    expect(only[0].factType).toBe("schema");
  });

  it("searchFacts filters by invariant language with fact-null permissive match", () => {
    // Fact with no language invariant should still match any language query.
    store.storeFact({
      scope: "global",
      factType: "preference",
      statement: "use pnpm over npm",
      invariants: {},
      source: { origin: "declared" },
    });
    const out = store.searchFacts({ invariants: { language: "typescript" } });
    expect(out.length).toBe(1);
  });

  it("excludes language-tagged facts of a different language", () => {
    store.storeFact({
      scope: "global",
      factType: "convention",
      statement: "tests go in tests/ not __tests__/",
      invariants: { language: "python" },
      source: { origin: "declared" },
    });
    const out = store.searchFacts({ invariants: { language: "typescript" } });
    expect(out.length).toBe(0);
  });

  it("searchFacts supports full-text", () => {
    store.storeFact(FACT);
    const out = store.searchFacts({ text: "email unique" });
    expect(out.length).toBe(1);
  });

  it("updateFactStatus flips active ↔ stale", () => {
    const f = store.storeFact(FACT);
    const stale = store.updateFactStatus(f.id, "stale");
    expect(stale?.status).toBe("stale");
    // Default search excludes stale.
    expect(store.searchFacts({}).length).toBe(0);
    // Explicit inclusion finds it.
    expect(store.searchFacts({ status: "stale" }).length).toBe(1);
  });

  it("verifyFact bumps confidence and restores active", () => {
    const f = store.storeFact({ ...FACT, confidence: 0.5 });
    store.updateFactStatus(f.id, "stale");
    const v = store.verifyFact(f.id);
    expect(v?.status).toBe("active");
    expect(v!.confidence).toBeGreaterThan(0.5);
  });

  it("rejects fact statement with pytest-id leak", () => {
    expect(() =>
      store.storeFact({
        scope: "repo:x",
        factType: "convention",
        statement: "run test_foo.py::test_bar to verify",
        invariants: {},
        source: { origin: "declared" },
      }),
    ).toThrow(LeakageError);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("BlockStore — analytics events", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("round-trips a retrieval event", () => {
    const ev: AnalyticsEvent = {
      ts: 1000,
      queryId: "q1",
      event: "retrieval",
      candidates: [{ blockId: "b1", score: 0.8 }, { blockId: "b2", score: 0.5 }],
      shadow: false,
    };
    store.appendEvent(ev);
    const back = store.readEvents({});
    expect(back.length).toBe(1);
    expect(back[0]).toEqual(ev);
  });

  it("filters events by type and query id", () => {
    const base: Omit<AnalyticsEvent & { event: "retrieval" }, "event"> = {
      ts: 0, queryId: "", candidates: [], shadow: false,
    };
    store.appendEvent({ ...base, ts: 1, queryId: "q1", event: "retrieval", shadow: false });
    store.appendEvent({ ts: 2, queryId: "q1", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: 3, queryId: "q2", event: "retrieval", candidates: [], shadow: true });

    expect(store.readEvents({ eventType: "retrieval" }).length).toBe(2);
    expect(store.readEvents({ queryId: "q1" }).length).toBe(2);
    expect(store.readEvents({ blockId: "b1" }).length).toBe(1);
  });

  it("filters events by run id", () => {
    store.appendEvent(
      { ts: 1, queryId: "q1", event: "retrieval", candidates: [], shadow: false },
      { runId: "run-A" },
    );
    store.appendEvent(
      { ts: 2, queryId: "q1", event: "retrieval", candidates: [], shadow: false },
      { runId: "run-B" },
    );
    expect(store.readEvents({ runId: "run-A" }).length).toBe(1);
  });

  it("counts events by type", () => {
    store.appendEvent({ ts: 1, queryId: "q", event: "retrieval", candidates: [], shadow: false });
    store.appendEvent({ ts: 2, queryId: "q", event: "outcome", resolved: true, control: false });
    expect(store.countEvents()).toBe(2);
    expect(store.countEvents("retrieval")).toBe(1);
    expect(store.countEvents("outcome")).toBe(1);
  });

  it("preserves strict append order", () => {
    for (let i = 0; i < 5; i++) {
      store.appendEvent({
        ts: i, queryId: `q${i}`, event: "retrieval", candidates: [], shadow: false,
      });
    }
    const back = store.readEvents({});
    const tss = back.map((e) => e.ts);
    expect(tss).toEqual([0, 1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Shared DB coexistence with v1 TraceStore (on the same SQLite file)
// ---------------------------------------------------------------------------

describe("BlockStore — shared DB coexistence with TraceStore", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-shared-"));
    dbPath = join(dir, "shared.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("TraceStore and BlockStore operate on the same file without collision", async () => {
    const { TraceStore } = await import("../../src/core/store.js");
    const { randomUUID } = await import("node:crypto");

    // Open v1 first, then v2 — additive migration path.
    const traceStore = new TraceStore(dbPath);
    const blockStore = new BlockStore(dbPath);

    // Exercise v2.
    const b = createBlock(SAMPLE);
    b.status = "candidate";
    blockStore.storeBlock(b);
    blockStore.attachCaseRef({
      blockId: b.id, traceId: "trace-x", role: "origin", evidenceQuality: "strong",
    });
    blockStore.updateBlockStatus(b.id, "active");

    // Exercise v1.
    const now = Date.now();
    const traceId = randomUUID();
    traceStore.store({
      id: traceId,
      createdAt: now,
      updatedAt: now,
      problem: {
        description: "example python TypeError",
        language: "python",
        tags: [],
        fingerprint: "fp-1",
      },
      solution: { summary: "fix", steps: [], outcome: "success" },
      metadata: { agent: "test" },
      quality: { recallCount: 0, helpfulCount: 0, score: 0.5 },
      provenance: { origin: "local", appliedCount: 0 },
    });

    // Both live in the same file.
    expect(traceStore.count()).toBe(1);
    expect(blockStore.countBlocks()).toBe(1);

    // Round-trip both.
    expect(traceStore.getById(traceId)?.problem.description).toContain("TypeError");
    expect(blockStore.getBlock(b.id)?.status).toBe("active");

    traceStore.close();
    blockStore.close();
  });

  it("allows constructing v2 on a DB that already has v1 tables populated", async () => {
    const { TraceStore } = await import("../../src/core/store.js");
    // Populate v1 first without v2 present.
    const traceStore = new TraceStore(dbPath);
    traceStore.close();

    // Now open v2 on same file. v2 migration must be additive.
    const blockStore = new BlockStore(dbPath);
    expect(blockStore.countBlocks()).toBe(0);
    const b = createBlock(SAMPLE); b.status = "candidate";
    blockStore.storeBlock(b);
    expect(blockStore.countBlocks()).toBe(1);
    blockStore.close();
  });
});

// ---------------------------------------------------------------------------
// Counter-ref lifecycle (design doc §L3)
// ---------------------------------------------------------------------------

describe("BlockStore — counter-ref lifecycle", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  function activeBlock(input = SAMPLE): ReasoningBlock {
    const b = createBlock(input); b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-origin", role: "origin", evidenceQuality: "strong",
    });
    return store.updateBlockStatus(b.id, "active")!;
  }

  it("hasCounterRef reports false for clean block", () => {
    const b = activeBlock();
    expect(store.hasCounterRef(b.id)).toBe(false);
  });

  it("attaching a counter ref to an active block auto-demotes it", () => {
    const b = activeBlock();
    expect(store.getBlock(b.id)!.status).toBe("active");
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-counter", role: "counter", evidenceQuality: "moderate",
    });
    expect(store.getBlock(b.id)!.status).toBe("demoted");
    expect(store.hasCounterRef(b.id)).toBe(true);
  });

  it("updateBlockStatus('active') rejects while counter ref present", () => {
    const b = activeBlock();
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-counter", role: "counter", evidenceQuality: "moderate",
    });
    expect(() => store.updateBlockStatus(b.id, "active")).toThrow(BlockIntegrityError);
  });

  it("storeBlock with status=active rejects when counter ref already exists", () => {
    // Insert as candidate, attach counter, then attempt to insert (replace)
    // a sibling block with status=active on the same id.
    const b = createBlock(SAMPLE); b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-origin", role: "origin", evidenceQuality: "strong",
    });
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-counter", role: "counter", evidenceQuality: "moderate",
    });
    b.status = "active";
    // storeBlock uses INSERT; sibling id will collide — simulate by calling
    // replaceBlock (which uses UPDATE) as the realistic path.
    expect(() => store.replaceBlock(b)).toThrow(BlockIntegrityError);
  });

  it("detaching the counter ref does NOT auto-promote back to active", () => {
    const b = activeBlock();
    const counter = store.attachCaseRef({
      blockId: b.id, traceId: "trace-counter", role: "counter", evidenceQuality: "moderate",
    });
    expect(store.getBlock(b.id)!.status).toBe("demoted");
    store.detachCaseRef(counter.id);
    // Still demoted — resolution is explicit.
    expect(store.getBlock(b.id)!.status).toBe("demoted");
    // But now callers CAN manually re-promote (no counter present).
    store.updateBlockStatus(b.id, "active");
    expect(store.getBlock(b.id)!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Scope hierarchy helpers (design doc §L4)
// ---------------------------------------------------------------------------

describe("BlockStore — scope helpers", () => {
  it("expandScopeHierarchy covers global + dotted + slashed prefixes", () => {
    const out = expandScopeHierarchy("repo:myorg/app.auth.services");
    expect(out).toContain("global");
    expect(out).toContain("repo:myorg/app.auth.services");
    expect(out).toContain("repo:myorg");
    expect(out).toContain("repo:myorg/app");
    expect(out).toContain("repo:myorg/app.auth");
    // Not a separator-bounded prefix:
    expect(out).not.toContain("repo:myor");
  });

  it("expandScopeHierarchy of global / empty returns just global", () => {
    expect(expandScopeHierarchy("")).toEqual(["global"]);
    expect(expandScopeHierarchy("global")).toEqual(["global"]);
  });

  it("scopeSpecificity ranks more-specific higher", () => {
    expect(scopeSpecificity("global")).toBe(0);
    expect(scopeSpecificity("repo:myorg")).toBe(1);
    expect(scopeSpecificity("repo:myorg/app")).toBe(2);
    expect(scopeSpecificity("repo:myorg/app.auth")).toBe(3);
    expect(scopeSpecificity("repo:myorg/app.auth.services")).toBe(4);
  });
});

describe("BlockStore — hierarchical fact retrieval", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("returns facts at all matching ancestor scopes, ordered most-specific first", () => {
    store.storeFact({
      scope: "global",
      factType: "preference",
      statement: "prefer small PRs",
      invariants: {},
      source: { origin: "declared" },
    });
    store.storeFact({
      scope: "repo:myorg",
      factType: "convention",
      statement: "organization tests live under tests/",
      invariants: {},
      source: { origin: "declared" },
    });
    store.storeFact({
      scope: "repo:myorg/app",
      factType: "architecture",
      statement: "app-specific auth lives in services/auth/",
      invariants: {},
      source: { origin: "declared" },
    });
    // An unrelated scope which should NOT match.
    store.storeFact({
      scope: "repo:other",
      factType: "convention",
      statement: "unrelated",
      invariants: {},
      source: { origin: "declared" },
    });

    const out = store.searchFacts({ scope: "repo:myorg/app.auth" });
    const scopes = out.map((f) => f.scope);
    // All three ancestors (incl. global) present, other-scope excluded.
    expect(scopes).toContain("global");
    expect(scopes).toContain("repo:myorg");
    expect(scopes).toContain("repo:myorg/app");
    expect(scopes).not.toContain("repo:other");
    // Ordering: most specific first.
    const indexOf = (s: string) => scopes.indexOf(s);
    expect(indexOf("repo:myorg/app")).toBeLessThan(indexOf("repo:myorg"));
    expect(indexOf("repo:myorg")).toBeLessThan(indexOf("global"));
  });

  it("does NOT match a scope that is only a string prefix but not separator-bounded", () => {
    store.storeFact({
      scope: "repo:myorgOther",
      factType: "convention",
      statement: "should NOT match repo:myorg queries",
      invariants: {},
      source: { origin: "declared" },
    });
    const out = store.searchFacts({ scope: "repo:myorg/app" });
    expect(out.find((f) => f.scope === "repo:myorgOther")).toBeUndefined();
  });

  it("apiSurface intersection filter applies to facts", () => {
    store.storeFact({
      scope: "global",
      factType: "schema",
      statement: "apiSurface-tagged-fact-one",
      invariants: { apiSurface: ["numpy.ndarray.__array_ufunc__"] },
      source: { origin: "declared" },
    });
    store.storeFact({
      scope: "global",
      factType: "schema",
      statement: "apiSurface-tagged-fact-two",
      invariants: { apiSurface: ["react.useEffect"] },
      source: { origin: "declared" },
    });

    const out = store.searchFacts({
      invariants: { apiSurface: ["numpy.ndarray.__array_ufunc__"] },
    });
    // Only the numpy-tagged fact should come back.
    expect(out.length).toBe(1);
    expect(out[0].statement).toContain("one");
  });

  it("facts with empty apiSurface pass through any apiSurface query", () => {
    store.storeFact({
      scope: "global",
      factType: "preference",
      statement: "universal preference",
      invariants: {}, // empty apiSurface
      source: { origin: "declared" },
    });
    const out = store.searchFacts({
      invariants: { apiSurface: ["something.specific"] },
    });
    expect(out.length).toBe(1);
  });
});
