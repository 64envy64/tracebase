/**
 * Phase C.2 ServingEvidenceV3 report — pure aggregation over the local
 * `reasoning.evidence_comparison` event stream (rollout=shadow).
 *
 * $0, offline, deterministic. Reads only privacy-safe fields. Separates ORGANIC
 * (runtime-captured) from BOOTSTRAP (imported) by top-block provenance;
 * bootstrap shadow traffic never counts toward organic readiness.
 */
import type { AnalyticsEvent, ReasoningEvidenceComparisonEvent, EvidenceComparisonAgreement, EvidenceFallback } from "../types.js";

export type ProvenanceClass = "organic" | "bootstrap" | "unknown";

export interface EvidenceComparisonReport {
  traffic: number;
  byLane: Record<string, number>;
  byLicenseReason: Record<string, number>;
  agreement: Record<EvidenceComparisonAgreement, number>;
  /** Fraction of recalls where V3 changed the decision vs served V1/V2. */
  decisionDisagreementRate: number;
  /** Recalls where V3 licensed at least one candidate. */
  recallsWithLicense: number;
  licensedCandidatesTotal: number;
  semanticOnlyCandidatesTotal: number;
  byFallback: Record<EvidenceFallback, number>;
  redactionTotal: number;
  latencyMsP50: number;
  latencyMsP95: number;
  byProvenance: Record<ProvenanceClass, { traffic: number; v3Licensed: number; v3OnlyInject: number }>;
  readinessBlockers: string[];
}

const ALL_AGREEMENTS: EvidenceComparisonAgreement[] = [
  "agree_abstain",
  "agree_inject_same",
  "agree_inject_diff",
  "v2_only_inject",
  "v3_only_inject",
];
const ALL_FALLBACKS: EvidenceFallback[] = ["none", "error"];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function aggregateEvidenceComparison(
  events: readonly AnalyticsEvent[],
  classifyBlock: (blockId: string) => ProvenanceClass = () => "unknown",
): EvidenceComparisonReport {
  const ev = events.filter((e): e is ReasoningEvidenceComparisonEvent => e.event === "reasoning.evidence_comparison");

  const byLane: Record<string, number> = {};
  const byLicenseReason: Record<string, number> = {};
  const agreement = {
    agree_abstain: 0,
    agree_inject_same: 0,
    agree_inject_diff: 0,
    v2_only_inject: 0,
    v3_only_inject: 0,
  } as Record<EvidenceComparisonAgreement, number>;
  const byFallback = { none: 0, error: 0 } as Record<EvidenceFallback, number>;
  const byProvenance: Record<ProvenanceClass, { traffic: number; v3Licensed: number; v3OnlyInject: number }> = {
    organic: { traffic: 0, v3Licensed: 0, v3OnlyInject: 0 },
    bootstrap: { traffic: 0, v3Licensed: 0, v3OnlyInject: 0 },
    unknown: { traffic: 0, v3Licensed: 0, v3OnlyInject: 0 },
  };

  let recallsWithLicense = 0;
  let licensedCandidatesTotal = 0;
  let semanticOnlyCandidatesTotal = 0;
  let redactionTotal = 0;
  let disagree = 0;
  const lat: number[] = [];

  for (const e of ev) {
    byLane[e.lane] = (byLane[e.lane] ?? 0) + 1;
    byLicenseReason[e.licenseReason] = (byLicenseReason[e.licenseReason] ?? 0) + 1;
    agreement[e.agreement] = (agreement[e.agreement] ?? 0) + 1;
    byFallback[e.fallback] = (byFallback[e.fallback] ?? 0) + 1;
    if (e.licensedCandidates > 0) recallsWithLicense++;
    licensedCandidatesTotal += e.licensedCandidates;
    semanticOnlyCandidatesTotal += e.semanticOnlyCandidates;
    redactionTotal += e.redactedFieldCount;
    if (e.agreement !== "agree_abstain" && e.agreement !== "agree_inject_same") disagree++;
    lat.push(e.latencyMs);

    const topId = e.v3TopBlockId ?? e.servedTopBlockId;
    const cls: ProvenanceClass = topId ? classifyBlock(topId) : "unknown";
    byProvenance[cls].traffic++;
    if (e.licensedCandidates > 0) byProvenance[cls].v3Licensed++;
    if (e.agreement === "v3_only_inject") byProvenance[cls].v3OnlyInject++;
  }

  const n = ev.length;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const sorted = lat.slice().sort((a, b) => a - b);

  const readinessBlockers: string[] = [];
  if (byProvenance.organic.traffic === 0) readinessBlockers.push("no organic shadow traffic (bootstrap-only / empty)");
  if (byProvenance.organic.v3OnlyInject === 0) readinessBlockers.push("V3 converted no organic candidate recall into a (shadow) inject the served path missed");
  if (byFallback.error > 0) readinessBlockers.push(`${byFallback.error} V3 fallback error(s) — investigate before promoting`);

  return {
    traffic: n,
    byLane,
    byLicenseReason,
    agreement,
    decisionDisagreementRate: n ? round(disagree / n) : 0,
    recallsWithLicense,
    licensedCandidatesTotal,
    semanticOnlyCandidatesTotal,
    byFallback,
    redactionTotal,
    latencyMsP50: pct(sorted, 0.5),
    latencyMsP95: pct(sorted, 0.95),
    byProvenance,
    readinessBlockers,
  };
}

export function evidenceAgreementKeys(): EvidenceComparisonAgreement[] {
  return [...ALL_AGREEMENTS];
}
export function evidenceFallbackKeys(): EvidenceFallback[] {
  return [...ALL_FALLBACKS];
}
