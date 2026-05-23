/**
 * `captureTurnFromTexts` — pure capture core shared by the
 * Claude Code `Stop` hook (`src/cli/commands/capture-turn.ts`)
 * and the SDK `runtime.afterRun()` method
 * (`src/sdk/runtime.ts`) per PLAN-0.5.4 §4 / 0.5.5 §3b.
 *
 * The CLI hook reads a Claude Code transcript file then walks the
 * JSONL to extract the most-recent user/assistant pair. The SDK
 * runtime receives `{ userText, assistantText }` directly. Both
 * surfaces converge on this helper for the storage half — same
 * pattern + fact extraction, same error handling, same store-side
 * try/catch boundaries.
 *
 * The pure pattern + fact extractors (`extractPattern`,
 * `extractFacts`) still live in `src/cli/commands/capture-turn.ts`
 * — they're already exported from there and have stable test
 * coverage. Moving them risked touching the 0.5.3 hook's hot path
 * for no architectural gain. Both this module and the CLI command
 * import from the same canonical home.
 *
 * Privacy invariants (PLAN-0.5.4 §2.2):
 *   - The stored block goes through the existing
 *     `storeReasoningPattern` validation: leakage scanner +
 *     bounded fields + dedupe against fingerprint.
 *   - Each fact goes through `BlockStore.storeFact` which runs
 *     its own bounds + invariants checks.
 *   - Per-fact failures are logged to stderr but never bubble
 *     up — one bad row never kills the batch.
 */

import type { BlockStore } from "../core/block-store.js";
import {
  extractPattern,
  extractFacts,
} from "../cli/commands/capture-turn.js";
import {
  StorePatternValidationError,
  storeReasoningPattern,
} from "../server/mcp-v2-helpers.js";
import { emitCaptureError } from "./capture-errors.js";

export interface CaptureTurnInput {
  userText: string;
  assistantText: string;
}

/**
 * R1 — optional plumbing of a correlation id so capture-error events
 * land with the same `runId` as the matching retrieval/injection
 * events. Caller picks the source (session id, run id from inject-
 * context, etc.); both fields are optional and default to "no
 * correlation".
 */
export interface CaptureTurnOpts {
  runId?: string;
}

export interface CaptureTurnOutcome {
  /** Stored block id when a pattern was extracted + written. */
  blockId: string | null;
  /** True iff the block is brand-new (vs. reinforcing an existing). */
  isNew: boolean;
  /** Number of facts persisted. */
  factCount: number;
  /**
   * R1 — number of `capture.error` events emitted on this call.
   * Zero on a clean capture; counts pattern + fact failures. Callers
   * can use this to decide whether to surface a soft warning to the
   * user without re-walking the event log.
   */
  errorCount: number;
}

/**
 * Run pattern + fact extraction against a user/assistant text pair
 * and persist the results in a single store transaction-style
 * sweep. Caller owns the BlockStore handle so the SDK runtime can
 * reuse its persistent connection across many `afterRun` calls.
 *
 * Never throws. Validation failures inside `storeReasoningPattern`
 * are logged to stderr; per-fact failures are logged + skipped.
 * The outcome surfaces what made it through.
 */
export function captureTurnFromTexts(
  store: BlockStore,
  input: CaptureTurnInput,
  opts: CaptureTurnOpts = {},
): CaptureTurnOutcome {
  let errorCount = 0;
  const factsCandidate = (() => {
    try {
      return extractFacts(input.userText, input.assistantText);
    } catch (err) {
      emitCaptureError(store, {
        phase: "fact_extraction",
        reason: "unknown",
        err,
        stderrPrefix: "fact extraction skipped",
        runId: opts.runId,
      });
      errorCount += 1;
      return [];
    }
  })();

  const patternCandidate = extractPattern(input.userText, input.assistantText);

  let blockId: string | null = null;
  let isNew = false;
  if (patternCandidate) {
    try {
      const result = storeReasoningPattern(store, patternCandidate);
      blockId = result.blockId;
      isNew = result.isNew;
    } catch (err) {
      const isValidation = err instanceof StorePatternValidationError;
      emitCaptureError(store, {
        phase: "pattern_store",
        reason: isValidation ? "validation" : "unknown",
        err,
        stderrPrefix: isValidation ? "pattern skipped (validation)" : "pattern error",
        runId: opts.runId,
      });
      errorCount += 1;
      // Non-validation errors are still swallowed — the SDK runtime
      // contract requires `afterRun` to never throw into caller code,
      // and the CLI hook has the same contract. The block just doesn't
      // land; the next afterRun will try again.
    }
  }

  let factCount = 0;
  for (const candidate of factsCandidate) {
    try {
      store.storeFact(candidate);
      factCount += 1;
    } catch (err) {
      emitCaptureError(store, {
        phase: "fact_store",
        reason: "unknown",
        err,
        stderrPrefix: "fact dropped",
        runId: opts.runId,
      });
      errorCount += 1;
    }
  }

  return { blockId, isNew, factCount, errorCount };
}

