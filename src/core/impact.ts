/**
 * Impact — value-first translation of EventAggregates for end-user UX.
 *
 * The aggregator in `analytics.ts` produces the rigorous numbers the
 * doctor / dashboard / academic write-up need: helpful rate, coverage,
 * shadow lift, calibration deltas. None of those words mean anything
 * to a regular coder who just wants to know "did this thing actually
 * save me time?".
 *
 * This module is the friendly half of that pipeline. Same input
 * (`EventAggregates`), simpler output:
 *
 *   • `assistedTasks` — how many of the agent's runs TraceBase showed
 *     up for at all (non-shadow retrievals with an injection).
 *   • `helpedTasks` — how many of those actually worked (helpful = the
 *     §L6 helpfulness definition: injection ∧ agent_used ∧ resolved).
 *   • `memoriesUsed` — distinct blocks that were `agent_used` at least
 *     once. The "size of your useful memory" stat.
 *   • `estimatedMinutesSaved`, `estimatedTokensSaved` — translated from
 *     helpful counts and (if available) shadow-arm token lift.
 *   • `topMemories` — the blocks that helped most (by helpful count).
 *   • `needsAttention` — blocks that fired but didn't help (so the
 *     user can prune them).
 *
 * The single `confidence` field is the honesty layer:
 *
 *   "measured" — we have a non-empty shadow arm AND token data, so
 *                the saved-tokens number is observed, not modelled.
 *   "estimated" — we have events but no shadow arm; numbers come from
 *                 a default heuristic. Caller MUST render "Estimated".
 *   "empty"    — no events. The UI shows the empty state, no numbers.
 *
 * No new analytics here. Just a renaming + a simple cost model. The
 * cost-model coefficients (minutesPerHelp, tokensPerHelp) are
 * deliberately conservative so the surfaced number underestimates
 * rather than overpromises — better to delight a returning user than
 * to inflate a first-week claim.
 */
import type { EventAggregates } from "./analytics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImpactConfidence = "measured" | "estimated" | "empty";

export interface TopMemory {
  blockId: string;
  /** Times this block was credited as `helpful` (injection ∧ used ∧ resolved). */
  helpful: number;
  /** Times the agent acted on the block. Always ≥ helpful. */
  agentUsed: number;
  /** Times the block was injected into the prompt. Always ≥ agentUsed. */
  injected: number;
}

export interface NeedsAttention {
  blockId: string;
  /** Times this block was injected, used, and the task did NOT resolve. */
  counterproductive: number;
  injected: number;
}

export interface Impact {
  /** True iff there are no events at all — render the empty state. */
  isEmpty: boolean;
  /**
   * How sure are we about the saved-minutes / saved-tokens numbers?
   *
   *   "measured"  — shadow-arm comparison is available; numbers are
   *                 derived from observed token lift, not a heuristic.
   *   "estimated" — events exist but no shadow arm to compare against,
   *                 so numbers come from a conservative cost model.
   *   "empty"     — no events; numbers are 0 by convention.
   */
  confidence: ImpactConfidence;

  /** Non-shadow retrievals where at least one injection fired. */
  assistedTasks: number;
  /**
   * Tasks credited as helpful (resolved AND used the injected pattern).
   * Counts BOTH Stop-hook-inferred and explicit-MCP resolutions —
   * matches the historical `helpedTasks` definition. Pair with
   * `verifiedHelpedTasks` for the explicit-only subset.
   */
  helpedTasks: number;
  /**
   * Subset of `helpedTasks` whose outcome was reported through the
   * canonical MCP / SDK path (`attribution: "explicit"` or absent
   * for backwards-compat). Excludes outcomes written by the Stop-
   * hook attribution layer (`attribution: "inferred"`). Sourced
   * from `aggregates.funnel.verifiedHelpfulRuns`.
   */
  verifiedHelpedTasks: number;
  /** Distinct blocks that were agent_used at least once. */
  memoriesUsed: number;

  /** Minutes-saved estimate. Always ≥ 0. See cost model below. */
  estimatedMinutesSaved: number;
  /** Tokens-saved estimate. Always ≥ 0. See cost model below. */
  estimatedTokensSaved: number;

  /** Top blocks by helpful count. Capped at `topN` (default 5). */
  topMemories: TopMemory[];
  /** Blocks with counterproductive > 0. Capped at `topN` (default 5). */
  needsAttention: NeedsAttention[];
}

export interface ImpactOptions {
  /** Cap on topMemories and needsAttention list lengths. Default 5. */
  topN?: number;
  /**
   * Minutes saved per helpful task — conservative default reflects the
   * "skim a paragraph instead of debugging from scratch" win. Override
   * via team-level enterprise config later; not user-facing.
   */
  minutesPerHelp?: number;
  /**
   * Tokens saved per helpful task when no shadow-arm measurement is
   * available. Conservative.
   */
  tokensPerHelp?: number;
}

// ---------------------------------------------------------------------------
// Cost model defaults — deliberately conservative.
//
// Rationale: a recurring user will accumulate more confidence in the
// numbers as the shadow arm kicks in and `confidence` flips to
// "measured". Until then we'd rather under-report a real win than
// over-promise on a thin sample.
// ---------------------------------------------------------------------------

const DEFAULT_MINUTES_PER_HELP = 4;
const DEFAULT_TOKENS_PER_HELP = 600;
const DEFAULT_TOP_N = 5;

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/**
 * Project `EventAggregates` (the rigorous metric surface) into `Impact`
 * (the friendly summary the CLI and the dashboard show by default).
 *
 * Never throws. Always returns a fully-populated `Impact` even when
 * the aggregates are empty — `isEmpty=true` is the signal callers
 * use to switch to the empty-state UI.
 */
