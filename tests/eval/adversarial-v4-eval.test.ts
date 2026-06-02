/**
 * Phase C.3 adversarial eval — frozen, deterministic, $0 (no model/network).
 *
 * Pins the verdict: V4's contrastive gate CLOSES the V3 same-domain-sibling leak
 * (semantic-lane FP 0.125 → 0, precision 0.667 → 1.0) at ZERO recall cost vs V3,
 * and a declared sensitivity sweep shows the shipped 0.5 majority floor is the
 * smallest that closes the collision. Constants are NOT tuned to this fixture.
 */
import { describe, it, expect } from "vitest";
import { runAdversarialV4Eval } from "../../scripts/reasoning-precision/adversarial-v4-eval.js";

describe("phase-c.3 adversarial eval (frozen)", () => {
  it("V4 closes the V3 sibling-collision leak at no recall cost + sensitivity is stable", async () => {
    const r = await runAdversarialV4Eval();

    expect(r.corpusHash).toBe("bfebdff7538b7a2d");
    expect(r.acceptedFamilies).toBe(6);
    expect(r.corpus.negativeTypes.sort()).toEqual(["ambiguous-sibling", "disjoint", "lexically-rich-wrong", "sibling-collision"]);

    const v2 = r.arms["sparse-v2"];
    const v3 = r.arms["hybrid-v3-shadow"];
    const v4 = r.arms["hybrid-v4-shadow"];

    // (1) Hybrid lifts candidate recall; V4 keeps V3's decision recall.
    expect(v4.candidateRecallAtUseful).toBe(1);
    expect(v2.candidateRecallAtUseful!).toBeLessThan(1);
    expect(v4.recallAtUseful).toBe(v3.recallAtUseful); // V4 costs no recall vs V3

    // (2) V4 closes the V3 leak: semantic-lane FP 0.125 → 0; precision 0.667 → 1.0.
    expect(v3.semanticLicenseLaneFP).toBeCloseTo(0.125, 3);
    expect(v4.semanticLicenseLaneFP).toBe(0);
    expect(v4.falsePositiveRateNegatives).toBe(0);
    expect(v3.precisionAtFire!).toBeLessThan(1);
    expect(v4.precisionAtFire).toBe(1);
    expect(v3.fpByType["sibling-collision"]).toEqual({ fired: 1, total: 2 });
    expect(v4.fpByType["sibling-collision"]).toEqual({ fired: 0, total: 2 });

    // (3) The contrastive tightening: V4 abstained on a negative V3 licensed, and
    //     cost no useful recall (V4 ⊑ V3 on this slate).
    expect(r.contrastive.v3FiredV4AbstainedNeg).toBeGreaterThanOrEqual(1);
    expect(r.contrastive.v3FiredV4AbstainedUseful).toBe(0);
    expect(r.contrastive.v4RecallRetainedVsV3).toBe(1);

    // (4) Material recall lift over the served V2 baseline.
    expect((v4.recallAtUseful ?? 0) - (v2.recallAtUseful ?? 0)).toBeGreaterThanOrEqual(r.targets.materialRecallLift);

    // (5) Probes: rank inversion, timeout, remote boundary, missing sibling.
    expect(r.probes.rankInversion.decoyInjectionsV4).toBe(0);
    expect(r.probes.providerTimeout.failOpenParityWithSparse).toBe(true);
    expect(r.probes.remoteBoundary.boundaryClean).toBe(true);
    expect(r.probes.remoteBoundary.engagedWithoutOptIn).toBe(false);
    expect(r.probes.remoteBoundary.scrubbed.sort()).toEqual(["abs-path", "api-key", "bearer-token"]);
    expect(r.probes.missingSibling.v4Action).toBe("abstain");
    expect(r.probes.missingSibling.v4LicenseReason).toBe("no-competitor");

    // (6) Sensitivity: the shipped 0.5 floor is the smallest that closes the
    //     collision (below it the leak reappears); the leak stays closed above it.
    const byMin = new Map(r.sensitivity.map((s) => [s.discriminativeSupportMin, s]));
    expect(byMin.get(0.3)!.collisionLicensed).toBeGreaterThan(0); // leak open below the majority floor
    expect(byMin.get(0.5)!.collisionLicensed).toBe(0); // closed at the shipped floor
    expect(byMin.get(0.6)!.collisionLicensed).toBe(0); // stays closed (stable plateau)
    expect(byMin.get(0.5)!.usefulLicensed).toBeGreaterThan(0); // not over-conservative in isolation

    // (7) Verdict.
    expect(r.targets.allMet).toBe(true);
    expect(r.verdict.closesLeak).toBe(true);
    expect(r.verdict.retainsRecall).toBe(true);
    expect(r.organicReadiness).toMatch(/N\/A/);
    expect(v4.latencyMsP95).toBeLessThan(5000);
  });
});
