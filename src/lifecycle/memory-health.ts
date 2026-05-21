/**
 * Memory health scoring — May-2026 C3.
 *
 * Pure-math layer that scores each active reasoning_block on its
 * §L6 helpful evidence + memory-hygiene risk factors. The C3
 * directive: a single read-only health number per block, with a
 * breakdown of the penalty components AND the demotion reason
 * codes, so a later pass (C4) can route the lowest-scoring blocks
 * into the existing `runMemoryPrune` flow as demotion candidates
 * — without spinning up a parallel memory system.
 *
 * Scope contract this commit honors verbatim:
 *
 *   • Read-only. No `updateBlockStatus`, no event emission, no
 *     side effects. Demotion is a separate pass.
 *   • Reuse: `computeAggregates` (per-block §L6 stats), block
 *     `trigger.keywords` + `jaccardSimilarity` (duplication),
 *     `BlockStats.lastUsedAt` (staleness). No new tables, no new
 *     event types.
 *   • Backward compatible: blocks without recent events score
 *     cleanly via the priors (wilson_lb=0 when n=0; staleness
 *     leans on createdAt when lastUsedAt is unset).
 *   • C4 will wire the per-block ROI penalty through the existing
 *     `serving-arbiter` math (currently the V1 penalty is a
 *     conservative heuristic over high-injection / low-helpful
 *     blocks — clearly marked so the swap is mechanical).
 *
 * Health formula:
 *
 *     health = wilson_lb
 *            − counterproductive_rate
 *            − stale_penalty
 *            − duplication_penalty
 *            − genericness_penalty
 *            − negative_roi_penalty
 *
 * Typical range [-1, 1]. Higher = healthier. `health ≤ 0` is the
 * default demotion threshold; callers can tighten.
 */
import type { BlockStore } from "../core/block-store.js";
import type { ReasoningBlock } from "../types.js";
import { computeAggregates } from "../core/analytics.js";
import { jaccardSimilarity } from "../core/fingerprint.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-component breakdown of the deductions feeding `health`. Each
 * field is a NON-NEGATIVE penalty in [0, 1]; the score is
 * `wilson_lb − Σ penalties`. Keeping the breakdown explicit lets
 * the CLI render which lever dragged the block down and gives C4 a
 * mechanical demotion-reason mapping.
 */
export interface MemoryHealthComponents {
  /**
   * Wilson 95% LOWER bound on P(helpful | injection). 0 when no
   * injections — explicitly "no evidence", not "bad". The Wilson
   * lower bound is preferred over raw helpful-rate because tiny-n
   * blocks (1/1 helpful) would otherwise look perfect.
   */
  wilsonLb: number;
  /**
   * `counterproductive / injected`. Direct §L6 signal that the
   * block was used by the agent AND the run failed. 0 when
   * injected=0.
   */
  counterproductiveRate: number;
  /**
   * Penalty for time since the block was last useful. Smooth ramp
   * scaled by `staleHalfLifeDays`; capped at `staleMaxPenalty`.
   * Blocks that have never been used at all use `createdAt` as the
   * staleness anchor (the floor for "this block has been around
   * but nobody ever needed it").
   */
  stalePenalty: number;
  /**
   * Per-hit duplication cost — for each sibling block whose
   * trigger keywords share Jaccard ≥ `duplicationJaccardThreshold`
   * with this one, we add `duplicationPerHit`. Capped. Designed to
   * surface obvious near-duplicates surfaced by the same retrieval
   * pass; NOT a clustering step (that lives in distillation).
   */
  duplicationPenalty: number;
  /**
   * Penalty for blocks whose trigger fingerprint is so short / so
   * non-specific that they would match many unrelated queries.
   * V1 proxy: keyword count below `genericMinKeywords`. Cheap and
   * uses data we already extract; can be sharpened later via an
   * IDF / surprisal measure if needed.
   */
  genericnessPenalty: number;
  /**
   * V1 conservative proxy for the C1 arbiter's
   * `expectedNetTokens`. Fires when a block has been injected ≥
   * `negativeRoiMinInjections` times and the helpful rate is
   * below `negativeRoiHelpfulFloor`. C4 will replace this with a
   * real `scoreCandidate({calibratedProb, estimatedAvoidedTokens,
   * injectionTokens, ...})` call — the shape of the penalty stays
   * identical so the demotion-reason wiring downstream is stable.
   */
  negativeRoiPenalty: number;
}

