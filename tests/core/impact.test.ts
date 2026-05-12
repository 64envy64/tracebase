/**
 * Impact — value-first translation unit tests.
 *
 * We don't drive these through SQLite + computeAggregates because that
 * would just retest the aggregator. Instead we hand-build the smallest
 * `EventAggregates` payloads that exercise each branch of `computeImpact`:
 *
 *   • empty → isEmpty=true, confidence="empty", all numbers zero
 *   • has events but no shadow arm → confidence="estimated", numbers
 *     come from the conservative cost model
 *   • has shadow arm with negative tokenLift → confidence="measured",
 *     numbers come from the observed lift
 *   • has shadow arm with non-negative tokenLift → tokens saved = 0
 *
 * Anything that's "just plumbing" through aggregates (top-N caps,
 * counterproductive sort) gets one targeted assertion each.
 */
import { describe, it, expect } from "vitest";
import { computeImpact } from "../../src/core/impact.js";
import type { EventAggregates } from "../../src/core/analytics.js";

type AggregateOverrides = Omit<
  Partial<EventAggregates>,
  "counts" | "retrieval" | "outcome" | "rates" | "funnel" | "causal" | "integrity" | "mechanisms"
> & {
  counts?: Partial<EventAggregates["counts"]>;
  retrieval?: Partial<EventAggregates["retrieval"]>;
  outcome?: Partial<EventAggregates["outcome"]>;
  rates?: Partial<EventAggregates["rates"]>;
  funnel?: Partial<EventAggregates["funnel"]>;
  causal?: Partial<EventAggregates["causal"]>;
  integrity?: Partial<EventAggregates["integrity"]>;
  mechanisms?: Partial<EventAggregates["mechanisms"]>;
};

function blankMechanisms(): EventAggregates["mechanisms"] {
  return {
    fileIndex: {
      completedCount: 0,
      bytesSummarized: 0,
      durationMs: 0,
      pending: 0,
      skippedCount: 0,
      bySummarizer: { heuristic: 0, embedding: 0, llm: 0 },
    },
    fileMemory: { recallCount: 0, tokensInjected: 0, bytesAvoided: 0 },
    toolSupervision: {
      warnCount: 0,
      suppressedCount: 0,
      byFamily: {
        read: 0,
        search: 0,
        web: 0,
        edit: 0,
        write: 0,
        shell: 0,
        task: 0,
        other: 0,
      },
    },
    loopRedirect: {
      redirectCount: 0,
      fallbackCount: 0,
      byKind: { block: 0, file: 0 },
    },
    contextFold: {
      chunkCount: 0,
      tokensBeforeSum: 0,
      tokensAfterSum: 0,
      skipCount: 0,
      bySummarizer: { heuristic: 0, embedding: 0, llm: 0 },
      byReason: {
        "no-new-turns": 0,
        "hash-collision": 0,
        leakage: 0,
        injection: 0,
        "below-threshold": 0,
      },
    },
    injectionRejected: {
      rejectCount: 0,
      byPattern: {
        "role-override": 0,
        "persona-flip": 0,
        "system-spoof": 0,
        "delimiter-spoof": 0,
        "exfil-prompt": 0,
        "tool-coercion": 0,
      },
    },
    promptCache: {
      hitCount: 0,
      tokensSavedSum: 0,
      bySurface: { anthropic: 0, openai: 0 },
    },
  };
}

function blankAggregates(over: AggregateOverrides = {}): EventAggregates {
  const base: EventAggregates = {
    counts: {
      retrieval: 0, injection: 0, agentUsed: 0, outcome: 0,
      factInjection: 0, factAgentUsed: 0,
    },
    retrieval: { total: 0, shadow: 0, treatment: 0, totalInjectedTokensEstimate: 0 },
    outcome: {
      totalTreatment: 0, totalShadow: 0,
      resolvedTreatment: 0, resolvedShadow: 0,
      tokensTreatment: [], tokensShadow: [],
      durationsTreatment: [], durationsShadow: [],
    },
    rates: {
      coverage: 0,
      hitRate: null, helpfulRate: null, counterproductiveRate: null,
      factHitRate: null, factHelpfulRate: null, factCounterproductiveRate: null,
      resolvedLift: null, tokenLift: null,
    },
    funnel: {
      eligibleRuns: 0,
      recalledRuns: 0,
      injectedRuns: 0,
      usedRuns: 0,
      helpfulRuns: 0,
    },
    causal: {
      assisted: { n: 0, resolved: 0, tokens: [], durations: [] },
      holdout: { n: 0, resolved: 0, tokens: [], durations: [] },
    },
    perBlock: [],
    perFact: [],
    integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
    mechanisms: blankMechanisms(),
    window: {},
  };

  return {
    ...base,
    ...over,
    counts: { ...base.counts, ...over.counts },
    retrieval: { ...base.retrieval, ...over.retrieval },
    outcome: { ...base.outcome, ...over.outcome },
    rates: { ...base.rates, ...over.rates },
    funnel: { ...base.funnel, ...over.funnel },
    causal: { ...base.causal, ...over.causal },
    integrity: { ...base.integrity, ...over.integrity },
    mechanisms: { ...base.mechanisms, ...over.mechanisms },
  };
}

