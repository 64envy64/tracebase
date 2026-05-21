/**
 * Memory health scoring tests — C3.
 *
 * Two layers:
 *
 *   1. Pure-math unit tests for `wilsonLowerBound`,
 *      `stalenessPenalty`, `duplicationPenalty`, `genericnessPenalty`,
 *      `negativeRoiPenalty`, `scoreBlock`, `classifyDemotionReasons`.
 *      No store, no events — the math layer is verified
 *      independently so a future event-shape change can't silently
 *      regress it.
 *
 *   2. Integration tests for `computeMemoryHealth` against a live
 *      `BlockStore` — confirms the driver pulls the right per-block
 *      stats from `computeAggregates`, that the §L6 strength gate
 *      (C2.3) still flows through, and that the report shape is
 *      stable.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import { emitAgentUsed, emitOutcome } from "../../src/core/analytics.js";
import {
  classifyDemotionReasons,
  computeMemoryHealth,
  DEFAULT_MEMORY_HEALTH_CONFIG,
  duplicationPenalty,
  genericnessPenalty,
  negativeRoiPenalty,
  scoreBlock,
  stalenessPenalty,
  wilsonLowerBound,
  type MemoryHealthComponents,
} from "../../src/lifecycle/memory-health.js";
import type { ReasoningBlock, StoreBlockInput } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Pure-math tests
// ---------------------------------------------------------------------------

describe("wilsonLowerBound", () => {
  it("returns 0 when trials is 0 (no evidence is not bad evidence)", () => {
    expect(wilsonLowerBound(0, 0, 1.96)).toBe(0);
  });

  it("returns 0 when trials is negative (defensive)", () => {
    expect(wilsonLowerBound(0, -1, 1.96)).toBe(0);
  });

  it("matches the closed-form formula for 5/10 at 95%", () => {
    // p̂ = 0.5, n = 10, z = 1.96. Standard Wilson lower = ~0.2366.
    const v = wilsonLowerBound(5, 10, 1.96);
    expect(v).toBeGreaterThan(0.23);
    expect(v).toBeLessThan(0.25);
  });

  it("is strictly lower than the raw rate (it's a lower bound)", () => {
    for (const [s, n] of [[3, 5], [10, 20], [50, 100]] as Array<[number, number]>) {
      const raw = s / n;
      const lb = wilsonLowerBound(s, n, 1.96);
      expect(lb).toBeLessThan(raw);
    }
  });

  it("tightens toward the raw rate as n grows (consistency)", () => {
    const small = wilsonLowerBound(5, 10, 1.96);
    const big = wilsonLowerBound(500, 1000, 1.96);
    // Both 50% rate, but big-n LB should be much closer to 0.5.
    expect(big).toBeGreaterThan(small);
    expect(big).toBeGreaterThan(0.45);
  });

  it("stays bounded in [0, 1] under perfect-success small n", () => {
    // 1/1 helpful: float drift in (p*(1-p) + z²/4n) can dip below
    // zero. Clamp must keep the result in [0, 1].
    const v = wilsonLowerBound(1, 1, 1.96);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("stalenessPenalty", () => {
  it("is 0 at day 0", () => {
    expect(stalenessPenalty(0, 30, 0.2)).toBe(0);
  });

  it("reaches halfLifeDays/2 of max at halfLife", () => {
    // formula: (days / 2*halfLife) * maxPenalty
    // 30d, halfLife=30, max=0.2 → (30/60)*0.2 = 0.1.
    expect(stalenessPenalty(30, 30, 0.2)).toBeCloseTo(0.1, 6);
  });

  it("caps at maxPenalty for very old blocks", () => {
    expect(stalenessPenalty(1000, 30, 0.2)).toBe(0.2);
  });

  it("returns 0 on negative or non-finite inputs (defensive)", () => {
    expect(stalenessPenalty(-1, 30, 0.2)).toBe(0);
    expect(stalenessPenalty(Number.NaN, 30, 0.2)).toBe(0);
    expect(stalenessPenalty(Infinity, 30, 0.2)).toBe(0.2); // cap still applies
  });

  it("returns 0 when halfLifeDays is misconfigured to ≤ 0", () => {
    expect(stalenessPenalty(60, 0, 0.2)).toBe(0);
    expect(stalenessPenalty(60, -1, 0.2)).toBe(0);
  });
});

describe("duplicationPenalty", () => {
  it("returns 0 with no siblings", () => {
    expect(duplicationPenalty([], 0.75, 0.1, 0.2)).toBe(0);
  });

  it("returns 0 when no sibling crosses the threshold", () => {
    expect(duplicationPenalty([0.2, 0.5, 0.6], 0.75, 0.1, 0.2)).toBe(0);
  });

  it("counts hits ≥ threshold and scales by perHit", () => {
    expect(duplicationPenalty([0.8, 0.9, 0.5], 0.75, 0.1, 0.5)).toBeCloseTo(0.2, 6);
  });

  it("caps at maxPenalty when many siblings cluster", () => {
    expect(duplicationPenalty([0.9, 0.9, 0.9, 0.9, 0.9], 0.75, 0.1, 0.2)).toBe(0.2);
  });
});

describe("genericnessPenalty", () => {
  it("is 0 when keyword count meets the minimum", () => {
    expect(genericnessPenalty(4, 4, 0.15)).toBe(0);
    expect(genericnessPenalty(10, 4, 0.15)).toBe(0);
  });

  it("scales linearly with the shortfall and caps at maxPenalty", () => {
    expect(genericnessPenalty(2, 4, 0.15)).toBeCloseTo(0.075, 6);
    expect(genericnessPenalty(0, 4, 0.15)).toBe(0.15);
  });

  it("is 0 when minKeywords is misconfigured to ≤ 0", () => {
    expect(genericnessPenalty(0, 0, 0.15)).toBe(0);
    expect(genericnessPenalty(2, -1, 0.15)).toBe(0);
  });
});

describe("negativeRoiPenalty (V1 heuristic — replaced by arbiter in C4)", () => {
  it("does not fire below the inject-count threshold", () => {
    // Even with 0% helpful, we don't penalise on n<5 — not enough signal.
    expect(negativeRoiPenalty(2, 0, 5, 0.1, 0.2)).toBe(0);
  });

  it("does not fire when helpful rate clears the floor", () => {
    expect(negativeRoiPenalty(10, 2, 5, 0.1, 0.2)).toBe(0); // 0.2 ≥ 0.1
  });

  it("scales linearly with how far below the floor we are", () => {
    // 0 helpful / 10 injected = 0.0 rate; floor = 0.1; shortfall = 1.0.
    expect(negativeRoiPenalty(10, 0, 5, 0.1, 0.2)).toBe(0.2);
    // 0.05 rate; shortfall = 0.5; penalty = 0.1.
    expect(negativeRoiPenalty(20, 1, 5, 0.1, 0.2)).toBeCloseTo(0.1, 6);
  });

  it("returns 0 when helpfulFloor is misconfigured to ≤ 0", () => {
    expect(negativeRoiPenalty(10, 0, 5, 0, 0.2)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scoreBlock — composite assembly
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 4, 21, 12, 0, 0);
const DAY_MS = 86_400_000;

function dummyBlock(overrides: Partial<{
  id: string;
  createdAt: number;
  lastUsedAt?: number;
  keywords: string[];
}>): Parameters<typeof scoreBlock>[0]["block"] {
  return {
    id: overrides.id ?? "b-1",
    createdAt: overrides.createdAt ?? NOW - 7 * DAY_MS,
    trigger: {
      situation: "test",
      invariants: {},
      keywords: overrides.keywords ?? ["python", "asyncio", "loop", "deadlock", "lock"],
      fingerprint: "fp-1",
    },
    stats: {
      timesRetrieved: 0,
      timesInjected: 0,
      timesAgentUsed: 0,
      timesHelpful: 0,
      timesCounterproductive: 0,
      cumulativeTokensSaved: 0,
      cumulativeStepsSaved: 0,
      ...(overrides.lastUsedAt !== undefined ? { lastUsedAt: overrides.lastUsedAt } : {}),
    },
  };
}

describe("scoreBlock — composite", () => {
  it("returns wilsonLb when there are no penalty drivers", () => {
    const result = scoreBlock({
      block: dummyBlock({ lastUsedAt: NOW - DAY_MS }),
      perBlock: { injected: 100, agentUsed: 50, helpful: 50, verifiedHelpful: 50, counterproductive: 0 },
      siblings: [],
      nowMs: NOW,
      config: DEFAULT_MEMORY_HEALTH_CONFIG,
    });
    expect(result.components.wilsonLb).toBeGreaterThan(0.4); // ~0.40 on 50/100
    expect(result.components.counterproductiveRate).toBe(0);
    expect(result.components.stalePenalty).toBeCloseTo(0.0033, 3); // 1 day → tiny
    expect(result.components.duplicationPenalty).toBe(0);
    expect(result.components.genericnessPenalty).toBe(0);
    expect(result.components.negativeRoiPenalty).toBe(0);
    expect(result.reasons).toEqual([]); // healthy
  });

  it("penalises high counterproductive even when wilsonLb is decent", () => {
    const r = scoreBlock({
      block: dummyBlock({ lastUsedAt: NOW - DAY_MS }),
      perBlock: { injected: 20, agentUsed: 15, helpful: 5, verifiedHelpful: 5, counterproductive: 10 },
      siblings: [],
      nowMs: NOW,
      config: DEFAULT_MEMORY_HEALTH_CONFIG,
    });
    expect(r.components.counterproductiveRate).toBe(0.5);
    expect(r.health).toBeLessThan(0); // 5/20 wilson_lb ~0.1 − 0.5 counter
    expect(r.reasons).toContain("high_counterproductive");
  });

  it("detects a duplicate via trigger-keyword Jaccard", () => {
    const own = ["python", "asyncio", "loop", "deadlock", "lock"];
    const dup = ["python", "asyncio", "loop", "deadlock", "lock", "extra"];
    const r = scoreBlock({
      block: dummyBlock({ id: "block-with-dup", keywords: own, lastUsedAt: NOW - DAY_MS }),
      perBlock: { injected: 10, agentUsed: 5, helpful: 5, verifiedHelpful: 5, counterproductive: 0 },
      siblings: [{ id: "block-other", keywords: dup }],
      nowMs: NOW,
      config: DEFAULT_MEMORY_HEALTH_CONFIG,
    });
    expect(r.components.duplicationPenalty).toBeGreaterThan(0);
  });

  it("flags genericness when trigger has very few keywords", () => {
    const r = scoreBlock({
      block: dummyBlock({ keywords: ["error"], lastUsedAt: NOW - DAY_MS }),
      perBlock: { injected: 5, agentUsed: 2, helpful: 1, verifiedHelpful: 1, counterproductive: 0 },
      siblings: [],
      nowMs: NOW,
      config: DEFAULT_MEMORY_HEALTH_CONFIG,
    });
    expect(r.components.genericnessPenalty).toBeGreaterThan(0);
  });

  it("flags negative_roi when injections are many but helpful rate is below floor", () => {
    const r = scoreBlock({
      block: dummyBlock({ lastUsedAt: NOW - DAY_MS }),
      perBlock: { injected: 20, agentUsed: 4, helpful: 0, verifiedHelpful: 0, counterproductive: 4 },
      siblings: [],
      nowMs: NOW,
      config: DEFAULT_MEMORY_HEALTH_CONFIG,
    });
    expect(r.components.negativeRoiPenalty).toBeGreaterThan(0);
    expect(r.reasons).toContain("negative_roi");
  });

  it("anchors staleness on createdAt when lastUsedAt is unset", () => {
    // No lastUsedAt, block created 100 days ago.
    const r = scoreBlock({
      block: dummyBlock({ createdAt: NOW - 100 * DAY_MS }),
      perBlock: { injected: 0, agentUsed: 0, helpful: 0, verifiedHelpful: 0, counterproductive: 0 },
      siblings: [],
      nowMs: NOW,
      config: DEFAULT_MEMORY_HEALTH_CONFIG,
    });
    expect(r.evidence.lastUsedAt).toBe(null);
    expect(r.evidence.daysSinceLastUse).toBe(null);
    // Stale penalty should be at or near the cap.
    expect(r.components.stalePenalty).toBeGreaterThan(0.15);
    expect(r.reasons).toContain("stale");
  });

  it("never produces a NaN or undefined component", () => {
    const r = scoreBlock({
      block: dummyBlock({}),
      perBlock: { injected: 0, agentUsed: 0, helpful: 0, verifiedHelpful: 0, counterproductive: 0 },
      siblings: [],
      nowMs: NOW,
      config: DEFAULT_MEMORY_HEALTH_CONFIG,
    });
    const components: MemoryHealthComponents = r.components;
    for (const v of Object.values(components)) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(Number.isFinite(r.health)).toBe(true);
  });
});

describe("classifyDemotionReasons", () => {
  it("returns empty when health is above the threshold", () => {
    const reasons = classifyDemotionReasons(
      0.5,
      {
        wilsonLb: 0.5, counterproductiveRate: 0, stalePenalty: 0,
        duplicationPenalty: 0, genericnessPenalty: 0, negativeRoiPenalty: 0,
      },
      { injected: 10 },
      DEFAULT_MEMORY_HEALTH_CONFIG,
    );
    expect(reasons).toEqual([]);
  });

  it("does NOT fire low_wilson_lb when there are no injections", () => {
    // 0 injections with wilson_lb=0 is "no evidence", not "bad
    // evidence" — would-be brand-new blocks must not be tagged.
    const reasons = classifyDemotionReasons(
      -0.05,
      {
        wilsonLb: 0, counterproductiveRate: 0, stalePenalty: 0.05,
        duplicationPenalty: 0, genericnessPenalty: 0, negativeRoiPenalty: 0,
      },
      { injected: 0 },
      DEFAULT_MEMORY_HEALTH_CONFIG,
    );
    expect(reasons).not.toContain("low_wilson_lb");
  });

  it("fires multiple reasons when multiple components crossed thresholds", () => {
    const reasons = classifyDemotionReasons(
      -0.5,
      {
        wilsonLb: 0.05, counterproductiveRate: 0.3, stalePenalty: 0.2,
        duplicationPenalty: 0.1, genericnessPenalty: 0.1, negativeRoiPenalty: 0.1,
      },
      { injected: 50 },
      DEFAULT_MEMORY_HEALTH_CONFIG,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        "low_wilson_lb",
        "high_counterproductive",
        "stale",
        "duplicate",
        "generic",
        "negative_roi",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Integration — computeMemoryHealth against a live BlockStore
// ---------------------------------------------------------------------------

const SAMPLE_INPUT: StoreBlockInput = {
  trigger: {
    situation: "asyncio event loop blocks on deadlock with shared lock",
    invariants: { language: "python", framework: "asyncio" },
  },
  body: {
    mechanism: "two tasks acquire locks in opposite order",
    deadEnds: [],
    unlock: "always acquire locks in the same global order",
    verification: "stress test never deadlocks under 1000 runs",
  },
  provenance: { sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "llm" },
};

function makeActive(store: BlockStore, sample: StoreBlockInput): ReasoningBlock {
  const b = createBlock(sample);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id, traceId: `trace-${b.id}`, role: "origin", evidenceQuality: "strong",
  });
  return store.updateBlockStatus(b.id, "active")!;
}

let store: BlockStore;

beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

afterEach(() => {
  store.close();
});

describe("computeMemoryHealth — integration", () => {
  it("returns an empty report when the store has no active blocks", () => {
    const report = computeMemoryHealth(store, { nowMs: NOW });
    expect(report.scanned).toBe(0);
    expect(report.scored).toEqual([]);
    expect(report.wouldDemote).toEqual([]);
  });

  it("scores every active block exactly once", () => {
    makeActive(store, SAMPLE_INPUT);
    makeActive(store, {
      ...SAMPLE_INPUT,
      trigger: { ...SAMPLE_INPUT.trigger, situation: "different trigger keywords avoid collision" },
    });
    const report = computeMemoryHealth(store, { nowMs: NOW });
    expect(report.scanned).toBe(2);
    expect(report.scored).toHaveLength(2);
    expect(new Set(report.scored.map((s) => s.blockId)).size).toBe(2);
  });

  it("respects the C2.3 §L6 gate — weak agent_used does not promote helpful", () => {
    // Pre-C2 / weak attribution: per-block.helpful must stay 0, so
    // wilson_lb stays 0, and a series of injections with weak
    // signals can DEMOTE the block via negative_roi instead of
    // promoting it. This pins that memory-health learns on the
    // strict §L6 numbers (not the permissive pre-C2 ones).
    const b = makeActive(store, SAMPLE_INPUT);
    // 10 injections, only weak agent_used, all resolved.
    for (let i = 0; i < 10; i++) {
      const queryId = `q-${i}`;
      store.appendEvent({
        ts: Date.now(),
        queryId,
        event: "retrieval",
        candidates: [{ blockId: b.id, score: 0.5 }],
        shadow: false,
      });
      store.appendEvent({
        ts: Date.now(),
        queryId,
        event: "injection",
        blockId: b.id,
        score: 0.5,
        calibratedProb: 0.5,
      });
      emitAgentUsed(store, {
        queryId,
        blockId: b.id,
        matchSignal: "jaccard",
        matchScore: 0.05, // below MODERATE_JACCARD_THRESHOLD
        evidenceStrength: "weak",
      });
      emitOutcome(store, { queryId, resolved: true, control: false });
    }
    const report = computeMemoryHealth(store, { nowMs: NOW });
    const row = report.scored.find((s) => s.blockId === b.id)!;
    expect(row.evidence.injected).toBe(10);
    expect(row.evidence.helpful).toBe(0); // strict §L6 gate
    expect(row.components.wilsonLb).toBe(0);
    // 10 injections, helpful=0 < floor 0.1 → negative_roi fires.
    expect(row.components.negativeRoiPenalty).toBeGreaterThan(0);
    expect(row.reasons).toContain("negative_roi");
  });

  it("does not mutate the store (read-only contract)", () => {
    const b = makeActive(store, SAMPLE_INPUT);
    const before = store.listBlocks({ status: "active", limit: 100 })[0]!;
    const beforeUpdatedAt = before.updatedAt;
    computeMemoryHealth(store, { nowMs: NOW });
    const after = store.listBlocks({ status: "active", limit: 100 })[0]!;
    expect(after.id).toBe(b.id);
    expect(after.status).toBe("active");
    expect(after.updatedAt).toBe(beforeUpdatedAt);
  });

  it("C3 fresh-block safety: a brand-new block with zero events is NOT in wouldDemote", () => {
    // health=0 (= threshold) but no reason fires → must NOT demote.
    // The earliest version of the driver classified by `health <=
    // threshold` alone, which would have flagged every newborn
    // block. The reason-code-gated filter is the right semantic.
    makeActive(store, SAMPLE_INPUT);
    const report = computeMemoryHealth(store, { nowMs: NOW });
    expect(report.scanned).toBe(1);
    expect(report.scored).toHaveLength(1);
    expect(report.scored[0]!.reasons).toEqual([]);
    expect(report.wouldDemote).toEqual([]);
  });

  it("sorts scored[] worst-first and populates wouldDemote at threshold", () => {
    const healthy = makeActive(store, SAMPLE_INPUT);
    const sick = makeActive(store, {
      ...SAMPLE_INPUT,
      trigger: { ...SAMPLE_INPUT.trigger, situation: "totally different keywords to dodge dup" },
    });
    // Inject the sick block many times with no helpful outcomes.
    for (let i = 0; i < 10; i++) {
      const queryId = `q-sick-${i}`;
      store.appendEvent({
        ts: Date.now(),
        queryId,
        event: "retrieval",
        candidates: [{ blockId: sick.id, score: 0.5 }],
        shadow: false,
      });
      store.appendEvent({
        ts: Date.now(),
        queryId,
        event: "injection",
        blockId: sick.id,
        score: 0.5,
        calibratedProb: 0.5,
      });
      emitAgentUsed(store, {
        queryId,
        blockId: sick.id,
        matchSignal: "explicit",
        matchScore: 1,
        evidenceStrength: "explicit",
      });
      emitOutcome(store, { queryId, resolved: false, control: false });
    }
    const report = computeMemoryHealth(store, { nowMs: NOW });
    expect(report.scored).toHaveLength(2);
    // worst first
    expect(report.scored[0]!.blockId).toBe(sick.id);
    expect(report.scored[1]!.blockId).toBe(healthy.id);
    // sick should fall to wouldDemote at the default 0 threshold.
    expect(report.wouldDemote.map((s) => s.blockId)).toContain(sick.id);
    expect(report.wouldDemote.map((s) => s.blockId)).not.toContain(healthy.id);
  });
});
