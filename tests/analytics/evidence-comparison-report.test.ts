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
    // Phase C.3 V4 defaults (mirror V3 unless overridden).
    v4Action: "inject",
    v4Reason: "injected",
    v4LicenseReason: "structured-corroborated",
    v4LicensedCandidates: 1,
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

  it("aggregates the contrastive V4 lane: tightening, monotonicity, conservative abstains", () => {
    const events: AnalyticsEvent[] = [
      // V3 injected, V4 abstained on a same-domain collision (the tightening V4 exists for).
      mk({ queryId: "1", v3Action: "inject", v3TopBlockId: "org-1", v4Action: "abstain", v4Reason: "weak_evidence", v4LicenseReason: "ambiguous-sibling", v4LicensedCandidates: 0, agreement: "v3_only_inject", v4TopBlockId: "org-1" }),
      // V3 + V4 both license a discriminative paraphrase (recall retained).
      mk({ queryId: "2", servedAction: "abstain", v3Action: "inject", v4Action: "inject", v4LicenseReason: "structured-corroborated", v4LicensedCandidates: 1, v4TopBlockId: "org-2", v3TopBlockId: "org-2" }),
      // Singleton domain: V4 conservatively abstains (no competitor).
      mk({ queryId: "3", v3Action: "inject", v4Action: "abstain", v4Reason: "weak_evidence", v4LicenseReason: "no-competitor", v4LicensedCandidates: 0, v4TopBlockId: "org-3" }),
    ];
    const r = aggregateEvidenceComparison(events, () => "organic");
    expect(r.v4.traffic).toBe(3);
    expect(r.v4.v3LicensedV4Abstained).toBe(2); // events 1 and 3 — V4 caught what V3 licensed
    expect(r.v4.monotonicityViolations).toBe(0); // never inject where V3 abstained
    expect(r.v4.ambiguousSibling).toBe(1);
    expect(r.v4.noCompetitor).toBe(1);
    expect(r.v4.byLicenseReason["structured-corroborated"]).toBe(1);
    expect(r.v4.servedVsV4.v3_only_inject).toBe(1); // event 2: served abstained, V4 injected
    expect(r.v4.byProvenance.organic.v4OnlyInject).toBe(1);
  });

  it("V4 summary is present but empty when events carry no V4 decision", () => {
    const r = aggregateEvidenceComparison([mk({ queryId: "1", v4Action: undefined, v4LicenseReason: undefined, v4LicensedCandidates: undefined })]);
    expect(r.v4.traffic).toBe(0);
    expect(r.v4.readinessBlockers.some((b) => b.includes("no V4 shadow traffic"))).toBe(true);
  });
});
