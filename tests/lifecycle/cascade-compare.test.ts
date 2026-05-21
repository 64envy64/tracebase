/**
 * cascade-compare aggregator tests — May-2026 B1.4.
 *
 * Builds a synthetic event log where the §L6 helpful-rate per arm is
 * known by construction, then asserts the aggregator recovers it.
 * Anything the aggregator gets wrong here directly mis-reports the
 * cascade rollout to the user, so the truth-table coverage matters.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  computeCascadeComparisonByDay,
  computeCascadeComparison,
  MIN_SAMPLE,
} from "../../src/lifecycle/cascade-compare.js";

let store: BlockStore;

beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

afterEach(() => {
  store.close();
});

/**
 * Append a complete query lifecycle to the event log:
 *   retrieval (cascade or sync arm)
 *   → optional injection
 *   → optional agent_used
 *   → outcome (resolved or not)
 *
 * Mirrors the §L6 helpful definition: helpful = injection ∧
 * agent_used ∧ outcome.resolved. By controlling which step we skip,
 * we plant outcomes we can count up by hand and compare.
 */
function seedQuery(args: {
  queryId: string;
  arm: "cascade" | "sync";
  injection?: boolean;
  agentUsed?: boolean;
  resolved?: boolean;
  /** When set, the retrieval event reports a reranker fallback (cascade arm only). */
  fallbackReason?: "timeout" | "error" | "null" | "empty" | "validation";
  ts?: number;
}): void {
  const ts = args.ts ?? Date.now();
  store.appendEvent({
    ts,
    queryId: args.queryId,
    event: "retrieval",
    candidates: [{ blockId: "b-1", score: 0.5 }],
    shadow: false,
    ...(args.arm === "cascade"
      ? {
          rerankerName: "test-reranker",
          cascadePolicyId: "linear+rerank+mmr.v1",
          mmrLambda: 0.7,
          rerankerFellBack: args.fallbackReason !== undefined,
          ...(args.fallbackReason ? { rerankerFallbackReason: args.fallbackReason } : {}),
        }
      : {}),
  });
  if (args.injection) {
    store.appendEvent({
      ts: ts + 1,
      queryId: args.queryId,
      event: "injection",
      blockId: "b-1",
      score: 0.5,
      calibratedProb: 0.5,
    });
  }
  if (args.agentUsed) {
    store.appendEvent({
      ts: ts + 2,
      queryId: args.queryId,
      event: "agent_used",
      blockId: "b-1",
      matchSignal: "explicit",
      matchScore: 1,
    });
  }
  store.appendEvent({
    ts: ts + 3,
    queryId: args.queryId,
    event: "outcome",
    resolved: args.resolved ?? false,
    control: false,
  });
}

describe("computeCascadeComparison — base contract", () => {
  it("returns zeroed metrics on an empty store", () => {
    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.retrievals).toBe(0);
    expect(cmp.sync.retrievals).toBe(0);
    expect(cmp.cascade.helpfulRate).toBeNull();
    expect(cmp.sync.helpfulRate).toBeNull();
    expect(cmp.lift).toBeNull();
    expect(cmp.lowSample).toBe(true);
  });

  it("splits arms by cascadePolicyId on retrieval events", () => {
    seedQuery({ queryId: "c-1", arm: "cascade", injection: true, agentUsed: true, resolved: true });
    seedQuery({ queryId: "s-1", arm: "sync", injection: true, agentUsed: true, resolved: true });
    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.retrievals).toBe(1);
    expect(cmp.sync.retrievals).toBe(1);
  });

  it("computes helpful-rate as helpfulRuns / totalRuns per arm", () => {
    // Cascade arm: 3 outcomes, 2 helpful  → 0.667
    seedQuery({ queryId: "c-1", arm: "cascade", injection: true, agentUsed: true, resolved: true });
    seedQuery({ queryId: "c-2", arm: "cascade", injection: true, agentUsed: true, resolved: true });
    seedQuery({ queryId: "c-3", arm: "cascade", injection: true, agentUsed: true, resolved: false });
    // Sync arm: 4 outcomes, 1 helpful  → 0.25
    seedQuery({ queryId: "s-1", arm: "sync", injection: true, agentUsed: true, resolved: true });
    seedQuery({ queryId: "s-2", arm: "sync", injection: true, agentUsed: true, resolved: false });
    seedQuery({ queryId: "s-3", arm: "sync", injection: true, agentUsed: true, resolved: false });
    seedQuery({ queryId: "s-4", arm: "sync", injection: true, agentUsed: false, resolved: true });

    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.helpfulRate).toBeCloseTo(2 / 3, 5);
    expect(cmp.sync.helpfulRate).toBeCloseTo(1 / 4, 5);
    expect(cmp.lift).toBeCloseTo(2 / 3 - 1 / 4, 5);
  });

  it("excludes outcomes where the agent didn't use any block (§L6)", () => {
    // Injection fired but no agent_used → not helpful even if resolved.
    seedQuery({ queryId: "c-1", arm: "cascade", injection: true, agentUsed: false, resolved: true });
    seedQuery({ queryId: "c-2", arm: "cascade", injection: true, agentUsed: true, resolved: true });
    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.totalRuns).toBe(2);
    expect(cmp.cascade.helpfulRuns).toBe(1);
  });

  it("excludes outcomes where injection never fired (§L6)", () => {
    // No injection → cannot be credited helpful even if everything
    // else lined up — the §L6 definition is strict.
    seedQuery({ queryId: "c-1", arm: "cascade", injection: false, agentUsed: true, resolved: true });
    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.totalRuns).toBe(1);
    expect(cmp.cascade.helpfulRuns).toBe(0);
  });
});

