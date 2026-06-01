/**
 * Phase D.4 — canary exposure events threaded into the D.3 ledger/replay. A
 * `treatment` exposure SERVED the candidate (injection emitted), turning a
 * formerly-counterfactual `reranker_only_apply` into an OBSERVED, labelled trial;
 * a `control` exposure stays counterfactual. The report's readiness recognizes
 * canary-observed applies.
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent } from "../../src/types.js";
import { joinApplicabilityTrials } from "../../src/analytics/applicability-ledger.js";
import { replayApplicabilityPolicy, POLICIES } from "../../src/analytics/applicability-replay.js";
import { buildApplicabilityLedgerReport } from "../../src/analytics/applicability-ledger-report.js";

let ts = 0;
const cmp = (queryId: string, blockId: string): AnalyticsEvent =>
  ({ event: "reasoning.applicability_comparison", ts: ts++, queryId, queryHash: "q", corpusSize: 5, candidateCount: 2, v4Action: "abstain", applicabilityProvider: "p", applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "reranker_only_apply", applicabilityTopBlockId: blockId, verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1 }) as AnalyticsEvent;
const exposure = (queryId: string, arm: "treatment" | "control", blockId: string): AnalyticsEvent =>
  ({ event: "reasoning.applicability_canary_exposure", ts: ts++, queryId, queryHash: "q", unitHash: "u_x", arm, propensity: 0.05, policyVersion: "p", applicabilityFeatureVersion: 1, blockId, eligibilityReason: "v4_abstain_reranker_applicable", outcomeCompatible: arm === "treatment" }) as AnalyticsEvent;
const inj = (queryId: string, blockId: string): AnalyticsEvent => ({ event: "injection", ts: ts++, queryId, blockId, score: 1, featureVersion: 4 }) as AnalyticsEvent;
const used = (queryId: string, blockId: string): AnalyticsEvent => ({ event: "agent_used", ts: ts++, queryId, blockId, matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit" }) as AnalyticsEvent;
const out = (queryId: string, o: Record<string, unknown> = {}): AnalyticsEvent => ({ event: "outcome", ts: ts++, queryId, resolved: true, control: false, ...o }) as AnalyticsEvent;

describe("canary exposure threading into the ledger", () => {
  it("a TREATMENT exposure makes a reranker_only_apply OBSERVABLE + labelled", () => {
    const events: AnalyticsEvent[] = [
      cmp("t1", "bT"), exposure("t1", "treatment", "bT"), inj("t1", "bT"), used("t1", "bT"), out("t1", { resolved: true }),
    ];
    const t = joinApplicabilityTrials(events).trials[0]!;
    expect(t.canary).toEqual({ arm: "treatment", propensity: 0.05 });
    expect(t.baselineExposed).toBe(true); // the canary injected it
    expect(t.observability).toBe("observed_exposed"); // no longer counterfactual!
    expect(t.label).toBe("helpful");
  });

  it("a CONTROL exposure stays counterfactual_unobserved (no injection, no label)", () => {
    const events: AnalyticsEvent[] = [cmp("c1", "bC"), exposure("c1", "control", "bC"), out("c1", { resolved: true })];
    const t = joinApplicabilityTrials(events).trials[0]!;
    expect(t.canary).toEqual({ arm: "control", propensity: 0.05 });
    expect(t.observability).toBe("counterfactual_unobserved");
    expect(t.label).toBeUndefined();
  });

  it("replay surfaces canary exposures + observedViaCanary", () => {
    const events: AnalyticsEvent[] = [
      cmp("t1", "bT"), exposure("t1", "treatment", "bT"), inj("t1", "bT"), used("t1", "bT"), out("t1"),
      cmp("c1", "bC"), exposure("c1", "control", "bC"), out("c1"),
    ];
    const { trials } = joinApplicabilityTrials(events);
    const r = replayApplicabilityPolicy(trials, POLICIES.reranker!, "reranker");
    expect(r.canary).toEqual({ treatmentExposed: 1, controlExposed: 1, observedViaCanary: 1 });
    expect(r.identifiable.applied).toBe(1); // the treatment-served apply, now scoreable
  });

  it("the report's 'served canary required' blocker LIFTS once a treatment apply is observed", () => {
    // Counterfactual-only first → blocker present.
    const cf: AnalyticsEvent[] = [cmp("c1", "bC"), out("c1")];
    const before = buildApplicabilityLedgerReport(cf, { featureVersion: 1 });
    expect(before.readiness.blockers.some((b) => b.includes("served canary is required"))).toBe(true);
    expect(before.canaryObservedApplies).toBe(0);

    // Add a treatment-served apply → that specific blocker lifts (others may remain).
    const withCanary: AnalyticsEvent[] = [cmp("t1", "bT"), exposure("t1", "treatment", "bT"), inj("t1", "bT"), used("t1", "bT"), out("t1")];
    const after = buildApplicabilityLedgerReport(withCanary, { featureVersion: 1 });
    expect(after.canaryObservedApplies).toBe(1);
    expect(after.readiness.blockers.some((b) => b.includes("served canary is required"))).toBe(false);
  });
});
