/**
 * LifecycleRepair — the offline pass that closes the substrate's
 * self-correction loop (design doc §L6).
 *
 * Two responsibilities in Phase 5.1:
 *   1. `syncStats()` — recompute per-block `stats` and
 *      `quality.wilsonLowerBound` from the event log. Idempotent,
 *      order-independent, safe to rerun. Source of truth is the
 *      event log; stats in the block row are a materialized view.
 *   2. `applyDemotionRules()` — walk active blocks and move them
 *      to `demoted` when any of:
 *        a. `verification.status === "disproved"` (hard signal from
 *           the verifier; shouldn't be served regardless of stats)
 *        b. Wilson lower bound ≤ τ_demote with sufficient sample
 *        c. counterproductive / helpful ratio too high with sample
 *      `status: demoted` is already excluded from serving, so a
 *      demoted block is immediately taken out of the path.
 *
 * Deliberately NOT part of Phase 5.1 (scheduled for later):
 *   • Re-promote: demoted → active. This requires a fresh verify
 *     signal or a manual unblock, both of which land with Phase 4.5.
 *   • Fact-side repair loop (staleness TTL, reverify). Scoped to
 *     Phase 5.3 if data density supports it.
 *   • `cumulativeTokensSaved` / `cumulativeStepsSaved` rollup. Phase
 *     5.3 — needs shadow-arm comparison to be honest.
 *
 * Everything here reads from the event log, never from live traffic.
 * Ref: §L6 "Lifecycle repair reads from the event log, never from
 * live traffic."
 */
import type { BlockStore } from "../core/block-store.js";
import { refreshWilson } from "../core/block.js";
import { computeAggregates, type AggregateOptions } from "../core/analytics.js";
import type { ReasoningBlock } from "../types.js";

// ---------------------------------------------------------------------------
// Options + reports
// ---------------------------------------------------------------------------

export interface LifecycleRepairOptions {
  store: BlockStore;
  /**
   * Minimum number of injections before Wilson / counter-ratio gates
   * apply. Below this, demotion rules are skipped (sample too small
   * to be trustworthy). Default 5.
   */
  minInjectionSample?: number;
  /**
   * Wilson LB threshold below which an active block gets demoted.
   * Default 0.3. Choose in tandem with the serving gate threshold:
   *   wilsonDemoteThreshold < gateThreshold
   * so only serving-eligible blocks actually serve.
   */
  wilsonDemoteThreshold?: number;
  /**
   * Demote when counterproductive ÷ max(1, helpful) ≥ this ratio AND
   * the sample is large enough. Default 2.0.
   */
  counterToHelpfulRatio?: number;
  /** Window / scoping for the aggregate underlying syncStats. */
  afterTs?: number;
  beforeTs?: number;
  runId?: string;
}

export interface LifecycleSyncReport {
  blocksUpdated: number;
  /** Blocks seen in the event log that no longer exist in storage. */
  orphanEventBlocks: number;
}

export interface LifecycleDemotionAction {
  blockId: string;
  /** Key describing which rule fired — e.g. "verification:disproved",
   *  "wilson-lb:0.17", "counter-ratio:3.0". */
  reason: string;
}

export interface LifecycleActionReport {
  demoted: LifecycleDemotionAction[];
  /** Active blocks considered and kept — with the primary reason. */
  kept: Array<{ blockId: string; reason: string }>;
}

export interface LifecycleRunReport {
  sync: LifecycleSyncReport;
  actions: LifecycleActionReport;
}

// ---------------------------------------------------------------------------
// LifecycleRepair
// ---------------------------------------------------------------------------

export class LifecycleRepair {
  private readonly store: BlockStore;
  private readonly minInjectionSample: number;
  private readonly wilsonDemoteThreshold: number;
  private readonly counterToHelpfulRatio: number;
  private readonly window: AggregateOptions;

  constructor(opts: LifecycleRepairOptions) {
    this.store = opts.store;
    this.minInjectionSample = opts.minInjectionSample ?? 5;
    this.wilsonDemoteThreshold = opts.wilsonDemoteThreshold ?? 0.3;
    this.counterToHelpfulRatio = opts.counterToHelpfulRatio ?? 2.0;
    this.window = {
      ...(opts.afterTs !== undefined ? { afterTs: opts.afterTs } : {}),
      ...(opts.beforeTs !== undefined ? { beforeTs: opts.beforeTs } : {}),
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    };
  }

