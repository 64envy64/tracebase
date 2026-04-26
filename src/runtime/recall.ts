/**
 * `recallForPrompt` — pure recall core shared by the Claude Code
 * `UserPromptSubmit` hook (`src/cli/commands/inject-context.ts`)
 * and the SDK `runtime.beforeRun()` method
 * (`src/sdk/runtime.ts`, lands in §8.6).
 *
 * Why this lives in `src/runtime/` rather than co-located with
 * inject-context: PLAN-0.5.4 §4 establishes that the CLI commands
 * and the SDK runtime must call the SAME canonical implementation
 * of each capability. Otherwise the SDK would silently drift from
 * the Claude Code behaviour the 0.5.3 test suite pins down.
 *
 * What stays in inject-context.ts: host-specific envelope wrapping,
 * the compact / silent status-mode resolver, the systemMessage
 * composer (`formatStatus` + `formatToolFragment`), and the
 * stdin-reading boilerplate. None of that is portable to a
 * framework-neutral runtime.
 *
 * Privacy invariants (PLAN-0.5.4 §2.2):
 *   - Never reads tool_response anywhere.
 *   - The detector reads only `argKey` + `toolName` off observations,
 *     never argSummary / argument bodies.
 *   - `recordHookRecallEvents` writes retrieval / injection /
 *     fact_injection events to `analytics_events`. The events log
 *     ids and scores only — no prompt / response content.
 */

import type { BlockStore } from "../core/block-store.js";
import type { BlockServer, RecallV2Result } from "../core/block-serving.js";
import type { ToolPatternSignal } from "../core/tool-loop-detect.js";
import type { InjectionPayload } from "../core/build-injection-payload.js";
import type { readHoldoutConfig } from "../core/config.js";

import { detectToolPattern } from "../core/tool-loop-detect.js";
import { buildInjectionPayload } from "../core/build-injection-payload.js";
import { drainIndexerPending, recallFiles } from "../core/file-indexer.js";
import { runReasoningPatternsRecall } from "../server/reasoning-patterns-entry.js";
import { sessionScope } from "./digest.js";

/**
 * Match the signature `withBlockServer` already passes — a function
 * that returns the holdout config (or null) for a given basePath.
 * Kept on the input rather than imported here so tests can stub it.
 */
export type HoldoutLoader = () => ReturnType<typeof readHoldoutConfig>;

export interface RecallForPromptOptions {
  /** User prompt — already extracted, leakage-bounded by the caller. */
  prompt: string;
  /** Project root the call is rooted at. */
  basePath: string;
  /**
   * Stable Claude Code session id, when present. Used to (a) narrow
   * fact recall to `project.session.<sha-12>` and (b) read the
   * session's recent `tool_observations` for loop detection.
   */
  sessionId?: string | null;
  /**
   * Soft token budget for `additionalContext`. Default 1200, capped
   * by `buildInjectionPayload` at 2200.
   */
  tokenBudget?: number;
  /**
   * Number of recent observations the loop detector considers.
   * Default 6 — matches the `inject-context` call site.
   */
  toolWindowSize?: number;
  /**
   * If false, skip the loop detector entirely. Defaults true.
   * Matches `CreateRuntimeOptions.enableTool` / `enableLoop` —
   * disabling either disables both at this layer because the
   * detector emits both kinds of signal from a single window walk.
   */
  enableToolDetection?: boolean;
  /**
   * 0.7.0-rc.3 §rc.3 — top-K override for file memory recall.
   * Default `FILE_HITS_DEFAULT_K`. Values above the file-indexer
   * hard ceiling (10) are silently capped there.
   */
  fileHitsK?: number;
}

export interface RecallForPromptResult {
  /** Raw recall result — useful when the caller wants per-block scores. */
  raw: RecallV2Result;
  /** Bounded injection payload (text + ids + token estimate). */
  payload: InjectionPayload;
  /** Tool-loop / repeat detector signal. `none` when no session id. */
  signal: ToolPatternSignal;
  /** Convenience: `payload.queryId`. */
  queryId: string;
  /** Convenience: `payload.hasContent`. */
  hasContent: boolean;
}

