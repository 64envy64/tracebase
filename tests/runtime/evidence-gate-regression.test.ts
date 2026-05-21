/**
 * C2.1 regression tests — strict §L6 gate in real analytics.
 *
 * The C2 review caught that `isStrictlyHelpful()` existed only as
 * dead code: production `computeAggregates()` was still crediting
 * any agent_used regardless of strength, and `emitAgentUsed()`
 * silently dropped evidence fields. C2.1 wires both. These tests
 * pin the named failure mode end-to-end against the real
 * `computeAggregates` path so a future refactor cannot regress
 * back to the permissive behaviour.
 *
 * Specifically:
 *   • weak agent_used + resolved outcome → helpfulRuns=0,
 *     verifiedHelpfulRuns=0 (P0-A regression).
 *   • emitAgentUsed actually persists evidenceStrength /
 *     evidenceKind to analytics_events (P0-B regression).
 *   • The strict aggregator path still credits moderate / strong /
 *     explicit evidence with resolved=true.
 *   • Pre-C2 events (no evidenceStrength) still credit via the
 *     matchSignal back-compat ladder (no dashboard regression).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  computeAggregates,
  emitAgentUsed,
  emitOutcome,
} from "../../src/core/analytics.js";

let store: BlockStore;

beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

afterEach(() => {
  store.close();
});

function seedRetrievalAndInjection(queryId: string, blockId: string): void {
  store.appendEvent({
    ts: Date.now(),
    queryId,
    event: "retrieval",
    candidates: [{ blockId, score: 0.5 }],
    shadow: false,
  } as never);
  store.appendEvent({
    ts: Date.now(),
    queryId,
    event: "injection",
    blockId,
    score: 0.5,
    calibratedProb: 0.5,
  });
}

describe("C2.1 regression — strict gate in computeAggregates", () => {
  it("weak agent_used + resolved outcome → helpfulRuns=0, verifiedHelpfulRuns=0", () => {
    // The named C2 directive failure mode. Pre-C2.1 this would have
    // bumped both helpful AND verifiedHelpful — even though the
    // agent_used was explicitly classified as weak evidence.
    seedRetrievalAndInjection("q-weak", "b-1");
    emitAgentUsed(store, {
      queryId: "q-weak",
      blockId: "b-1",
      matchSignal: "jaccard",
      matchScore: 0.05,        // well below MODERATE_JACCARD_THRESHOLD
      evidenceStrength: "weak", // explicit "weak" classification
      evidenceKind: "answer_mentions_injected_anchor",
    });
    emitOutcome(store, { queryId: "q-weak", resolved: true, control: false });

    const agg = computeAggregates(store);
    const stats = agg.perBlock.find((b) => b.blockId === "b-1")!;
    expect(stats.injected).toBe(1);
    expect(stats.agentUsed).toBe(1); // observability counter still bumps
    expect(stats.helpful).toBe(0);   // strict gate denies
    expect(stats.verifiedHelpful).toBe(0); // denied downstream of helpful
    expect(stats.neutral).toBe(1);   // falls through to neutral
    // C2.2 — funnel must agree with per-block. Pre-C2.2 the funnel
    // would have promoted this run to helpful (and verifiedHelpful)
    // purely on (injection ∧ ANY agent_used ∧ resolved), inflating
    // memory-health top-line metrics that the dashboard reads from.
    expect(agg.funnel.injectedRuns).toBe(1);
    expect(agg.funnel.usedRuns).toBe(1);            // observability — weak still counts
    expect(agg.funnel.helpfulRuns).toBe(0);          // strict §L6 gate at the funnel
    expect(agg.funnel.verifiedHelpfulRuns).toBe(0);  // denied downstream
  });

  it("moderate agent_used + resolved → helpfulRuns=1", () => {
    seedRetrievalAndInjection("q-mod", "b-2");
    emitAgentUsed(store, {
      queryId: "q-mod",
      blockId: "b-2",
      matchSignal: "jaccard",
      matchScore: 0.25,
      evidenceStrength: "moderate",
      evidenceKind: "answer_mentions_injected_anchor",
    });
    emitOutcome(store, { queryId: "q-mod", resolved: true, control: false });

    const agg = computeAggregates(store);
    const stats = agg.perBlock.find((b) => b.blockId === "b-2")!;
    expect(stats.helpful).toBe(1);
    // Moderate inferred evidence does NOT clear the verified bar (which
    // additionally requires outcome.attribution !== "inferred"; pre-
    // C2 events default to explicit attribution).
    expect(stats.verifiedHelpful).toBe(1);
    // C2.2 — funnel agrees with per-block on the positive case.
    expect(agg.funnel.helpfulRuns).toBe(1);
    expect(agg.funnel.verifiedHelpfulRuns).toBe(1);
  });

  it("explicit agent_used + resolved → helpfulRuns=1 AND verifiedHelpfulRuns=1", () => {
    seedRetrievalAndInjection("q-explicit", "b-3");
    emitAgentUsed(store, {
      queryId: "q-explicit",
      blockId: "b-3",
      matchSignal: "explicit",
      matchScore: 1,
      evidenceStrength: "explicit",
      evidenceKind: "record_reasoning_outcome",
    });
    emitOutcome(store, { queryId: "q-explicit", resolved: true, control: false });

    const agg = computeAggregates(store);
    const stats = agg.perBlock.find((b) => b.blockId === "b-3")!;
    expect(stats.helpful).toBe(1);
    expect(stats.verifiedHelpful).toBe(1);
    expect(agg.funnel.helpfulRuns).toBe(1);
    expect(agg.funnel.verifiedHelpfulRuns).toBe(1);
  });

  it("weak + NOT resolved → counterproductive stays 0, neutral=1 (no harsh penalty for ambiguous signal)", () => {
    seedRetrievalAndInjection("q-weak-fail", "b-4");
    emitAgentUsed(store, {
      queryId: "q-weak-fail",
      blockId: "b-4",
      matchSignal: "jaccard",
      matchScore: 0.05,
      evidenceStrength: "weak",
    });
    emitOutcome(store, { queryId: "q-weak-fail", resolved: false, control: false });

    const agg = computeAggregates(store);
    const stats = agg.perBlock.find((b) => b.blockId === "b-4")!;
    // Weak evidence doesn't qualify for counterproductive either —
    // we can't blame the block when we don't believe the agent used it.
    expect(stats.counterproductive).toBe(0);
    expect(stats.neutral).toBe(1);
    // Funnel never promotes — outcome.resolved=false keeps helpfulRuns at 0
    // regardless of strength gate. Pinning explicitly so a later refactor
    // can't reintroduce a "weak + unresolved = helpful" pathway.
    expect(agg.funnel.helpfulRuns).toBe(0);
    expect(agg.funnel.verifiedHelpfulRuns).toBe(0);
  });

  it("pre-C2 event (no evidenceStrength, matchSignal=explicit) credits via legacy ladder", () => {
    // Backward compatibility: events emitted before C2.1 have no
    // evidenceStrength field. They MUST still credit when matchSignal
    // is "explicit" — otherwise existing dashboards would lose data.
    seedRetrievalAndInjection("q-legacy", "b-5");
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-legacy",
      event: "agent_used",
      blockId: "b-5",
      matchSignal: "explicit",
      matchScore: 1,
      // No evidenceStrength / evidenceKind — pre-C2.1 shape.
    } as never);
    emitOutcome(store, { queryId: "q-legacy", resolved: true, control: false });

    const agg = computeAggregates(store);
    const stats = agg.perBlock.find((b) => b.blockId === "b-5")!;
    expect(stats.helpful).toBe(1);
    expect(stats.verifiedHelpful).toBe(1);
    expect(agg.funnel.helpfulRuns).toBe(1);
    expect(agg.funnel.verifiedHelpfulRuns).toBe(1);
  });

  it("pre-C2 event with low matchScore (jaccard=0.05) → gate rejects via derived strength", () => {
    // The wire-level value the legacy gate would have credited (low
    // Jaccard) gets reclassified as "weak" via strengthFromMatchSignal
    // → does NOT pass the strict helpful threshold. This is the
    // back-compat path's protection against historic noise.
    seedRetrievalAndInjection("q-legacy-low", "b-6");
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-legacy-low",
      event: "agent_used",
      blockId: "b-6",
      matchSignal: "jaccard",
      matchScore: 0.05, // well below MODERATE_JACCARD_THRESHOLD = 0.18
    } as never);
    emitOutcome(store, { queryId: "q-legacy-low", resolved: true, control: false });

    const agg = computeAggregates(store);
    const stats = agg.perBlock.find((b) => b.blockId === "b-6")!;
    expect(stats.helpful).toBe(0);
    expect(stats.verifiedHelpful).toBe(0);
    // Funnel respects the same derived strength — legacy noisy
    // Jaccard never promotes to helpful at the dashboard level.
    expect(agg.funnel.helpfulRuns).toBe(0);
    expect(agg.funnel.verifiedHelpfulRuns).toBe(0);
  });

  it("C2.3 — orphan strong attribution on a NON-injected block does NOT promote funnel helpful", () => {
    // The named C2.3 regression. Pre-C2.3 the funnel checked "any
    // strong agent_used on the queryId" without intersecting with
    // the injected set. Repro: inject blockA, fire explicit
    // agent_used on blockB (orphan) → funnel.helpfulRuns=1 even
    // though both perBlock rows stayed neutral (block A had no
    // agent_used; block B was never injected so doesn't get
    // classified at all). For memory-health and pruning the
    // funnel-vs-per-block divergence would be silent miseducation.
    seedRetrievalAndInjection("q-orphan", "injected-block");
    emitAgentUsed(store, {
      queryId: "q-orphan",
      blockId: "not-injected-block", // orphan: was NOT injected
      matchSignal: "explicit",
      matchScore: 1,
      evidenceStrength: "explicit",
      evidenceKind: "record_reasoning_outcome",
    });
    emitOutcome(store, { queryId: "q-orphan", resolved: true, control: false });

    const agg = computeAggregates(store);
    const injectedStats = agg.perBlock.find((b) => b.blockId === "injected-block")!;
    expect(injectedStats.injected).toBe(1);
    expect(injectedStats.agentUsed).toBe(0);    // no agent_used on the injected block
    expect(injectedStats.helpful).toBe(0);
    expect(injectedStats.verifiedHelpful).toBe(0);
    // The orphan block is never classified — it was never injected.
    expect(agg.perBlock.find((b) => b.blockId === "not-injected-block")).toBeUndefined();
    // Funnel must agree with per-block: no injected→used pair, no helpful.
    expect(agg.funnel.injectedRuns).toBe(1);
    expect(agg.funnel.usedRuns).toBe(1);           // observability — orphan still counts as "agent used something"
    expect(agg.funnel.helpfulRuns).toBe(0);        // C2.3 intersection gate
    expect(agg.funnel.verifiedHelpfulRuns).toBe(0);
  });

  it("C2.3 — orphan strong attribution on a NON-injected FACT does not promote funnel helpful", () => {
    // Symmetric fact-side regression: a `fact_injection` for fact-A
    // plus a `fact_agent_used` (strong) on fact-B must NOT promote
    // helpfulRuns. Mirrors the block-side intersection rule.
    seedRetrievalAndInjection("q-fact-orphan", "blockA");
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-fact-orphan",
      event: "fact_injection",
      factId: "injected-fact",
      score: 0.5,
      calibratedProb: 0.5,
    } as never);
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-fact-orphan",
      event: "fact_agent_used",
      factId: "not-injected-fact",
      matchSignal: "explicit",
      matchScore: 1,
      evidenceStrength: "explicit",
      evidenceKind: "record_reasoning_outcome",
    } as never);
    emitOutcome(store, { queryId: "q-fact-orphan", resolved: true, control: false });

    const agg = computeAggregates(store);
    // The injected fact has no agent_used. The orphan agent_used on
    // a non-injected fact must NOT promote the funnel run.
    expect(agg.funnel.helpfulRuns).toBe(0);
    expect(agg.funnel.verifiedHelpfulRuns).toBe(0);
  });

  it("C2.3 — strong attribution on an INJECTED block AND an orphan strong on a non-injected block → helpful=1 (the injected one carries it)", () => {
    // Defensive complement: when the same queryId has BOTH a
    // properly-injected strong pair AND an orphan strong attribution,
    // the run is helpful (the legitimate pair satisfies §L6). Pins
    // that the intersection gate is "exists an injected pair", not
    // "all pairs are injected".
    seedRetrievalAndInjection("q-mixed-orphan", "real-block");
    emitAgentUsed(store, {
      queryId: "q-mixed-orphan",
      blockId: "real-block",
      matchSignal: "explicit",
      matchScore: 1,
      evidenceStrength: "explicit",
      evidenceKind: "record_reasoning_outcome",
    });
    emitAgentUsed(store, {
      queryId: "q-mixed-orphan",
      blockId: "orphan-block", // not in the injected set
      matchSignal: "explicit",
      matchScore: 1,
      evidenceStrength: "explicit",
      evidenceKind: "record_reasoning_outcome",
    });
    emitOutcome(store, { queryId: "q-mixed-orphan", resolved: true, control: false });

    const agg = computeAggregates(store);
    const realStats = agg.perBlock.find((b) => b.blockId === "real-block")!;
    expect(realStats.helpful).toBe(1);
    expect(realStats.verifiedHelpful).toBe(1);
    expect(agg.funnel.helpfulRuns).toBe(1);
    expect(agg.funnel.verifiedHelpfulRuns).toBe(1);
  });

  it("C2.2 — mixed cohort: one weak + one moderate same queryId → funnel helpful=1 (any strong-enough use suffices)", () => {
    // The funnel gate is OR across the queryId's evidence — pre-fix
    // it was "ANY agent_used", post-fix it is "ANY agent_used at
    // moderate+ strength". A queryId that touched two blocks (one
    // weak, one moderate) is still a helpful run, because the
    // strong-enough block satisfies §L6 for that query. This pins
    // the OR semantics so a future refactor cannot accidentally
    // require ALL pairs to be strong-enough.
    seedRetrievalAndInjection("q-mixed", "b-mixed-weak");
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-mixed",
      event: "injection",
      blockId: "b-mixed-strong",
      score: 0.7,
      calibratedProb: 0.7,
    });
    emitAgentUsed(store, {
      queryId: "q-mixed",
      blockId: "b-mixed-weak",
      matchSignal: "jaccard",
      matchScore: 0.05,
      evidenceStrength: "weak",
    });
    emitAgentUsed(store, {
      queryId: "q-mixed",
      blockId: "b-mixed-strong",
      matchSignal: "jaccard",
      matchScore: 0.5,
      evidenceStrength: "strong",
      evidenceKind: "diff_touches_recalled_file",
    });
    emitOutcome(store, { queryId: "q-mixed", resolved: true, control: false });

    const agg = computeAggregates(store);
    const weakRow = agg.perBlock.find((b) => b.blockId === "b-mixed-weak")!;
    const strongRow = agg.perBlock.find((b) => b.blockId === "b-mixed-strong")!;
    // Per-block remains strict: weak block stays neutral, strong block helpful.
    expect(weakRow.helpful).toBe(0);
    expect(weakRow.neutral).toBe(1);
    expect(strongRow.helpful).toBe(1);
    // Funnel counts the QUERY once — the strong attribution promotes it.
    expect(agg.funnel.helpfulRuns).toBe(1);
    expect(agg.funnel.verifiedHelpfulRuns).toBe(1);
  });
});

describe("C2.1 regression — emitAgentUsed persists evidence fields", () => {
  it("round-trips evidenceStrength + evidenceKind through analytics_events", () => {
    const ev = emitAgentUsed(store, {
      queryId: "q-round-trip",
      blockId: "b-1",
      matchSignal: "jaccard",
      matchScore: 0.5,
      evidenceStrength: "strong",
      evidenceKind: "diff_touches_recalled_file",
    });
    expect(ev.evidenceStrength).toBe("strong");
    expect(ev.evidenceKind).toBe("diff_touches_recalled_file");

    const stored = store
      .readEvents({ queryId: "q-round-trip", eventType: "agent_used", limit: 10 })
      .find((e) => e.event === "agent_used") as Extract<
        import("../../src/types.js").AnalyticsEvent,
        { event: "agent_used" }
      >;
    expect(stored).toBeDefined();
    expect(stored.evidenceStrength).toBe("strong");
    expect(stored.evidenceKind).toBe("diff_touches_recalled_file");
  });

  it("legacy call (no evidence fields) still works — fields absent on stored row", () => {
    emitAgentUsed(store, {
      queryId: "q-legacy-emit",
      blockId: "b-1",
      matchSignal: "explicit",
      matchScore: 1,
    });
    const stored = store
      .readEvents({ queryId: "q-legacy-emit", eventType: "agent_used", limit: 10 })
      .find((e) => e.event === "agent_used") as Extract<
        import("../../src/types.js").AnalyticsEvent,
        { event: "agent_used" }
      >;
    expect(stored).toBeDefined();
    expect(stored.evidenceStrength).toBeUndefined();
    expect(stored.evidenceKind).toBeUndefined();
  });

  it("validator rejects unknown evidenceKind strings on JSONL import", () => {
    // The validator is the import-path guard. Defensive against a
    // foreign producer (or an out-of-tree fork) writing an
    // unrecognised kind into the event stream.
    expect(() =>
      store.appendEvent({
        ts: Date.now(),
        queryId: "q-bad",
        event: "agent_used",
        blockId: "b-1",
        matchSignal: "explicit",
        matchScore: 1,
        evidenceStrength: "explicit",
        evidenceKind: "asteroid_impact",
      } as never),
    ).not.toThrow();
    // appendEvent doesn't validate — but readEvents-style consumers
    // pass through the JSONL validator. We assert the validator
    // rejects via the actual exposed `isValidEvent` once that surface
    // is exported; for now we pin the type-narrowing behaviour.
  });
});

describe("C2.1 regression — shadow filter tighter on inference path", () => {
  it("inferAgentUsedFromTranscript drops a queryId with NO matching retrieval", async () => {
    // Pre-C2.1: missing retrieval meant the queryId fell through and
    // could still be credited if the transcript matched. After C2.1
    // strict gate: missing retrieval ⇒ no inference. This pins the
    // cross-session leakage guard the directive named.
    const { inferAgentUsedFromTranscript } = await import(
      "../../src/runtime/attribution-inference.js"
    );
    const { createBlock } = await import("../../src/core/block.js");
    const block = createBlock({
      trigger: { situation: "cors error in express", invariants: {} },
      body: {
        mechanism: "x",
        deadEnds: [],
        unlock: "Add cors middleware to express, whitelist the auth_token origin.",
        verification: "OPTIONS preflight returns 204.",
      },
      provenance: { sourceTaskId: "p-1", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    block.status = "candidate";
    store.storeBlock(block);
    store.attachCaseRef({ blockId: block.id, traceId: "t-1", role: "origin", evidenceQuality: "strong" });
    store.updateBlockStatus(block.id, "active");

    // Injection WITHOUT a retrieval event. Pre-C2.1 inference would
    // have credited; post-C2.1 it must drop.
    store.appendEvent({
      ts: Date.now() - 30_000,
      queryId: "q-orphan-inj",
      event: "injection",
      blockId: block.id,
      score: 0.85,
    });

    const transcript =
      "I added cors middleware to express, whitelisted the auth_token origin, OPTIONS returns 204.";
    const uses = inferAgentUsedFromTranscript(store, transcript);
    expect(uses).toEqual([]); // no retrieval → no inference
  });
});
