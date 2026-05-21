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
import type { readCascadeConfig, readHoldoutConfig } from "../core/config.js";

import { detectToolPattern } from "../core/tool-loop-detect.js";
import { buildInjectionPayload } from "../core/build-injection-payload.js";
import { buildDriftAugmentation } from "../core/drift-trigger.js";
import { drainIndexerPending, recallFiles } from "../core/file-indexer.js";
import { normalizeIntentKey } from "../core/intent-key.js";
import { resolveLoopRedirect, type LoopRedirectResult } from "../core/loop-redirect.js";
import { runReasoningPatternsRecall } from "../server/reasoning-patterns-entry.js";
import { sessionScope } from "./digest.js";
import {
  filterChunkHitsForRoi,
  filterFileHitsForRoi,
  resolveServingPlan,
  type ServingPlan,
  type ServingProfile,
} from "./serving-policy.js";
import {
  isServingArbiterEnabled,
  runServingArbiter,
} from "./serving-arbiter-runtime.js";
import { randomUUID } from "node:crypto";

/**
 * Match the signature `withBlockServer` already passes — a function
 * that returns the holdout config (or null) for a given basePath.
 * Kept on the input rather than imported here so tests can stub it.
 */
export type HoldoutLoader = () => ReturnType<typeof readHoldoutConfig>;

/**
 * May-2026 B1.2 — sibling to HoldoutLoader. Returns the persisted
 * cascade config (or null when not configured / malformed). The hook
 * path and SDK runtime hot-load this on every prompt so
 * `tracebase cascade set-rate` takes effect without a restart.
 */
export type CascadeLoader = () => ReturnType<typeof readCascadeConfig>;

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
   * Soft token budget for `additionalContext`. The runtime serving
   * policy may clamp this lower in cost-saver mode.
   */
  tokenBudget?: number;
  /**
   * Runtime serving profile. Defaults to `TRACEBASE_SERVING_PROFILE`
   * and then to `cost-saver`: compact, high-ROI context by default.
   * `recall-heavy` preserves the older broad recall shape.
   */
  servingProfile?: ServingProfile | string | null;
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
  /**
   * 0.7.0-rc.6 §rc.6 — top-K override for session-chunk recall.
   * Default `CHUNK_HITS_DEFAULT_K`. Recalled chunks are scoped to
   * the SAME session only; cross-session recall is structurally
   * impossible.
   */
  chunkHitsK?: number;
}

