/**
 * Block calibrator — turn raw ranker scores into calibrated P(helpful)
 * via isotonic regression fitted on the event log.
 *
 * Two entry points:
 *   • `fitCalibratorFromEvents(store)` — reads events, builds (score,
 *     helpful?1:0) training pairs, fits the isotonic model. Returns
 *     null when sample is too small (default min: 20 pairs).
 *   • `isotonicCalibrator(model)` — wraps a fitted IsotonicModel into
 *     a function matching the Calibrator type that `BlockServer`
 *     plugs in at its `opts.calibrator` slot. The existing slot
 *     means the serving layer needs NO code changes to pick up the
 *     real calibrator; callers just construct the server with it.
 *
 * Persistence lives in BlockStore (`saveCalibrator` / `loadCalibrator`)
 * under a user-chosen `name` — multiple named calibrators can coexist
 * (e.g. per-deployment, per-cohort). Phase 5 ships one standard name:
 * `BLOCK_CALIBRATOR_NAME` (= "isotonic.block.v1").
 */
import type { Calibrator } from "../core/block-serving.js";
import type { BlockStore } from "../core/block-store.js";
import type { InjectionEvent } from "../types.js";
import {
  fitIsotonic,
  predictIsotonic,
  type IsotonicModel,
} from "./isotonic.js";

/** Canonical name for the block-side calibrator in `calibrator_models`. */
export const BLOCK_CALIBRATOR_NAME = "isotonic.block.v1";

export interface FitCalibratorOptions {
  afterTs?: number;
  beforeTs?: number;
  runId?: string;
  /**
   * Below this number of (injection, outcome) training pairs, we
   * refuse to fit — too little data for the curve to be meaningful.
   * Default 20. Design doc §L6 suggests ≥ 200 for production use; 20
   * is a soft floor so smaller dev-time datasets still work.
   */
  minSample?: number;
  /** Deterministic clock for tests. */
  now?: () => number;
}

/**
 * Walk the event log and produce a fitted IsotonicModel, or null if
 * the dataset is too small. Semantics of "helpful" match §L6:
 *   helpful = injection ∧ agent_used ∧ outcome.resolved
 *
 * Training pairs are (injection.score, 1 if helpful else 0). Shadow
 * queries contribute no training data (they never fire injections).
 * Injection events that lack a matching outcome are skipped (the
 * ground truth isn't known yet).
 */
export function fitCalibratorFromEvents(
  store: BlockStore,
  opts: FitCalibratorOptions = {},
): IsotonicModel | null {
  const events = store.readEvents({
    ...(opts.afterTs !== undefined ? { afterTs: opts.afterTs } : {}),
    ...(opts.beforeTs !== undefined ? { beforeTs: opts.beforeTs } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    limit: 1_000_000,
  });

  const agentUsedPairs = new Set<string>(); // "queryId|blockId"
  const outcomeByQuery = new Map<string, { resolved: boolean }>();
  const injections: InjectionEvent[] = [];

  for (const ev of events) {
    switch (ev.event) {
      case "agent_used":
        agentUsedPairs.add(pairKey(ev.queryId, ev.blockId));
        break;
      case "outcome":
        outcomeByQuery.set(ev.queryId, { resolved: ev.resolved });
        break;
      case "injection":
        injections.push(ev);
        break;
      // Explicitly skipped:
      //   - retrieval        — pre-injection candidate enumeration
      //   - fact_injection / fact_agent_used — fact-domain (parallel calibrator)
      //   - trace_retrieval / trace_agent_used / trace_feedback
      //     — V1 trace-domain (PR 1 of May-2026 modernization); the V1 weight
      //     learner owns these. Mixing trace-domain events into the block
      //     calibrator would pollute the (score, helpful) pairs with values
      //     from a different scoring policy.
      default:
        break;
    }
  }

  const training: Array<{ x: number; y: number }> = [];
  for (const inj of injections) {
    const outcome = outcomeByQuery.get(inj.queryId);
    if (!outcome) continue; // incomplete pair
    const used = agentUsedPairs.has(pairKey(inj.queryId, inj.blockId));
    const helpful = used && outcome.resolved;
    training.push({ x: inj.score, y: helpful ? 1 : 0 });
  }

  const minSample = opts.minSample ?? 20;
  if (training.length < minSample) return null;

  const now = (opts.now ?? Date.now)();
  return fitIsotonic(training, now);
}

/**
 * Wrap an IsotonicModel into a BlockServer-compatible Calibrator
 * function. The second argument (block) is ignored — the block-side
 * calibrator operates on raw scores only. Phase 5.3 may introduce
 * per-block-class calibration; the signature already accommodates it.
 */
export function isotonicCalibrator(model: IsotonicModel): Calibrator {
  return (score, _block) => clamp01(predictIsotonic(model, score));
}

/** Identity fallback — useful when no model has been fitted yet. */
export const identityBlockCalibrator: Calibrator = (score) => clamp01(score);

/**
 * Convenience: fit from events, persist under BLOCK_CALIBRATOR_NAME,
 * and return the fitted model (or null). The caller is expected to
 * `loadCalibrator(BLOCK_CALIBRATOR_NAME)` and wrap with
 * `isotonicCalibrator` at server construction time.
 */
export function fitAndSaveBlockCalibrator(
  store: BlockStore,
  opts: FitCalibratorOptions = {},
): IsotonicModel | null {
  const model = fitCalibratorFromEvents(store, opts);
  if (!model) return null;
  store.saveCalibrator(BLOCK_CALIBRATOR_NAME, model);
  return model;
}

/**
 * Convenience: load the standard block calibrator from storage and
 * wrap it into a Calibrator function. Returns `identityBlockCalibrator`
 * if no model has been fitted yet.
 */
export function loadBlockCalibrator(store: BlockStore): Calibrator {
  const model = store.loadCalibrator<IsotonicModel>(BLOCK_CALIBRATOR_NAME);
  return model ? isotonicCalibrator(model) : identityBlockCalibrator;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pairKey(queryId: string, blockId: string): string {
  return `${queryId}|${blockId}`;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Re-export so `import { IsotonicModel } from "tracebase-ai"` works.
export type { IsotonicModel };