/**
 * Reason codes attached when `health <= demotionThreshold`. Empty
 * for healthy blocks. Multiple reasons may fire; we keep the full
 * list so C4 / dashboards can prioritise the strongest signal.
 */
export type DemotionReason =
  | "low_wilson_lb"
  | "high_counterproductive"
  | "stale"
  | "duplicate"
  | "generic"
  | "negative_roi";

export interface MemoryHealthEvidence {
  injected: number;
  agentUsed: number;
  helpful: number;
  verifiedHelpful: number;
  counterproductive: number;
  /** Block's creation time, ms epoch. */
  createdAt: number;
  /** Last time the block contributed to a retrieval slate, ms epoch. */
  lastUsedAt: number | null;
  /** Days since the block was created. */
  ageDays: number;
  /**
   * Days since the block was last used. `null` when never used —
   * `stalePenalty` falls back to `ageDays` in that case.
   */
  daysSinceLastUse: number | null;
}

export interface MemoryHealthScore {
  blockId: string;
  /**
   * Composite health number. `wilson_lb − Σ penalties`. Range
   * effectively [-1, 1]; values below the demotion threshold are
   * candidates for the C4 demotion pass.
   */
  health: number;
  components: MemoryHealthComponents;
  /**
   * Reason codes when `health ≤ demotionThreshold`, in priority
   * order. Empty when the block is above threshold.
   */
  reasons: DemotionReason[];
  evidence: MemoryHealthEvidence;
}

export interface MemoryHealthReport {
  /** Number of active blocks scored. */
  scanned: number;
  /** Per-block scores, sorted by health ASC (worst first). */
  scored: MemoryHealthScore[];
  /**
   * Blocks whose health is ≤ `demotionThreshold`. Subset of
   * `scored`; surfaced separately because the CLI prints this list
   * as "would demote on apply" (NO --apply in C3 — read-only by
   * contract; the actual transition lives in C4).
   */
  wouldDemote: MemoryHealthScore[];
  /** Threshold that classified `wouldDemote`. */
  demotionThreshold: number;
  /** Window the per-block analytics covered. */
  window: { afterTs?: number; beforeTs?: number };
  /** Wall clock the report was produced — for cache/freshness checks. */
  generatedAt: number;
  /** Effective config the scorer used (after defaults merged). */
  config: MemoryHealthConfig;
}

export interface MemoryHealthConfig {
  /** Wilson z-score. 1.96 = 95% CI. */
  wilsonZ: number;
  /** Stale-penalty growth rate, in days; lower → ramp faster. */
  staleHalfLifeDays: number;
  /** Max stale penalty applied (cap). */
  staleMaxPenalty: number;
  /** Trigger-keyword Jaccard threshold to count as a duplicate. */
  duplicationJaccardThreshold: number;
  /** Penalty per duplicate sibling. */
  duplicationPerHit: number;
  /** Cap on duplication penalty regardless of sibling count. */
  duplicationMaxPenalty: number;
  /** Trigger keyword count below which the block reads as "generic". */
  genericMinKeywords: number;
  /** Max genericness penalty applied. */
  genericMaxPenalty: number;
  /** Inject-count threshold before negative-ROI heuristic fires. */
  negativeRoiMinInjections: number;
  /** Helpful-rate floor — below this with enough injections fires the penalty. */
  negativeRoiHelpfulFloor: number;
  /** Max negative-ROI penalty applied. */
  negativeRoiMaxPenalty: number;
  /** Composite-health threshold for `wouldDemote`. */
  demotionThreshold: number;
}

export const DEFAULT_MEMORY_HEALTH_CONFIG: MemoryHealthConfig = {
  wilsonZ: 1.96,
  staleHalfLifeDays: 30,
  staleMaxPenalty: 0.2,
  duplicationJaccardThreshold: 0.75,
  duplicationPerHit: 0.1,
  duplicationMaxPenalty: 0.2,
  genericMinKeywords: 4,
  genericMaxPenalty: 0.15,
  negativeRoiMinInjections: 5,
  negativeRoiHelpfulFloor: 0.1,
  negativeRoiMaxPenalty: 0.2,
  demotionThreshold: 0,
};