describe("computeCascadeComparison — cascade fallback breakdown", () => {
  it("counts each fallback reason separately and ignores non-cascade events", () => {
    seedQuery({ queryId: "c-1", arm: "cascade", injection: true, agentUsed: true, resolved: true });
    seedQuery({ queryId: "c-2", arm: "cascade", fallbackReason: "timeout", injection: false });
    seedQuery({ queryId: "c-3", arm: "cascade", fallbackReason: "timeout", injection: false });
    seedQuery({ queryId: "c-4", arm: "cascade", fallbackReason: "error", injection: false });
    seedQuery({ queryId: "c-5", arm: "cascade", fallbackReason: "validation", injection: false });
    // Sync-arm event should not pollute the breakdown.
    seedQuery({ queryId: "s-1", arm: "sync", injection: true, agentUsed: true, resolved: false });

    const cmp = computeCascadeComparison(store);
    expect(cmp.cascadeFallback.timeout).toBe(2);
    expect(cmp.cascadeFallback.error).toBe(1);
    expect(cmp.cascadeFallback.validation).toBe(1);
    expect(cmp.cascadeFallback.null).toBe(0);
    expect(cmp.cascadeFallback.empty).toBe(0);
    // The one cascade event with no fallback counts as "ran" successfully.
    expect(cmp.cascadeRerankerRan).toBe(1);
  });
});

describe("computeCascadeComparison — low-sample flag", () => {
  it("flags lowSample when EITHER arm has fewer than MIN_SAMPLE outcomes", () => {
    // Build 50 outcomes on cascade arm only.
    for (let i = 0; i < MIN_SAMPLE; i++) {
      seedQuery({
        queryId: `c-${i}`,
        arm: "cascade",
        injection: true,
        agentUsed: true,
        resolved: i % 2 === 0,
      });
    }
    seedQuery({ queryId: "s-1", arm: "sync", injection: true, agentUsed: true, resolved: true });

    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.totalRuns).toBe(MIN_SAMPLE);
    expect(cmp.sync.totalRuns).toBe(1);
    expect(cmp.lowSample).toBe(true); // sync arm too small
  });

  it("clears lowSample when both arms have ≥ MIN_SAMPLE outcomes", () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      seedQuery({
        queryId: `c-${i}`,
        arm: "cascade",
        injection: true,
        agentUsed: true,
        resolved: true,
      });
      seedQuery({
        queryId: `s-${i}`,
        arm: "sync",
        injection: true,
        agentUsed: true,
        resolved: i % 2 === 0,
      });
    }
    const cmp = computeCascadeComparison(store);
    expect(cmp.lowSample).toBe(false);
    expect(cmp.lift).toBeCloseTo(1.0 - 0.5, 5);
  });
});

