/**
 * attribution-inference — close the retrieval → injection →
 * **agent_used** → outcome chain when the agent didn't (and likely
 * won't) self-report.
 *
 * Why this exists
 * ---------------
 * The MCP `record_reasoning_outcome` tool path is the only canonical
 * way an `agent_used` event lands in the event log today. Most coding
 * agents call `get_reasoning_patterns` (the retrieval side) but never
 * `record_reasoning_outcome` — there is nothing in the prompt
 * contract forcing the round trip. The consequence is a metric that
 * looks broken even when the runtime is doing its job: retrievals fire,
 * blocks get injected, the agent silently uses (or doesn't use) them,
 * and then the savings/impact pages report 0 helpful runs because the
 * attribution leg never produced an event.
 *
 * The fix is to **infer agent_used from the transcript** when the Stop
 * hook fires. The Stop hook has the transcript in memory already
 * (capture-turn reads it for pattern extraction), and we have the
 * blocks that were injected during the same window — so we can score
 * each injection's content against what the agent actually said and
 * emit an `agent_used` event for the ones that crossed the evidence
 * threshold.
 *
 * Honesty contract
 * ----------------
 * `matchSignal` is the carrier of provenance for `agent_used` events:
 *
 *   - `"explicit"`  — emitted by the MCP tool or the SDK middleware
 *                     (the agent literally told us it used the block).
 *   - `"jaccard"`   — emitted by THIS module (Stop-hook inference;
 *                     evidence derived from transcript text overlap).
 *   - `"embedding"` — reserved for future cosine-based inference.
 *
 * The two existing emitters (server/mcp.ts and sdk/contextual-runtime-
 * provider.ts) only ever emit `"explicit"`, so any `"jaccard"` row in
 * the event log is unambiguously this module's. Downstream metrics
 * surface the split so callers can see how many helpful runs were
 * self-reported vs. inferred.
 *
 * NOT in scope here
 * -----------------
 * - Per-step stuck/loop scoring (already lives in src/core/loop.ts).
 * - Difficulty FSM, early-exit nudge, model routing — explicitly
 *   gated behind the user request "do not build more intelligence
 *   until the value loop is measurable". This module IS the value
 *   loop being made measurable; nothing more.
 */

import type { BlockStore } from "../core/block-store.js";
import type { AnalyticsEvent, ReasoningBlock } from "../types.js";
import { jaccardSimilarity } from "../core/fingerprint.js";
import { emitAgentUsed, emitOutcome } from "../core/analytics.js";
import { strengthFromMatchSignal } from "./attribution-evidence.js";

/**
 * Default lookback window for injection events when inferring uses
 * from a Stop-hook firing. Tightened from the initial 10 minutes
 * down to 90 seconds after review: a longer window risks crediting
 * one session's transcript against another session's injection on
 * shared workstations (Claude Code, Cursor, and Codex all running
 * in parallel terminals). A typical Claude Code turn ends in well
 * under a minute, so 90 s gives the writer comfortable margin
 * without expanding the cross-session attack surface.
 *
 * Callers that need a different window (verify-loop's synthetic
 * smoke, off-line replay, batch attribution sweeps) can override
 * via the `lookbackMs` option.
 */
export const DEFAULT_LOOKBACK_MS = 90 * 1000;

/**
 * Evidence threshold for emitting `agent_used`. Tuned conservatively:
 * a transcript and a block's unlock/verification share at least 18%
 * of their token set when the agent followed the pattern. Tested
 * against synthetic positive/negative pairs in
 * tests/runtime/attribution-inference.test.ts — see that file when
 * tuning.
 */
export const DEFAULT_EVIDENCE_THRESHOLD = 0.18;

/** Minimum token length to keep when tokenising. Three filters out
 * single-letter noise and language particles (a, the, и, не) while
 * keeping short symbol-like tokens (CORS, MCP, npx). */
const MIN_TOKEN_LEN = 3;

/** Maximum number of injection candidates we score per Stop-hook
 * firing. Bounded so a long-running session that accumulated many
 * injections doesn't make Stop hook latency unpredictable. */
const MAX_INJECTIONS_TO_SCORE = 64;

export type InferredUse = {
  queryId: string;
  blockId: string;
  /** Jaccard similarity between block evidence text and transcript tail. */
  evidenceScore: number;
  /** Convenience: the injection event's timestamp (so caller can dedupe). */
  injectionTs: number;
};

export type InferOptions = {
  /** Override `Date.now()` (used by tests + verify-loop). */
  nowMs?: number;
  /** Override the default 90-second lookback. */
  lookbackMs?: number;
  /** Override the default 0.18 Jaccard threshold. */
  evidenceThreshold?: number;
  /**
   * Restrict the candidate injection set to a specific runId. Stop-hook
   * stdin carries `session_id` from Claude Code; inject-context plumbs
   * it through `recallForPrompt` so future injection events will pin
   * `runId` to that session. Filtering here tightens cross-session
   * isolation: even if two sessions in parallel produce text that
   * scores against each other's blocks, runId mismatch keeps the
   * credit local.
   *
   * When the field is `undefined`, inference runs across all injection
   * events in the lookback window (the legacy / hook-without-runId
   * path). When it is set but no events match, no inferred uses are
   * returned — better to under-credit than mis-credit.
   */
  runId?: string;
};

