/**
 * Router V2 shadow comparison report — pure aggregation over the local
 * `router.shadow_comparison` event stream (rollout=shadow).
 *
 * $0, offline, deterministic: events in → report out. No DB, no network. The
 * caller supplies the events (via `store.readEvents`) and an optional
 * block-provenance classifier so the report can separate ORGANIC (runtime-
 * captured, extractedFrom="trajectory") from BOOTSTRAP/imported evidence — the
 * load-bearing split: bootstrap shadow traffic NEVER counts toward organic
 * readiness.
 *
 * The report reads only privacy-safe event fields (counts, hashes, opaque ids).
 */
import type { AnalyticsEvent, RouterShadowComparisonEvent, RouterShadowAgreement, OutcomeEvent } from "../types.js";

export type ProvenanceClass = "organic" | "bootstrap" | "unknown";

/** Per-provenance slice of shadow traffic. */
export interface ShadowProvenanceSlice {
  traffic: number;
  v1Inject: number;
  v2Inject: number;
  /** Recalls whose top family had ≥2 distinct supporting cases (a recurring family). */
  recurringFamilyHits: number;
}

export interface RouterShadowReport {
  traffic: number;
  v1: { inject: number; abstain: number; injectRate: number };
  v2: { inject: number; abstain: number; injectRate: number };
  /** Disagreement matrix. */
  agreement: Record<RouterShadowAgreement, number>;
  /** Fraction of recalls where V1 and V2 chose the same action+block. */
  agreementRate: number;
  v1Reasons: Record<string, number>;
  v2Reasons: Record<string, number>;
  /** topFamilySupport (distinct cases in the served/top family) → recall count. */
  topFamilySupportDistribution: Record<string, number>;
  bridgesPreventedTotal: number;
  bridgesPreventedRecalls: number;
  redactionTotal: number;
  redactionRecalls: number;
  fallbackCount: number;
  v2OverheadMsP50: number;
  v2OverheadMsP95: number;
  /** Served-path outcomes joined by queryId (V2 is never served, so this is V1). */
  attributedOutcomes: { withOutcome: number; resolved: number; regressed: number };
  byProvenance: Record<ProvenanceClass, ShadowProvenanceSlice>;
  /** Organic-only: recalls whose top family was recurring (≥2 distinct cases). */
  organicRecurringFamilyHits: number;
  readinessBlockers: string[];
}

