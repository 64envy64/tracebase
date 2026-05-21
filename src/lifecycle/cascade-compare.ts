/**
 * Cascade A/B aggregator — May-2026 B1.4.
 *
 * Splits the analytics_events log into a `cascade` arm (retrieval
 * events with `cascadePolicyId` stamped — these went through
 * BlockServer.recallAsync) and a `sync` arm (retrieval events
 * without it — these went through BlockServer.recall).
 *
 * For each arm, computes the §L6 helpful definition:
 *     helpful = injection ∧ agent_used ∧ outcome.resolved
 * and surfaces the rate, sample size, and (cascade arm only) the
 * fallback breakdown by reason.
 *
 * Honesty contract — what this is NOT:
 *   • Not a hypothesis test. We report the lift and the sample sizes;
 *     the reader decides whether the spread is big enough to act on.
 *   • Not a causal estimate. Cascade rollout is fingerprint-deterministic
 *     so queries don't randomise across arms; in particular, easy
 *     queries that always match a high-bm25 block flow through both
 *     arms similarly, while hard queries where reranking helps are
 *     the ones where the arms diverge. The B3 replay screening
 *     harness (deferred) is the right tool for causal claims; this
 *     aggregator is the operational dashboard.
 *
 * Sample-size guard: when either arm has fewer than `MIN_SAMPLE`
 * outcomes we still return the numbers but flag `lowSample: true`
 * so the CLI can render a warning.
 */

import type { BlockStore } from "../core/block-store.js";
import type { AnalyticsEvent } from "../types.js";
import {
  effectiveAttributionStrength,
  meetsHelpfulThreshold,
  STRENGTH_RANK,
  type AttributionStrength,
} from "../runtime/attribution-evidence.js";

/**
 * Per-arm aggregate. `helpfulRuns / totalRuns` is the §L6 rate.
 * `totalRuns` counts retrievals that produced an outcome (either
 * resolved or not) — retrievals without a matching outcome event
 * are not yet attributable and are excluded from the denominator.
 */
export interface CascadeArmMetrics {
  /** Retrieval events in this arm. */
  retrievals: number;
  /** Retrievals that also got at least one injection event. */
  injections: number;
  /** Retrievals where the agent provably used a hit and resolved. */
  helpfulRuns: number;
  /** Retrievals with any outcome event (resolved or not). */
  totalRuns: number;
  /** helpfulRuns / totalRuns; null when totalRuns === 0. */
  helpfulRate: number | null;
}

export interface CascadeFallbackBreakdown {
  /** Reranker call timed out. */
  timeout: number;
  /** Reranker threw / returned null. */
  error: number;
  /** Reranker returned null without throwing. */
  null: number;
  /** Score-length mismatch with candidate set. */
  empty: number;
  /** Wrapper rejected NaN/Infinity/out-of-band scores. */
  validation: number;
}

export interface CascadeComparison {
  cascade: CascadeArmMetrics;
  sync: CascadeArmMetrics;
  /** Per-reason fallback counts within the cascade arm. */
  cascadeFallback: CascadeFallbackBreakdown;
  /** Cascade arm runs where the reranker successfully scored (didn't fall back). */
  cascadeRerankerRan: number;
  /**
   * `cascade.helpfulRate - sync.helpfulRate`, computed only when both
   * arms have non-null rates. The CLI renders this with the sample
   * sizes so the reader can judge confidence.
   */
  lift: number | null;
  /**
   * True iff either arm has fewer than `MIN_SAMPLE` outcomes. The CLI
   * uses this to render a "too early to tell" banner.
   */
  lowSample: boolean;
  /** Window the aggregation covered. */
  window: { afterTs?: number; beforeTs?: number };
}

export interface CascadeComparisonBucket {
  /** UTC day label, YYYY-MM-DD. */
  day: string;
  /** Inclusive UTC bucket start. */
  bucketStartTs: number;
  /** Exclusive UTC bucket end. */
  bucketEndTs: number;
  /** Same arm metrics as the summary, scoped to this day. */
  comparison: CascadeComparison;
}

/** Below this many outcomes per arm, lift is mostly noise. */
export const MIN_SAMPLE = 50;

export interface CompareOptions {
  /** Only count events with `ts > afterTs`. */
  afterTs?: number;
  /** Only count events with `ts < beforeTs`. */
  beforeTs?: number;
  /** Page size for the underlying event read. */
  pageLimit?: number;
}

/**
 * Compute the cascade-vs-sync comparison from the persisted event log.
 *
 * Reads up to `pageLimit` (default 1,000,000) events in a single
 * batch — `analytics_events` is bounded by the project's recall
 * volume and tends to fit comfortably in memory. Larger projects
 * should pass a narrower `afterTs` / `beforeTs` window.
 */
