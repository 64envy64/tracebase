/**
 * Phase D.3 — off-policy replay over frozen trials. Identifiable metrics are
 * scored ONLY from served outcomes; apply-on-counterfactual is an opportunity,
 * never a fire. No causal claim from shadow-only rows.
 */
import { describe, it, expect } from "vitest";
import { replayApplicabilityPolicy, replayNamedPolicies, POLICIES, type TrialProvenanceClass } from "../../src/analytics/applicability-replay.js";
import type { ApplicabilityTrialV1 } from "../../src/analytics/applicability-ledger.js";

function trial(o: Partial<ApplicabilityTrialV1> & { queryId: string; observability: ApplicabilityTrialV1["observability"] }): ApplicabilityTrialV1 {
  return {
    trialVersion: 1,
    queryHash: "q",
    policyVersion: "deterministic-applicability.v1",
    applicabilityFeatureVersion: 1,
    changedDecision: "none",
    v4Action: "abstain",
    applicabilityVerdict: "applicable",
    baselineExposed: false,
    holdout: false,
    latencyMs: 2,
    ...o,
  } as ApplicabilityTrialV1;
}

describe("replayApplicabilityPolicy", () => {
  it("scores precision@observed-fire + withhold-correctness from served rows only", () => {
    const trials: ApplicabilityTrialV1[] = [
      // applied (verdict applicable) + observed + helpful → a correct fire.
      trial({ queryId: "1", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b1", label: "helpful", applicabilityVerdict: "applicable" }),
      // applied + observed + harmful → an incorrect fire.
      trial({ queryId: "2", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b2", label: "harmful", applicabilityVerdict: "applicable" }),
      // withheld (verdict inapplicable) + observed + the served block was harmful → correct withhold.
      trial({ queryId: "3", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b3", label: "harmful", applicabilityVerdict: "inapplicable" }),
      // withheld + observed + the served block was helpful → WRONG withhold.
      trial({ queryId: "4", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b4", label: "helpful", applicabilityVerdict: "inapplicable" }),
    ];
    const r = replayApplicabilityPolicy(trials, POLICIES.reranker!, "reranker");
    expect(r.observedTrials).toBe(4);
    expect(r.identifiable.applied).toBe(2);
    expect(r.identifiable.helpfulFires).toBe(1);
    expect(r.identifiable.precisionAtObservedFire).toBe(0.5);
    expect(r.identifiable.withheld).toBe(2);
    expect(r.identifiable.withholdCorrect).toBe(1); // b3 harmful → correct; b4 helpful → wrong
    expect(r.identifiable.withholdCorrectness).toBe(0.5);
    expect(r.identifiable.coverage).toBe(0.5);
    expect(r.completeness).toBe(1);
  });

  it("counts apply-on-counterfactual as an opportunity, NEVER a fire (no causal claim)", () => {
    const trials: ApplicabilityTrialV1[] = [
      trial({ queryId: "c1", observability: "counterfactual_unobserved", changedDecision: "reranker_only_apply", applicabilityVerdict: "applicable" }),
      trial({ queryId: "c2", observability: "counterfactual_unobserved", changedDecision: "reranker_only_apply", applicabilityVerdict: "applicable" }),
    ];
    const r = replayApplicabilityPolicy(trials, POLICIES.reranker!, "reranker");
    expect(r.observedTrials).toBe(0);
    expect(r.identifiable.applied).toBe(0);
    expect(r.identifiable.precisionAtObservedFire).toBeNull(); // nothing to score
    expect(r.unidentifiable.applyOpportunities).toBe(2);
    expect(r.completeness).toBe(0);
  });

  it("separates holdout + incomplete rows and reports a Wilson lower bound", () => {
    const trials: ApplicabilityTrialV1[] = [
      trial({ queryId: "1", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b1", label: "helpful" }),
      trial({ queryId: "2", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b2", label: "helpful" }),
      trial({ queryId: "h", observability: "observed_holdout", holdout: true }),
      trial({ queryId: "i", observability: "incomplete" }),
    ];
    const r = replayApplicabilityPolicy(trials, POLICIES.reranker!, "reranker");
    expect(r.unidentifiable.holdoutRows).toBe(1);
    expect(r.unidentifiable.incompleteRows).toBe(1);
    expect(r.identifiable.precisionAtObservedFire).toBe(1);
    expect(r.identifiable.wilsonLB).toBeGreaterThan(0);
    expect(r.identifiable.wilsonLB!).toBeLessThan(1); // a LB below the point estimate
  });

  it("excludes stale feature-version trials from the replay", () => {
    const trials: ApplicabilityTrialV1[] = [
      trial({ queryId: "1", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b1", label: "helpful", applicabilityFeatureVersion: 1 }),
      trial({ queryId: "2", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b2", label: "harmful", applicabilityFeatureVersion: 99 }),
    ];
    const r = replayApplicabilityPolicy(trials, POLICIES.reranker!, "reranker", { featureVersion: 1 });
    expect(r.staleFeatureVersion).toBe(1);
    expect(r.observedTrials).toBe(1);
    expect(r.identifiable.precisionAtObservedFire).toBe(1);
  });

  it("splits the observed corpus by provenance (organic gates readiness)", () => {
    const classifyBlock = (id: string): TrialProvenanceClass => (id.startsWith("org") ? "organic" : id.startsWith("syn") ? "synthetic" : "bootstrap");
    const trials: ApplicabilityTrialV1[] = [
      trial({ queryId: "1", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "org-1", label: "helpful" }),
      trial({ queryId: "2", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "syn-1", label: "helpful" }),
    ];
    const r = replayApplicabilityPolicy(trials, POLICIES.reranker!, "reranker", { classifyBlock });
    expect(r.corpus.organic).toBe(1);
    expect(r.corpus.synthetic).toBe(1);
  });

  it("replays every named policy deterministically", () => {
    const trials: ApplicabilityTrialV1[] = [
      trial({ queryId: "1", observability: "observed_exposed", baselineExposed: true, candidateBlockId: "b1", label: "helpful", applicabilityVerdict: "applicable", v4Action: "abstain" }),
    ];
    const a = replayNamedPolicies(trials);
    const b = replayNamedPolicies(trials);
    expect(a).toEqual(b);
    // reranker applies (verdict applicable), baseline-v4 withholds (v4 abstained).
    expect(a["reranker"]!.identifiable.applied).toBe(1);
    expect(a["baseline-v4"]!.identifiable.applied).toBe(0);
  });
});