export interface RecallForPromptResult {
  /** Raw recall result — useful when the caller wants per-block scores. */
  raw: RecallV2Result;
  /** Bounded injection payload (text + ids + token estimate). */
  payload: InjectionPayload;
  /** Tool-loop / repeat detector signal. `none` when no session id. */
  signal: ToolPatternSignal;
  /**
   * 0.7.0-rc.5 §rc.5 — loop redirect resolver result. Present when
   * a tool-pattern signal fired AND the resolver returned either
   * a confident anchor or a static fallback. Absent when signal
   * was `none`. Wrappers surface `loopRedirect.label` as the TB
   * LOOP badge text.
   */
  loopRedirect?: LoopRedirectResult;
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
export async function recallForPrompt(
  server: BlockServer,
  store: BlockStore,
  holdoutLoader: HoldoutLoader,
  opts: RecallForPromptOptions,
  cascadeLoader?: CascadeLoader,
): Promise<RecallForPromptResult> {
  const recallScope = opts.sessionId ? sessionScope(opts.sessionId) : "project";

  // May-2026 — drift-as-injection-trigger. Fetch the recent tool
  // observations ONCE here, run BOTH the literal and intent-key
  // detectors, and stash the results. The post-recall redirect path
  // below reuses the same observations + signal — no second fetch,
  // no second detector call, no chance of the two paths disagreeing
  // on whether the agent is stuck.
  //
  // When the chosen signal is non-`none`, build a drift augmentation
  // (widened query + relaxed gate) and thread it through to the
  // recall call below. Everything is best-effort: any failure here
  // falls through to the pre-drift behaviour.
  let recentObservations: Awaited<
    ReturnType<typeof store.recentToolObservations>
  > = [];
  let signal: ToolPatternSignal = { kind: "none", count: 0 };
  // Set to the semantic-key shape when the semantic detector wins, so
  // the resolver's loop_redirect_dedupe row keys on intent_key
  // (`grep`→`rg`→`ag` rotations dedupe), and to the literal shape
  // otherwise. 0.7.0-rc.5 hardening.
  let observationsForResolver: typeof recentObservations = [];
  if (opts.sessionId && opts.enableToolDetection !== false) {
    try {
      recentObservations = store.recentToolObservations(
        opts.sessionId,
        opts.toolWindowSize ?? 6,
      );
      observationsForResolver = recentObservations;
      if (recentObservations.length >= 2) {
        signal = detectToolPattern(recentObservations);
        // ALWAYS run semantic, prefer it when it fires (rc.5: a cross-
        // alias rotation `grep`→`rg`→`ag` shows up as literal duplicate
        // on Grep + a separate `rg` argKey, so without the semantic
        // pass the resolver dedupes on the stale literal key).
        const semantic = recentObservations.map((o) => ({
          ...o,
          argKey: normalizeIntentKey(o.argSummary, o.toolName),
        }));
        const semanticSignal = detectToolPattern(semantic);
        if (semanticSignal.kind !== "none") {
          signal = semanticSignal;
          observationsForResolver = semantic;
        }
      }
    } catch {
      // detector is non-load-bearing on the prompt path — swallow
    }
  }
  const driftAug =
    signal.kind !== "none"
      ? buildDriftAugmentation({
          baseText: opts.prompt,
          signal,
          observations: recentObservations,
        })
      : null;
  const servingPlan = resolveServingPlan({
    profile: opts.servingProfile,
    tokenBudget: opts.tokenBudget,
    signalKind: signal.kind,
    hasSession: !!opts.sessionId,
  });

  // May-2026 B1.2 — runReasoningPatternsRecall is async because the
  // cascade rollout decision can route the query through
  // recallAsync(). When `cascadeLoader` is omitted or returns null,
  // the entry takes the synchronous recall() path internally and the
  // await resolves on the same tick.
  const raw = await runReasoningPatternsRecall(
    server,
    {
      problem: driftAug ? driftAug.text : opts.prompt,
      scope: recallScope,
      // Stamp every retrieval/injection event with run_id = sessionId
      // so Stop-hook attribution inference can scope its candidate
      // set to this session only. inject-context plumbs the Claude
      // Code session_id straight into sessionId here.
      ...(opts.sessionId ? { runId: opts.sessionId } : {}),
      ...(driftAug ? { gateOverride: driftAug.gateOverride } : {}),
    },
    {
      readHoldoutConfig: holdoutLoader,
      ...(cascadeLoader ? { readCascadeConfig: cascadeLoader } : {}),
    },
  );

  // 0.7.0-rc.3 §rc.3 — file memory recall runs alongside the
  // pattern recall. K=3 default (FILE_HITS_DEFAULT_K). The file
  // hits feed into buildInjectionPayload as a separate section
  // wrapped in `<file_memory>…</file_memory>`. Best-effort: any
  // failure (FTS not yet built, malformed prompt, etc.) yields
  // an empty list and the legacy block + fact path still ships.
  let fileHits: ReturnType<typeof recallFiles> = [];
  try {
    const rawFileHits = recallFiles(store, {
      prompt: opts.prompt,
      k: opts.fileHitsK ?? servingPlan.fileHitsK,
    });
    fileHits = filterFileHitsForRoi(rawFileHits, servingPlan);
  } catch {
    fileHits = [];
  }

  // 0.7.0-rc.6 §rc.6 — chunk-based context compression recall.
  // SAME-SESSION ONLY. Pulls the top-K most recent chunks for
  // this session and feeds them into the injection payload as a
  // `<context_fold>` section. Cross-session recall is structurally
  // impossible (the SQL filters on session_id) and a missing
  // sessionId produces an empty list.
  // 0.7.0-rc.6 hardening — prompt-aware chunk recall. Pre-
  // hardening this used `recallSessionChunks` (recency-only),
  // which surfaced the most recent K chunks regardless of which
  // topic the user just asked about. The new method scores each
  // chunk's summary by token overlap against the prompt; recency
  // becomes the tiebreaker.
  let chunkHits: ReturnType<typeof store.recallSessionChunksForPrompt> = [];
  if (opts.sessionId) {
    try {
      chunkHits = store.recallSessionChunksForPrompt(
        opts.sessionId,
        opts.prompt,
        opts.chunkHitsK ?? servingPlan.chunkHitsK,
      );
      chunkHits = filterChunkHitsForRoi(chunkHits, servingPlan);
    } catch {
      chunkHits = [];
    }
  }

  // May-2026 C4-runtime — opt-in arbiter pass over blocks + facts.
  // When `TRACEBASE_SERVING_ARBITER=1`, the arbiter scores each
  // gate-passing hit on conservative ROI and emits one
  // `arbitration_decision` event per decision. Suppressed hits
  // are filtered out of `raw` before the payload is built. When
  // the env is unset, this entire branch is skipped — `raw`
  // flows into `buildInjectionPayload` byte-for-byte identical
  // to the legacy path.
  //
  // V1 scope: reasoning_reuse only (blocks + facts). file_memory
  // and context_fold keep their existing `filterFileHitsForRoi` /
  // `filterChunkHitsForRoi` gates above; absorbing them into the
  // arbiter lands in a follow-up so this commit's change surface
  // stays small.
  let arbitratedRaw = raw;
  if (isServingArbiterEnabled()) {
    const out = runServingArbiter(raw, {
      plan: servingPlan,
      store,
      shadow: raw.shadow,
      ...(opts.sessionId ? { runId: opts.sessionId } : {}),
    });
    arbitratedRaw = out.raw;
  }

  const payload = buildInjectionPayload(arbitratedRaw, {
    tokenBudget: servingPlan.tokenBudget,
    maxBlocks: servingPlan.maxBlocks,
    maxFacts: servingPlan.maxFacts,
    maxFiles: servingPlan.maxFiles,
    maxChunks: servingPlan.maxChunks,
    fileHits,
    chunkHits,
  });

  // Drift-injection event: emit ONLY when the relaxed recall actually
  // surfaced patterns that reached the bounded payload. We count the
  // ids the agent can see, not every gate-passing hit from the raw
  // recall, so dashboard "auto-recoveries" cannot overstate impact.
  if (driftAug && payload.hasContent) {
    const injectedCount = payload.blockIds.length + payload.factIds.length;
    if (injectedCount > 0) {
      try {
        store.appendEvent({
          ts: Date.now(),
          queryId: raw.queryId,
          event: "drift_injection",
          signalKind: driftAug.signal.kind as "straight" | "pingpong" | "duplicate",
          patternsInjected: injectedCount,
          gateThreshold: driftAug.gateOverride,
          ...(opts.sessionId ? { runId: opts.sessionId } : {}),
        });
      } catch {
        // never break the recall path on telemetry failure
      }
    }
  }

  // The pre-recall block above already fetched observations and ran
  // BOTH the literal and intent-key-normalised detectors. Reuse those
  // results — the drift-augmentation path and the redirect-resolver
  // path are now guaranteed to see the same signal on the same
  // observations.
  let loopRedirect: LoopRedirectResult | undefined = undefined;

  // 0.7.0-rc.5 §rc.5 — loop redirect resolver. Runs only when a
  // signal fired; never throws (resolver is wrapped). Surfaces
  // a `matched` anchor or a static `fallback`. Wrappers read
  // `loopRedirect.label` for the badge text.
  if (
    signal.kind !== "none" &&
    opts.sessionId &&
    observationsForResolver.length > 0
  ) {
    try {
      loopRedirect = resolveLoopRedirect({
        store,
        server,
        signal,
        observations: observationsForResolver,
        sessionId: opts.sessionId,
        basePath: opts.basePath,
      });
      emitLoopEvent(store, loopRedirect, signal, payload.queryId);
    } catch {
      // resolver is non-load-bearing — never break the recall path
    }
  }

  recordRecallEvents(store, raw, payload, servingPlan);

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
        // 0.7.0-rc.3 hardening — per-section cost only. Pre-
        // hardening this was `payload.tokensEstimate`, the full
        // payload total (blocks + facts + prior_fix + file_memory),
        // which over-counted the file mechanism's cost. The rc.7
        // `file_memory_avoided = size_bytes/4 - tokensInjected`
        // metric depends on this being the file section's cost
        // alone.
        tokensInjected: payload.fileMemoryTokensEstimate,
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
    ...(loopRedirect ? { loopRedirect } : {}),
    queryId: payload.queryId,
    hasContent: payload.hasContent,
  };
}

