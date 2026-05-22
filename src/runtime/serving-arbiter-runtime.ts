/**
 * Serving-arbiter runtime wiring — May-2026 C4-runtime.
 *
 * The pure-math arbiter (`serving-arbiter.ts`) explicitly refuses
 * to touch the DB or know about block / fact shapes. This module
 * is the thin translation layer between `recallForPrompt`'s
 * existing `RecallV2Result` and the arbiter's `ServingCandidate[]`
 * interface, plus the env-gated entry point that keeps the
 * default path byte-for-byte identical when the operator hasn't
 * opted in.
 *
 * Scope contract honored here:
 *
 *   • Opt-in only via `TRACEBASE_SERVING_ARBITER=1`. When unset
 *     the entry point returns `null` and the caller is required
 *     to take the legacy path unchanged.
 *
 *   • Conservative cold-start. Per-candidate
 *     `estimatedAvoidedTokens` is a fixed, modest estimate so
 *     fresh blocks need a genuinely confident calibrator output
 *     to clear the cost-saver profile floor. The arbiter's
 *     existing `CONFIDENCE_FLOOR` still applies on top.
 *
 *   • No raw content in telemetry. The wiring emits one
 *     `arbitration_decision` event per decision carrying only
 *     ids + scalars + closed-vocab enums (action / reason /
 *     capability). Block triggers, bodies, file paths, and
 *     prompts never enter the event stream from this code.
 *
 *   • V1 scope: reasoning_reuse only (blocks + facts). file_memory
 *     and context_fold keep their existing ROI gates
 *     (`filterFileHitsForRoi`, `filterChunkHitsForRoi`) for this
 *     commit so the change surface is small. C4.x will absorb
 *     them into the same arbitration pass once their tests are
 *     ported.
 */
import type { BlockStore } from "../core/block-store.js";
import type { BlockHit, FactHit, RecallV2Result } from "../core/block-serving.js";
import { emitArbitrationDecision } from "../core/analytics.js";
import {
  arbitrateServingCandidates,
  type ArbitrationResult,
  type ServingCandidate,
} from "./serving-arbiter.js";
import type { ServingPlan } from "./serving-policy.js";

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

export const SERVING_ARBITER_ENV = "TRACEBASE_SERVING_ARBITER";

/**
 * True only when the operator has set the env var to the
 * canonical `"1"`. Any other value — including missing, empty,
 * `"true"`, `"yes"`, etc. — leaves the legacy path active. The
 * strict comparison is deliberate: a stray export ("=0",
 * `="false"`) must NOT silently enable the new path.
 */
export function isServingArbiterEnabled(
  raw: string | null | undefined = process.env[SERVING_ARBITER_ENV],
): boolean {
  return raw === "1";
}

// ---------------------------------------------------------------------------
// Per-candidate cost / benefit estimation
// ---------------------------------------------------------------------------

/**
 * Conservative fixed estimate of tokens an injected reasoning
 * block would help the agent AVOID downstream when the block is
 * actually relevant. V1 ships a single constant; C4.x will swap
 * to a learned per-capability estimate once the
 * `mechanism-savings` aggregator can scope to single blocks.
 */
export const BLOCK_AVOIDED_TOKENS_ESTIMATE = 200;

/**
 * Conservative fixed estimate of tokens a fact helps avoid. Facts
 * are point assertions (one identifier, one rule) — they
 * shortcut a small amount of investigation rather than a whole
 * reasoning path, so the upside is structurally smaller.
 */
export const FACT_AVOIDED_TOKENS_ESTIMATE = 50;

/**
 * Per-character → tokens factor matching the rest of the
 * codebase's coarse estimator (string length / 4). NOT a real
 * tokenizer; the arbiter only needs an ordering-stable cost
 * proxy. If real tokenization arrives later we swap this one
 * function and the contract holds.
 */
function approxTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/**
 * Total prompt cost of injecting one block (situation + body +
 * wrapper overhead). Approximates the same content
 * `build-injection-payload` will actually emit, so the arbiter's
 * budget bookkeeping doesn't drift from the payload builder's.
 */
export function estimateBlockInjectionTokens(hit: BlockHit): number {
  const t = hit.block.trigger;
  const b = hit.block.body;
  // Wrapper overhead: the `<situation>…</unlock>` scaffolding the
  // payload builder emits per block. Kept as a flat constant so
  // it's auditable.
  const WRAPPER_OVERHEAD = 30;
  const tokens =
    approxTokens(t.situation ?? "") +
    approxTokens(b.mechanism ?? "") +
    approxTokens(b.unlock ?? "") +
    approxTokens(b.verification ?? "");
  return tokens + WRAPPER_OVERHEAD;
}

/**
 * Total prompt cost of injecting one fact. Simpler shape — facts
 * are key + value + optional source link.
 */
export function estimateFactInjectionTokens(hit: FactHit): number {
  const fact = hit.fact;
  // Fact wrapper is a single `<fact ... />`-shaped line; overhead
  // ~12 tokens. Cost dominated by the statement text.
  const WRAPPER_OVERHEAD = 12;
  return approxTokens(fact.statement ?? "") + WRAPPER_OVERHEAD;
}

// ---------------------------------------------------------------------------
// Normalization — RecallV2Result → ServingCandidate[]
// ---------------------------------------------------------------------------

/**
 * Translate one `BlockHit` into a `ServingCandidate` the arbiter
 * understands. Cold-start protection lives in
 * `estimatedAvoidedTokens` (fixed, conservative) — when a fresh
 * block has a high ranker score but no calibrator evidence yet,
 * the modest upside × the modest calibrator output ≈ break-even
 * vs the real injection cost, so the cost-saver profile rejects
 * cleanly without the calibrator needing a per-block prior.
 */
function blockHitToCandidate(hit: BlockHit, index: number): ServingCandidate {
  return {
    id: `block:${hit.block.id}#${index}`,
    capability: "reasoning_reuse",
    sourceId: hit.block.id,
    injectionTokens: estimateBlockInjectionTokens(hit),
    estimatedAvoidedTokens: BLOCK_AVOIDED_TOKENS_ESTIMATE,
    relevanceScore: clamp01(hit.score),
    calibratedHelpfulProb: clamp01(hit.calibratedProb),
    freshnessPenalty: 0,
    noisePenalty: 0,
  };
}

function factHitToCandidate(hit: FactHit, index: number): ServingCandidate {
  return {
    id: `fact:${hit.fact.id}#${index}`,
    capability: "reasoning_reuse",
    sourceId: hit.fact.id,
    injectionTokens: estimateFactInjectionTokens(hit),
    estimatedAvoidedTokens: FACT_AVOIDED_TOKENS_ESTIMATE,
    relevanceScore: clamp01(hit.score),
    calibratedHelpfulProb: clamp01(hit.calibratedProb),
    freshnessPenalty: 0,
    noisePenalty: 0,
  };
}

export interface NormalizedCandidates {
  candidates: ServingCandidate[];
  /** Map back from candidate.id → block hit / fact hit (lossless). */
  blockByCandidateId: Map<string, BlockHit>;
  factByCandidateId: Map<string, FactHit>;
}

/**
 * Build the union candidate list from a `RecallV2Result`.
 *
 * Gate-filter semantics differ by cohort:
 *
 *   • Non-shadow path (`raw.shadow === false`) — only
 *     `passesGate=true` hits are normalised. The block-serving
 *     gate already suppressed the rest with their own reason; we
 *     don't want to re-suppress them through the arbiter with a
 *     less informative code.
 *
 *   • Shadow path (`raw.shadow === true`) — BlockServer sets
 *     `passesGate=false` for EVERY hit on a shadow query (see
 *     `src/core/block-serving.ts:736`). If we kept the filter
 *     uniform we'd hand the arbiter zero candidates and zero
 *     `action=shadow / reason=holdout` events would ever land —
 *     the holdout telemetry surface would be silently dead. So on
 *     shadow we pass all hits through; the pure arbiter's shadow
 *     gate marks every decision `shadow/holdout` regardless.
 *
 * (The C4 review caught this dead-shadow path with a real-
 * BlockServer regression test in `serving-arbiter-runtime.test.ts`.)
 */
