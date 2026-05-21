/**
 * Attribution evidence layer — May-2026 C2.
 *
 * Sits above `attribution-inference.ts`. The inference module produces
 * transcript-Jaccard candidate matches; this module classifies each
 * candidate's evidence strength and (optionally) detects concrete
 * corroboration kinds — diff touched the recalled file, tool path
 * matched the anchor, loop-redirect was actually followed, etc.
 *
 * Why this exists
 * ---------------
 * Pre-C2, ANY transcript match above 0.18 Jaccard threshold emitted an
 * `agent_used` event with `matchSignal: "jaccard"`. Downstream
 * §L6 helpful = injection ∧ agent_used ∧ outcome.resolved. That made
 * "appeared in injected list" almost-equivalent to "helped" — exactly
 * the failure mode the C2 directive names:
 *
 *   • outcome.resolved=true on a block that the agent ignored
 *     would credit it as helpful purely on text overlap.
 *   • Shadow / control cohorts could still produce agent_used if
 *     the analyser didn't filter them out.
 *
 * The C2 fix
 * ----------
 * Every `agent_used` emission now carries `evidenceStrength` and
 * (when known) `evidenceKind`. The strict helpful definition is
 * tightened: `helpful = injection ∧ agent_used(strength ≥ moderate)
 * ∧ outcome.resolved`. Weak evidence is logged for observability but
 * never credits. Explicit evidence (`record_reasoning_outcome`)
 * remains authoritative — those calls bypass inference entirely.
 *
 * Joining contract
 * ----------------
 * Every detector takes `queryId` AND `runId` so cross-session
 * attribution cannot leak. A diff observed in session A can never
 * credit a block injected in session B even if the texts overlap.
 *
 * Shadow filter
 * -------------
 * Detectors expose a `respectShadowRetrievals` helper that loads the
 * relevant retrieval events and rejects any queryId whose retrieval
 * had `shadow: true`. The legacy inference already does this; C2
 * factors it out so every kind shares the same gate without
 * duplicating it.
 *
 * Pure
 * ----
 * No DB writes. Caller emits `agent_used` with the evidence fields
 * attached. Tests can assert on the classification without touching
 * `analytics_events`.
 */

import type { BlockStore } from "../core/block-store.js";
import type { AnalyticsEvent, ReasoningBlock } from "../types.js";

export type AttributionStrength = "explicit" | "strong" | "moderate" | "weak";

export type AttributionKind =
  | "record_reasoning_outcome"
  | "diff_touches_recalled_file"
  | "tool_path_matches_memory"
  | "answer_mentions_injected_anchor"
  | "loop_redirect_followed"
  | "test_or_command_success_after_redirect";

/**
 * Strength rank order — higher means stronger evidence. Used by
 * `strongestEvidenceFor` and by the helpful-definition gate to
 * compare candidates and decide whether to credit.
 */
export const STRENGTH_RANK: Record<AttributionStrength, number> = {
  weak: 0,
  moderate: 1,
  strong: 2,
  explicit: 3,
};

/**
 * Minimum strength required to count toward the §L6 helpful
 * definition. Weak signals (Jaccard barely above the inference
 * floor, anchor mentions on common boilerplate) DO log
 * `agent_used` for observability but DO NOT close the loop on
 * their own.
 */
export const HELPFUL_MIN_STRENGTH: AttributionStrength = "moderate";

export function meetsHelpfulThreshold(strength: AttributionStrength): boolean {
  return STRENGTH_RANK[strength] >= STRENGTH_RANK[HELPFUL_MIN_STRENGTH];
}

/**
 * Map an existing matchSignal + score combination to a strength
 * classification. Used to bridge the legacy `inferAgentUsedFromTranscript`
 * output into the C2 evidence taxonomy without changing the
 * inference math itself.
 *
 *   matchSignal = "explicit" — caller already attested → "explicit"
 *   matchSignal = "jaccard" + score ≥ STRONG_THRESHOLD → "strong"
 *   matchSignal = "jaccard" + score ≥ MODERATE_THRESHOLD → "moderate"
 *   anything below                                       → "weak"
 *
 * The strong threshold (0.45) is chosen so a transcript that
 * verbatim quotes the block's unlock + verification crosses it.
 * Moderate (0.18) matches the existing DEFAULT_EVIDENCE_THRESHOLD
 * from attribution-inference.
 */
export const STRONG_JACCARD_THRESHOLD = 0.45;
export const MODERATE_JACCARD_THRESHOLD = 0.18;

/**
 * Derive the effective strength of an agent_used event.
 *
 *   • C2-aware events populate `evidenceStrength` directly — use it.
 *   • Pre-C2 events only carry matchSignal + matchScore — derive
 *     strength via `strengthFromMatchSignal` so the helpful gate
 *     STILL applies (a pre-C2 event with matchScore 0.10 must NOT
 *     credit even though it was emitted by the legacy path).
 *
 * This is the single source of truth that aggregators (analytics,
 * calibrator) call when deciding whether an agent_used counts toward
 * §L6 helpful. Pre-C2 review found that `computeAggregates` was just
 * checking set membership without consulting strength at all —
 * `effectiveAttributionStrength` is what closes that gap.
 */
