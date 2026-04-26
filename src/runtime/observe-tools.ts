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
import { toRepoRelative } from "../core/guard.js";
import { enqueuePending } from "../core/file-indexer.js";
import { RecentToolCache, type CachedObservation } from "./recent-tool-cache.js";

/**
 * 0.7.0-rc.2 §rc.2 — closed set of tool names that imply the file
 * at `toolInput.file_path` was just modified. PostToolBatch enqueues
 * each touched repo-relative path into `indexer_pending(kind='file')`
 * so the next recall pass can drain a slice and refresh
 * `indexed_files`. We never enqueue for read tools — those don't
 * change content and re-summarizing wastes budget.
 */
const WRITE_LIKE_TOOLS = new Set<string>([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Create",
  "Patch",
]);

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
  /**
   * 0.7.0-rc.4 hardening — workspace path used to warm the
   * `.tracebase/cache/rtools.bin` on-disk PreToolUse cache.
   *
   * Pre-hardening, observations landed in SQLite via
   * `recordToolObservations` but the warm cache was never written.
   * That left the rc.4 PreToolUse hook permanently cache-missing
   * on real Claude Code sessions: only manual seeding or test
   * fixtures put rows in the cache.
   *
   * When set, after recordToolObservations succeeds, the
   * sanitised observations are batch-appended to the cache file.
   * Best-effort — any failure is swallowed; PostToolBatch must
   * never break because cache warming is being attempted.
   *
   * When omitted, behaviour matches pre-hardening (no cache
   * warming). Tests that don't care about PreToolUse can keep
   * passing observeToolBatch the legacy options.
   */
  workspacePath?: string;
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

  // 0.7.0-rc.4 hardening — warm the PreToolUse cache. Without this
  // step the rc.4 PreToolUse hook would permanently cache-miss on
  // real Claude Code sessions; only test fixtures + manual seeds
  // populated the cache. PostToolBatch is the canonical
  // observation path, so wiring the warm here covers both the
  // CLI hook and the SDK runtime call sites uniformly.
  //
  // Best-effort: any failure (read-only fs, full disk, etc.) is
  // swallowed. Cache warming must NEVER break the agent's tool
  // path; PostToolBatch already succeeded persisting to SQLite.
  if (opts.workspacePath) {
    try {
      const cache = new RecentToolCache();
      const tNow = Date.now();
      const records: CachedObservation[] = [];
      for (let i = 0; i < cap; i++) {
        const input = inputs[i]!;
        records.push({
          sessionId: input.sessionId,
          argKey: input.argKey,
          toolName: input.toolName,
          ts: tNow,
        });
      }
      cache.appendBatchToDisk(opts.workspacePath, records);
    } catch {
      // never break PostToolBatch on cache warming failure
    }
  }

  // 0.7.0-rc.2 §rc.2 — opportunistic indexer enqueue. After the
  // observations land, scan the same batch for write-like tools and
  // queue the touched files for re-summarization. Best-effort: any
  // failure here is swallowed — the agent's tool path must never
  // break because the indexer is being cute.
  try {
    const enqueueAt = Date.now();
    for (let i = 0; i < cap; i++) {
      const call = opts.toolCalls[i]!;
      if (!WRITE_LIKE_TOOLS.has(call.toolName)) continue;
      const filePath = extractTouchedPath(call.toolInput);
      if (filePath === null) continue;
      const rel = toRepoRelative(filePath, opts.cwd);
      if (rel === null) continue;
      enqueuePending(store, rel, "file", enqueueAt);
    }
  } catch {
    // never break PostToolBatch on indexer enqueue failure.
  }

  return { recorded: ids.length, ids, truncated };
}

/**
 * Pull the touched-file path from a write-like tool's `toolInput`.
 * Reads ONLY the documented field names — never sniffs arbitrary
 * keys — so a future tool that hides paths in odd places is dropped
 * cleanly rather than silently leaking.
 */
function extractTouchedPath(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const obj = toolInput as Record<string, unknown>;
  // Claude Code uses `file_path`; LangChain / SDK conventions
  // sometimes use `path` or `filename`. We accept the common set.
  for (const key of ["file_path", "path", "filename", "filePath"] as const) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}
