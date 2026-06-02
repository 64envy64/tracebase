/**
 * Isotonic regression (Pool-Adjacent-Violators Algorithm).
 *
 * Pure, deterministic, zero-dependency. Used by Phase 5.2 to turn
 * raw ranker scores into calibrated P(helpful) values.
 *
 * PAVA (Barlow, Bartholomew, Bremner, Brunk, 1972):
 *   • Sort points by x.
 *   • Treat each point as a block of weight 1 with value y.
 *   • Walk left→right. When block[i].value > block[i+1].value, merge
 *     them (weighted average). The merge may make the new block
 *     smaller than block[i-1]; step back to re-check. Repeat until
 *     no violations remain.
 *   • Result: a sequence of blocks whose values are non-decreasing.
 *
 * For calibration we want a callable f(x) → y. We represent the
 * fitted model as `breakpoints` — one (x, y) pair per PAVA block
 * (x = weighted centroid, y = block value). Prediction is linear
 * interpolation between the two surrounding breakpoints, clamped at
 * the ends. This gives a monotone non-decreasing piecewise-linear
 * function.
 *
 * This module is intentionally separate from calibrator.ts so the
 * math stays unit-testable without touching the BlockStore or events.
 */

export interface IsotonicModel {
  /**
   * PAVA block representatives, sorted by `x` ascending. `y` values
   * are guaranteed non-decreasing. Empty when fitted on zero points.
   */
  breakpoints: Array<{ x: number; y: number }>;
  /** Training point count. */
  n: number;
  /** Epoch ms when the model was fitted. */
  fittedAt: number;
  /**
   * Serving feature-schema version the training inputs were drawn from.
   * `loadBlockCalibrator` refuses to serve a model whose version does not
   * match the current schema, so a calibrator trained on a stale input
   * domain (e.g. the legacy normalized rank score) is never used. Optional
   * for back-compat with models persisted before versioning.
   */
  featureVersion?: number;
}

/**
 * Fit an isotonic regression model to the given (x, y) points.
 *
 * Convention:
 *   • x can be any real (typically a ranker score in [0, 1]).
 *   • y can be any real (typically a Bernoulli-like 0/1 outcome).
 * The returned model is a monotone non-decreasing step-centroid
 * piecewise-linear function.
 *
 * Edge cases:
 *   • points.length === 0 → empty model; predictIsotonic returns the
 *     input x unchanged (identity fallback).
 *   • ties in x are merged within PAVA's weighted-average step.
 */
export function fitIsotonic(
  points: Array<{ x: number; y: number }>,
  now: number = Date.now(),
): IsotonicModel {
  if (points.length === 0) return { breakpoints: [], n: 0, fittedAt: now };

  // Deterministic sort by x; ties are resolved by insertion order
  // (Array.prototype.sort is stable on modern JS engines).
  const sorted = [...points].sort((a, b) => a.x - b.x);

  // Each block tracks sumX, sumY, and weight. Representative x and y
  // are computed at the end as sumX/w, sumY/w.
  type Block = { sumX: number; sumY: number; w: number };
  const blocks: Block[] = sorted.map((p) => ({ sumX: p.x, sumY: p.y, w: 1 }));

  // Pool-Adjacent-Violators.
  let i = 0;
  while (i < blocks.length - 1) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!;
    const aY = a.sumY / a.w;
    const bY = b.sumY / b.w;
    if (aY > bY) {
      const merged: Block = {
        sumX: a.sumX + b.sumX,
        sumY: a.sumY + b.sumY,
        w: a.w + b.w,
      };
      blocks.splice(i, 2, merged);
      // Stepping back lets the new (possibly-lower) block re-check
      // against its new left neighbor.
      if (i > 0) i--;
    } else {
      i++;
    }
  }

  const breakpoints = blocks.map((b) => ({
    x: b.sumX / b.w,
    y: b.sumY / b.w,
  }));

  return { breakpoints, n: sorted.length, fittedAt: now };
}

/**
 * Predict `y` at a new `x`. Strategy:
 *   • If the model has no breakpoints, return x (identity).
 *   • Below the first breakpoint: return the first y (left clamp).
 *   • Above the last breakpoint: return the last y (right clamp).
 *   • Otherwise: linear interpolation between the two surrounding
 *     breakpoints.
 *
 * Monotonicity is preserved because breakpoint ys are non-decreasing
 * by construction and linear interpolation preserves order.
 */
export function predictIsotonic(model: IsotonicModel, x: number): number {
  const bp = model.breakpoints;
  if (bp.length === 0) return x;

  const first = bp[0]!;
  const last = bp[bp.length - 1]!;

  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;

  for (let i = 0; i < bp.length - 1; i++) {
    const a = bp[i]!;
    const b = bp[i + 1]!;
    if (x >= a.x && x <= b.x) {
      if (b.x === a.x) return a.y;
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return last.y;
}

/**
 * Sanity check: returns true iff the model's breakpoints are sorted
 * by x and have monotone non-decreasing y. Exported because some
 * callers round-trip models through storage and want to assert
 * invariants on load.
 */
export function isMonotone(model: IsotonicModel): boolean {
  for (let i = 0; i < model.breakpoints.length - 1; i++) {
    const a = model.breakpoints[i]!;
    const b = model.breakpoints[i + 1]!;
    if (a.x > b.x) return false;
    if (a.y > b.y) return false;
  }
  return true;
}