function emptySlice(): ShadowProvenanceSlice {
  return { traffic: 0, v1Inject: 0, v2Inject: 0, recurringFamilyHits: 0 };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

const ALL_AGREEMENTS: RouterShadowAgreement[] = [
  "agree_abstain",
  "agree_inject_same",
  "agree_inject_diff",
  "v1_only_inject",
  "v2_only_inject",
];

/**
 * Aggregate the shadow comparison stream. `classifyBlock` maps a block id to its
 * provenance class (default: everything "unknown"); supply a store-backed one
 * to separate organic from bootstrap. Outcome events in `events` are joined by
 * queryId to surface served-path attribution where available.
 */
export function aggregateRouterShadow(
  events: readonly AnalyticsEvent[],
  classifyBlock: (blockId: string) => ProvenanceClass = () => "unknown",
): RouterShadowReport {
  const shadow = events.filter((e): e is RouterShadowComparisonEvent => e.event === "router.shadow_comparison");

  // queryId → outcome (served-path attribution). Last outcome wins.
  const outcomeByQuery = new Map<string, OutcomeEvent>();
  for (const e of events) {
    if (e.event === "outcome") outcomeByQuery.set(e.queryId, e);
  }

  const agreement: Record<RouterShadowAgreement, number> = {
    agree_abstain: 0,
    agree_inject_same: 0,
    agree_inject_diff: 0,
    v1_only_inject: 0,
    v2_only_inject: 0,
  };
  const v1Reasons: Record<string, number> = {};
  const v2Reasons: Record<string, number> = {};
  const supportDist: Record<string, number> = {};
  const byProvenance: Record<ProvenanceClass, ShadowProvenanceSlice> = {
    organic: emptySlice(),
    bootstrap: emptySlice(),
    unknown: emptySlice(),
  };
  const overheads: number[] = [];

  let v1Inject = 0;
  let v2Inject = 0;
  let bridgesPreventedTotal = 0;
  let bridgesPreventedRecalls = 0;
  let redactionTotal = 0;
  let redactionRecalls = 0;
  let fallbackCount = 0;
  let organicRecurringFamilyHits = 0;
  let withOutcome = 0;
  let resolved = 0;
  let regressed = 0;

  for (const e of shadow) {
    agreement[e.agreement] = (agreement[e.agreement] ?? 0) + 1;
    v1Reasons[e.v1Reason] = (v1Reasons[e.v1Reason] ?? 0) + 1;
    v2Reasons[e.v2Reason] = (v2Reasons[e.v2Reason] ?? 0) + 1;
    supportDist[String(e.topFamilySupport)] = (supportDist[String(e.topFamilySupport)] ?? 0) + 1;
    overheads.push(e.v2OverheadMs);
    if (e.v1Action === "inject") v1Inject++;
    if (e.v2Action === "inject") v2Inject++;
    if (e.bridgesPrevented > 0) {
      bridgesPreventedTotal += e.bridgesPrevented;
      bridgesPreventedRecalls++;
    }
    if (e.redactedFieldCount > 0) {
      redactionTotal += e.redactedFieldCount;
      redactionRecalls++;
    }
    if (e.v2FallbackReason) fallbackCount++;

    // Provenance: classify by the top block of whichever side proposed one
    // (prefer V2's top, else V1's). Abstain-on-both recalls have no block.
    const topId = e.v2TopBlockId ?? e.v1TopBlockId;
    const cls: ProvenanceClass = topId ? classifyBlock(topId) : "unknown";
    const slice = byProvenance[cls];
    slice.traffic++;
    if (e.v1Action === "inject") slice.v1Inject++;
    if (e.v2Action === "inject") slice.v2Inject++;
    const recurring = e.topFamilySupport >= 2;
    if (recurring) slice.recurringFamilyHits++;
    if (recurring && cls === "organic") organicRecurringFamilyHits++;

    const outcome = outcomeByQuery.get(e.queryId);
    if (outcome) {
      withOutcome++;
      if (outcome.resolved) resolved++;
      if (outcome.regressed) regressed++;
    }
  }

  const traffic = shadow.length;
  const sortedOverhead = overheads.slice().sort((a, b) => a - b);
  const agreeCount = agreement.agree_abstain + agreement.agree_inject_same;
  const round = (x: number) => Math.round(x * 1000) / 1000;

  const readinessBlockers: string[] = [];
  if (byProvenance.organic.traffic === 0) {
    readinessBlockers.push("no organic shadow traffic captured (bootstrap-only / empty)");
  }
  if (organicRecurringFamilyHits === 0) {
    readinessBlockers.push("no organic recurring families observed (top-family support is all singletons)");
  }
  if (withOutcome === 0) {
    readinessBlockers.push("no attributed served-path outcomes yet (cannot estimate helpful/harmful lift)");
  }
  if (fallbackCount > 0) {
    readinessBlockers.push(`${fallbackCount} V2 fallback(s) — investigate before serving V2`);
  }

  return {
    traffic,
    v1: { inject: v1Inject, abstain: traffic - v1Inject, injectRate: traffic ? round(v1Inject / traffic) : 0 },
    v2: { inject: v2Inject, abstain: traffic - v2Inject, injectRate: traffic ? round(v2Inject / traffic) : 0 },
    agreement,
    agreementRate: traffic ? round(agreeCount / traffic) : 0,
    v1Reasons,
    v2Reasons,
    topFamilySupportDistribution: supportDist,
    bridgesPreventedTotal,
    bridgesPreventedRecalls,
    redactionTotal,
    redactionRecalls,
    fallbackCount,
    v2OverheadMsP50: pct(sortedOverhead, 0.5),
    v2OverheadMsP95: pct(sortedOverhead, 0.95),
    attributedOutcomes: { withOutcome, resolved, regressed },
    byProvenance,
    organicRecurringFamilyHits,
    readinessBlockers,
  };
}

/** Ensure every agreement bucket is present (for stable rendering). */
export function agreementKeys(): RouterShadowAgreement[] {
  return [...ALL_AGREEMENTS];
}
