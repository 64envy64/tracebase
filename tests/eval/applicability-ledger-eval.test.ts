/**
 * Phase D.3 applicability ledger eval — frozen, deterministic, $0.
 *
 * Pins the replay table on a frozen corpus exercising every join case, and adds
 * ADVERSARIAL tests that try to break the honesty rule (label an unserved apply,
 * poison a replay via cross-run / stale-version rows). The reranker's WITHHOLD
 * value is identifiable (beats baseline-v4 precision on the served subset); its
 * APPLY value stays a counterfactual opportunity.
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent } from "../../src/types.js";
import { runApplicabilityLedgerEval } from "../../scripts/reasoning-precision/applicability-ledger-eval.js";
import { joinApplicabilityTrials } from "../../src/analytics/applicability-ledger.js";
import { replayApplicabilityPolicy, POLICIES } from "../../src/analytics/applicability-replay.js";

describe("phase-d.3 applicability ledger eval (frozen)", () => {
  it("classifies every case and reports identifiable-vs-counterfactual honestly", () => {
    const r = runApplicabilityLedgerEval();
    expect(r.corpusHash).toBe("f21d66680b9b1b86");
    const rep = r.report;

    expect(rep.totalTrials).toBe(9);
    expect(rep.observability).toEqual({ observed_exposed: 5, observed_holdout: 1, counterfactual_unobserved: 1, incomplete: 2 });
    expect(rep.diagnostics.crossRun).toBe(1);
    expect(rep.diagnostics.featureVersionMismatch).toBe(1);

    // Reranker: identifiable precision 1.0 + perfect withhold-correctness on the
    // served subset; its recall (apply) value is 1 counterfactual opportunity.
    const rr = rep.policies["reranker"]!;
    expect(rr.observedTrials).toBe(4); // the v0 stale trial is excluded
    expect(rr.identifiable.precisionAtObservedFire).toBe(1);
    expect(rr.identifiable.withholdCorrectness).toBe(1);
    expect(rr.unidentifiable.applyOpportunities).toBe(1);
    expect(rr.staleFeatureVersion).toBe(1);

    // The withhold value is IDENTIFIABLE: reranker beats baseline-v4 precision by
    // withholding the harmful inject baseline served.
    expect(rep.policies["baseline-v4"]!.identifiable.precisionAtObservedFire).toBe(0.75);

    // Readiness honestly NOT READY: synthetic corpus, 0 organic.
    expect(rep.corpus.organic).toBe(0);
    expect(rep.readiness.ready).toBe(false);
    expect(rep.counterfactualApplyOpportunities).toBe(1);
  });

  // ── Adversarial: the honesty rule must resist crafted event logs ──
  it("ADVERSARIAL: a spurious agent_used cannot label an UNSERVED apply", () => {
    const events: AnalyticsEvent[] = [
      { event: "reasoning.applicability_comparison", ts: 0, queryId: "atk", queryHash: "q", corpusSize: 5, candidateCount: 2, v4Action: "abstain", applicabilityProvider: "p", applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "reranker_only_apply", applicabilityTopBlockId: "want", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1 } as AnalyticsEvent,
      // baseline injected a DIFFERENT block, not "want"
      { event: "injection", ts: 1, queryId: "atk", blockId: "other", score: 0.9, featureVersion: 4 } as AnalyticsEvent,
      // a (spurious) agent_used claiming the apply-target was used
      { event: "agent_used", ts: 2, queryId: "atk", blockId: "want", matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit" } as AnalyticsEvent,
      { event: "outcome", ts: 3, queryId: "atk", resolved: true, control: false } as AnalyticsEvent,
    ];
    const t = joinApplicabilityTrials(events).trials[0]!;
    expect(t.candidateBlockId).toBe("want");
    expect(t.baselineExposed).toBe(false); // "want" was never injected
    expect(t.observability).toBe("counterfactual_unobserved");
    expect(t.label).toBeUndefined(); // the spurious agent_used cannot fabricate a label
  });

  it("ADVERSARIAL: a stale-version harmful row cannot poison a replay's precision", () => {
    const helpful = (q: string): AnalyticsEvent[] => [
      { event: "reasoning.applicability_comparison", ts: 0, queryId: q, queryHash: "q", corpusSize: 5, candidateCount: 1, v4Action: "inject", v4TopBlockId: q, applicabilityTopBlockId: q, applicabilityProvider: "p", applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "none", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1 } as AnalyticsEvent,
      { event: "injection", ts: 1, queryId: q, blockId: q, score: 0.9, featureVersion: 4 } as AnalyticsEvent,
      { event: "agent_used", ts: 2, queryId: q, blockId: q, matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit" } as AnalyticsEvent,
      { event: "outcome", ts: 3, queryId: q, resolved: true, control: false } as AnalyticsEvent,
    ];
    // One in-version helpful + one STALE (v0) harmful served row.
    const stale: AnalyticsEvent[] = [
      { event: "reasoning.applicability_comparison", ts: 4, queryId: "stale", queryHash: "q", corpusSize: 5, candidateCount: 1, v4Action: "inject", v4TopBlockId: "sb", applicabilityTopBlockId: "sb", applicabilityProvider: "p", applicabilityFeatureVersion: 0, applicabilityVerdict: "applicable", changedDecision: "none", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1 } as AnalyticsEvent,
      { event: "injection", ts: 5, queryId: "stale", blockId: "sb", score: 0.9, featureVersion: 4 } as AnalyticsEvent,
      { event: "outcome", ts: 6, queryId: "stale", resolved: false, regressed: true, control: false } as AnalyticsEvent,
    ];
    const { trials } = joinApplicabilityTrials([...helpful("g"), ...stale], { featureVersion: 1 });
    const r = replayApplicabilityPolicy(trials, POLICIES.reranker!, "reranker", { featureVersion: 1 });
    expect(r.staleFeatureVersion).toBe(1);
    expect(r.observedTrials).toBe(1); // only the in-version helpful row
    expect(r.identifiable.precisionAtObservedFire).toBe(1); // the v0 harmful row excluded
  });
});
