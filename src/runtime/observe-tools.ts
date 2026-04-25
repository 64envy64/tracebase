/**
 * `observeToolBatch` — pure tool-observation core shared by the
 * Claude Code `PostToolBatch` hook
 * (`src/cli/commands/capture-tool-use.ts`) and the SDK
 * `runtime.observeToolBatch()` method
 * (`src/sdk/runtime.ts`, lands in §8.6).
 *
 * Same extraction rationale as `src/runtime/recall.ts`: the
 * canonical implementation lives here so the SDK runtime cannot
 * silently drift from the Claude Code behaviour the 0.5.3 test
 * suite pins down.
 *
 * Privacy invariants (PLAN-0.5.4 §2.2):
 *   - NEVER reads tool_response. The function signature does not
 *     accept a `toolResponse` field; the per-tool projection in
 *     `src/core/tool-arg.ts` only reads named fields off
 *     `toolInput`.
 *   - Sanitised `argSummary` and HMAC `argKey` are persisted
 *     locally; the cloud allowlist (§6) blocks both from ever
 *     reaching the wire.
 *   - Bash collapses to the binary name; outside-cwd paths and
 *     secret-shaped patterns degrade to `<tool>(arg-hidden)`.
 */

import type { BlockStore } from "../core/block-store.js";
import type { RecordToolObservationInput, ToolObservationOutcome } from "../types.js";
import { sanitizeToolArgs } from "../core/tool-arg.js";

/**
 * Hard ceiling on per-batch observations. Real Claude Code batches
 * are <10 calls; anything above 64 is almost certainly a malformed
 * payload or a denial-of-service probe. The tail is dropped
 * silently — the caller still gets a `recorded` count so they can
 * detect truncation if it matters.
 */
export const MAX_CALLS_PER_BATCH = 64;

export interface ObserveToolBatchCall {
  toolName: string;
  /** Raw tool_input dict. Sanitiser only reads named fields per tool. */
  toolInput: unknown;
  toolUseId?: string | null;
  outcome?: ToolObservationOutcome;
}

export interface ObserveToolBatchOptions {
  /** Stable session id. Required — observations cluster by session. */
  sessionId: string;
  /**
   * Project root the call ran against. Used by the per-tool
   * sanitiser to project absolute paths to repo-relative form.
   * Outside-cwd paths collapse to `arg-hidden`.
   */
  cwd: string;
  /**
   * Local HMAC key from `getOrMintWorkspaceSalt`. Same workspace +
   * same projection → same `argKey` bucket; cross-workspace buckets
   * diverge because salts differ.
   */
  workspaceSalt: string;
  /** Tool calls to record. Empty array is a no-op. */
  toolCalls: ObserveToolBatchCall[];
  /** Optional batch correlation id. Defaults to null. */
  batchId?: string | null;
}

export interface ObserveToolBatchOutcome {
  /** Number of `tool_observations` rows persisted. */
  recorded: number;
  /** Inserted row ids in input order — useful for tests + audit. */
  ids: string[];
  /**
   * True iff the input list exceeded `MAX_CALLS_PER_BATCH` and the
   * tail was dropped. Callers can surface this on a debug channel.
   */
  truncated: boolean;
}

/**
 * Sanitise + persist a batch of tool observations in a single
 * SQLite transaction. Caller owns the BlockStore lifecycle (so the
 * SDK runtime can keep a persistent connection across calls;
 * `capture-tool-use` opens-and-closes per invocation).
 *
 * Empty input is a no-op that returns
 * `{ recorded: 0, ids: [], truncated: false }`.
 */
export function observeToolBatch(
  store: BlockStore,
  opts: ObserveToolBatchOptions,
): ObserveToolBatchOutcome {
  if (opts.toolCalls.length === 0) {
    return { recorded: 0, ids: [], truncated: false };
  }

  const truncated = opts.toolCalls.length > MAX_CALLS_PER_BATCH;
  const inputs: RecordToolObservationInput[] = [];
  const cap = Math.min(opts.toolCalls.length, MAX_CALLS_PER_BATCH);
  for (let i = 0; i < cap; i++) {
    const call = opts.toolCalls[i]!;
    const { argSummary, argKey } = sanitizeToolArgs({
      toolName: call.toolName,
      toolInput: call.toolInput,
      cwd: opts.cwd,
      workspaceSalt: opts.workspaceSalt,
    });
    inputs.push({
      sessionId: opts.sessionId,
      batchId: opts.batchId ?? null,
      batchOrder: i,
      toolUseId: call.toolUseId ?? null,
      toolName: call.toolName,
      argSummary,
      argKey,
      outcome: call.outcome ?? "unknown",
    });
  }

  const ids = store.recordToolObservations(inputs);
  return { recorded: ids.length, ids, truncated };
}