export function effectiveAttributionStrength(ev: {
  evidenceStrength?: AttributionStrength;
  matchSignal: "jaccard" | "embedding" | "explicit";
  matchScore: number;
}): AttributionStrength {
  if (ev.evidenceStrength !== undefined) return ev.evidenceStrength;
  return strengthFromMatchSignal(ev.matchSignal, ev.matchScore);
}

export function strengthFromMatchSignal(
  signal: "explicit" | "jaccard" | "embedding",
  score: number,
): AttributionStrength {
  if (signal === "explicit") return "explicit";
  if (signal === "embedding") {
    // Embedding similarity uses the same threshold ladder; we keep
    // the same numerical boundaries so the two paths agree.
    if (score >= STRONG_JACCARD_THRESHOLD) return "strong";
    if (score >= MODERATE_JACCARD_THRESHOLD) return "moderate";
    return "weak";
  }
  // jaccard
  if (score >= STRONG_JACCARD_THRESHOLD) return "strong";
  if (score >= MODERATE_JACCARD_THRESHOLD) return "moderate";
  return "weak";
}

// ---------------------------------------------------------------------------
// Concrete-evidence detectors. Each takes a queryId + runId and an
// input artefact (diff, tool argument, post-redirect outcome) and
// returns the matching block ids with the kind that fired.
//
// All detectors are best-effort, never throw, and consult the event
// log to honour the shadow-arm gate.
// ---------------------------------------------------------------------------

export interface DetectorContext {
  queryId: string;
  /** Restrict to one runId; undefined = legacy / cross-run. */
  runId?: string;
  store: BlockStore;
  /** Used to override Date.now() in tests. */
  nowMs?: number;
}

/**
 * Returns true iff the retrieval event for `queryId` was a shadow /
 * holdout run. Callers MUST short-circuit before emitting agent_used.
 * Defensive: missing retrieval event → returns true (no inference
 * without provenance).
 */
export function retrievalIsShadow(ctx: DetectorContext): boolean {
  try {
    const events = ctx.store.readEvents({
      queryId: ctx.queryId,
      eventType: "retrieval",
      limit: 4,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
    });
    if (events.length === 0) return true;
    const ev = events[0] as Extract<AnalyticsEvent, { event: "retrieval" }>;
    return ev.shadow === true;
  } catch {
    return true;
  }
}

/**
 * `diff_touches_recalled_file` — strong evidence. The agent edited a
 * file that was injected as `file_memory` for this queryId. The
 * detector takes a list of touched paths (caller computes from
 * the diff) and checks against the injection's file payload.
 *
 * Returns the file_memory injection ids whose path appears in
 * `touchedPaths`. Multiple matches → multiple ids (each gets its
 * own agent_used).
 */
export function detectDiffTouchesRecalledFile(
  ctx: DetectorContext,
  touchedPaths: readonly string[],
  recalledPaths: readonly { id: string; path: string }[],
): Array<{ id: string; kind: AttributionKind; strength: AttributionStrength }> {
  if (retrievalIsShadow(ctx)) return [];
  if (touchedPaths.length === 0 || recalledPaths.length === 0) return [];
  const touched = new Set(touchedPaths.map(normalisePath));
  const out: Array<{ id: string; kind: AttributionKind; strength: AttributionStrength }> = [];
  for (const r of recalledPaths) {
    if (touched.has(normalisePath(r.path))) {
      out.push({ id: r.id, kind: "diff_touches_recalled_file", strength: "strong" });
    }
  }
  return out;
}

/**
 * `tool_path_matches_memory` — strong evidence. A tool invocation
 * argument (file path, command target) matches an anchor encoded
 * in a recalled block's body.unlock / body.verification. Caller
 * supplies the argument summary; we look at the body text.
 */
export function detectToolPathMatchesMemory(
  ctx: DetectorContext,
  toolArgSummary: string,
  recalledBlocks: readonly ReasoningBlock[],
): Array<{ id: string; kind: AttributionKind; strength: AttributionStrength }> {
  if (retrievalIsShadow(ctx)) return [];
  const arg = toolArgSummary.toLowerCase();
  if (arg.length < 3) return [];
  const out: Array<{ id: string; kind: AttributionKind; strength: AttributionStrength }> = [];
  for (const b of recalledBlocks) {
    const unlock = (b.body.unlock ?? "").toLowerCase();
    const verification = (b.body.verification ?? "").toLowerCase();
    if (anchorMatches(arg, unlock) || anchorMatches(arg, verification)) {
      out.push({ id: b.id, kind: "tool_path_matches_memory", strength: "strong" });
    }
  }
  return out;
}

/**
 * `loop_redirect_followed` — strong evidence. After a loop_redirect
 * was injected for `queryId`, the very next tool call diverges from
 * the looping pattern (different toolName OR different argKey).
 *
 * Caller supplies the redirect block's id + the next tool observation.
 * No observation → no credit (we don't speculate).
 */
