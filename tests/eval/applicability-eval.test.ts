/**
 * Phase D.2 applicability eval — frozen, deterministic, $0 (no model/network).
 *
 * Pins the verdict: the §4.5 reranker recovers the DECISION recall V4 abstains on
 * (strong prose-only positives: 0 → 1.0) AND tightens precision (it withholds the
 * negative V4 false-fired), with ZERO new false positives across six adversary
 * types — and the shipped 0.5 strong-single-field floor sits in a stable plateau.
 * Recall gain at NO precision cost; not fixture-tuned.
 */
import { describe, it, expect } from "vitest";
import { runApplicabilityEval } from "../../scripts/reasoning-precision/applicability-eval.js";

describe("phase-d.2 applicability eval (frozen)", () => {
  it("the reranker recovers prose-only recall with no precision loss", async () => {
    const r = await runApplicabilityEval();

    expect(r.corpusHash).toBe("81bc9729a00f3239");
    expect(r.corpus.adversaries.sort()).toEqual([
      "dialogue-ambiguity",
      "harmful-pitfall",
      "misleading-api",
      "missing-invariant",
      "sibling-collision",
      "stale",
      "strong-positive",
    ]);

    // (1) V4 abstains on the strong prose-only positives (the D.1 residual).
    expect(r.arms.v4.recallAtUseful).toBe(0);

    // (2) The reranker recovers ALL of them with perfect precision and ZERO FP.
    expect(r.arms.reranker.recallAtUseful).toBe(1);
    expect(r.arms.reranker.precisionAtFire).toBe(1);
    expect(r.arms.reranker.fpRate).toBe(0);

    // (3) Precision is HELD (in fact improved): the reranker FP rate does not
    //     exceed V4's, and it withholds the negative V4 false-fired.
    expect(r.arms.reranker.fpRate).toBeLessThanOrEqual(r.arms.v4.fpRate);
    expect(r.changedDecisions.rerankerOnlyApply).toBe(3);
    expect(r.changedDecisions.recoveredUseful.sort()).toEqual(["strong/deadlock", "strong/float-acc", "strong/lost-update"]);
    expect(r.changedDecisions.falsePositives).toEqual([]); // no recovery was a false positive
    expect(r.changedDecisions.rerankerWithholds).toBeGreaterThanOrEqual(1);

    // (4) Latency bounded; timeout fails open.
    expect(r.latency.p95).toBeLessThan(5000);
    expect(r.probes.timeoutFailOpen).toBe(true);

    // (5) Sensitivity: the shipped 0.5 floor recovers all positives with no FP,
    //     and sits in a stable plateau (the leak never opens; recall is maximal).
    const at = (f: number) => r.sensitivity.find((s) => s.strongSingleField === f)!;
    expect(at(0.5).usefulRecovered).toBe(3);
    expect(at(0.5).negativeFP).toBe(0);
    expect(at(0.3).negativeFP).toBe(0); // no FP even at the most permissive floor
    expect(at(0.4).usefulRecovered).toBe(3); // recall stable across the plateau

    // (6) Verdict.
    expect(r.verdict.recoversRecall).toBe(true);
    expect(r.verdict.precisionHeld).toBe(true);
    expect(r.organicReadiness).toMatch(/N\/A/);
  });
});