  /**
   * Recompute per-block stats from the event log and persist.
   * Overwrites `stats.timesRetrieved/Injected/AgentUsed/Helpful/
   * Counterproductive` and refreshes `quality.wilsonLowerBound`.
   * Leaves `cumulativeTokensSaved/StepsSaved` and `calibrationCohort`
   * untouched (both are owned by separate modules).
   */
  syncStats(): LifecycleSyncReport {
    const agg = computeAggregates(this.store, this.window);
    let updated = 0;
    let orphaned = 0;

    for (const row of agg.perBlock) {
      const existing = this.store.getBlock(row.blockId);
      if (!existing) {
        // The event log references a block that's been deleted.
        // Count for reporting; nothing to update.
        orphaned++;
        continue;
      }

      const lastUsedAt = this.latestUsageTs(row.blockId);
      const withStats: ReasoningBlock = {
        ...existing,
        stats: {
          ...existing.stats,
          timesRetrieved: row.retrieved,
          timesInjected: row.injected,
          timesAgentUsed: row.agentUsed,
          timesHelpful: row.helpful,
          timesCounterproductive: row.counterproductive,
          ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
        },
      };
      const refreshed = refreshWilson(withStats);
      this.store.replaceBlock(refreshed);
      updated++;
    }
    return { blocksUpdated: updated, orphanEventBlocks: orphaned };
  }

  /**
   * Walk active blocks and apply the demotion rules. Rules are checked
   * in order; the first matching rule wins. Returns a per-block action
   * list (demoted or kept, with a reason string). Never throws.
   */
  applyDemotionRules(): LifecycleActionReport {
    const demoted: LifecycleDemotionAction[] = [];
    const kept: Array<{ blockId: string; reason: string }> = [];

    const blocks = this.store.listBlocks({ status: "active", limit: 100_000 });
    for (const block of blocks) {
      const reason = this.evaluateForDemotion(block);
      if (reason) {
        this.store.updateBlockStatus(block.id, "demoted");
        demoted.push({ blockId: block.id, reason });
      } else {
        kept.push({ blockId: block.id, reason: "active-retained" });
      }
    }
    return { demoted, kept };
  }

  /**
   * Convenience: run sync then demotion in order. Returns both reports.
   */
  runAll(): LifecycleRunReport {
    const sync = this.syncStats();
    const actions = this.applyDemotionRules();
    return { sync, actions };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private evaluateForDemotion(block: ReasoningBlock): string | null {
    // Rule (a): explicit disproof from the verifier — always demote.
    // Fires regardless of sample size because the verifier signal is
    // authoritative by itself.
    if (block.verification?.status === "disproved") {
      return "verification:disproved";
    }

    const injected = block.stats.timesInjected;
    if (injected < this.minInjectionSample) {
      // Not enough data; leave alone.
      return null;
    }

    // Rule (b): Wilson LB below threshold with sufficient sample.
    if (block.quality.wilsonLowerBound < this.wilsonDemoteThreshold) {
      return `wilson-lb:${block.quality.wilsonLowerBound.toFixed(3)}`;
    }

    // Rule (c): counterproductive-to-helpful ratio over threshold.
    const counter = block.stats.timesCounterproductive;
    const helpful = Math.max(1, block.stats.timesHelpful);
    const ratio = counter / helpful;
    if (ratio >= this.counterToHelpfulRatio) {
      return `counter-ratio:${ratio.toFixed(2)}`;
    }

    return null;
  }

  /**
   * Max timestamp across injection + agent_used events for a block —
   * the "last time this block was in front of an agent".
   * Returns undefined if no such events exist.
   */
  private latestUsageTs(blockId: string): number | undefined {
    const events = this.store.readEvents({
      ...this.window,
      blockId,
      eventType: ["injection", "agent_used"],
      limit: 100_000,
    });
    if (events.length === 0) return undefined;
    let max = -Infinity;
    for (const ev of events) if (ev.ts > max) max = ev.ts;
    return Number.isFinite(max) ? max : undefined;
  }
}
