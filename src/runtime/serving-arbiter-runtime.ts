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
 * Build the union candidate list from a `RecallV2Result`. Filters
 * to gate-passing hits only so the arbiter doesn't see candidates
 * the gate has already rejected (avoids double-suppression with
 * confusing reason codes).
 */
export function normalizeReasoningHits(raw: RecallV2Result): NormalizedCandidates {
  const candidates: ServingCandidate[] = [];
  const blockByCandidateId = new Map<string, BlockHit>();
  const factByCandidateId = new Map<string, FactHit>();

  raw.blocks.forEach((hit, i) => {
    if (!hit.passesGate) return;
    const c = blockHitToCandidate(hit, i);
    candidates.push(c);
    blockByCandidateId.set(c.id, hit);
  });
  raw.facts.forEach((hit, i) => {
    if (!hit.passesGate) return;
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
  const { candidates, blockByCandidateId, factByCandidateId } =
    normalizeReasoningHits(raw);

  const arbitration = arbitrateServingCandidates(candidates, {
    plan: opts.plan,
    ...(opts.shadow !== undefined ? { shadow: opts.shadow } : {}),
  });

  // Emit one event per decision. We do this before filtering so
  // every decision — including suppressions — is in the log; the
  // dashboard wants the full denominator, not just the kept set.
  const ts = opts.nowMs ?? Date.now();
  let decisionsEmitted = 0;
  for (const decision of arbitration.decisions) {
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

  // Build the filtered raw. We keep BlockHit / FactHit instances
  // identical (just the array is trimmed) so downstream code
  // sees the same object identities and `buildInjectionPayload`
  // can rely on its existing invariants.
  const kept = new Set(
    arbitration.decisions.filter((d) => d.action === "inject").map((d) => d.candidateId),
  );
  const keptBlocks = raw.blocks.filter((hit, i) => {
    if (!hit.passesGate) return false; // already excluded
    return kept.has(`block:${hit.block.id}#${i}`);
  });
  const keptFacts = raw.facts.filter((hit, i) => {
    if (!hit.passesGate) return false;
    return kept.has(`fact:${hit.fact.id}#${i}`);
  });

  const filteredRaw: RecallV2Result = {
    ...raw,
    blocks: keptBlocks,
    facts: keptFacts,
    shouldInject: raw.shouldInject && (keptBlocks.length + keptFacts.length) > 0,
  };
  // Unused locals: maps available if a follow-up wants to join
  // events back to the original hits. Touch them so the linter
  // doesn't flag.
  void blockByCandidateId;
  void factByCandidateId;

  return { raw: filteredRaw, arbitration, decisionsEmitted };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