export interface ComputeMemoryHealthOptions {
  /** Override `Date.now()` for deterministic tests. */
  nowMs?: number;
  /** Pass-through to `computeAggregates` for the evidence window. */
  afterTs?: number;
  beforeTs?: number;
  /** Partial override of the scoring config; merged over defaults. */
  config?: Partial<MemoryHealthConfig>;
}

// ---------------------------------------------------------------------------
// Pure scoring — no I/O. Composable from unit tests.
// ---------------------------------------------------------------------------

/**
 * Wilson 95% lower bound on a Bernoulli mean given `successes /
 * trials`. Stable when `trials=0` (returns 0 — "no evidence"). We
 * inline the formula rather than pulling a stats dep; the numeric
 * stability concerns (z²/n dominating for tiny n, and the
 * radicand turning negative under float drift on perfect 0/0)
 * are handled with explicit guards.
 */
export function wilsonLowerBound(
  successes: number,
  trials: number,
  z: number,
): number {
  if (trials <= 0) return 0;
  const phat = successes / trials;
  const z2 = z * z;
  const centre = phat + z2 / (2 * trials);
  const radicand = (phat * (1 - phat) + z2 / (4 * trials)) / trials;
  // Float drift can push the radicand a hair below zero on n=1
  // boundary cases (e.g. 0 successes / 1 trial). Clamp.
  const margin = z * Math.sqrt(Math.max(0, radicand));
  const denom = 1 + z2 / trials;
  return Math.max(0, Math.min(1, (centre - margin) / denom));
}

/**
 * Smooth ramp: `min(maxPenalty, days / halfLifeDays * maxPenalty
 * / 2)` saturating cleanly. Picked over an exp curve because
 * operators read a linear ramp more easily and the cap removes the
 * tail's punitive asymmetry.
 */
export function stalenessPenalty(
  days: number,
  halfLifeDays: number,
  maxPenalty: number,
): number {
  // NaN guard. Infinity is allowed to flow through to the cap — a
  // block with infinite age is fully stale, not "no info".
  if (Number.isNaN(days) || days <= 0) return 0;
  if (halfLifeDays <= 0) return 0;
  // 0d → 0; halfLifeDays → maxPenalty/2; 2*halfLifeDays → maxPenalty.
  const raw = (days / (2 * halfLifeDays)) * maxPenalty;
  return Math.min(maxPenalty, Math.max(0, raw));
}

/**
 * Duplication penalty given per-sibling Jaccard scores. Counts
 * siblings ≥ threshold, scales linearly by `perHit`, capped by
 * `maxPenalty`. Intentionally NOT a clustering — we want a cheap
 * "is this block obviously redundant" signal.
 */
export function duplicationPenalty(
  perSiblingJaccard: readonly number[],
  threshold: number,
  perHit: number,
  maxPenalty: number,
): number {
  let hits = 0;
  for (const j of perSiblingJaccard) {
    if (j >= threshold) hits++;
  }
  if (hits <= 0) return 0;
  return Math.min(maxPenalty, hits * perHit);
}

/**
 * Genericness penalty: blocks with a tiny trigger keyword set
 * read as "this matches everything" and are over-served. Linear
 * shortfall scaled to `maxPenalty`; zero when at/above the
 * minimum.
 */
export function genericnessPenalty(
  keywordCount: number,
  minKeywords: number,
  maxPenalty: number,
): number {
  if (minKeywords <= 0) return 0;
  if (keywordCount >= minKeywords) return 0;
  const shortfall = (minKeywords - keywordCount) / minKeywords;
  return Math.min(maxPenalty, Math.max(0, shortfall * maxPenalty));
}

/**
 * V1 negative-ROI heuristic. Fires when the block has had enough
 * injections that the failure rate is real signal AND the helpful
 * rate is below the floor. Magnitude scales linearly with how far
 * below the floor we are. C4 will replace the body of this
 * function with a real arbiter call; the shape (single non-negative
 * scalar in [0, maxPenalty]) is the durable contract.
 */