export function normalizeReasoningHits(raw: RecallV2Result): NormalizedCandidates {
  const candidates: ServingCandidate[] = [];
  const blockByCandidateId = new Map<string, BlockHit>();
  const factByCandidateId = new Map<string, FactHit>();

  const acceptAll = raw.shadow === true;

  raw.blocks.forEach((hit, i) => {
    if (!acceptAll && !hit.passesGate) return;
    const c = blockHitToCandidate(hit, i);
    candidates.push(c);
    blockByCandidateId.set(c.id, hit);
  });
  raw.facts.forEach((hit, i) => {
    if (!acceptAll && !hit.passesGate) return;
    const c = factHitToCandidate(hit, i);
    candidates.push(c);
    factByCandidateId.set(c.id, hit);
  });

  return { candidates, blockByCandidateId, factByCandidateId };
}

// ---------------------------------------------------------------------------
// Entry point — runs the arbiter + emits telemetry + returns
// the FILTERED RecallV2Result that downstream code consumes
// in place of the raw recall.
// ---------------------------------------------------------------------------

export interface RunServingArbiterOptions {
  plan: ServingPlan;
  store: BlockStore;
  /** Optional run id, threaded into the emitted events. */
  runId?: string;
  /** Shadow / holdout gate from the upstream recall plumbing. */
  shadow?: boolean;
  /** Override the wall clock for deterministic tests. */
  nowMs?: number;
}

export interface RunServingArbiterResult {
  /** Filtered raw with only inject-decisions surviving. */
  raw: RecallV2Result;
  /** Full arbitration result for downstream observability. */
  arbitration: ArbitrationResult;
  /** Count of emitted `arbitration_decision` events. */
  decisionsEmitted: number;
}

/**
 * Run the arbiter against the recall result and emit one event
 * per decision. The returned `raw` is a SHALLOW clone with the
 * suppressed blocks/facts removed — `buildInjectionPayload` then
 * proceeds against the smaller slate exactly as it does today.
 *
 * Pure-ish: the only side effects are the analytics events and
 * the `null`-safe return shape. The store is used solely as the
 * event sink; no block status mutations happen here.
 */
