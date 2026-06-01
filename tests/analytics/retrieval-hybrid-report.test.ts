/**
 * Phase C hybrid retrieval report aggregation — pure, deterministic.
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent, RetrievalHybridComparisonEvent } from "../../src/types.js";
import { aggregateRetrievalHybrid, type ProvenanceClass } from "../../src/analytics/retrieval-hybrid-report.js";

function mk(o: Partial<RetrievalHybridComparisonEvent> & { queryId: string }): RetrievalHybridComparisonEvent {
  return {
    event: "retrieval.hybrid_comparison",
    ts: 1,
    queryHash: "q_x",
    corpusSize: 10,
    provider: "deterministic-local",
    fallback: "none",
    providerLatencyMs: 1,
    hybridLatencyMs: 2,
    sparseSlateSize: 5,
    semanticSlateSize: 3,
    hybridSlateSize: 6,
    overlap: 2,
    semanticOnly: 1,
    rankMovement: 2,
    sparseAction: "abstain",
    hybridAction: "inject",
    decisionAgreement: "hybrid_only_inject",
    featureVersion: 2,
    ...o,
  } as RetrievalHybridComparisonEvent;
}

describe("hybrid retrieval report aggregation", () => {
  it("counts traffic, providers, fallbacks, and the agreement matrix", () => {
    const events: AnalyticsEvent[] = [
      mk({ queryId: "1", fallback: "none", decisionAgreement: "hybrid_only_inject" }),
      mk({ queryId: "2", fallback: "timeout", decisionAgreement: "agree_abstain", semanticOnly: 0 }),
      mk({ queryId: "3", fallback: "none", decisionAgreement: "agree_inject_same", semanticOnly: 0 }),
    ];
    const r = aggregateRetrievalHybrid(events);
    expect(r.traffic).toBe(3);
    expect(r.byProvider["deterministic-local"]).toBe(3);
    expect(r.byFallback.none).toBe(2);
    expect(r.byFallback.timeout).toBe(1);
    expect(r.providerContributed).toBe(2);
    expect(r.decisionAgreement.hybrid_only_inject).toBe(1);
    expect(r.decisionDisagreementRate).toBeCloseTo(1 / 3, 3); // only the hybrid_only_inject
  });

  it("tracks semantic-only surfacing and separates organic vs bootstrap", () => {
    const events: AnalyticsEvent[] = [
      mk({ queryId: "1", hybridTopBlockId: "org-1", semanticOnly: 2, hybridAction: "inject" }),
      mk({ queryId: "2", hybridTopBlockId: "boot-1", semanticOnly: 1, hybridAction: "abstain" }),
    ];
    const classify = (id: string): ProvenanceClass => (id.startsWith("org") ? "organic" : "bootstrap");
    const r = aggregateRetrievalHybrid(events, classify);
    expect(r.recallsWithSemanticOnly).toBe(2);
    expect(r.semanticOnlyTotal).toBe(3);
    expect(r.byProvenance.organic.semanticOnly).toBe(1);
    expect(r.byProvenance.organic.hybridInject).toBe(1);
    expect(r.byProvenance.bootstrap.traffic).toBe(1);
  });

  it("surfaces readiness blockers and never throws on empty", () => {
    const empty = aggregateRetrievalHybrid([]);
    expect(empty.traffic).toBe(0);
    expect(empty.readinessBlockers.length).toBeGreaterThan(0);
    const bootstrapOnly = aggregateRetrievalHybrid([mk({ queryId: "1", hybridTopBlockId: "boot-1" })], () => "bootstrap");
    expect(bootstrapOnly.readinessBlockers.some((b) => b.includes("no organic shadow traffic"))).toBe(true);
  });

  it("flags provider failures as a readiness blocker", () => {
    const r = aggregateRetrievalHybrid([mk({ queryId: "1", fallback: "error", hybridTopBlockId: "org-1" })], () => "organic");
    expect(r.readinessBlockers.some((b) => b.includes("provider failure/timeout"))).toBe(true);
  });
});
