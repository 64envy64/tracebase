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
  type Capability,
  type ServingCandidate,
  type ServingDecision,
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
  // candidate sits below the ranker's top-K.
  const { candidates, blockByCandidateId, factByCandidateId } =
    normalizeReasoningHits(raw);

  // C4.4 — disable the arbiter's bucket cap entirely. Blocks AND
  // facts share `capability = "reasoning_reuse"` (facts have no
  // own slot in the directive's closed enum), so any non-trivial
  // bucket cap would underfill a lane: a maxBlocks=1 / maxFacts=1
  // plan with combined cap 2 lets two strong blocks consume the
  // budget before a strong fact gets considered, then the
  // post-process demotes the overflow block but the fact lane is
  // empty because the fact was suppressed as profile_cap at the
  // bucket level. Set the bucket to `candidates.length` so the
  // arbiter's only remaining global gate is the token budget
  // (which IS scarce and IS its job). Per-lane invariants land
  // in the post-process below.
  const arbiterPlan = {
    ...opts.plan,
    maxBlocks: Math.max(candidates.length, opts.plan.maxBlocks + opts.plan.maxFacts),
  };
  const arbitration = arbitrateServingCandidates(candidates, {
    plan: arbiterPlan,
    ...(opts.shadow !== undefined ? { shadow: opts.shadow } : {}),
  });

  // C4.4 — per-lane finalisation in ROI order. The arbiter's
  // `decisions` array is in INPUT candidate order
  // (`serving-arbiter.ts:226`), NOT in greedy-walk / ROI order —
  // a fact the original C4.3 cap-finaliser missed. Walking input
  // order produced "keep the lower-ROI earlier block, demote
  // the higher-ROI later block". Here we re-sort the inject
  // subset by `expectedNetTokens` DESC (input index tie-break for
  // determinism) before applying per-lane caps. Underfilled lanes
  // naturally get the next-best item.
  const injectInRoiOrder = arbitration.decisions
    .map((d, idx) => ({ d, idx }))
    .filter(({ d }) => d.action === "inject")
    .sort((a, b) => {
      if (b.d.expectedNetTokens !== a.d.expectedNetTokens) {
        return b.d.expectedNetTokens - a.d.expectedNetTokens;
      }
      return a.idx - b.idx;
    });

  const demoted = new Set<string>();
  let blockKept = 0;
  let factKept = 0;
  for (const { d } of injectInRoiOrder) {
    const isBlock = blockByCandidateId.has(d.candidateId);
    if (isBlock) {
      if (blockKept < opts.plan.maxBlocks) {
        blockKept++;
      } else {
        demoted.add(d.candidateId);
      }
    } else {
      if (factKept < opts.plan.maxFacts) {
        factKept++;
      } else {
        demoted.add(d.candidateId);
      }
    }
  }

  // Compose final decisions: pre-existing suppress/shadow pass
  // through, demoted injects flip to suppress/profile_cap.
  const finalDecisions: ServingDecision[] = arbitration.decisions.map((d) => {
    if (demoted.has(d.candidateId)) {
      return { ...d, action: "suppress", reason: "profile_cap" };
    }
    return d;
  });

  // C4.4 — recompute `byCandidateId`, `summary`, and
  // `injectedTokens` from the FINAL decisions. Pre-fix the
  // returned `arbitration` carried the pre-finalisation counts
  // (e.g. summary[reasoning_reuse].inject overstated by the
  // demoted overflow), which a future C5 dashboard could read as
  // ground truth. Rebuild explicitly so stale numbers can't leak.
  const byCandidateId: Record<string, ServingDecision> = {};
  const summary = emptyServingSummary();
  let injectedTokens = 0;
  for (const d of finalDecisions) {
    byCandidateId[d.candidateId] = d;
    summary[d.capability][d.action]++;
    if (d.action === "inject") {
      const candidate = candidates.find((c) => c.id === d.candidateId);
      if (candidate) injectedTokens += Math.max(0, candidate.injectionTokens);
    }
  }

  const finalArbitration = {
    ...arbitration,
    decisions: finalDecisions,
    byCandidateId,
    summary,
    injectedTokens,
  };

  // Emit one event per FINAL decision — one row per candidate so
  // the dashboard reads a clean 1:1 mapping.
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
      // Never break the recall path on telemetry failure.
    }
  }

  // Build the filtered raw from the FINAL inject set.
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
  void factByCandidateId;

  return {
    raw: filteredRaw,
    arbitration: finalArbitration,
    decisionsEmitted,
  };
}

/**
 * Mirror of the internal `emptySummary` in `serving-arbiter.ts`.
 * Local replica keeps this module's `runServingArbiter` self-
 * contained without forcing a new export from the pure module.
 */
function emptyServingSummary(): ArbitrationResult["summary"] {
  const caps: Capability[] = [
    "reasoning_reuse",
    "file_memory",
    "loop_redirect",
    "tool_supervision",
    "context_fold",
    "context_pruning",
  ];
  const out = {} as ArbitrationResult["summary"];
  for (const cap of caps) out[cap] = { inject: 0, suppress: 0, shadow: 0 };
  return out;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
