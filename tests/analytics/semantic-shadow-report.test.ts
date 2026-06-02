import { describe, expect, it } from "vitest";
import { aggregateSemanticShadow } from "../../src/analytics/semantic-shadow-report.js";
import type { ReasoningSemanticComparisonEvent } from "../../src/types.js";

function event(
  overrides: Partial<ReasoningSemanticComparisonEvent> = {},
): ReasoningSemanticComparisonEvent {
  return {
    event: "reasoning.semantic_comparison",
    ts: 1,
    queryId: "q1",
    queryHash: "h1",
    corpusSize: 4,
    candidateCount: 2,
    v4Action: "abstain",
    semanticProvider: "http",
    semanticFeatureVersion: 1,
    semanticAttestationId: "att-1",
    semanticVerdict: "applicable",
    semanticTopBlockId: "b1",
    semanticConfidence: 0.9,
    changedDecision: "reranker_only_apply",
    verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 1 },
    fallback: "none",
    latencyMs: 10,
    ...overrides,
  };
}

describe("aggregateSemanticShadow", () => {
  it("summarizes residual recovery, fallback, latency, and latest sidecar state", () => {
    const report = aggregateSemanticShadow([
      event(),
      event({
        ts: 2,
        queryId: "q2",
        v4Action: "inject",
        semanticVerdict: "uncertain",
        changedDecision: "reranker_withholds",
        fallback: "timeout",
        latencyMs: 30,
        semanticHealth: {
          status: "degraded",
          observedAt: 2,
          scannerBlocked: 1,
          attestationRejected: 0,
        },
        warmQueue: { pending: 2, inFlight: 1, completed: 4, dropped: 0 },
      }),
    ]);

    expect(report.traffic).toBe(2);
    expect(report.baseline).toEqual({ inject: 1, abstain: 1 });
    expect(report.semantic).toEqual({ applicable: 1, uncertain: 1, inapplicable: 0, none: 0 });
    expect(report.residual).toEqual({
      v4Abstain: 1,
      semanticApplicable: 1,
      fallback: 0,
      recoveryRate: 1,
    });
    expect(report.fallback.timeout).toBe(1);
    expect(report.latencyMs).toEqual({ p50: 30, p95: 30 });
    expect(report.providers).toEqual(["http"]);
    expect(report.attestationIds).toEqual(["att-1"]);
    expect(report.latestWarmQueue?.pending).toBe(2);
    expect(report.readinessBlockers).toEqual([
      "semantic provider timeout/error observed",
      "scanner blocked one or more semantic payloads",
    ]);
  });

  it("reports an empty traffic blocker without leaking raw content", () => {
    const report = aggregateSemanticShadow([]);
    expect(report.traffic).toBe(0);
    expect(report.readinessBlockers).toEqual([
      "no semantic shadow traffic captured",
      "no V4-abstain residual observed",
      "no semantic residual recovery observed",
    ]);
  });
});