export function detectLoopRedirectFollowed(
  ctx: DetectorContext,
  redirectBlockId: string,
  loopingPattern: { toolName: string; argKey: string },
  nextObservation: { toolName: string; argKey: string } | null,
): Array<{ id: string; kind: AttributionKind; strength: AttributionStrength }> {
  if (retrievalIsShadow(ctx)) return [];
  if (!nextObservation) return [];
  const diverged =
    nextObservation.toolName !== loopingPattern.toolName ||
    nextObservation.argKey !== loopingPattern.argKey;
  if (!diverged) return [];
  return [{ id: redirectBlockId, kind: "loop_redirect_followed", strength: "strong" }];
}

/**
 * `test_or_command_success_after_redirect` — strong evidence. Inside
 * the same runId, a test command or compile/build tool exited 0 in
 * the lookback window AFTER a loop-redirect was injected. Confirms
 * the redirect's recovery action actually worked.
 *
 * Caller supplies the success signal (we don't shell out from here).
 * Pre-condition: the prior loop_redirect_followed must have already
 * fired — otherwise crediting a success that was already going to
 * happen is fabrication.
 */
export function detectTestOrCommandSuccessAfterRedirect(
  ctx: DetectorContext,
  redirectBlockId: string,
  followedAlready: boolean,
  successSignal: { kind: "test_pass" | "build_ok" | "command_exit_0"; ts: number } | null,
): Array<{ id: string; kind: AttributionKind; strength: AttributionStrength }> {
  if (!followedAlready) return [];
  if (!successSignal) return [];
  if (retrievalIsShadow(ctx)) return [];
  return [
    {
      id: redirectBlockId,
      kind: "test_or_command_success_after_redirect",
      strength: "strong",
    },
  ];
}

// ---------------------------------------------------------------------------
// Strict helpful gate
// ---------------------------------------------------------------------------

/**
 * Decide whether a particular (agent_used event, outcome event) pair
 * counts toward §L6 helpful. The directive: outcome.resolved=true
 * must NOT automatically credit every injected item; weak inferred
 * evidence is logged but does not close the loop.
 *
 * C2.3 — single source of truth via `effectiveAttributionStrength`.
 * Pre-C2.3 this function had a `legacyAsHelpful` knob that defaulted
 * absent `evidenceStrength` to helpful=true, which was a footgun for
 * C3/C4: a caller could pick the obviously-named helper and silently
 * regress the strict gate to the old permissive behaviour. Now we
 * derive strength uniformly:
 *
 *   • `evidenceStrength` present → use it directly.
 *   • Absent → derive from (matchSignal, matchScore) via
 *     `strengthFromMatchSignal`. A pre-C2.1 explicit signal still
 *     reads as "explicit"; a noisy Jaccard reads as "weak".
 *   • Neither field present → derived "weak" (does NOT clear gate).
 *   • Outcome missing or shadow (control=true) or unresolved →
 *     never helpful.
 *
 * The aggregators in `core/analytics.ts` and `lifecycle/cascade-compare.ts`
 * implement the SAME semantics inline (they need the strength value
 * to update per-pair Maps anyway); this helper is the canonical
 * single-event check for ad-hoc callers and tests.
 */
export function isStrictlyHelpful(
  agentUsed: {
    evidenceStrength?: AttributionStrength;
    matchSignal?: "jaccard" | "embedding" | "explicit";
    matchScore?: number;
  } | null,
  outcome: { resolved: boolean; control: boolean } | null,
): boolean {
  if (!agentUsed || !outcome) return false;
  if (outcome.control === true) return false;
  if (!outcome.resolved) return false;
  const strength = agentUsed.evidenceStrength
    ?? (agentUsed.matchSignal !== undefined
      ? strengthFromMatchSignal(agentUsed.matchSignal, agentUsed.matchScore ?? 0)
      : "weak");
  return meetsHelpfulThreshold(strength);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").trim().toLowerCase();
}

/**
 * Anchor match — checks whether `arg` and `target` share a meaningful
 * sequence of characters. Defensive against trivial false positives:
 *
 *   • Require at least 6 contiguous chars of overlap (rules out
 *     boilerplate like "the", "use", "with").
 *   • Lowercase comparison only.
 *
 * NOT a Jaccard pass — we want a textual subsequence, not a token
 * set match. Tool paths are typically file paths or command names,
 * and a body anchor is typically a file or symbol name; the
 * substring rule catches the "the agent invoked tool with path X
 * which appears verbatim in the block" pattern cleanly.
 */
function anchorMatches(arg: string, target: string): boolean {
  if (target.length < 6) return false;
  // Look for the longest substring of target that fits inside arg.
  // We try the simplest correct thing — Aho-Corasick / suffix arrays
  // would be overkill for arg lengths typically < 200 chars.
  const minLen = 6;
  for (let i = 0; i <= target.length - minLen; i++) {
    const piece = target.slice(i, i + minLen);
    if (arg.includes(piece)) return true;
  }
  return false;
}