export function computeImpact(
  aggregates: EventAggregates,
  opts: ImpactOptions = {},
): Impact {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const minutesPerHelp = opts.minutesPerHelp ?? DEFAULT_MINUTES_PER_HELP;
  const tokensPerHelp = opts.tokensPerHelp ?? DEFAULT_TOKENS_PER_HELP;

  // assistedTasks: non-shadow retrievals that had ANY injection. This
  // is the "how often did TraceBase contribute to a run" count — the
  // user's mental model of "TraceBase was on this task".
  //
  // We back it out of coverage instead of re-counting events because
  // computeAggregates already encodes the right join.
  const treatment = aggregates.retrieval.treatment;
  const assistedTasks = Math.round(treatment * aggregates.rates.coverage);

  // helpedTasks: sum of `helpful` across blocks (multiple blocks may
  // share a helpful credit on one queryId — that's fine, it reflects
  // a query genuinely benefiting from N memories).
  let helpedTasks = 0;
  let verifiedHelpedTasks = 0;
  const usedBlockIds = new Set<string>();
  for (const row of aggregates.perBlock) {
    helpedTasks += row.helpful;
    // verifiedHelpedTasks is summed in the SAME unit as helpedTasks
    // (per-block) so the savings UI can subtract them honestly:
    // helpedTasks - verifiedHelpedTasks = inferred-only help. Pulling
    // from funnel.verifiedHelpfulRuns would mix distinct-queryId
    // counts with per-block sums and the split would lie whenever
    // a single query touched multiple helpful blocks.
    verifiedHelpedTasks += row.verifiedHelpful;
    if (row.agentUsed > 0) usedBlockIds.add(row.blockId);
  }

  const memoriesUsed = usedBlockIds.size;

  // ---- saved-tokens: measured when possible, modelled otherwise ----------
  //
  // tokenLift in EventAggregates is signed (mean treatment − mean shadow).
  // Negative tokenLift = treatment used fewer tokens than shadow = real
  // savings. The total "tokens saved" is therefore
  //   -tokenLift × totalTreatment
  // when tokenLift is negative; positive tokenLift means TraceBase
  // INCREASED token usage on average, in which case "saved" is 0.
  //
  // We require BOTH a non-null tokenLift AND non-null resolvedLift
  // before claiming "measured" — having token data without shadow
  // resolved data leaves us guessing about whether the tokens were
  // well-spent.
  const haveShadowArm =
    aggregates.rates.tokenLift !== null && aggregates.rates.resolvedLift !== null;

  let estimatedTokensSaved: number;
  if (
    haveShadowArm &&
    aggregates.rates.tokenLift !== null &&
    aggregates.rates.tokenLift < 0
  ) {
    estimatedTokensSaved = Math.round(
      -aggregates.rates.tokenLift * aggregates.outcome.totalTreatment,
    );
  } else if (haveShadowArm) {
    // Shadow arm exists but lift was zero or positive — be honest, 0.
    estimatedTokensSaved = 0;
  } else {
    // No shadow arm → cost model fallback.
    estimatedTokensSaved = helpedTasks * tokensPerHelp;
  }

  const estimatedMinutesSaved = Math.round(helpedTasks * minutesPerHelp);

  // ---- top memories / needs-attention ------------------------------------
  // perBlock is already sorted by helpful desc in computeAggregates.
  const topMemories: TopMemory[] = aggregates.perBlock
    .filter((b) => b.helpful > 0)
    .slice(0, topN)
    .map((b) => ({
      blockId: b.blockId,
      helpful: b.helpful,
      agentUsed: b.agentUsed,
      injected: b.injected,
    }));

  const needsAttention: NeedsAttention[] = aggregates.perBlock
    .filter((b) => b.counterproductive > 0)
    // Sort by counter desc — different ordering from perBlock's helpful
    // ordering, so we have to resort here.
    .sort((a, b) => b.counterproductive - a.counterproductive)
    .slice(0, topN)
    .map((b) => ({
      blockId: b.blockId,
      counterproductive: b.counterproductive,
      injected: b.injected,
    }));

  // ---- emptiness + confidence -------------------------------------------
  const totalEvents =
    aggregates.counts.retrieval +
    aggregates.counts.injection +
    aggregates.counts.agentUsed +
    aggregates.counts.outcome;
  const isEmpty = totalEvents === 0;

  let confidence: ImpactConfidence;
  if (isEmpty) {
    confidence = "empty";
  } else if (haveShadowArm) {
    confidence = "measured";
  } else {
    confidence = "estimated";
  }

  return {
    isEmpty,
    confidence,
    assistedTasks,
    helpedTasks,
    // Per-block sum from above — same unit as helpedTasks so the
    // savings UI can compute inferredHelpedTasks = helpedTasks -
    // verifiedHelpedTasks without unit-mismatch artefacts. The
    // funnel exposes a queryId-distinct count too
    // (funnel.verifiedHelpfulRuns) which is the right surface for
    // run-level dashboards; we keep them numerically consistent at
    // a queryId == single-block-helpful boundary, and they diverge
    // honestly when one query helps N blocks.
    verifiedHelpedTasks,
    memoriesUsed,
    estimatedMinutesSaved,
    estimatedTokensSaved,
    topMemories,
    needsAttention,
  };
}
