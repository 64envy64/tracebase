/**
 * Phase D.3 — applicability ledger report + readiness. The headline readiness
 * truth: when the reranker's apply value is entirely counterfactual (unserved),
 * the report says NOT READY and names "a served canary is required".
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent } from "../../src/types.js";
import { buildApplicabilityLedgerReport, MIN_OBSERVED_ORGANIC } from "../../src/analytics/applicability-ledger-report.js";
import type { TrialProvenanceClass } from "../../src/analytics/applicability-replay.js";

let ts = 0;
const cmp = (queryId: string, changedDecision: "none" | "reranker_only_apply" | "reranker_withholds", o: Record<string, unknown> = {}): AnalyticsEvent =>
  ({ event: "reasoning.applicability_comparison", ts: ts++, queryId, queryHash: "q", corpusSize: 9, candidateCount: 2, v4Action: "abstain", applicabilityProvider: "deterministic-applicability.v1", applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1, changedDecision, ...o }) as AnalyticsEvent;
const inj = (queryId: string, blockId: string): AnalyticsEvent => ({ event: "injection", ts: ts++, queryId, blockId, score: 0.9, featureVersion: 4 }) as AnalyticsEvent;
const used = (queryId: string, blockId: string): AnalyticsEvent => ({ event: "agent_used", ts: ts++, queryId, blockId, matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit" }) as AnalyticsEvent;
const out = (queryId: string, o: Record<string, unknown> = {}): AnalyticsEvent => ({ event: "outcome", ts: ts++, queryId, resolved: true, control: false, ...o }) as AnalyticsEvent;

describe("buildApplicabilityLedgerReport", () => {
  it("flags NOT READY when the reranker's apply value is entirely counterfactual", () => {
    // Two reranker_only_apply trials: reranker wants to apply, baseline abstained,
    // nothing served → unidentifiable. A served canary is the only way to learn.
    const events: AnalyticsEvent[] = [
      cmp("c1", "reranker_only_apply", { applicabilityTopBlockId: "b1" }), out("c1"),
      cmp("c2", "reranker_only_apply", { applicabilityTopBlockId: "b2" }), out("c2"),
    ];
    const r = buildApplicabilityLedgerReport(events, { featureVersion: 1 });
    expect(r.observability.counterfactual_unobserved).toBe(2);
    expect(r.observability.observed_exposed).toBe(0);
    expect(r.counterfactualApplyOpportunities).toBe(2);
    expect(r.readiness.ready).toBe(false);
    expect(r.readiness.blockers.some((b) => b.includes("served canary is required"))).toBe(true);
  });

  it("scores served trials but still gates readiness on organic volume", () => {
    const events: AnalyticsEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(cmp(`s${i}`, "none", { v4Action: "inject", v4TopBlockId: `org-${i}`, applicabilityTopBlockId: `org-${i}` }), inj(`s${i}`, `org-${i}`), used(`s${i}`, `org-${i}`), out(`s${i}`));
    }
    const classifyBlock = (id: string): TrialProvenanceClass => (id.startsWith("org") ? "organic" : "unknown");
    const r = buildApplicabilityLedgerReport(events, { featureVersion: 1, classifyBlock });
    expect(r.observability.observed_exposed).toBe(3);
    expect(r.policies["reranker"]!.identifiable.precisionAtObservedFire).toBe(1);
    expect(r.corpus.organic).toBe(3);
    // 3 < MIN_OBSERVED_ORGANIC → not ready (volume blocker), even with perfect precision.
    expect(MIN_OBSERVED_ORGANIC).toBeGreaterThan(3);
    expect(r.readiness.ready).toBe(false);
    expect(r.readiness.blockers.some((b) => b.includes("ORGANIC"))).toBe(true);
  });

  it("empty event log → zero trials, not ready, never throws", () => {
    const r = buildApplicabilityLedgerReport([]);
    expect(r.totalTrials).toBe(0);
    expect(r.readiness.ready).toBe(false);
  });
});