describe("computeCascadeComparison — time window", () => {
  it("respects the afterTs window when supplied", () => {
    seedQuery({ queryId: "c-old", arm: "cascade", injection: true, agentUsed: true, resolved: true });
    // Bump the clock so subsequent events land in a clearly later bucket.
    // We can't easily fake timestamps through seedQuery, so this test
    // pins that the aggregator reads the option (truth-table coverage
    // for window semantics lives in BlockStore.readEvents tests).
    const cmp = computeCascadeComparison(store, { afterTs: Date.now() + 60_000 });
    expect(cmp.cascade.retrievals).toBe(0);
    expect(cmp.sync.retrievals).toBe(0);
  });
});

describe("computeCascadeComparison — C2.2 strength gate", () => {
  /**
   * Append a query lifecycle with explicit control over the
   * agent_used evidence strength. Pre-C2.2 cascade-compare credited
   * ANY agent_used; this fixture exercises the now-required
   * moderate-or-stronger threshold so the dashboard lift number can't
   * be inflated by noisy Jaccard.
   */
  function seedStrengthQuery(args: {
    queryId: string;
    arm: "cascade" | "sync";
    evidenceStrength: "weak" | "moderate" | "strong" | "explicit";
    resolved: boolean;
  }): void {
    const ts = Date.now();
    store.appendEvent({
      ts,
      queryId: args.queryId,
      event: "retrieval",
      candidates: [{ blockId: "b-1", score: 0.5 }],
      shadow: false,
      ...(args.arm === "cascade"
        ? { rerankerName: "test-reranker", cascadePolicyId: "linear+rerank+mmr.v1", mmrLambda: 0.7, rerankerFellBack: false }
        : {}),
    });
    store.appendEvent({
      ts: ts + 1,
      queryId: args.queryId,
      event: "injection",
      blockId: "b-1",
      score: 0.5,
      calibratedProb: 0.5,
    });
    store.appendEvent({
      ts: ts + 2,
      queryId: args.queryId,
      event: "agent_used",
      blockId: "b-1",
      matchSignal: args.evidenceStrength === "explicit" ? "explicit" : "jaccard",
      matchScore: args.evidenceStrength === "weak" ? 0.05 : args.evidenceStrength === "moderate" ? 0.25 : 1,
      evidenceStrength: args.evidenceStrength,
    } as never);
    store.appendEvent({
      ts: ts + 3,
      queryId: args.queryId,
      event: "outcome",
      resolved: args.resolved,
      control: false,
    });
  }

  it("weak agent_used + resolved → cascade arm helpfulRuns=0 (NOT counted as helpful)", () => {
    // The named C2.2 regression: pre-fix this would have credited
    // helpfulRuns=1 on a noisy Jaccard match. Post-fix the cascade
    // arm must agree with the §L6 strict gate.
    seedStrengthQuery({
      queryId: "c-weak",
      arm: "cascade",
      evidenceStrength: "weak",
      resolved: true,
    });
    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.retrievals).toBe(1);
    expect(cmp.cascade.injections).toBe(1);
    expect(cmp.cascade.totalRuns).toBe(1);
    expect(cmp.cascade.helpfulRuns).toBe(0);
    expect(cmp.cascade.helpfulRate).toBe(0);
  });

  it("moderate / strong / explicit agent_used + resolved → helpfulRuns=1 each", () => {
    seedStrengthQuery({ queryId: "c-mod", arm: "cascade", evidenceStrength: "moderate", resolved: true });
    seedStrengthQuery({ queryId: "c-strong", arm: "cascade", evidenceStrength: "strong", resolved: true });
    seedStrengthQuery({ queryId: "c-explicit", arm: "cascade", evidenceStrength: "explicit", resolved: true });
    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.totalRuns).toBe(3);
    expect(cmp.cascade.helpfulRuns).toBe(3);
    expect(cmp.cascade.helpfulRate).toBe(1);
  });

  it("strongest observed strength wins — a weak then a strong agent_used on the same (queryId, blockId) credits helpful", () => {
    // Mirrors the per-pair update pattern: STRENGTH_RANK[new] >
    // STRENGTH_RANK[prev] replaces. A late strong signal must NOT
    // be downgraded by an earlier weak one. This pins the upgrade
    // semantics so reranker-late inference (which might fire first
    // with a weak Jaccard, then later confirm with a strong diff
    // touch) credits helpful.
    const ts = Date.now();
    store.appendEvent({
      ts,
      queryId: "c-upgrade",
      event: "retrieval",
      candidates: [{ blockId: "b-1", score: 0.5 }],
      shadow: false,
      rerankerName: "test-reranker",
      cascadePolicyId: "linear+rerank+mmr.v1",
      mmrLambda: 0.7,
      rerankerFellBack: false,
    });
    store.appendEvent({ ts: ts + 1, queryId: "c-upgrade", event: "injection", blockId: "b-1", score: 0.5, calibratedProb: 0.5 });
    store.appendEvent({
      ts: ts + 2,
      queryId: "c-upgrade",
      event: "agent_used",
      blockId: "b-1",
      matchSignal: "jaccard",
      matchScore: 0.05,
      evidenceStrength: "weak",
    } as never);
    store.appendEvent({
      ts: ts + 3,
      queryId: "c-upgrade",
      event: "agent_used",
      blockId: "b-1",
      matchSignal: "jaccard",
      matchScore: 0.5,
      evidenceStrength: "strong",
      evidenceKind: "diff_touches_recalled_file",
    } as never);
    store.appendEvent({ ts: ts + 4, queryId: "c-upgrade", event: "outcome", resolved: true, control: false });

    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.helpfulRuns).toBe(1);
  });

  it("strength gate applies to BOTH arms — sync arm with weak agent_used also drops to helpfulRuns=0", () => {
    seedStrengthQuery({ queryId: "s-weak", arm: "sync", evidenceStrength: "weak", resolved: true });
    seedStrengthQuery({ queryId: "s-explicit", arm: "sync", evidenceStrength: "explicit", resolved: true });
    const cmp = computeCascadeComparison(store);
    expect(cmp.sync.totalRuns).toBe(2);
    expect(cmp.sync.helpfulRuns).toBe(1);
  });

  it("legacy event (no evidenceStrength) with matchSignal=explicit still credits — back-compat preserved", () => {
    // Pre-C2.1 events have no evidenceStrength field. The
    // cascade-compare aggregator must reuse the same back-compat
    // ladder (`strengthFromMatchSignal`) used elsewhere, so the
    // operational lift number stays continuous across the C2.1 cut.
    const ts = Date.now();
    store.appendEvent({
      ts,
      queryId: "c-legacy",
      event: "retrieval",
      candidates: [{ blockId: "b-1", score: 0.5 }],
      shadow: false,
      rerankerName: "test-reranker",
      cascadePolicyId: "linear+rerank+mmr.v1",
      mmrLambda: 0.7,
      rerankerFellBack: false,
    });
    store.appendEvent({ ts: ts + 1, queryId: "c-legacy", event: "injection", blockId: "b-1", score: 0.5, calibratedProb: 0.5 });
    store.appendEvent({
      ts: ts + 2,
      queryId: "c-legacy",
      event: "agent_used",
      blockId: "b-1",
      matchSignal: "explicit",
      matchScore: 1,
      // No evidenceStrength — pre-C2.1 shape.
    } as never);
    store.appendEvent({ ts: ts + 3, queryId: "c-legacy", event: "outcome", resolved: true, control: false });

    const cmp = computeCascadeComparison(store);
    expect(cmp.cascade.helpfulRuns).toBe(1);
  });
});

