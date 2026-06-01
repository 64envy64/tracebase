/**
 * Phase C hybrid retrieval report — pure aggregation over the local
 * `retrieval.hybrid_comparison` event stream (rollout=shadow).
 *
 * $0, offline, deterministic. Reads only privacy-safe event fields (counts,
 * hashes, opaque ids, closed enums). Separates ORGANIC (runtime-captured) from
 * BOOTSTRAP/imported traffic by top-block provenance; bootstrap shadow traffic
 * never counts toward organic readiness.
 */
import type {
  AnalyticsEvent,
  RetrievalHybridComparisonEvent,
  RetrievalFallback,
  RetrievalDecisionAgreement,
} from "../types.js";

export type ProvenanceClass = "organic" | "bootstrap" | "unknown";

export interface RetrievalHybridReport {
  traffic: number;
  byProvider: Record<string, number>;
  byFallback: Record<RetrievalFallback, number>;
  /** Recalls where the semantic provider contributed (fallback === "none"). */
  providerContributed: number;
  decisionAgreement: Record<RetrievalDecisionAgreement, number>;
  /** Fraction of recalls where hybrid changed the served decision. */
  decisionDisagreementRate: number;
  /** Recalls where the semantic provider surfaced >=1 block FTS missed. */
  recallsWithSemanticOnly: number;
  /** Total semantic-only blocks surfaced across all recalls. */
  semanticOnlyTotal: number;
  avgSparseSlateSize: number;
  avgHybridSlateSize: number;
  avgOverlap: number;
  avgRankMovement: number;
  providerLatencyMsP50: number;
  providerLatencyMsP95: number;
  hybridLatencyMsP50: number;
  hybridLatencyMsP95: number;
  byProvenance: Record<ProvenanceClass, { traffic: number; semanticOnly: number; hybridInject: number }>;
  readinessBlockers: string[];
}

const ALL_FALLBACKS: RetrievalFallback[] = ["none", "unavailable", "timeout", "error"];
const ALL_AGREEMENTS: RetrievalDecisionAgreement[] = [
  "agree_abstain",
  "agree_inject_same",
  "agree_inject_diff",
  "sparse_only_inject",
  "hybrid_only_inject",
];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** Aggregate the hybrid comparison stream. `classifyBlock` maps a block id to its provenance. */
export function aggregateRetrievalHybrid(
  events: readonly AnalyticsEvent[],
  classifyBlock: (blockId: string) => ProvenanceClass = () => "unknown",
): RetrievalHybridReport {
  const hybrid = events.filter((e): e is RetrievalHybridComparisonEvent => e.event === "retrieval.hybrid_comparison");

  const byProvider: Record<string, number> = {};
  const byFallback = { none: 0, unavailable: 0, timeout: 0, error: 0 } as Record<RetrievalFallback, number>;
  const decisionAgreement = {
    agree_abstain: 0,
    agree_inject_same: 0,
    agree_inject_diff: 0,
    sparse_only_inject: 0,
    hybrid_only_inject: 0,
  } as Record<RetrievalDecisionAgreement, number>;
  const byProvenance: Record<ProvenanceClass, { traffic: number; semanticOnly: number; hybridInject: number }> = {
    organic: { traffic: 0, semanticOnly: 0, hybridInject: 0 },
    bootstrap: { traffic: 0, semanticOnly: 0, hybridInject: 0 },
    unknown: { traffic: 0, semanticOnly: 0, hybridInject: 0 },
  };

  let providerContributed = 0;
  let recallsWithSemanticOnly = 0;
  let semanticOnlyTotal = 0;
  let sparseSum = 0;
  let hybridSum = 0;
  let overlapSum = 0;
  let rankMoveSum = 0;
  let disagree = 0;
  const provLat: number[] = [];
  const hybLat: number[] = [];

  for (const e of hybrid) {
    byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;
    byFallback[e.fallback] = (byFallback[e.fallback] ?? 0) + 1;
    decisionAgreement[e.decisionAgreement] = (decisionAgreement[e.decisionAgreement] ?? 0) + 1;
    if (e.fallback === "none") providerContributed++;
    if (e.semanticOnly > 0) recallsWithSemanticOnly++;
    semanticOnlyTotal += e.semanticOnly;
    sparseSum += e.sparseSlateSize;
    hybridSum += e.hybridSlateSize;
    overlapSum += e.overlap;
    rankMoveSum += e.rankMovement;
    if (e.decisionAgreement !== "agree_abstain" && e.decisionAgreement !== "agree_inject_same") disagree++;
    provLat.push(e.providerLatencyMs);
    hybLat.push(e.hybridLatencyMs);

    const topId = e.hybridTopBlockId ?? e.sparseTopBlockId;
    const cls: ProvenanceClass = topId ? classifyBlock(topId) : "unknown";
    byProvenance[cls].traffic++;
    if (e.semanticOnly > 0) byProvenance[cls].semanticOnly++;
    if (e.hybridAction === "inject") byProvenance[cls].hybridInject++;
  }

  const n = hybrid.length;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const sortedProv = provLat.slice().sort((a, b) => a - b);
  const sortedHyb = hybLat.slice().sort((a, b) => a - b);

  const readinessBlockers: string[] = [];
  if (byProvenance.organic.traffic === 0) readinessBlockers.push("no organic shadow traffic (bootstrap-only / empty)");
  if (byProvenance.organic.semanticOnly === 0) readinessBlockers.push("hybrid surfaced no new organic candidates (semantic provider added nothing FTS missed)");
  if (byFallback.error + byFallback.timeout > 0) readinessBlockers.push(`${byFallback.error + byFallback.timeout} provider failure/timeout fallback(s) — investigate before serving on`);

  return {
    traffic: n,
    byProvider,
    byFallback,
    providerContributed,
    decisionAgreement,
    decisionDisagreementRate: n ? round(disagree / n) : 0,
    recallsWithSemanticOnly,
    semanticOnlyTotal,
    avgSparseSlateSize: n ? round(sparseSum / n) : 0,
    avgHybridSlateSize: n ? round(hybridSum / n) : 0,
    avgOverlap: n ? round(overlapSum / n) : 0,
    avgRankMovement: n ? round(rankMoveSum / n) : 0,
    providerLatencyMsP50: pct(sortedProv, 0.5),
    providerLatencyMsP95: pct(sortedProv, 0.95),
    hybridLatencyMsP50: pct(sortedHyb, 0.5),
    hybridLatencyMsP95: pct(sortedHyb, 0.95),
    byProvenance,
    readinessBlockers,
  };
}

export function retrievalFallbackKeys(): RetrievalFallback[] {
  return [...ALL_FALLBACKS];
}
export function retrievalAgreementKeys(): RetrievalDecisionAgreement[] {
  return [...ALL_AGREEMENTS];
}