export function negativeRoiPenalty(
  injected: number,
  helpful: number,
  minInjections: number,
  helpfulFloor: number,
  maxPenalty: number,
): number {
  if (injected < minInjections) return 0;
  if (helpfulFloor <= 0) return 0;
  const rate = helpful / injected;
  if (rate >= helpfulFloor) return 0;
  const shortfall = (helpfulFloor - rate) / helpfulFloor;
  return Math.min(maxPenalty, Math.max(0, shortfall * maxPenalty));
}

/** Days between two epoch-ms timestamps; `from` is the earlier. */
function daysBetween(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, (toMs - fromMs) / (1000 * 60 * 60 * 24));
}

/**
 * Map fired components to demotion reasons, in priority order.
 * `health` must be ≤ threshold for any reason to fire — above
 * threshold the block is healthy regardless of which penalties
 * contributed. We surface ALL reasons that crossed an
 * intermediate threshold, not just the strongest, so the CLI and
 * future C4 demotion path can show why.
 */
export function classifyDemotionReasons(
  health: number,
  components: MemoryHealthComponents,
  evidence: { injected: number },
  config: MemoryHealthConfig,
): DemotionReason[] {
  if (health > config.demotionThreshold) return [];
  const reasons: DemotionReason[] = [];
  if (evidence.injected > 0 && components.wilsonLb < 0.1) reasons.push("low_wilson_lb");
  if (components.counterproductiveRate >= 0.2) reasons.push("high_counterproductive");
  if (components.stalePenalty >= config.staleMaxPenalty * 0.5) reasons.push("stale");
  if (components.duplicationPenalty > 0) reasons.push("duplicate");
  if (components.genericnessPenalty > 0) reasons.push("generic");
  if (components.negativeRoiPenalty > 0) reasons.push("negative_roi");
  return reasons;
}

// ---------------------------------------------------------------------------
// Scoring a single block — pure given a per-block stat row + siblings.
// ---------------------------------------------------------------------------

export interface ScoreBlockInput {
  block: Pick<ReasoningBlock, "id" | "createdAt" | "trigger" | "stats">;
  perBlock: {
    injected: number;
    agentUsed: number;
    helpful: number;
    verifiedHelpful: number;
    counterproductive: number;
  };
  /**
   * Other active blocks' trigger keywords, used for duplication.
   * Pass `[]` when no siblings (or to skip duplication scoring).
   */
  siblings: ReadonlyArray<{ id: string; keywords: string[] }>;
  /** Current wall clock, ms epoch. */
  nowMs: number;
  config: MemoryHealthConfig;
}

