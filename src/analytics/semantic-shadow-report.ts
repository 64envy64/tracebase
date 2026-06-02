/**
 * Semantic-overlay shadow report.
 *
 * Pure, deterministic, local-only aggregation over privacy-safe
 * `reasoning.semantic_comparison` events. The report intentionally does not read
 * prompt text, candidate bodies, paths, credentials, or the semantic cache.
 */
import type { AnalyticsEvent, ReasoningSemanticComparisonEvent } from "../types.js";

export interface SemanticShadowReport {
  traffic: number;
  baseline: { inject: number; abstain: number };
  semantic: {
    applicable: number;
    uncertain: number;
    inapplicable: number;
    none: number;
  };
  changedDecision: {
    none: number;
    rerankerOnlyApply: number;
    rerankerWithholds: number;
  };
  residual: {
    v4Abstain: number;
    semanticApplicable: number;
    fallback: number;
    recoveryRate: number;
  };
  fallback: { none: number; miss: number; timeout: number; error: number };
  latencyMs: { p50: number; p95: number };
  providers: string[];
  attestationIds: string[];
  latestHealth: ReasoningSemanticComparisonEvent["semanticHealth"] | null;
  observedHealthMax: { scannerBlocked: number; attestationRejected: number };
  latestWarmQueue: ReasoningSemanticComparisonEvent["warmQueue"] | null;
  readinessBlockers: string[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function aggregateSemanticShadow(events: readonly AnalyticsEvent[]): SemanticShadowReport {
  const comparisons = events
    .filter((e): e is ReasoningSemanticComparisonEvent => e.event === "reasoning.semantic_comparison")
    .sort((a, b) => a.ts - b.ts);
  const semantic = { applicable: 0, uncertain: 0, inapplicable: 0, none: 0 };
  const changedDecision = { none: 0, rerankerOnlyApply: 0, rerankerWithholds: 0 };
  const fallback = { none: 0, miss: 0, timeout: 0, error: 0 };
  const providers = new Set<string>();
  const attestationIds = new Set<string>();
  const latencies: number[] = [];
  let baselineInject = 0;
  let residualV4Abstain = 0;
  let residualSemanticApplicable = 0;
  let residualFallback = 0;
  let latestHealth: ReasoningSemanticComparisonEvent["semanticHealth"] | null = null;
  const observedHealthMax = { scannerBlocked: 0, attestationRejected: 0 };
  let latestWarmQueue: ReasoningSemanticComparisonEvent["warmQueue"] | null = null;

  for (const e of comparisons) {
    if (e.v4Action === "inject") baselineInject++;
    semantic[e.semanticVerdict]++;
    fallback[e.fallback]++;
    if (e.changedDecision === "reranker_only_apply") changedDecision.rerankerOnlyApply++;
    else if (e.changedDecision === "reranker_withholds") changedDecision.rerankerWithholds++;
    else changedDecision.none++;
    providers.add(e.semanticProvider);
    if (e.semanticAttestationId) attestationIds.add(e.semanticAttestationId);
    latencies.push(Math.max(0, e.latencyMs));
    if (e.semanticHealth) {
      latestHealth = e.semanticHealth;
      observedHealthMax.scannerBlocked = Math.max(observedHealthMax.scannerBlocked, e.semanticHealth.scannerBlocked);
      observedHealthMax.attestationRejected = Math.max(observedHealthMax.attestationRejected, e.semanticHealth.attestationRejected);
    }
    if (e.warmQueue) latestWarmQueue = e.warmQueue;
    if (e.v4Action === "abstain") {
      residualV4Abstain++;
      if (e.semanticVerdict === "applicable") residualSemanticApplicable++;
      if (e.fallback !== "none") residualFallback++;
    }
  }

  const readinessBlockers: string[] = [];
  if (comparisons.length === 0) readinessBlockers.push("no semantic shadow traffic captured");
  if (residualV4Abstain === 0) readinessBlockers.push("no V4-abstain residual observed");
  if (residualSemanticApplicable === 0) readinessBlockers.push("no semantic residual recovery observed");
  if (fallback.timeout > 0 || fallback.error > 0) readinessBlockers.push("semantic provider timeout/error observed");
  if (observedHealthMax.scannerBlocked > 0) readinessBlockers.push("scanner blocked one or more semantic payloads");
  if (observedHealthMax.attestationRejected > 0) readinessBlockers.push("semantic attestation mismatch observed");

  const sortedLatencies = latencies.sort((a, b) => a - b);
  return {
    traffic: comparisons.length,
    baseline: { inject: baselineInject, abstain: comparisons.length - baselineInject },
    semantic,
    changedDecision,
    residual: {
      v4Abstain: residualV4Abstain,
      semanticApplicable: residualSemanticApplicable,
      fallback: residualFallback,
      recoveryRate: residualV4Abstain ? round(residualSemanticApplicable / residualV4Abstain) : 0,
    },
    fallback,
    latencyMs: { p50: percentile(sortedLatencies, 0.5), p95: percentile(sortedLatencies, 0.95) },
    providers: [...providers].sort(),
    attestationIds: [...attestationIds].sort(),
    latestHealth,
    observedHealthMax,
    latestWarmQueue,
    readinessBlockers,
  };
}