export function runServingArbiter(
  raw: RecallV2Result,
  opts: RunServingArbiterOptions,
): RunServingArbiterResult {
  // C4.3 — the arbiter must see the FULL gate-passing slate so it
  // can pick the highest-ROI candidate per lane, even when that
  // candidate sits below the ranker's top-K. Earlier (C4.2) we
  // pre-sliced `raw.blocks` / `raw.facts` to `plan.maxBlocks` /
  // `plan.maxFacts` here, which was honest about prompt-visible
  // events but actively defeated the arbiter's value-add: under
  // cost-saver (maxBlocks=1) a net-negative block ranked #1
  // would force "suppress all" even when block #2 was net +155.
  // Now we feed the entire slate through. Per-lane caps land
  // post-arbitration below, demoting overflow to
  // `suppress / profile_cap` so decisions still match the
  // prompt-visible items.
  const { candidates, blockByCandidateId, factByCandidateId } =
    normalizeReasoningHits(raw);

  // Blocks AND facts normalise to capability="reasoning_reuse"
  // (facts don't have their own slot in the directive's closed
  // capability enum). The pure arbiter reads `plan.maxBlocks` as
  // the cap for that bucket — which would unfairly suppress
  // facts whose own `plan.maxFacts` lane has headroom. We
  // synthesize a temporary plan with the combined cap so both
  // lanes can compete cross-lane on ROI; the per-lane invariant
  // is restored in the post-arbitration walk below.
  const arbiterPlan = {
    ...opts.plan,
    maxBlocks: opts.plan.maxBlocks + opts.plan.maxFacts,
  };
  const arbitration = arbitrateServingCandidates(candidates, {
    plan: arbiterPlan,
    ...(opts.shadow !== undefined ? { shadow: opts.shadow } : {}),
  });

  // C4.3 per-lane post-process. `arbitration.decisions` arrive in
  // the arbiter's greedy walk order — `inject` decisions are
  // emitted highest-ROI first (with diversity tie-break baked in).
  // We walk them in that order and demote any inject that would
  // exceed the per-lane cap from `inject` → `suppress` with
  // reason `profile_cap`. Suppressions from the arbiter pass
  // through unchanged.
  let blockInjectCount = 0;
  let factInjectCount = 0;
  const finalDecisions = arbitration.decisions.map((d) => {
    if (d.action !== "inject") return d;
    const isBlock = blockByCandidateId.has(d.candidateId);
    if (isBlock) {
      if (blockInjectCount < opts.plan.maxBlocks) {
        blockInjectCount++;
        return d;
      }
      return { ...d, action: "suppress" as const, reason: "profile_cap" as const };
    }
    if (factInjectCount < opts.plan.maxFacts) {
      factInjectCount++;
      return d;
    }
    return { ...d, action: "suppress" as const, reason: "profile_cap" as const };
  });

  // Emit one event per FINAL decision. We do this once per
  // candidate (not once per arbitration step + once per
  // post-process demotion) so the dashboard reads a clean
  // 1:1 mapping between candidates and events.
  const ts = opts.nowMs ?? Date.now();
  let decisionsEmitted = 0;
  for (const decision of finalDecisions) {
    const candidate = candidates.find((c) => c.id === decision.candidateId);
    if (!candidate) continue;
    try {
      emitArbitrationDecision(opts.store, {
        ts,
        queryId: raw.queryId,
        ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
        capability: decision.capability,
        candidateId: decision.candidateId,
        ...(candidate.sourceId !== undefined ? { sourceId: candidate.sourceId } : {}),
        action: decision.action,
        reason: decision.reason,
        expectedNetTokens: decision.expectedNetTokens,
        calibratedProb: candidate.calibratedHelpfulProb,
        relevanceScore: candidate.relevanceScore,
        injectionTokens: candidate.injectionTokens,
      });
      decisionsEmitted++;
    } catch {
      // Never break the recall path on telemetry failure — the
      // user-visible action is the filtered injection slate.
    }
  }

  // Build the filtered raw from the FINAL decisions (after
  // per-lane post-process). Items that were rolled from inject
  // to suppress/profile_cap drop out here, matching the
  // dashboard's view of prompt-visible items.
  const kept = new Set(
    finalDecisions.filter((d) => d.action === "inject").map((d) => d.candidateId),
  );
  const acceptAllForShadow = raw.shadow === true;
  const keptBlocks = raw.blocks.filter((hit, i) => {
    if (!acceptAllForShadow && !hit.passesGate) return false;
    return kept.has(`block:${hit.block.id}#${i}`);
  });
  const keptFacts = raw.facts.filter((hit, i) => {
    if (!acceptAllForShadow && !hit.passesGate) return false;
    return kept.has(`fact:${hit.fact.id}#${i}`);
  });

  const filteredRaw: RecallV2Result = {
    ...raw,
    blocks: keptBlocks,
    facts: keptFacts,
    shouldInject: raw.shouldInject && (keptBlocks.length + keptFacts.length) > 0,
  };
  void factByCandidateId; // map available for future event joins

  return {
    raw: filteredRaw,
    arbitration: { ...arbitration, decisions: finalDecisions },
    decisionsEmitted,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
