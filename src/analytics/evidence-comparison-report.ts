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
  /** Phase C.3 contrastive V4 lane (present when events carry v4Action). */
  v4: EvidenceComparisonReportV4;
}

/** Phase C.3 ServingEvidenceV4 (contrastive) aggregation over the same stream. */
export interface EvidenceComparisonReportV4 {
  /** Events that carried a V4 decision (older V3-only events are excluded). */
  traffic: number;
  byLane: Record<string, number>;
  byLicenseReason: Record<string, number>;
  /** Served-vs-V4 (dis)agreement (derived; "v3_only_inject" reads as v4-only). */
  servedVsV4: Record<EvidenceComparisonAgreement, number>;
  decisionDisagreementRate: number;
  recallsWithLicense: number;
  licensedCandidatesTotal: number;
  /** V3 injected but V4 abstained — the contrastive TIGHTENING (V4 caught a V3 leak). */
  v3LicensedV4Abstained: number;
  /** V4 injected but V3 abstained — MUST be 0 (V4 is a strict tightening of V3). */
  monotonicityViolations: number;
  /** Recalls where V4 found no competing sibling (conservative abstain). */
  noCompetitor: number;
  /** Recalls V4 abstained on as ambiguous between siblings (low discriminative gap). */
  ambiguousSibling: number;
  byProvenance: Record<ProvenanceClass, { v4Licensed: number; v4OnlyInject: number }>;
  readinessBlockers: string[];
}

/** Derive a served-vs-shadow agreement label (same enum; shadow-only ⇒ v3_only_inject). */
function deriveAgreement(
  servedAction: "inject" | "abstain",
  servedTop: string | undefined,
  shadowAction: "inject" | "abstain",
  shadowTop: string | undefined,
): EvidenceComparisonAgreement {
  if (servedAction === "abstain" && shadowAction === "abstain") return "agree_abstain";
  if (servedAction === "inject" && shadowAction === "inject") return servedTop === shadowTop ? "agree_inject_same" : "agree_inject_diff";
  if (servedAction === "inject") return "v2_only_inject";
  return "v3_only_inject";
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

  const v4 = aggregateV4(ev, classifyBlock, round);

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
    v4,
  };
}

/** Phase C.3 contrastive V4 aggregation (over events that carry a V4 decision). */
function aggregateV4(
  ev: readonly ReasoningEvidenceComparisonEvent[],
  classifyBlock: (blockId: string) => ProvenanceClass,
  round: (x: number) => number,
): EvidenceComparisonReportV4 {
  const byLane: Record<string, number> = {};
  const byLicenseReason: Record<string, number> = {};
  const servedVsV4 = { agree_abstain: 0, agree_inject_same: 0, agree_inject_diff: 0, v2_only_inject: 0, v3_only_inject: 0 } as Record<EvidenceComparisonAgreement, number>;
  const byProvenance: Record<ProvenanceClass, { v4Licensed: number; v4OnlyInject: number }> = {
    organic: { v4Licensed: 0, v4OnlyInject: 0 },
    bootstrap: { v4Licensed: 0, v4OnlyInject: 0 },
    unknown: { v4Licensed: 0, v4OnlyInject: 0 },
  };
  let traffic = 0;
  let recallsWithLicense = 0;
  let licensedCandidatesTotal = 0;
  let v3LicensedV4Abstained = 0;
  let monotonicityViolations = 0;
  let noCompetitor = 0;
  let ambiguousSibling = 0;
  let disagree = 0;

  for (const e of ev) {
    if (e.v4Action === undefined) continue; // V3-only event (no V4 computed)
    traffic++;
    const lane = e.v4LicenseReason === "lexical" ? "lexical" : "semantic-license";
    byLane[lane] = (byLane[lane] ?? 0) + 1;
    if (e.v4LicenseReason) byLicenseReason[e.v4LicenseReason] = (byLicenseReason[e.v4LicenseReason] ?? 0) + 1;
    const lic = e.v4LicensedCandidates ?? 0;
    if (lic > 0) recallsWithLicense++;
    licensedCandidatesTotal += lic;
    if (e.v3Action === "inject" && e.v4Action === "abstain") v3LicensedV4Abstained++;
    if (e.v4Action === "inject" && e.v3Action === "abstain") monotonicityViolations++;
    if (e.v4LicenseReason === "no-competitor") noCompetitor++;
    if (e.v4LicenseReason === "ambiguous-sibling") ambiguousSibling++;

    const ag = deriveAgreement(e.servedAction, e.servedTopBlockId, e.v4Action, e.v4TopBlockId);
    servedVsV4[ag]++;
    if (ag !== "agree_abstain" && ag !== "agree_inject_same") disagree++;

    const topId = e.v4TopBlockId ?? e.servedTopBlockId;
    const cls: ProvenanceClass = topId ? classifyBlock(topId) : "unknown";
    if (lic > 0) byProvenance[cls].v4Licensed++;
    if (ag === "v3_only_inject") byProvenance[cls].v4OnlyInject++;
  }

  const readinessBlockers: string[] = [];
  if (traffic === 0) readinessBlockers.push("no V4 shadow traffic (V3-only events / empty)");
  if (monotonicityViolations > 0) readinessBlockers.push(`${monotonicityViolations} V4-injected-but-V3-abstained (monotonicity violation — V4 must only tighten V3)`);
  if (traffic > 0 && byProvenance.organic.v4OnlyInject === 0) readinessBlockers.push("V4 converted no organic candidate recall into a (shadow) inject the served path missed");

  return {
    traffic,
    byLane,
    byLicenseReason,
    servedVsV4,
    decisionDisagreementRate: traffic ? round(disagree / traffic) : 0,
    recallsWithLicense,
    licensedCandidatesTotal,
    v3LicensedV4Abstained,
    monotonicityViolations,
    noCompetitor,
    ambiguousSibling,
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