describe("computeImpact — empty state", () => {
  it("isEmpty=true and confidence='empty' when there are no events", () => {
    const r = computeImpact(blankAggregates());
    expect(r.isEmpty).toBe(true);
    expect(r.confidence).toBe("empty");
    expect(r.helpedTasks).toBe(0);
    expect(r.assistedTasks).toBe(0);
    expect(r.memoriesUsed).toBe(0);
    expect(r.estimatedMinutesSaved).toBe(0);
    expect(r.estimatedTokensSaved).toBe(0);
    expect(r.topMemories).toEqual([]);
    expect(r.needsAttention).toEqual([]);
  });
});

describe("computeImpact — estimated mode (no shadow arm)", () => {
  it("confidence='estimated' and falls back to the cost model", () => {
    const r = computeImpact(blankAggregates({
      counts: { retrieval: 10, injection: 5, agentUsed: 4, outcome: 5, factInjection: 0, factAgentUsed: 0 },
      retrieval: { total: 10, shadow: 0, treatment: 10 },
      rates: {
        coverage: 0.5,
        hitRate: 0.8, helpfulRate: 0.6, counterproductiveRate: 0.2,
        factHitRate: null, factHelpfulRate: null, factCounterproductiveRate: null,
        resolvedLift: null, tokenLift: null, // no shadow arm
      },
      perBlock: [
        { blockId: "a", retrieved: 5, injected: 3, agentUsed: 3, helpful: 3, counterproductive: 0, neutral: 0 },
        { blockId: "b", retrieved: 4, injected: 2, agentUsed: 1, helpful: 0, counterproductive: 1, neutral: 1 },
      ],
    }));
    expect(r.confidence).toBe("estimated");
    // 10 treatment × 0.5 coverage = 5 assisted
    expect(r.assistedTasks).toBe(5);
    // 3 helpful (from block a)
    expect(r.helpedTasks).toBe(3);
    // a + b both have agentUsed > 0 → 2 distinct blocks used
    expect(r.memoriesUsed).toBe(2);
    // 3 helpful × 4 min default = 12 min
    expect(r.estimatedMinutesSaved).toBe(12);
    // 3 helpful × 600 default = 1800 tokens
    expect(r.estimatedTokensSaved).toBe(1800);
    // top memory: just block a (b has helpful=0 so excluded)
    expect(r.topMemories).toHaveLength(1);
    expect(r.topMemories[0].blockId).toBe("a");
    // needs attention: block b (counterproductive=1)
    expect(r.needsAttention).toHaveLength(1);
    expect(r.needsAttention[0].blockId).toBe("b");
  });

  it("ImpactOptions overrides change the cost-model coefficients", () => {
    const r = computeImpact(blankAggregates({
      counts: { retrieval: 1, injection: 1, agentUsed: 1, outcome: 1, factInjection: 0, factAgentUsed: 0 },
      retrieval: { total: 1, shadow: 0, treatment: 1 },
      rates: {
        coverage: 1,
        hitRate: 1, helpfulRate: 1, counterproductiveRate: 0,
        factHitRate: null, factHelpfulRate: null, factCounterproductiveRate: null,
        resolvedLift: null, tokenLift: null,
      },
      perBlock: [
        { blockId: "x", retrieved: 1, injected: 1, agentUsed: 1, helpful: 1, counterproductive: 0, neutral: 0 },
      ],
    }), { minutesPerHelp: 10, tokensPerHelp: 1000 });
    expect(r.estimatedMinutesSaved).toBe(10);
    expect(r.estimatedTokensSaved).toBe(1000);
  });
});