/**
 * Emit `loop.redirected` (matched) or `loop.fallback` (no-hit /
 * low-confidence / anti-self-loop) telemetry rows. Best-effort —
 * telemetry must never break the recall path.
 */
function emitLoopEvent(
  store: BlockStore,
  redirect: LoopRedirectResult,
  signal: ToolPatternSignal,
  queryId: string,
): void {
  if (signal.kind === "none") return;
  try {
    const ts = Date.now();
    if (redirect.kind === "matched") {
      store.appendEvent({
        ts,
        queryId: queryId || `loop-redirect-${randomUUID()}`,
        event: "loop.redirected",
        signal: signal.kind,
        anchorId: redirect.anchorId ?? "",
        anchorKind: redirect.anchorKind ?? "block",
        confidence: redirect.confidence ?? 0,
      });
    } else {
      store.appendEvent({
        ts,
        queryId: queryId || `loop-fallback-${randomUUID()}`,
        event: "loop.fallback",
        signal: signal.kind,
        reason: redirect.fallbackReason ?? "no-hit",
      });
    }
  } catch {
    // best-effort
  }
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
 * 0.7.0-rc.6 §rc.6 — default top-K for session-chunk recall. The
 * spec ships at 3; raising this risks crowding the prompt with
 * redundant fold summaries since chunks ALREADY summarise their
 * window. Lowering to 1 or 2 is fine if the wrapper has a tight
 * token budget.
 */
export const CHUNK_HITS_DEFAULT_K = 3;

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
  servingPlan: ServingPlan,
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
    injectionProfile: servingPlan.profile,
    injectedSectionTokensEstimate: payload.sectionTokensEstimate,
    injectedItemCounts: {
      blocks: payload.blockIds.length,
      facts: payload.factIds.length,
      files: payload.fileIds.length,
      chunks: payload.contextFoldRanges.length,
    },
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