/**
 * Run the recall + tool-pattern detection that backs both the
 * Claude Code `UserPromptSubmit` hook and the SDK
 * `runtime.beforeRun()`.
 *
 * Caller owns:
 *   - opening the BlockServer / BlockStore (this function does not
 *     manage DB lifecycle so the SDK runtime can keep a persistent
 *     connection across calls);
 *   - skipping the call entirely on trivial prompts (see
 *     `shouldQueryForPrompt`);
 *   - host-specific badge / envelope formatting.
 *
 * Always populates the result. On any internal failure callers
 * receive the recall payload populated as-if-no-match and a `none`
 * tool signal. Surface errors via stderr / `onBadge` at the call
 * site if you need them.
 */
export function recallForPrompt(
  server: BlockServer,
  store: BlockStore,
  holdoutLoader: HoldoutLoader,
  opts: RecallForPromptOptions,
): RecallForPromptResult {
  const recallScope = opts.sessionId ? sessionScope(opts.sessionId) : "project";
  const raw = runReasoningPatternsRecall(
    server,
    { problem: opts.prompt, scope: recallScope },
    { readHoldoutConfig: holdoutLoader },
  );

  // 0.7.0-rc.3 §rc.3 — file memory recall runs alongside the
  // pattern recall. K=3 default (FILE_HITS_DEFAULT_K). The file
  // hits feed into buildInjectionPayload as a separate section
  // wrapped in `<file_memory>…</file_memory>`. Best-effort: any
  // failure (FTS not yet built, malformed prompt, etc.) yields
  // an empty list and the legacy block + fact path still ships.
  let fileHits: ReturnType<typeof recallFiles> = [];
  try {
    fileHits = recallFiles(store, {
      prompt: opts.prompt,
      k: opts.fileHitsK ?? FILE_HITS_DEFAULT_K,
    });
  } catch {
    fileHits = [];
  }

  const payload = buildInjectionPayload(raw, {
    tokenBudget: opts.tokenBudget ?? 1200,
    fileHits,
  });

  let signal: ToolPatternSignal = { kind: "none", count: 0 };
  if (opts.sessionId && opts.enableToolDetection !== false) {
    try {
      const recent = store.recentToolObservations(
        opts.sessionId,
        opts.toolWindowSize ?? 6,
      );
      signal = detectToolPattern(recent);
    } catch {
      // detector is non-load-bearing on the prompt path — swallow
    }
  }

  recordRecallEvents(store, raw, payload);

  // 0.7.0-rc.3 §rc.3 — file_memory.recalled emit. Fires once when
  // the rendered payload includes at least one file_memory bullet.
  // Aggregate-only fields (fileIds + tokensInjected + bytesAvoided)
  // — the cloud allowlist drops fileIds at the wire, so paths
  // never leave the local DB.
  if (payload.fileIds.length > 0) {
    try {
      store.appendEvent({
        ts: Date.now(),
        queryId: payload.queryId,
        event: "file_memory.recalled",
        fileIds: [...payload.fileIds],
        tokensInjected: payload.tokensEstimate,
        bytesAvoided: payload.bytesAvoided,
      });
    } catch {
      // never break the recall path on a telemetry failure
    }
  }

  // 0.7.0-rc.2 §rc.2 — opportunistic indexer drain.
  //
  // 0.7.0-rc.2 hardening: tight budget. The §rc.2 default drain
  // slice is 50 files / 200 ms — that conflicts with the planned
  // UserPromptSubmit p95 ≤ 150 ms target (§0.7 stable bench).
  // Cap the recall-path slice at 10 files / 30 ms so the prompt
  // path can never be blocked by indexer work, even when many
  // pending rows exist. The bigger 50/200 slice belongs on
  // Stop / PostToolBatch / startup hooks, which rc.4+ wires up.
  //
  // Best-effort: any failure is swallowed so the recall path
  // never breaks because the indexer is being asked to do work.
  try {
    drainIndexerPending(store, {
      root: opts.basePath,
      maxFiles: RECALL_PATH_DRAIN_MAX_FILES,
      timeMs: RECALL_PATH_DRAIN_TIME_MS,
    });
  } catch {
    // swallow — drain is non-load-bearing on the recall path.
  }

  return {
    raw,
    payload,
    signal,
    queryId: payload.queryId,
    hasContent: payload.hasContent,
  };
}