export function computeCascadeComparison(
  store: BlockStore,
  opts: CompareOptions = {},
): CascadeComparison {
  const events = readWindowEvents(store, opts);
  return computeCascadeComparisonFromEvents(events, {
    ...(opts.afterTs !== undefined ? { afterTs: opts.afterTs } : {}),
    ...(opts.beforeTs !== undefined ? { beforeTs: opts.beforeTs } : {}),
  });
}

/**
 * Daily trend view for the same operational comparison. Buckets are UTC
 * days and include only days that have at least one event in the window.
 */
export function computeCascadeComparisonByDay(
  store: BlockStore,
  opts: CompareOptions = {},
): CascadeComparisonBucket[] {
  const events = readWindowEvents(store, opts);
  const buckets = new Map<number, AnalyticsEvent[]>();
  for (const ev of events) {
    const start = utcDayStart(ev.ts);
    const bucket = buckets.get(start);
    if (bucket) bucket.push(ev);
    else buckets.set(start, [ev]);
  }

  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((bucketStartTs) => {
      const bucketEndTs = bucketStartTs + DAY_MS;
      const afterTs =
        opts.afterTs !== undefined ? Math.max(bucketStartTs, opts.afterTs) : bucketStartTs;
      const beforeTs =
        opts.beforeTs !== undefined ? Math.min(bucketEndTs, opts.beforeTs) : bucketEndTs;
      return {
        day: new Date(bucketStartTs).toISOString().slice(0, 10),
        bucketStartTs,
        bucketEndTs,
        comparison: computeCascadeComparisonFromEvents(buckets.get(bucketStartTs) ?? [], {
          afterTs,
          beforeTs,
        }),
      };
    });
}

function readWindowEvents(store: BlockStore, opts: CompareOptions): AnalyticsEvent[] {
  return store.readEvents({
    ...(opts.afterTs !== undefined ? { afterTs: opts.afterTs } : {}),
    ...(opts.beforeTs !== undefined ? { beforeTs: opts.beforeTs } : {}),
    limit: opts.pageLimit ?? 1_000_000,
  });
}

function computeCascadeComparisonFromEvents(
  events: AnalyticsEvent[],
  window: { afterTs?: number; beforeTs?: number },
): CascadeComparison {
  // Partition retrieval events by arm.
  const cascadeQueryIds = new Set<string>();
  const syncQueryIds = new Set<string>();
  const fallback: CascadeFallbackBreakdown = {
    timeout: 0,
    error: 0,
    null: 0,
    empty: 0,
    validation: 0,
  };
  let cascadeRerankerRan = 0;

  // Per-arm bookkeeping for injection / agent_used / outcome.
  //
  // C2.2 — `agentUsedPairs` is keyed by `(queryId, blockId)` and the
  // value is the STRONGEST observed evidence strength for that pair.
  // The §L6 helpful gate then requires at least one pair on the
  // queryId at moderate-or-stronger strength, matching the funnel
  // and per-block gates in `core/analytics.ts`. Pre-C2.2 this was a
  // bare `Set<string>` that admitted any agent_used regardless of
  // strength, which inflated cascade-arm helpfulRate on noisy
  // Jaccard hits.
  //
  // C2.3 — `injectionsByQuery` is now a `Map<queryId, Set<blockId>>`
  // (was `Set<queryId>`), so the §L6 helpful gate can intersect the
  // strong agent_used pair against the actual injected blockIds.
  // Pre-C2.3 fix: injected=blockA + strong agent_used=blockB on the
  // same queryId would credit helpful, even though the cascade
  // didn't put blockB in front of the agent. For memory-health
  // pruning this would have the cascade arm "learning" on orphan
  // attribution. `injections.size` (used for the surfaced
  // `metric.injections` counter) is now `arm.injections.size` of the
  // Map, which counts queryIds with at least one injection — same
  // semantics as the pre-C2.3 Set count.
  const arms = {
    cascade: { retrievals: 0, injections: new Map<string, Set<string>>(), agentUsedPairs: new Map<string, AttributionStrength>(), outcomes: new Map<string, boolean>() },
    sync: { retrievals: 0, injections: new Map<string, Set<string>>(), agentUsedPairs: new Map<string, AttributionStrength>(), outcomes: new Map<string, boolean>() },
  };

  for (const ev of events) {
    if (ev.event === "retrieval") {
      const isCascade = typeof ev.cascadePolicyId === "string" && ev.cascadePolicyId.length > 0;
      if (isCascade) {
        cascadeQueryIds.add(ev.queryId);
        arms.cascade.retrievals++;
        if (ev.rerankerFellBack) {
          const reason = ev.rerankerFallbackReason;
          if (reason && reason in fallback) {
            fallback[reason as keyof CascadeFallbackBreakdown]++;
          }
        } else if (ev.rerankerName) {
          cascadeRerankerRan++;
        }
      } else {
        syncQueryIds.add(ev.queryId);
        arms.sync.retrievals++;
      }
    }
  }

  // Second pass to attribute injections / agent_used / outcomes to arms.
  for (const ev of events) {
    if (ev.event === "injection") {
      const target = cascadeQueryIds.has(ev.queryId)
        ? arms.cascade.injections
        : syncQueryIds.has(ev.queryId)
          ? arms.sync.injections
          : null;
      if (target) {
        const existing = target.get(ev.queryId);
        if (existing) existing.add(ev.blockId);
        else target.set(ev.queryId, new Set([ev.blockId]));
      }
    } else if (ev.event === "agent_used") {
      const key = `${ev.queryId}|${ev.blockId}`;
      const strength = effectiveAttributionStrength(ev);
      const target = cascadeQueryIds.has(ev.queryId)
        ? arms.cascade.agentUsedPairs
        : syncQueryIds.has(ev.queryId)
          ? arms.sync.agentUsedPairs
          : null;
      if (target) {
        // Keep the STRONGEST observed strength for the pair so a
        // weak-then-strong stream still credits at strong, and the
        // reverse never downgrades. Mirrors the per-pair update
        // pattern in `core/analytics.ts`.
        const prev = target.get(key);
        if (prev === undefined || STRENGTH_RANK[strength] > STRENGTH_RANK[prev]) {
          target.set(key, strength);
        }
      }
    } else if (ev.event === "outcome") {
      if (cascadeQueryIds.has(ev.queryId)) arms.cascade.outcomes.set(ev.queryId, ev.resolved);
      else if (syncQueryIds.has(ev.queryId)) arms.sync.outcomes.set(ev.queryId, ev.resolved);
    }
  }

  const cascade = summarise(arms.cascade);
  const sync = summarise(arms.sync);
  const lift =
    cascade.helpfulRate !== null && sync.helpfulRate !== null
      ? cascade.helpfulRate - sync.helpfulRate
      : null;
  const lowSample = cascade.totalRuns < MIN_SAMPLE || sync.totalRuns < MIN_SAMPLE;

  return {
    cascade,
    sync,
    cascadeFallback: fallback,
    cascadeRerankerRan,
    lift,
    lowSample,
    window,
  };
}

