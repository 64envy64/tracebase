/**
 * R1 (May-2026) — shared `capture.error` emission used by the
 * Stop-hook (`src/cli/commands/capture-turn.ts:runCaptureTurn`) and
 * the SDK runtime (`src/runtime/capture-turn.ts:captureTurnFromTexts`).
 *
 * Why this lives in its own module
 * --------------------------------
 *   `src/runtime/capture-turn.ts` already imports `extractPattern` /
 *   `extractFacts` from `src/cli/commands/capture-turn.ts`. If the
 *   CLI command imported the helper back from `capture-turn.ts`, we'd
 *   close an ESM cycle through the same module. Splitting the helper
 *   out keeps the dependency graph one-directional and lets both
 *   surfaces share a single, audited emission path.
 *
 * Sink contract
 * -------------
 *   Both `store.appendEvent` AND `process.stderr.write` are
 *   wrapped in try/catch. The capture-path contract is "never throws
 *   into the caller" — a flaky telemetry sink (sandbox without
 *   stderr, store disk full mid-emit) must not promote a swallowed
 *   error into an unhandled exception.
 */

import { randomUUID } from "node:crypto";
import type { BlockStore } from "../core/block-store.js";
import type { CaptureErrorEvent } from "../types.js";

export interface EmitCaptureErrorArgs {
  phase: CaptureErrorEvent["phase"];
  reason: CaptureErrorEvent["reason"];
  err: unknown;
  /**
   * Short human prefix used on the stderr line for dev visibility.
   * Examples: "pattern skipped (validation)", "fact dropped".
   */
  stderrPrefix: string;
  /**
   * Correlation id — propagated to the analytics event so the
   * capture failure clusters with the matching retrieval/injection
   * events on the same run. Optional; emitted only when supplied.
   */
  runId?: string;
}

/**
 * Write a `capture.error` analytics event AND a one-line stderr
 * note. Idempotent on a per-call basis; safe to call from inside
 * any catch block on the capture hot path.
 */
export function emitCaptureError(store: BlockStore, args: EmitCaptureErrorArgs): void {
  const fullReason = args.err instanceof Error ? args.err.message : String(args.err);
  // Bound the message to keep payloads predictable —
  // `isValidCaptureError` enforces the same cap on JSONL re-import.
  const boundedMessage =
    fullReason.length > 200 ? `${fullReason.slice(0, 197)}...` : fullReason;

  try {
    store.appendEvent({
      ts: Date.now(),
      queryId: `capture-error-${randomUUID()}`,
      ...(args.runId ? { runId: args.runId } : {}),
      event: "capture.error",
      phase: args.phase,
      reason: args.reason,
      message: boundedMessage,
    });
  } catch {
    // Telemetry sink failure must not break the capture path.
  }

  try {
    process.stderr.write(`tracebase capture-turn: ${args.stderrPrefix}: ${fullReason}\n`);
  } catch {
    // Even stderr can fail in some sandboxes — swallow.
  }
}
