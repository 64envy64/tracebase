/**
 * Calibrator auto-refit loop — the lever that makes "every run teaches
 * the next run" land in production traffic instead of staying a
 * library-only knob.
 *
 * The mechanics:
 *
 *   1. Every `record_reasoning_outcome` call passes through
 *      `maybeRefitCalibrator()`. We count `outcome` analytics events that landed
 *      AFTER the currently-loaded model's `fittedAt` timestamp.
 *   2. When the post-fit outcome count crosses `refitThreshold`, we run
 *      `fitAndSaveBlockCalibrator` — same code path the manual CLI uses.
 *   3. If a model came back (sample size sufficient), we call
 *      `server.setCalibrator(isotonicCalibrator(model))` to hot-swap
 *      the in-process reference. The NEXT recall scores through the
 *      improved curve. No restart required.
 *   4. Every refit (successful or not) emits a `calibrator_refit` event
 *      so the dashboard can show "calibrator improved N times this week"
 *      to non-technical viewers.
 *
 * Why the threshold, not a fixed interval:
 *
 * A time-based cron (refit hourly, daily) refits on noise when traffic
 * is low and lags when traffic is high. The outcome count IS the
 * sample-quality proxy — refit exactly when the training set has grown
 * enough that the curve might shift. Default threshold 20 matches
 * `fitCalibratorFromEvents`'s `minSample` floor; bump to 200+ once the
 * deployment has been running for weeks (handled implicitly because each
 * refit raises `fittedAt`, so the counter resets and the next refit
 * waits for another 20 outcomes worth of fresh evidence).
 */
import {
  fitAndSaveBlockCalibrator,
  isotonicCalibrator,
  BLOCK_CALIBRATOR_NAME,
} from "./calibrator.js";
import type { BlockServer } from "../core/block-serving.js";
import type { BlockStore } from "../core/block-store.js";
import type { IsotonicModel } from "./isotonic.js";

export interface MaybeRefitOptions {
  store: BlockStore;
  server: BlockServer;
  /**
   * How many fresh outcome events trigger a refit. Default 20 — matches
   * `fitCalibratorFromEvents`'s minSample floor so the first refit can
   * actually produce a model.
   */
  refitThreshold?: number;
  /**
   * Deterministic clock override for tests.
   */
  now?: () => number;
}

export type RefitOutcome =
  | { status: "skipped"; reason: "below-threshold"; freshOutcomes: number; threshold: number }
  | { status: "skipped"; reason: "insufficient-sample"; freshOutcomes: number }
  | { status: "refit"; freshOutcomes: number; fittedAt: number };

/**
 * Check whether enough new evidence has accumulated since the loaded
 * calibrator was fit; if so, refit and hot-swap. Never throws — the
 * outcome recording path must not break because the calibrator pipeline
 * had a bad day.
 */
export function maybeRefitCalibrator(opts: MaybeRefitOptions): RefitOutcome {
  const threshold = opts.refitThreshold ?? DEFAULT_REFIT_THRESHOLD;
  const now = (opts.now ?? Date.now)();

  let lastFittedAt = 0;
  try {
    const prior = opts.store.loadCalibrator<IsotonicModel>(BLOCK_CALIBRATOR_NAME);
    if (prior) lastFittedAt = prior.fittedAt ?? 0;
  } catch {
    // best-effort — treat as "no prior" and count all outcomes
  }

  const freshOutcomes = countFreshOutcomes(opts.store, lastFittedAt);
  if (freshOutcomes < threshold) {
    return { status: "skipped", reason: "below-threshold", freshOutcomes, threshold };
  }

  let model: IsotonicModel | null;
  try {
    model = fitAndSaveBlockCalibrator(opts.store, { now: () => now });
  } catch {
    // Same swallowing posture as `loadCalibrator` — outcome recording
    // never breaks because a fit threw on a single bad event.
    return { status: "skipped", reason: "insufficient-sample", freshOutcomes };
  }
  if (!model) {
    return { status: "skipped", reason: "insufficient-sample", freshOutcomes };
  }

  opts.server.setCalibrator(isotonicCalibrator(model));

  // Emit a marker event so the dashboard can count refits over time.
  // Best-effort — a sink failure must not undo the swap above.
  try {
    opts.store.appendEvent({
      ts: now,
      queryId: `calibrator-refit-${now}`,
      event: "calibrator_refit",
      freshOutcomes,
      fittedAt: model.fittedAt,
    });
  } catch {
    // ignore
  }

  return { status: "refit", freshOutcomes, fittedAt: model.fittedAt };
}

export const DEFAULT_REFIT_THRESHOLD = 20;

/**
 * Count outcome events whose `ts > sinceTs`. Uses a direct SQL scan over
 * the analytics_events table rather than `store.readEvents` because we only
 * need the count, not the full row payloads.
 */
function countFreshOutcomes(store: BlockStore, sinceTs: number): number {
  try {
    const row = store.rawDb
      .prepare(
        `SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'outcome' AND ts > ?`,
      )
      .get(sinceTs) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