/**
 * 0.7.0-rc.2 hardening — recall-path drain budget caps.
 *
 * UserPromptSubmit p95 target is 150 ms (§0.7 stable bench). The
 * full §rc.2 drain slice (50 files / 200 ms) would single-handedly
 * bust that. Cap to 10 / 30 here; rc.4 will wire a 50/200 slice
 * onto Stop / PostToolBatch / startup paths where the latency
 * budget is far more forgiving.
 */
export const RECALL_PATH_DRAIN_MAX_FILES = 10;
export const RECALL_PATH_DRAIN_TIME_MS = 30;

/**
 * 0.7.0-rc.3 §rc.3 — default top-K for the file memory recall the
 * pattern path runs alongside the block + fact recall. Three is
 * the spec default; above 6 the prompt focus suffers more than
 * the recall hit gain (the indexer's heuristic summaries don't
 * have ground-truth ranking, just FTS bm25).
 */
export const FILE_HITS_DEFAULT_K = 3;

/**
 * Trivial-prompt gate. Returns false for prompts shorter than the
 * minimum, so callers can skip the recall query for "hi" / "thanks"
 * / similar chatter without drowning the analytics events in
 * useless retrievals.
 *
 * Callers that want detection-only on trivial prompts (the SDK
 * runtime might, since loop warnings are independent of prompt
 * length) can read recent observations via
 * `BlockStore.recentToolObservations` directly and call
 * `detectToolPattern` themselves.
 */
export function shouldQueryForPrompt(
  prompt: string,
  eventName: string = "UserPromptSubmit",
): boolean {
  // SessionStart fires once per session and may have no prompt.
  // We still want to warm context (e.g. on `/compact`) when the
  // host gives us a long-enough prompt.
  if (eventName === "SessionStart") {
    return prompt.length >= MIN_PROMPT_CHARS;
  }
  return prompt.length >= MIN_PROMPT_CHARS;
}

/** Lower bound matching the original inject-context behaviour. */
export const MIN_PROMPT_CHARS = 40;

/**
 * Write the standard retrieval / injection / fact_injection events
 * for a recall call. Mirrors the previous `recordHookRecallEvents`
 * helper but takes the payload it logs against so the SDK runtime
 * can call it without going through `inject-context`'s
 * host-envelope path.
 *
 * Only injection events for ids that survived the budget are
 * emitted — not every above-gate hit. `record_reasoning_outcome`
 * with `usedPattern: true` would otherwise credit patterns the
 * agent never saw.
 */
function recordRecallEvents(
  store: BlockStore,
  result: RecallV2Result,
  payload: InjectionPayload,
): void {
  let ts = Date.now();
  const nextTs = () => ts++;

  store.appendEvent({
    ts: nextTs(),
    queryId: result.queryId,
    event: "retrieval",
    candidates: result.blocks.map((h) => ({ blockId: h.block.id, score: h.score })),
    shadow: result.shadow,
    ...(result.controlReason ? { controlReason: result.controlReason } : {}),
    ...(result.facts.length > 0
      ? { factCandidates: result.facts.map((h) => ({ factId: h.fact.id, score: h.score })) }
      : {}),
    // 0.5.7 §C — record the injection-side token cost so the
    // analytics window can compute netTokenImpact = tokensLift -
    // sum(injectedTokensEstimate). Only meaningful when the
    // payload actually carried content; 0 captures "gate cleared
    // nothing".
    injectedTokensEstimate: payload.hasContent ? payload.tokensEstimate : 0,
  });

  const visibleBlocks = new Set(payload.blockIds);
  for (const hit of result.blocks) {
    if (!visibleBlocks.has(hit.block.id)) continue;
    store.appendEvent({
      ts: nextTs(),
      queryId: result.queryId,
      event: "injection",
      blockId: hit.block.id,
      score: hit.score,
      calibratedProb: hit.calibratedProb,
    });
  }

  const visibleFacts = new Set(payload.factIds);
  for (const hit of result.facts) {
    if (!visibleFacts.has(hit.fact.id)) continue;
    store.appendEvent({
      ts: nextTs(),
      queryId: result.queryId,
      event: "fact_injection",
      factId: hit.fact.id,
      score: hit.score,
      calibratedProb: hit.calibratedProb,
    });
  }
}
