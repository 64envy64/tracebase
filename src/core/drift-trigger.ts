/**
 * Drift-signal → forced recall.
 *
 * The default recall path is similarity-driven: BlockServer ranks
 * blocks against the user prompt, the gate filters weak hits, the
 * agent sees what passes. That works when the prompt itself
 * communicates the problem. It fails when the agent is silently stuck
 * — repeating the same Read/Bash, pingponging between two files,
 * editing-then-reverting — because the *next* user prompt may look
 * unrelated to the stuck behaviour while the agent's session state
 * screams "we have been here before".
 *
 * This module catches that second case. We piggyback on the existing
 * `detectToolPattern` (straight / pingpong / duplicate) which the
 * recall path already runs for the redirect-label feature. When the
 * detector fires, we:
 *
 *   1. Widen the recall query by appending the last few `argSummary`
 *      blurbs (already privacy-sanitised at PostToolBatch time). This
 *      lets BM25 reach patterns whose triggers mention the tools or
 *      file paths the agent has been hammering — patterns that the
 *      *prompt text alone* would never have retrieved.
 *
 *   2. Relax the gate from production (DEFAULT_GATE_THRESHOLD = 0.4)
 *      down to DEFAULT_DRIFT_GATE_THRESHOLD = 0.2. The signal itself
 *      is a strong prior that prior debugging is relevant; we deliberately
 *      accept moderate-confidence patterns that the static gate would
 *      drop in the steady-state recall path.
 *
 *   3. Emit a `drift_injection` event when the relaxed recall actually
 *      surfaces patterns. The dashboard counts these as "auto-recoveries"
 *      — a directly visible "agent noticed it was stuck and pulled
 *      institutional knowledge automatically" signal.
 *
 * What this module does NOT do:
 *
 *   • It never modifies the redirect-label path. Labels stay the
 *     informational nudge they always were; this is a parallel,
 *     content-bearing channel that fires only when the loop signal
 *     happens to also unlock useful prior patterns.
 *
 *   • It never bypasses the FTS stop-word filter, the leakage scan,
 *     or the holdout policy. Drift is a confidence prior, not a
 *     safety bypass. A blocked query under the drift path stays
 *     blocked.
 *
 *   • It is silent when `detectToolPattern` returns `none`. Zero
 *     overhead on the steady-state recall path: a single sub-array
 *     scan of the recent-observations window we were already
 *     loading.
 */
import {
  DEFAULT_DRIFT_GATE_THRESHOLD,
  type BlockRecallQuery,
} from "./block-serving.js";
import type { ToolObservation } from "../types.js";
import type { ToolPatternSignal } from "./tool-loop-detect.js";

export interface DriftQueryAugmentation {
  /** Widened FTS query — original prompt + recent argSummaries. */
  text: string;
  /** Relaxed gate to thread through `BlockRecallQuery.gateOverride`. */
  gateOverride: number;
  /** The pattern signal that triggered the augmentation. */
  signal: ToolPatternSignal;
  /**
   * How many recent observations were folded into the query. Useful
   * for the `drift_injection` event so observers can reproduce the
   * widening exactly.
   */
  observationsUsed: number;
}

export interface BuildDriftAugmentationOptions {
  /**
   * Original prompt-text query — anchor of the widened search.
   * Empty string is acceptable: the augmentation will return a
   * tool-arg-only query, which is exactly the right behaviour when
   * the user kept typing terse follow-ups while the agent was stuck.
   */
  baseText: string;
  /**
   * Result of `detectToolPattern` on the recent observation window.
   * Pass-through `none` → returns null (no augmentation).
   */
  signal: ToolPatternSignal;
  /**
   * Observation window the detector saw. The augmentation reuses
   * exactly this list — never re-fetches and never widens beyond it
   * (so the privacy surface stays identical to the redirect path).
   */
  observations: ToolObservation[];
  /**
   * Optional gate override. Defaults to DEFAULT_DRIFT_GATE_THRESHOLD.
   * Tests can pin a value to assert that the override threads through.
   */
  driftGate?: number;
  /**
   * Maximum argSummary fragments to fold into the widened text.
   * Default 4 — enough to capture the tool-arg pattern without
   * letting a long session bloat the FTS query.
   */
  maxArgFragments?: number;
}

/**
 * Build a drift-augmented recall query from a tool-pattern signal and
 * its observation window. Returns null when the signal kind is `none`
 * (the recall path should fall back to the original prompt-only query).
 *
 * Determinism: identical (baseText, signal, observations) always
 * produces the identical augmentation. Tests can pin the output.
 */
export function buildDriftAugmentation(
  opts: BuildDriftAugmentationOptions,
): DriftQueryAugmentation | null {
  if (opts.signal.kind === "none") return null;

  const maxFragments = opts.maxArgFragments ?? 4;
  const fragments: string[] = [];
  // Walk newest-first so the most recently-stuck call dominates the
  // widened query. The observations list is oldest-first per
  // `BlockStore.recentToolObservations`, so we iterate in reverse.
  for (let i = opts.observations.length - 1; i >= 0; i--) {
    const arg = opts.observations[i]?.argSummary;
    if (typeof arg === "string" && arg.length > 0) {
      fragments.push(arg);
      if (fragments.length >= maxFragments) break;
    }
  }

  const trimmedBase = opts.baseText.trim();
  const text = [trimmedBase, ...fragments].filter((s) => s.length > 0).join(" ");
  return {
    text,
    gateOverride: opts.driftGate ?? DEFAULT_DRIFT_GATE_THRESHOLD,
    signal: opts.signal,
    observationsUsed: fragments.length,
  };
}

/**
 * Convenience: thread a drift augmentation into a base BlockRecallQuery
 * without mutating the original. Returns a new query object with the
 * widened text and relaxed gate; all other fields (invariants, scope,
 * holdout experiment, runId, queryId) are preserved exactly.
 */
export function applyDriftAugmentation(
  base: BlockRecallQuery,
  aug: DriftQueryAugmentation,
): BlockRecallQuery {
  return {
    ...base,
    text: aug.text,
    gateOverride: aug.gateOverride,
  };
}
