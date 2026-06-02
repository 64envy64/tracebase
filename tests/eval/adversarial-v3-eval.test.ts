/**
 * Phase C.2 adversarial eval — frozen, deterministic, $0 (no model/network).
 *
 * Guards the INVARIANTS Phase C.2 must hold, plus the frozen outcomes of the
 * current corpus. The eval's verdict GATES promotion of ServingEvidenceV3 from
 * shadow → on; this test pins that verdict (currently: NOT ready — one semantic-
 * license-lane FP from a same-domain body-token collision). If a future change
 * closes that leak, these expectations should be updated deliberately.
 */
import { describe, it, expect } from "vitest";
import { runAdversarialEval } from "../../scripts/reasoning-precision/adversarial-v3-eval.js";

describe("phase-c.2 adversarial eval (frozen)", () => {
  it("conversion + invariants + safety probes + promotion verdict", async () => {
    const r = await runAdversarialEval();

    // Frozen corpus + clean ingest (no leaky bodies rejected).
    expect(r.corpusHash).toBe("590e0d724fa64628");
    expect(r.acceptedFamilies).toBe(5);
    expect(r.corpus.negativeTypes.sort()).toEqual(["body-token-collision", "disjoint", "sibling-family", "wrong-mechanism"]);

    const sparse = r.arms["sparse-v2"];
    const hybridV2 = r.arms["hybrid-v2"];
    const v3 = r.arms["hybrid-v3-shadow"];

    // (1) Hybrid lifts CANDIDATE recall; V3 converts it to DECISION recall.
    expect(hybridV2.candidateRecallAtUseful).toBe(1);
    expect(sparse.candidateRecallAtUseful!).toBeLessThan(1);
    expect(v3.recallAtUseful!).toBeGreaterThan(hybridV2.recallAtUseful!); // 0.3 > 0.1

    // (2) The clean headline: EVERY semantic-only candidate the hybrid path newly
    //     surfaced (FTS missed) was licensed + fired CORRECTLY by V3 — and V2 got
    //     none of them. Candidate-recall lift → decision-recall conversion.
    expect(r.conversion.semanticOnlyUseful).toBe(2);
    expect(r.conversion.convertedByV3).toBe(2);
    expect(r.conversion.conversionRate).toBe(1);
    expect(r.conversion.v2RecallOnThose).toBe(0);

    // (3) Phase C.2 adds NO new lexical-lane FP: the two V2 arms decide negatives
    //     identically (hybrid is candidate-additive; V2 won't fire a body-only one).
    expect(r.lexicalLaneInvariant).toBe(true);
    expect(sparse.falsePositiveRateNegatives).toBe(0);
    expect(hybridV2.falsePositiveRateNegatives).toBe(0);
    expect(sparse.precisionAtFire).toBe(1);

    // (4) Family separation rejects the ambiguous siblings; disjoint + wrong-
    //     mechanism (reworded, no body corroboration) are rejected too.
    expect(v3.fpByType["sibling-family"]).toEqual({ fired: 0, total: 2 });
    expect(v3.fpByType["disjoint"]).toEqual({ fired: 0, total: 2 });
    expect(v3.fpByType["wrong-mechanism"]).toEqual({ fired: 0, total: 2 });

    // (5) The ONE residual FP is a semantic-license-lane body-token collision
    //     (same-domain float-rounding vocabulary). Pinned as the frozen weakness.
    expect(v3.fpByType["body-token-collision"]).toEqual({ fired: 1, total: 2 });
    expect(v3.semanticLicenseLaneFP).toBeCloseTo(0.125, 3);
    expect(v3.fpByLane.lexical).toBe(0); // the leak is NOT from the lexical lane
    expect(v3.precisionAtFire).toBeCloseTo(0.75, 3);

    // (6) Safety / robustness / privacy probes — all must pass.
    expect(r.probes.misleadingProviderRank.decoyInjections).toBe(0); // RRF rank never becomes confidence
    expect(r.probes.misleadingProviderRank.candidateRecallUnderDecoy).toBe(1);
    expect(r.probes.providerTimeout.failOpenParityWithSparse).toBe(true);
    expect(r.probes.remoteBoundaryPrivacy.boundaryClean).toBe(true);
    expect(r.probes.remoteBoundaryPrivacy.scrubbed.sort()).toEqual(["abs-path", "api-key", "bearer-token"]);
    expect(r.probes.remoteBoundaryPrivacy.engagedWithoutOptIn).toBe(false); // remote never engaged implicitly
    expect(r.probes.remoteBoundaryPrivacy.noOptInParityWithSparse).toBe(true);
    expect(r.targets.safetyProbesPass).toBe(true);

    // (7) The verbatim-symptom lexical bullseye fires in ALL THREE arms (a pre-
    //     existing V2 trigger property, arm-invariant — disclosed, not a regression).
    expect(r.probes.lexicalBullseye.armInvariant).toBe(true);
    expect(r.probes.lexicalBullseye.firesV3).toBe(true);
    expect(r.probes.lexicalBullseye.v3Lane).toBe("lexical");

    // (8) Verdict: NOT ready to promote shadow → on (semantic-lane FP > ceiling).
    //     The default-off/shadow posture is the safe state these blockers validate.
    expect(r.promotion.readyForOn).toBe(false);
    expect(r.promotion.blockers.length).toBeGreaterThan(0);

    // (9) Organic readiness is N/A here; latency is bounded.
    expect(r.organicReadiness).toMatch(/N\/A/);
    expect(v3.latencyMsP95).toBeGreaterThanOrEqual(0);
    expect(v3.latencyMsP95).toBeLessThan(5000);
  });
});