describe("computeImpact — measured mode (shadow arm present)", () => {
  it("confidence='measured' and saved tokens = -tokenLift × totalTreatment", () => {
    const r = computeImpact(blankAggregates({
      counts: { retrieval: 20, injection: 8, agentUsed: 6, outcome: 20, factInjection: 0, factAgentUsed: 0 },
      retrieval: { total: 20, shadow: 10, treatment: 10 },
      outcome: {
        totalTreatment: 10, totalShadow: 10,
        resolvedTreatment: 7, resolvedShadow: 4,
        tokensTreatment: [400, 500], tokensShadow: [900, 1000],
      },
      rates: {
        coverage: 0.8,
        hitRate: 0.75, helpfulRate: 0.5, counterproductiveRate: 0.25,
        factHitRate: null, factHelpfulRate: null, factCounterproductiveRate: null,
        resolvedLift: 0.3,
        // Treatment used 450 mean, shadow used 950 mean → lift = -500 (saved)
        tokenLift: -500,
      },
      perBlock: [
        { blockId: "a", retrieved: 5, injected: 4, agentUsed: 4, helpful: 4, counterproductive: 0, neutral: 0 },
      ],
    }));
    expect(r.confidence).toBe("measured");
    // saved tokens = -(-500) × 10 treatment = 5000
    expect(r.estimatedTokensSaved).toBe(5000);
    // minutes still from cost model (we don't measure wall-clock yet)
    expect(r.estimatedMinutesSaved).toBe(4 * 4); // 4 helpful × 4 min default
  });

  it("confidence='measured' but zero savings when treatment used MORE tokens", () => {
    const r = computeImpact(blankAggregates({
      counts: { retrieval: 4, injection: 2, agentUsed: 2, outcome: 4, factInjection: 0, factAgentUsed: 0 },
      retrieval: { total: 4, shadow: 2, treatment: 2 },
      outcome: {
        totalTreatment: 2, totalShadow: 2,
        resolvedTreatment: 1, resolvedShadow: 1,
        tokensTreatment: [700], tokensShadow: [500],
      },
      rates: {
        coverage: 1,
        hitRate: 1, helpfulRate: 0.5, counterproductiveRate: 0.5,
        factHitRate: null, factHelpfulRate: null, factCounterproductiveRate: null,
        resolvedLift: 0,
        tokenLift: 200, // treatment used MORE tokens
      },
      perBlock: [],
    }));
    expect(r.confidence).toBe("measured");
    expect(r.estimatedTokensSaved).toBe(0);
  });
});

describe("computeImpact — sorting and caps", () => {
  it("topMemories is sorted by helpful and capped at topN", () => {
    const r = computeImpact(blankAggregates({
      counts: { retrieval: 1, injection: 10, agentUsed: 10, outcome: 1, factInjection: 0, factAgentUsed: 0 },
      retrieval: { total: 1, shadow: 0, treatment: 1 },
      perBlock: [
        // perBlock is expected sorted desc by helpful in computeAggregates;
        // we already pre-sort here to mirror real input shape.
        { blockId: "high", retrieved: 1, injected: 5, agentUsed: 5, helpful: 5, counterproductive: 0, neutral: 0 },
        { blockId: "mid",  retrieved: 1, injected: 3, agentUsed: 3, helpful: 3, counterproductive: 0, neutral: 0 },
        { blockId: "low",  retrieved: 1, injected: 1, agentUsed: 1, helpful: 1, counterproductive: 0, neutral: 0 },
        { blockId: "zero", retrieved: 1, injected: 1, agentUsed: 1, helpful: 0, counterproductive: 0, neutral: 1 },
      ],
    }), { topN: 2 });
    expect(r.topMemories.map((m) => m.blockId)).toEqual(["high", "mid"]);
    expect(r.topMemories).toHaveLength(2);
  });

  it("needsAttention is sorted by counterproductive desc and capped", () => {
    const r = computeImpact(blankAggregates({
      counts: { retrieval: 1, injection: 5, agentUsed: 5, outcome: 1, factInjection: 0, factAgentUsed: 0 },
      retrieval: { total: 1, shadow: 0, treatment: 1 },
      perBlock: [
        { blockId: "a", retrieved: 1, injected: 5, agentUsed: 5, helpful: 5, counterproductive: 0, neutral: 0 },
        { blockId: "b", retrieved: 1, injected: 5, agentUsed: 5, helpful: 0, counterproductive: 5, neutral: 0 },
        { blockId: "c", retrieved: 1, injected: 3, agentUsed: 3, helpful: 0, counterproductive: 3, neutral: 0 },
      ],
    }), { topN: 1 });
    expect(r.needsAttention).toHaveLength(1);
    expect(r.needsAttention[0].blockId).toBe("b");
  });
});