describe("computeCascadeComparisonByDay — trend buckets", () => {
  it("groups comparisons by UTC day using the same arm math", () => {
    const day1 = Date.UTC(2026, 4, 17, 12);
    const day2 = Date.UTC(2026, 4, 18, 12);
    seedQuery({
      queryId: "c-day-1",
      arm: "cascade",
      injection: true,
      agentUsed: true,
      resolved: true,
      ts: day1,
    });
    seedQuery({
      queryId: "s-day-1",
      arm: "sync",
      injection: true,
      agentUsed: true,
      resolved: false,
      ts: day1 + 10,
    });
    seedQuery({
      queryId: "c-day-2",
      arm: "cascade",
      injection: true,
      agentUsed: true,
      resolved: false,
      ts: day2,
    });

    const buckets = computeCascadeComparisonByDay(store, {
      afterTs: Date.UTC(2026, 4, 17),
      beforeTs: Date.UTC(2026, 4, 19),
    });
    expect(buckets.map((b) => b.day)).toEqual(["2026-05-17", "2026-05-18"]);
    expect(buckets[0]!.comparison.cascade.helpfulRate).toBe(1);
    expect(buckets[0]!.comparison.sync.helpfulRate).toBe(0);
    expect(buckets[1]!.comparison.cascade.helpfulRate).toBe(0);
    expect(buckets[1]!.comparison.sync.helpfulRate).toBeNull();
  });
});
