/**
 * Phase D.1 query-compiler eval — frozen, deterministic, $0 (no model/network).
 *
 * Pins the verdict: routing structured signal to the literal lane and mechanism
 * prose to a distilled causal lane LIFTS decision recall (sparse 0.143 → literal
 * 0.286 → causal 0.571) with precision 1.0 and ZERO false positives across all
 * arms — a genuine candidate-generation lever, not token reshuffling, and no FP
 * cost. Constants are not tuned to this fixture.
 */
import { describe, it, expect } from "vitest";
import { runQueryCompilerEval } from "../../scripts/reasoning-precision/query-compiler-eval.js";

describe("phase-d.1 query-compiler eval (frozen)", () => {
  it("the causal lane lifts decision recall with zero FP; not reshuffling", async () => {
    const r = await runQueryCompilerEval();

    expect(r.corpusHash).toBe("ceaf0190f160f6bf");
    expect(r.acceptedFamilies).toBe(6);

    // (1) Monotonic recall lift: sparse < literal < causal.
    expect(r.arms.sparse.recallAtUseful).toBeCloseTo(0.143, 3);
    expect(r.arms.literal.recallAtUseful).toBeCloseTo(0.286, 3);
    expect(r.arms.causal.recallAtUseful).toBeCloseTo(0.571, 3);
    expect(r.arms.causal.recallAtUseful).toBeGreaterThan(r.arms.literal.recallAtUseful);
    expect(r.arms.literal.recallAtUseful).toBeGreaterThan(r.arms.sparse.recallAtUseful);

    // (2) Precision is perfect and FP is zero in EVERY arm — the lift costs no FP.
    expect(r.arms.sparse.precisionAtFire).toBe(1);
    expect(r.arms.literal.precisionAtFire).toBe(1);
    expect(r.arms.causal.precisionAtFire).toBe(1);
    expect(r.arms.sparse.fpRate).toBe(0);
    expect(r.arms.literal.fpRate).toBe(0);
    expect(r.arms.causal.fpRate).toBe(0);
    expect(r.arms.causal.semanticLaneFP).toBe(0);

    // (3) The causal lane is a real candidate-generation lever (not reshuffling):
    //     it surfaced candidates FTS+literal missed and converted some to decisions.
    expect(r.causalLift.causalAddedDecisions).toBe(2);
    expect(r.causalLift.causalSemanticOnlyTotal).toBeGreaterThan(0);
    expect(r.causalLift.causalLaneInvoked).toBeGreaterThan(0); // cascade ran the causal lane
    expect(r.verdict.reshufflingOnly).toBe(false);
    expect(r.verdict.causalAddsRecall).toBe(true);
    expect(r.verdict.fpHeld).toBe(true);

    // (4) Bounded latency + fail-open / remote-refusal probes.
    expect(r.latency.incrementalP95).toBeLessThan(5000);
    expect(r.probes.providerTimeoutFailOpen).toBe(true);
    expect(r.probes.remoteEngagedWithoutOptIn).toBe(false);

    expect(r.organicReadiness).toMatch(/N\/A/);
  });
});