function summarise(arm: {
  retrievals: number;
  injections: Map<string, Set<string>>;
  agentUsedPairs: Map<string, AttributionStrength>;
  outcomes: Map<string, boolean>;
}): CascadeArmMetrics {
  let helpfulRuns = 0;
  let totalRuns = 0;
  for (const [queryId, resolved] of arm.outcomes) {
    totalRuns++;
    const injectedItems = arm.injections.get(queryId);
    if (!injectedItems || injectedItems.size === 0) continue;
    // C2.3: require at least one agent_used pair on this queryId at
    // moderate-or-stronger evidence strength AND on an item that
    // was actually injected for this queryId. Pre-C2.3 we admitted
    // any strong pair on the same queryId regardless of whether the
    // cascade had put that item in front of the agent — that let
    // orphan attribution credit helpful and would have polluted
    // memory-health pruning learned from cascade-arm lift.
    const hasStrongEnoughInjectedUse = anyStrongInjectedAgentUsedFor(
      arm.agentUsedPairs,
      queryId,
      injectedItems,
    );
    if (hasStrongEnoughInjectedUse && resolved) helpfulRuns++;
  }
  return {
    retrievals: arm.retrievals,
    injections: arm.injections.size,
    helpfulRuns,
    totalRuns,
    helpfulRate: totalRuns === 0 ? null : helpfulRuns / totalRuns,
  };
}

function anyStrongInjectedAgentUsedFor(
  pairs: Map<string, AttributionStrength>,
  queryId: string,
  injectedItems: ReadonlySet<string>,
): boolean {
  for (const blockId of injectedItems) {
    const strength = pairs.get(`${queryId}|${blockId}`);
    if (strength !== undefined && meetsHelpfulThreshold(strength)) return true;
  }
  return false;
}

/**
 * Type guard for an `AnalyticsEvent` of a given variant. Useful when
 * filtering in callers without losing TypeScript's discriminated-union
 * narrowing. Currently used only by tests; kept here so it lives with
 * the rest of the cascade-event taxonomy.
 */
export function isRetrievalWithCascade(
  ev: AnalyticsEvent,
): ev is AnalyticsEvent & { event: "retrieval"; cascadePolicyId: string } {
  return ev.event === "retrieval" && typeof (ev as { cascadePolicyId?: string }).cascadePolicyId === "string";
}

const DAY_MS = 86_400_000;

function utcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
