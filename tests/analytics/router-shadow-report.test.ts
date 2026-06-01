/**
 * Router V2 shadow report aggregation — pure, deterministic.
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent, RouterShadowComparisonEvent, OutcomeEvent } from "../../src/types.js";
import { aggregateRouterShadow, type ProvenanceClass } from "../../src/analytics/router-shadow-report.js";

function mkShadow(o: Partial<RouterShadowComparisonEvent> & { queryId: string }): RouterShadowComparisonEvent {
  return {
    event: "router.shadow_comparison",
    ts: 1,
    queryHash: "q_x",
    corpusSize: 10,
    candidateCount: 5,
    v1Action: "abstain",
    v1Reason: "ambiguous_margin",
    v1Confidence: 0.5,
    v1Margin: 0.05,
    v1FeatureVersion: 1,
    v1LatencyMs: 1,
    v2Action: "inject",
    v2Reason: "injected",
    v2Confidence: 0.8,
    v2Margin: 0.5,
    v2FeatureVersion: 2,
    v2LatencyMs: 2,
    v2OverheadMs: 2,
    agreement: "v2_only_inject",
    resolverName: "structured-signature.v2",
    familyCount: 2,
    topFamilySupport: 1,
    topFamilySourceDiversity: 1,
    topFamilyContradiction: 0,
    runnerUpFamilyConfidence: 0.2,
    familyMargin: 0.6,
    bridgesPrevented: 0,
    redactedFieldCount: 0,
    ...o,
  } as RouterShadowComparisonEvent;
}

describe("router shadow report aggregation", () => {
  it("counts traffic, inject rates, and the disagreement matrix", () => {
    const events: AnalyticsEvent[] = [
      mkShadow({ queryId: "1", v1Action: "abstain", v2Action: "inject", agreement: "v2_only_inject" }),
      mkShadow({ queryId: "2", v1Action: "inject", v2Action: "inject", agreement: "agree_inject_same" }),
      mkShadow({ queryId: "3", v1Action: "abstain", v2Action: "abstain", agreement: "agree_abstain" }),
    ];
    const r = aggregateRouterShadow(events);
    expect(r.traffic).toBe(3);
    expect(r.v1.inject).toBe(1);
    expect(r.v2.inject).toBe(2);
    expect(r.agreement.v2_only_inject).toBe(1);
    expect(r.agreement.agree_inject_same).toBe(1);
    expect(r.agreement.agree_abstain).toBe(1);
    expect(r.agreementRate).toBeCloseTo(2 / 3, 3); // agree_inject_same + agree_abstain
  });

  it("separates organic from bootstrap by block provenance", () => {
    const events: AnalyticsEvent[] = [
      mkShadow({ queryId: "1", v2TopBlockId: "org-1", v2Action: "inject" }),
      mkShadow({ queryId: "2", v2TopBlockId: "boot-1", v2Action: "inject" }),
      mkShadow({ queryId: "3", v1Action: "abstain", v2Action: "abstain", v2TopBlockId: undefined, v1TopBlockId: undefined }),
    ];
    const classify = (id: string): ProvenanceClass => (id.startsWith("org") ? "organic" : id.startsWith("boot") ? "bootstrap" : "unknown");
    const r = aggregateRouterShadow(events, classify);
    expect(r.byProvenance.organic.traffic).toBe(1);
    expect(r.byProvenance.organic.v2Inject).toBe(1);
    expect(r.byProvenance.bootstrap.traffic).toBe(1);
    expect(r.byProvenance.unknown.traffic).toBe(1); // the abstain-on-both recall
  });

  it("counts organic recurring-family hits (support>=2 AND organic)", () => {
    const events: AnalyticsEvent[] = [
      mkShadow({ queryId: "1", v2TopBlockId: "org-1", topFamilySupport: 2 }), // organic recurring
      mkShadow({ queryId: "2", v2TopBlockId: "org-2", topFamilySupport: 1 }), // organic singleton
      mkShadow({ queryId: "3", v2TopBlockId: "boot-1", topFamilySupport: 3 }), // bootstrap recurring (does NOT count organic)
    ];
    const classify = (id: string): ProvenanceClass => (id.startsWith("org") ? "organic" : "bootstrap");
    const r = aggregateRouterShadow(events, classify);
    expect(r.organicRecurringFamilyHits).toBe(1);
    expect(r.topFamilySupportDistribution["2"]).toBe(1);
    expect(r.topFamilySupportDistribution["3"]).toBe(1);
  });

  it("aggregates bridges-prevented, redactions, fallbacks, and overhead percentiles", () => {
    const events: AnalyticsEvent[] = [
      mkShadow({ queryId: "1", bridgesPrevented: 2, redactedFieldCount: 1, v2OverheadMs: 1 }),
      mkShadow({ queryId: "2", bridgesPrevented: 0, redactedFieldCount: 0, v2OverheadMs: 5, v2FallbackReason: "boom", v2Action: "abstain", v2Reason: "error" }),
    ];
    const r = aggregateRouterShadow(events);
    expect(r.bridgesPreventedTotal).toBe(2);
    expect(r.bridgesPreventedRecalls).toBe(1);
    expect(r.redactionTotal).toBe(1);
    expect(r.fallbackCount).toBe(1);
    expect(r.v2OverheadMsP95).toBeGreaterThanOrEqual(r.v2OverheadMsP50);
  });

  it("joins served-path outcomes by queryId (where available)", () => {
    const events: AnalyticsEvent[] = [
      mkShadow({ queryId: "q1", v1Action: "inject", v1TopBlockId: "org-1" }),
      { event: "outcome", ts: 2, queryId: "q1", resolved: true, control: false } as OutcomeEvent,
      mkShadow({ queryId: "q2", v1Action: "inject", v1TopBlockId: "org-2" }),
    ];
    const r = aggregateRouterShadow(events, () => "organic");
    expect(r.attributedOutcomes.withOutcome).toBe(1);
    expect(r.attributedOutcomes.resolved).toBe(1);
  });

  it("surfaces readiness blockers (bootstrap-only / no organic recurring / no outcomes)", () => {
    const events: AnalyticsEvent[] = [mkShadow({ queryId: "1", v2TopBlockId: "boot-1", topFamilySupport: 1 })];
    const r = aggregateRouterShadow(events, () => "bootstrap");
    expect(r.readinessBlockers.some((b) => b.includes("no organic shadow traffic"))).toBe(true);
    expect(r.readinessBlockers.some((b) => b.includes("no attributed served-path outcomes"))).toBe(true);
  });

  it("empty stream → zeroed report, blockers listed, never throws", () => {
    const r = aggregateRouterShadow([]);
    expect(r.traffic).toBe(0);
    expect(r.v1.injectRate).toBe(0);
    expect(r.readinessBlockers.length).toBeGreaterThan(0);
  });
});