/**
 * Look at injection events from the last `lookbackMs` and score each
 * one against the transcript text. Return the (queryId, blockId) pairs
 * whose evidence score crossed the threshold.
 *
 * Pure: does NOT emit events. Caller is responsible for emitting
 * `agent_used` (and optionally `outcome`) for the returned uses, so
 * tests can assert on the scoring without writing to the DB.
 */
export function inferAgentUsedFromTranscript(
  store: BlockStore,
  transcriptTailText: string,
  opts: InferOptions = {},
): InferredUse[] {
  const now = opts.nowMs ?? Date.now();
  const lookback = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const threshold = opts.evidenceThreshold ?? DEFAULT_EVIDENCE_THRESHOLD;

  const transcriptTokens = tokenize(transcriptTailText);
  if (transcriptTokens.length === 0) return [];

  const injections = store.readEvents({
    eventType: "injection",
    afterTs: now - lookback,
    limit: MAX_INJECTIONS_TO_SCORE,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
  }) as Array<Extract<AnalyticsEvent, { event: "injection" }>>;

  // Build a queryId → shadow lookup from retrieval events in the same
  // window. A query whose retrieval ran with `shadow: true` is in the
  // control arm: the agent never actually saw the injection (or, if
  // the system logged one for record-keeping, it didn't reach the
  // prompt). Crediting agent_used on such queries would corrupt the
  // shadow-vs-treatment lift signal — skip them entirely.
  const retrievals = store.readEvents({
    eventType: "retrieval",
    afterTs: now - lookback,
    limit: MAX_INJECTIONS_TO_SCORE,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
  }) as Array<Extract<AnalyticsEvent, { event: "retrieval" }>>;
  // May-2026 C2.1 — tighten shadow gate. Pre-C2.1 we only skipped
  // queryIds whose retrieval was explicitly shadow; a queryId with
  // NO matching retrieval (e.g. cross-runId leakage, or a queryId
  // the inference module fabricated) still passed through. The
  // strict rule mirrors `retrievalIsShadow` in attribution-evidence:
  // missing non-shadow retrieval ⇒ NO inference. Better to under-
  // credit than mis-credit across sessions.
  const nonShadowQueryIds = new Set<string>();
  for (const r of retrievals) {
    if (!r.shadow) nonShadowQueryIds.add(r.queryId);
  }

  // Dedupe by (queryId|blockId). The same block can land in multiple
  // injection events across a session (e.g. retrieval fired twice on
  // the same prompt shape). Each pair gets at most one inferred use.
  const seen = new Set<string>();
  const uses: InferredUse[] = [];

  for (const inj of injections) {
    // Strict: require a non-shadow retrieval event for this queryId
    // (within the same lookback + runId window). Missing → drop.
    if (!nonShadowQueryIds.has(inj.queryId)) continue;

    const key = `${inj.queryId}|${inj.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const block = store.getBlock(inj.blockId);
    if (!block) continue;

    const evidence = scoreBlockEvidenceAgainstTranscript(block, transcriptTokens);
    if (evidence >= threshold) {
      uses.push({
        queryId: inj.queryId,
        blockId: inj.blockId,
        evidenceScore: evidence,
        injectionTs: inj.ts,
      });
    }
  }

  return uses;
}

/**
 * Score how much a block's unlock+verification text overlaps with the
 * tokens that ended up in the agent's transcript. Exported so the
 * verify-loop CLI can show the per-block evidence for diagnostics.
 *
 * The scoring uses block.unlock + block.verification because:
 *   - `situation` describes the problem (the agent likely echoes the
 *     prompt, so this matches even without the agent using the block);
 *   - `mechanism` is the reasoning prose that explains WHY the unlock
 *     works — agents rarely repeat reasoning prose verbatim;
 *   - `unlock` is the actual fix/recipe — if the agent applied the
 *     pattern, fix-shaped tokens appear in its output;
 *   - `verification` is "how you'd check the fix worked" — also
 *     correlates with what the agent does after applying the fix.
 *
 * Returns 0..1 (Jaccard). Empty block text returns 0.
 */
export function scoreBlockEvidenceAgainstTranscript(
  block: ReasoningBlock,
  transcriptTokens: string[],
): number {
  const evidenceText = composeBlockEvidenceText(block);
  const blockTokens = tokenize(evidenceText);
  if (blockTokens.length === 0 || transcriptTokens.length === 0) return 0;
  return jaccardSimilarity(blockTokens, transcriptTokens);
}

/** The "what would the agent's output look like if it used this
 * block" text. Kept as a separate function so tests can swap the
 * composition strategy without rewriting the scorer.
 *
 * Sourcing: `block.body.unlock` is the actual fix the agent would have
 * typed back if it applied the pattern; `block.body.verification` is
 * the falsification / repro step it would have run. Both live under
 * `body` per the ReasoningBlock schema — NOT on the top-level block,
 * where `verification` is a separate BlockVerification status flag.
 */
function composeBlockEvidenceText(block: ReasoningBlock): string {
  const unlock = block.body?.unlock ?? "";
  const verification = block.body?.verification ?? "";
  return `${unlock}\n${verification}`.trim();
}

/**
 * Lower-cased, length-filtered token set. Splits on anything that
 * isn't an ASCII alphanumeric, underscore, or hyphen, so identifiers
 * like `auth_token` and CLI flags like `--mcp` survive intact.
 *
 * Exported for unit tests; the scoring code path always uses it
 * internally too.
 */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_-]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

// ---------------------------------------------------------------------------
// Wire-up helper — used by the Stop-hook (capture-turn) and by
// verify-loop. Owning the inference → emit sequence in one place keeps
// the contract about WHEN we emit outcomes auditable from a single
// file: capture-turn delegates here and never touches the outcome
// emit shape directly.
// ---------------------------------------------------------------------------

export type EmitInferenceOptions = InferOptions & {
  /**
   * Gate for emitting a soft `outcome.resolved=true` per credited
   * queryId. The Stop hook passes `true` only when capture-turn
   * itself extracted a fresh reusable pattern from the same turn —
   * that's our strongest "this run delivered value" signal short of
   * an explicit MCP `record_reasoning_outcome` call. When `false` we
   * still emit `agent_used` (the agent demonstrably used the block),
   * but we leave the outcome to whatever signal arrives next, so we
   * never write a fake `resolved=true` on an inconclusive turn.
   */
  allowOutcomeEmission?: boolean;
};

export type EmitInferenceReport = {
  inferredUses: InferredUse[];
  agentUsedEmitted: number;
  outcomeEmitted: number;
  /** queryIds we credited an `agent_used` event for, useful for logs. */
  creditedQueryIds: string[];
};

/**
 * Score the transcript, emit `agent_used` for each pair crossing the
 * threshold, and — only when explicitly allowed AND no prior outcome
 * exists for that queryId — emit a soft `outcome.resolved=true`.
 *
 * Honesty constraints:
 *   - `agent_used.matchSignal = "jaccard"` — the wire-level marker
 *     that distinguishes Stop-hook inference from explicit MCP
 *     emissions (which always use `"explicit"`).
 *   - `outcome.control = false` — guaranteed because
 *     `inferAgentUsedFromTranscript` already drops shadow-arm queries
 *     so we never emit credit for the control cohort.
 *   - Existing explicit outcome events are authoritative: we look up
 *     by queryId and skip emission rather than double-write.
 */
export function applyInferenceAndEmit(
  store: BlockStore,
  transcriptTailText: string,
  opts: EmitInferenceOptions = {},
): EmitInferenceReport {
  const uses = inferAgentUsedFromTranscript(store, transcriptTailText, opts);
  let agentUsedEmitted = 0;
  let outcomeEmitted = 0;
  const credited = new Set<string>();

  for (const use of uses) {
    // May-2026 C2.1 — stamp evidence taxonomy on every inferred
    // agent_used. `evidenceKind` is fixed by the inference channel
    // (the transcript-Jaccard path); `evidenceStrength` derives from
    // the same matchScore the legacy gate used, so existing thresholds
    // map cleanly into the new ladder.
    const strength = strengthFromMatchSignal("jaccard", use.evidenceScore);
    emitAgentUsed(store, {
      queryId: use.queryId,
      blockId: use.blockId,
      matchSignal: "jaccard",
      matchScore: use.evidenceScore,
      evidenceStrength: strength,
      evidenceKind: "answer_mentions_injected_anchor",
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    });
    agentUsedEmitted += 1;
    credited.add(use.queryId);
  }

  if (opts.allowOutcomeEmission === true) {
    for (const queryId of credited) {
      const priorOutcomes = store.readEvents({
        eventType: "outcome",
        queryId,
        limit: 1,
      });
      if (priorOutcomes.length === 0) {
        emitOutcome(store, {
          queryId,
          resolved: true,
          // Always false here: the inference module filters out shadow
          // retrievals upstream, so any queryId we reach has a
          // non-shadow retrieval. If the inference module ever starts
          // surfacing shadow uses, the caller must read the matching
          // retrieval's `shadow` flag and propagate it through.
          control: false,
          // Mark this as a soft / inferred outcome so the analytics
          // fold can present verifiedHelpfulRuns (explicit-only) and
          // helpfulRuns (both) side by side. Without this marker an
          // inferred resolution would masquerade as grader-verified.
          attribution: "inferred",
          ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
        });
        outcomeEmitted += 1;
      }
    }
  }

  return {
    inferredUses: uses,
    agentUsedEmitted,
    outcomeEmitted,
    creditedQueryIds: Array.from(credited),
  };
}
