import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEMANTIC_SHADOW_SOAK_THRESHOLDS,
  evaluateSemanticShadowSoak,
  type SemanticShadowSoakThresholds,
} from "../../src/analytics/semantic-shadow-soak.js";
import { aggregateSemanticShadow } from "../../src/analytics/semantic-shadow-report.js";
import type { SemanticShadowDoctorReport } from "../../src/experiments/semantic-bakeoff/service/doctor.js";
import type { ReasoningSemanticComparisonEvent } from "../../src/types.js";

const thresholds: SemanticShadowSoakThresholds = {
  ...DEFAULT_SEMANTIC_SHADOW_SOAK_THRESHOLDS,
  minTraffic: 2,
  minV4Abstain: 1,
  maxLatencyP95Ms: 20,
  maxWarmLatencyP95Ms: 100,
};

const cleanTelemetry = {
  served: 2,
  rejectedAuth: 0,
  rejectedLeak: 0,
  rejectedMalformed: 0,
  rejectedTooLarge: 0,
  rejectedExpired: 0,
  quotaExceeded: 0,
  timeouts: 0,
  overloads: 0,
  backendErrors: 0,
};

function readyDoctor(overrides: Partial<Extract<SemanticShadowDoctorReport, { status: "ready" }>> = {}): SemanticShadowDoctorReport {
  return {
    status: "ready",
    endpoint: "http://127.0.0.1:3489",
    attestationId: "att-1",
    unpinnedDevMode: false,
    inFlight: 0,
    telemetry: cleanTelemetry,
    ...overrides,
  };
}

function event(overrides: Partial<ReasoningSemanticComparisonEvent> = {}): ReasoningSemanticComparisonEvent {
  return {
    event: "reasoning.semantic_comparison",
    ts: 1,
    queryId: "soak-q1",
    queryHash: "soak-h1",
    corpusSize: 6,
    candidateCount: 3,
    v4Action: "abstain",
    semanticProvider: "http",
    semanticFeatureVersion: 1,
    semanticAttestationId: "att-1",
    semanticVerdict: "applicable",
    semanticTopBlockId: "block-1",
    semanticConfidence: 0.94,
    changedDecision: "reranker_only_apply",
    verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 2 },
    fallback: "none",
    latencyMs: 7,
    semanticHealth: {
      servedCalls: 2,
      cacheFresh: 1,
      cacheStale: 0,
      cacheMiss: 1,
      warmsScheduled: 1,
      warmsCompleted: 1,
      warmErrors: 0,
      warmAborted: 0,
      warmingSuppressed: 0,
      warmLatencyP95Ms: 12,
      scannerBlocked: 0,
      attestationRejected: 0,
    },
    warmQueue: {
      active: 0,
      pending: 0,
      dropped: 0,
      coalesced: 0,
      scheduled: 1,
      cancelled: 0,
      accepting: true,
    },
    ...overrides,
  };
}

describe("evaluateSemanticShadowSoak", () => {
  it("passes only when doctor, attestation, warm cache, privacy, and error budgets are clean", () => {
    const shadow = aggregateSemanticShadow([
      event(),
      event({ ts: 2, queryId: "soak-q2", queryHash: "soak-h2", v4Action: "inject", semanticVerdict: "inapplicable", changedDecision: "none" }),
    ]);
    const report = evaluateSemanticShadowSoak(
      { doctor: readyDoctor(), shadow },
      { thresholds, now: () => new Date("2026-06-03T00:00:00.000Z") },
    );

    expect(report.verdict).toBe("ready");
    expect(report.shadowOnly).toBe(true);
    expect(report.servingPromoted).toBe(false);
    expect(report.privacyTelemetrySafe).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.generatedAt).toBe("2026-06-03T00:00:00.000Z");
  });

  it("fails closed on unconfigured sidecar and missing soak traffic", () => {
    const report = evaluateSemanticShadowSoak(
      { doctor: { status: "off", reason: "not-configured" }, shadow: aggregateSemanticShadow([]) },
      { thresholds },
    );

    expect(report.verdict).toBe("not-ready");
    expect(report.blockers).toContain("semantic sidecar doctor is off");
    expect(report.blockers).toContain("semantic shadow traffic below soak floor");
  });

  it("detects attestation drift between local events and the live sidecar", () => {
    const report = evaluateSemanticShadowSoak(
      { doctor: readyDoctor({ attestationId: "att-2" }), shadow: aggregateSemanticShadow([event(), event({ ts: 2, queryId: "soak-q2" })]) },
      { thresholds },
    );

    expect(report.verdict).toBe("not-ready");
    expect(report.blockers).toContain("semantic shadow attestation differs from sidecar doctor");
  });

  it("keeps cumulative sidecar and client privacy/error counters load-bearing", () => {
    const report = evaluateSemanticShadowSoak(
      {
        doctor: readyDoctor({ telemetry: { ...cleanTelemetry, rejectedLeak: 1, backendErrors: 1 } }),
        shadow: aggregateSemanticShadow([
          event({
            semanticHealth: {
              ...event().semanticHealth!,
              scannerBlocked: 1,
              warmErrors: 1,
            },
          }),
          event({
            ts: 2,
            queryId: "soak-q2",
            semanticHealth: {
              ...event().semanticHealth!,
              scannerBlocked: 1,
              warmErrors: 1,
            },
          }),
        ]),
      },
      { thresholds },
    );

    expect(report.verdict).toBe("not-ready");
    expect(report.blockers).toContain("client-side semantic scanner blocked a payload");
    expect(report.blockers).toContain("semantic warm errors observed");
    expect(report.blockers).toContain("sidecar leakage rejection observed");
    expect(report.blockers).toContain("sidecar backend error observed");
  });

  it("does not silently allow unpinned sidecars unless explicitly opted in", () => {
    const shadow = aggregateSemanticShadow([event(), event({ ts: 2, queryId: "soak-q2" })]);
    expect(evaluateSemanticShadowSoak({ doctor: readyDoctor({ unpinnedDevMode: true }), shadow }, { thresholds }).blockers)
      .toContain("semantic sidecar is running without pinned attestation");

    expect(evaluateSemanticShadowSoak(
      { doctor: readyDoctor({ unpinnedDevMode: true }), shadow },
      { thresholds: { ...thresholds, allowUnpinnedDevMode: true } },
    ).blockers).not.toContain("semantic sidecar is running without pinned attestation");
  });
});
