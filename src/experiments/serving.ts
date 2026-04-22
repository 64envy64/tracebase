/**
 * Integration glue between persisted holdout config and the serving
 * surface. The caller of `BlockServer.recall` reads the config
 * explicitly, computes the fingerprint for the current query, and
 * passes the resulting `ExperimentInput` through. `BlockServer`
 * never reaches into config globals itself — Phase 3.4 keeps
 * serving pure.
 */
import type { ExperimentInput } from "../core/block-serving.js";
import type { HoldoutConfig } from "../types.js";

/**
 * Translate a stored `HoldoutConfig` into an `ExperimentInput` for
 * one recall call. Returns `undefined` — i.e. default-off serving —
 * when ANY of the preconditions for deterministic assignment fails:
 *
 *   - config missing (experiment never configured on this project);
 *   - `enabled === false` (the CLI `disable` state);
 *   - `rate <= 0` / non-finite (would collapse the cohort anyway);
 *   - fingerprint missing or empty (assignment cannot be
 *     deterministic without it, and serving treats an input
 *     without fingerprint as a silent no-op regardless).
 *
 * Callers therefore never need to null-guard the result they pass
 * to `recall`; they can splat `buildHoldoutInput(config, fp)`
 * directly into the `experiment` slot.
 */
export function buildHoldoutInput(
  config: HoldoutConfig | null | undefined,
  fingerprint: string | undefined,
): ExperimentInput | undefined {
  if (!config) return undefined;
  if (!config.enabled) return undefined;
  if (!Number.isFinite(config.rate) || config.rate <= 0) return undefined;
  if (!fingerprint) return undefined;
  return {
    rate: config.rate,
    salt: config.salt,
    fingerprint,
  };
}