export function scoreBlock(input: ScoreBlockInput): MemoryHealthScore {
  const { block, perBlock, siblings, nowMs, config } = input;

  const wilsonLb = wilsonLowerBound(perBlock.helpful, perBlock.injected, config.wilsonZ);
  const counterRate =
    perBlock.injected > 0 ? perBlock.counterproductive / perBlock.injected : 0;

  // Staleness anchor: lastUsedAt if known, else createdAt. Blocks
  // that never recorded a usage event are penalised based on how
  // long they've sat around without earning a touch.
  const lastUsedAt = block.stats.lastUsedAt;
  const stalenessAnchor = lastUsedAt ?? block.createdAt;
  const daysSinceAnchor = daysBetween(stalenessAnchor, nowMs);
  const stale = stalenessPenalty(daysSinceAnchor, config.staleHalfLifeDays, config.staleMaxPenalty);

  // Duplication — Jaccard against each sibling's keywords. We
  // compare keyword SETS (already normalised by the distiller)
  // not raw situation strings; this is the cheap, deterministic
  // proxy the design used everywhere else.
  const ownKeywords = block.trigger.keywords;
  const perSiblingJaccard: number[] = [];
  if (ownKeywords.length > 0) {
    for (const sib of siblings) {
      if (sib.id === block.id) continue;
      if (sib.keywords.length === 0) continue;
      perSiblingJaccard.push(jaccardSimilarity(ownKeywords, sib.keywords));
    }
  }
  const duplication = duplicationPenalty(
    perSiblingJaccard,
    config.duplicationJaccardThreshold,
    config.duplicationPerHit,
    config.duplicationMaxPenalty,
  );

  const generic = genericnessPenalty(
    ownKeywords.length,
    config.genericMinKeywords,
    config.genericMaxPenalty,
  );

  const negativeRoi = negativeRoiPenalty(
    perBlock.injected,
    perBlock.helpful,
    config.negativeRoiMinInjections,
    config.negativeRoiHelpfulFloor,
    config.negativeRoiMaxPenalty,
  );

  const components: MemoryHealthComponents = {
    wilsonLb,
    counterproductiveRate: counterRate,
    stalePenalty: stale,
    duplicationPenalty: duplication,
    genericnessPenalty: generic,
    negativeRoiPenalty: negativeRoi,
  };

  const health =
    wilsonLb - counterRate - stale - duplication - generic - negativeRoi;

  const evidence: MemoryHealthEvidence = {
    injected: perBlock.injected,
    agentUsed: perBlock.agentUsed,
    helpful: perBlock.helpful,
    verifiedHelpful: perBlock.verifiedHelpful,
    counterproductive: perBlock.counterproductive,
    createdAt: block.createdAt,
    lastUsedAt: lastUsedAt ?? null,
    ageDays: daysBetween(block.createdAt, nowMs),
    daysSinceLastUse: lastUsedAt !== undefined ? daysBetween(lastUsedAt, nowMs) : null,
  };

  const reasons = classifyDemotionReasons(
    health,
    components,
    { injected: perBlock.injected },
    config,
  );

  return {
    blockId: block.id,
    health,
    components,
    reasons,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Top-level driver — pulls inputs from the live store and scores each
// active block. Side-effect-free.
// ---------------------------------------------------------------------------

export function computeMemoryHealth(
  store: BlockStore,
  opts: ComputeMemoryHealthOptions = {},
): MemoryHealthReport {
  const config: MemoryHealthConfig = { ...DEFAULT_MEMORY_HEALTH_CONFIG, ...(opts.config ?? {}) };
  const nowMs = opts.nowMs ?? Date.now();

  const active = store.listBlocks({ status: "active", limit: 100_000 });
  const window: { afterTs?: number; beforeTs?: number } = {};
  if (opts.afterTs !== undefined) window.afterTs = opts.afterTs;
  if (opts.beforeTs !== undefined) window.beforeTs = opts.beforeTs;
  const agg = computeAggregates(store, window);

  // Build a perBlockId lookup once — `computeAggregates` already
  // applied the strict §L6 + C2.3 intersection gate, so we trust
  // its numbers directly.
  const perBlockById = new Map<string, (typeof agg.perBlock)[number]>();
  for (const row of agg.perBlock) perBlockById.set(row.blockId, row);

  // Sibling keyword set for duplication: every other active
  // block's `trigger.keywords`. This is O(N²) on the active
  // corpus; fine up to ~10k blocks (typical projects sit well
  // below that). When that ceiling matters we can swap in a
  // SimHash / MinHash banding step.
  const siblings = active.map((b) => ({ id: b.id, keywords: b.trigger.keywords }));

  const scored: MemoryHealthScore[] = [];
  for (const block of active) {
    const row = perBlockById.get(block.id);
    const score = scoreBlock({
      block,
      perBlock: row ?? {
        injected: 0,
        agentUsed: 0,
        helpful: 0,
        verifiedHelpful: 0,
        counterproductive: 0,
      },
      siblings,
      nowMs,
      config,
    });
    scored.push(score);
  }

  scored.sort((a, b) => a.health - b.health);
  // wouldDemote requires BOTH a sub-threshold composite health AND
  // at least one fired reason. A brand-new block with zero
  // evidence has health=0 (= threshold) but no reason codes —
  // that's "no information", not "should be demoted". Demanding
  // a reason gives C4 a clean handle and keeps fresh blocks safe.
  const wouldDemote = scored.filter(
    (s) => s.health <= config.demotionThreshold && s.reasons.length > 0,
  );

  return {
    scanned: active.length,
    scored,
    wouldDemote,
    demotionThreshold: config.demotionThreshold,
    window,
    generatedAt: nowMs,
    config,
  };
}
