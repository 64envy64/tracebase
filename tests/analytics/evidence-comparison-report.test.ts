/**
 * Phase C.2 ServingEvidenceV3 report aggregation — pure, deterministic.
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent, ReasoningEvidenceComparisonEvent } from "../../src/types.js";
import { aggregateEvidenceComparison, type ProvenanceClass } from "../../src/analytics/evidence-comparison-report.js";

function mk(o: Partial<ReasoningEvidenceComparisonEvent> & { queryId: string }): ReasoningEvidenceComparisonEvent {
  return {
    event: "reasoning.evidence_comparison",
    ts: 1,
    queryHash: "q_x",
    corpusSize: 10,
    candidateCount: 3,
    servedAction: "abstain",
    servedReason: "weak_evidence",
    servedFeatureVersion: 2,
    v3Action: "inject",
    v3Reason: "injected",
    lane: "semantic-license",
    licenseReason: "structured-corroborated",
    agreement: "v3_only_inject",
    semanticOnlyCandidates: 1,
    licensedCandidates: 1,
    redactedFieldCount: 0,
    fallback: "none",
    latencyMs: 2,
    ...o,
  } as ReasoningEvidenceComparisonEvent;
}

describe("evidence comparison report aggregation", () => {
  it("counts traffic, lanes, license reasons, and agreement", () => {
    const events: AnalyticsEvent[] = [
      mk({ queryId: "1", agreement: "v3_only_inject", lane: "semantic-license", licenseReason: "structured-corroborated" }),
      mk({ queryId: "2", agreement: "agree_abstain", lane: "lexical", licenseReason: "lexical", v3Action: "abstain", v3Reason: "weak_evidence", licensedCandidates: 0, semanticOnlyCandidates: 0 }),
      mk({ queryId: "3", agreement: "agree_inject_same", lane: "lexical", licenseReason: "lexical", servedAction: "inject", v3Action: "inject", licensedCandidates: 0 }),
    ];
    const r = aggregateEvidenceComparison(events);
    expect(r.traffic).toBe(3);
    expect(r.byLane["semantic-license"]).toBe(1);
    expect(r.byLane["lexical"]).toBe(2);
    expect(r.byLicenseReason["structured-corroborated"]).toBe(1);
    expect(r.agreement.v3_only_inject).toBe(1);
    expect(r.recallsWithLicense).toBe(1);
    expect(r.decisionDisagreementRate).toBeCloseTo(1 / 3, 3); // only v3_only_inject disagrees
  });

  it("separates organic vs bootstrap and surfaces conversion", () => {
    const events: AnalyticsEvent[] = [
      mk({ queryId: "1", v3TopBlockId: "org-1", agreement: "v3_only_inject", licensedCandidates: 1 }),
      mk({ queryId: "2", v3TopBlockId: "boot-1", agreement: "v3_only_inject", licensedCandidates: 1 }),
    ];
    const classify = (id: string): ProvenanceClass => (id.startsWith("org") ? "organic" : "bootstrap");
    const r = aggregateEvidenceComparison(events, classify);
    expect(r.byProvenance.organic.v3OnlyInject).toBe(1);
    expect(r.byProvenance.bootstrap.v3OnlyInject).toBe(1);
  });

  it("surfaces readiness blockers + flags fallbacks; empty never throws", () => {
    expect(aggregateEvidenceComparison([]).traffic).toBe(0);
    const r = aggregateEvidenceComparison([mk({ queryId: "1", v3TopBlockId: "boot-1", fallback: "error" })], () => "bootstrap");
    expect(r.readinessBlockers.some((b) => b.includes("no organic shadow traffic"))).toBe(true);
    expect(r.readinessBlockers.some((b) => b.includes("V3 fallback error"))).toBe(true);
  });
});
