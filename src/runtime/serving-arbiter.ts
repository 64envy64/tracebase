/**
 * Serving arbiter — May-2026 C1.
 *
 * Pure-math layer over `serving-policy.ts`. The policy decides PROFILE
 * (cost-saver / balanced / recall-heavy) and BUDGET (token + per-
 * capability caps). The arbiter takes a normalized candidate list
 * from every active capability and decides, per candidate, whether
 * to `inject` / `suppress` / `shadow` with a `reason` code.
 *
 * What this module is for
 * -----------------------
 * Closed-loop ROI gating. Each candidate carries a calibrated
 * P(helpful), an estimate of tokens it would help avoid, an
 * injection cost, and freshness / noise penalties. The arbiter
 * scores expected net tokens conservatively and refuses to inject
 * when the cost exceeds the expected benefit. Capabilities compete
 * inside the same budget — file_memory cannot starve reasoning_reuse
 * by injecting first.
 *
 * What this module deliberately is NOT
 * ------------------------------------
 *   • Not a memory store. Reads from no DB; the caller normalises
 *     existing capability outputs into ServingCandidate[].
 *   • Not a new abstraction layer. Slots above `serving-policy.ts`
 *     (which stays the source of profile/budget defaults).
 *   • Not a learning algorithm. Calibrator + contextual bandit
 *     supply the probabilities; the arbiter is the arithmetic gate
 *     that puts those probabilities in front of a real token budget.
 *
 * Backward-compatible by construction
 * -----------------------------------
 * The legacy filter path (`filterFileHitsForRoi`, `filterChunkHitsForRoi`,
 * direct payload assembly) keeps working — the arbiter is an
 * additional, opt-in surface. Wiring it into `recallForPrompt` lives
 * in C4 behind an env flag so existing tests don't shift on import.
 *
 * Scoring contract (every candidate)
 * ----------------------------------
 *   expectedNetTokens =
 *       calibratedHelpfulProb * estimatedAvoidedTokens
 *     - injectionTokens
 *     - noisePenalty
 *     - freshnessPenalty
 *
 * Profile rules:
 *   • cost-saver  : require expectedNetTokens > 0 strictly.
 *   • balanced    : allow expectedNetTokens >= near-zero floor
 *                   (we still reject deeply negative).
 *   • recall-heavy: floor effectively disabled (debug / escape hatch).
 *
 * Reason codes are the load-bearing observability surface. Every
 * suppression names WHY so downstream telemetry can answer "where
 * did the cascade lose ROI" without re-running the math.
 */

import type { ServingPlan, ServingProfile } from "./serving-policy.js";

// ---------------------------------------------------------------------------
// Public types (verbatim from the directive — do not rename / extend silently)
// ---------------------------------------------------------------------------

export type Capability =
  | "reasoning_reuse"
  | "file_memory"
  | "loop_redirect"
  | "tool_supervision"
  | "context_fold"
  | "context_pruning";

export interface ServingCandidate {
  /** Stable id within this arbitration pass. Caller's choice (block id, file
   * path hash, etc.). Must be unique inside one `arbitrateServingCandidates`
   * call so reason codes can be joined back. */
  id: string;
  capability: Capability;
  /** Optional reference back into the source store (block id, fact id,
   * file path, etc.). Logged only as an opaque token. */
  sourceId?: string;
  /** Tokens this candidate would add to the prompt if injected. */
  injectionTokens: number;
  /** Tokens this candidate is estimated to AVOID downstream when it
   * actually helps — conservative caller-supplied estimate. */
  estimatedAvoidedTokens: number;
  /** Per-capability ranker output, in [0, 1]. */
  relevanceScore: number;
  /** Calibrator output for P(helpful) given this candidate, in [0, 1]. */
  calibratedHelpfulProb: number;
  /** Soft penalty for staleness. ≥0; subtracted from net tokens. */
  freshnessPenalty: number;
  /** Soft penalty for known noise / counterproductive history. ≥0. */
  noisePenalty: number;
}

export type DecisionAction = "inject" | "suppress" | "shadow";

export type DecisionReason =
  | "positive_roi"
  | "budget"
  | "low_confidence"
  | "stale"
  | "duplicate"
  | "profile_cap"
  | "holdout";

export interface ServingDecision {
  candidateId: string;
  capability: Capability;
  action: DecisionAction;
  expectedNetTokens: number;
  reason: DecisionReason;
}

// ---------------------------------------------------------------------------
// Arbitration
// ---------------------------------------------------------------------------

/**
 * Minimum P(helpful) before a non-loop-redirect capability is even
 * considered for injection on the cost-saver profile. Loop-redirect
 * gets a lower floor because its value is bounded by the recovery
 * budget, not by ongoing relevance — even a moderately confident
 * redirect on a confirmed loop is worth more than a moderate
 * reasoning-reuse hit.
 */
const CONFIDENCE_FLOOR: Record<ServingProfile, number> = {
  "cost-saver": 0.25,
  balanced: 0.10,
  "recall-heavy": 0.0,
};

/**
 * The "near-zero floor" balanced uses. Below this expected-net-tokens
 * value the candidate is suppressed even if it scores marginally
 * positive — we'd rather skip a coin-flip injection than risk
 * net-negative bias under noisy calibrators.
 */
const BALANCED_NEAR_ZERO_FLOOR = -8;

/** Per-capability cap from the ServingPlan, accessed by capability. */
function planCapFor(plan: ServingPlan, capability: Capability): number {
  switch (capability) {
    case "reasoning_reuse": return plan.maxBlocks;
    case "file_memory": return plan.maxFiles;
    case "context_fold": return plan.maxChunks;
    // facts share the reasoning-reuse stream in current wiring; they
    // get the maxFacts cap on the other rail. We expose them under
    // reasoning_reuse semantically; the caller picks the right cap
    // before normalising into ServingCandidate.
    case "loop_redirect": return 1; // at most one redirect per recall
    case "tool_supervision": return 1; // at most one supervision event
    case "context_pruning": return Number.POSITIVE_INFINITY; // pruning emits no prompt text
    default: return 0;
  }
}

export interface ArbitrateOptions {
  /** Resolved serving plan (token budget + per-capability caps). */
  plan: ServingPlan;
  /** When true, treat every candidate as `shadow` — the cohort
   * gate has decided this query is in the control arm. Reason will
   * be "holdout" so downstream analytics can split cleanly. */
  shadow?: boolean;
  /** Optional set of source ids that have already been served in a
   * recent window. Used for the "duplicate" reason. Caller is
   * responsible for the window definition. */
  recentSourceIds?: ReadonlySet<string>;
  /** Override the confidence floor (tests / off-policy replay). */
  confidenceFloor?: number;
  /** Override the near-zero floor for balanced profile (tests). */
  nearZeroFloor?: number;
}

export interface ArbitrationResult {
  decisions: ServingDecision[];
  /** Same length as input — index-aligned for debug / replay. */
  byCandidateId: Record<string, ServingDecision>;
  /** Per-capability counts of injected vs suppressed vs shadowed. */
  summary: Record<Capability, { inject: number; suppress: number; shadow: number }>;
  /** Tokens the arbiter scheduled into the prompt across all injects. */
  injectedTokens: number;
  /** Remaining budget after the last accepted inject. */
  remainingBudget: number;
}

/**
 * Run the arbitration pass over a normalized candidate list.
 *
 * The algorithm:
 *
 *   1. Compute expectedNetTokens per candidate.
 *   2. Apply the cohort / confidence / duplicate gates — fast suppress
 *      paths so the budget pass doesn't see ineligible candidates.
 *   3. Sort surviving candidates by expectedNetTokens DESC, with
 *      capability diversity as the tie-break (prevents one capability
 *      from filling the budget when its top-N have nearly-equal scores).
 *   4. Greedy walk: accept inject while budget allows AND per-capability
 *      cap allows, otherwise suppress with `reason: "budget"` /
 *      `"profile_cap"`.
 *
 * Pure — no DB writes, no event emission. Caller is responsible for
 * emitting telemetry off the returned ArbitrationResult.
 */
export function arbitrateServingCandidates(
  candidates: readonly ServingCandidate[],
  opts: ArbitrateOptions,
): ArbitrationResult {
  const plan = opts.plan;
  const profile = plan.profile;
  const confidenceFloor =
    opts.confidenceFloor ?? CONFIDENCE_FLOOR[profile] ?? 0;
  const nearZeroFloor = opts.nearZeroFloor ?? BALANCED_NEAR_ZERO_FLOOR;

  // 1. Score every candidate up front. We attach the score to a
  //    parallel `Scored` array — keeping the original index lets us
  //    join decisions back when the caller renders telemetry.
  type Scored = { c: ServingCandidate; expectedNetTokens: number };
  const scored: Scored[] = candidates.map((c) => ({
    c,
    expectedNetTokens: scoreCandidate(c),
  }));

  // 2. Initialise decision map with everything suppressed; we'll flip
  //    to inject as the greedy pass accepts. This way an early return
  //    (budget exhausted) leaves the remainder suppressed with a
  //    correct reason rather than missing entries.
  const decisions: ServingDecision[] = scored.map(({ c, expectedNetTokens }) => ({
    candidateId: c.id,
    capability: c.capability,
    action: "suppress",
    expectedNetTokens,
    reason: "low_confidence", // overwritten below as the right reason is determined
  }));
  const byId = new Map<string, number>();
  decisions.forEach((d, i) => byId.set(d.candidateId, i));

  // 3. Fast-suppress gates — duplicates, confidence floor, holdout.
  for (let i = 0; i < scored.length; i++) {
    const { c, expectedNetTokens } = scored[i]!;
    const dec = decisions[i]!;
    if (opts.shadow === true) {
      dec.action = "shadow";
      dec.reason = "holdout";
      continue;
    }
    if (opts.recentSourceIds && c.sourceId && opts.recentSourceIds.has(c.sourceId)) {
      dec.reason = "duplicate";
      continue;
    }
    if (c.calibratedHelpfulProb < confidenceFloor) {
      dec.reason = "low_confidence";
      continue;
    }
    if (c.freshnessPenalty >= c.estimatedAvoidedTokens && c.freshnessPenalty > 0) {
      // Penalty wholly cancels the upside — staleness, not budget.
      dec.reason = "stale";
      continue;
    }
    // Profile floors on expectedNetTokens.
    if (profile === "cost-saver" && expectedNetTokens <= 0) {
      dec.reason = "low_confidence";
      continue;
    }
    if (profile === "balanced" && expectedNetTokens < nearZeroFloor) {
      dec.reason = "low_confidence";
      continue;
    }
    // Eligible for the budget pass. Leave as suppressed with a
    // placeholder reason; the budget pass below will flip it.
    dec.reason = "positive_roi";
  }

  // 4. Greedy budget walk. Sort by score DESC + capability round-robin
  //    so a single capability with 5 high scorers doesn't drown a
  //    different capability whose top scorer is comparable. The
  //    diversity tie-break is bounded: equal expectedNetTokens fall
  //    back to original order, so within one capability we stay
  //    deterministic.
  const eligible = scored
    .map((s, i) => ({ ...s, idx: i }))
    .filter((s) => decisions[s.idx]!.reason === "positive_roi");

  eligible.sort((a, b) => {
    if (b.expectedNetTokens !== a.expectedNetTokens) {
      return b.expectedNetTokens - a.expectedNetTokens;
    }
    return a.idx - b.idx;
  });

  // Diversity pass — when two adjacent entries share capability and
  // the second has a non-trivial alternative behind it, swap to
  // surface the alternative first.
  for (let i = 0; i + 1 < eligible.length; i++) {
    if (eligible[i]!.c.capability !== eligible[i + 1]!.c.capability) continue;
    for (let j = i + 2; j < eligible.length; j++) {
      if (eligible[j]!.c.capability === eligible[i]!.c.capability) continue;
      // Only swap if the alternative is within a token of the current
      // — don't sacrifice a clearly-better candidate for diversity.
      if (eligible[j]!.expectedNetTokens >= eligible[i + 1]!.expectedNetTokens - 1) {
        const tmp = eligible[i + 1]!;
        eligible[i + 1] = eligible[j]!;
        eligible[j] = tmp;
      }
      break;
    }
  }

  let remainingBudget = plan.tokenBudget;
  let injectedTokens = 0;
  const capabilityCounts = new Map<Capability, number>();

  for (const s of eligible) {
    const cap = s.c.capability;
    const capCap = planCapFor(plan, cap);
    const usedCap = capabilityCounts.get(cap) ?? 0;
    if (usedCap >= capCap) {
      decisions[s.idx]!.reason = "profile_cap";
      continue;
    }
    if (s.c.injectionTokens > remainingBudget) {
      decisions[s.idx]!.reason = "budget";
      continue;
    }
    // Accept.
    decisions[s.idx]!.action = "inject";
    decisions[s.idx]!.reason = "positive_roi";
    capabilityCounts.set(cap, usedCap + 1);
    remainingBudget -= s.c.injectionTokens;
    injectedTokens += s.c.injectionTokens;
  }

  // Build the index + summary.
  const byCandidateId: Record<string, ServingDecision> = {};
  const summary = emptySummary();
  for (const d of decisions) {
    byCandidateId[d.candidateId] = d;
    summary[d.capability][d.action]++;
  }

  return {
    decisions,
    byCandidateId,
    summary,
    injectedTokens,
    remainingBudget,
  };
}

/**
 * Score a single candidate per the contract in the module header.
 * Exported for unit tests and the C5 dashboard ("what would the
 * arbiter score this candidate at if we re-ran it now").
 */
export function scoreCandidate(c: ServingCandidate): number {
  const clampedProb = clamp01(c.calibratedHelpfulProb);
  const upside = clampedProb * Math.max(0, c.estimatedAvoidedTokens);
  const cost =
    Math.max(0, c.injectionTokens) +
    Math.max(0, c.noisePenalty) +
    Math.max(0, c.freshnessPenalty);
  return upside - cost;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function emptySummary(): ArbitrationResult["summary"] {
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

// ---------------------------------------------------------------------------
// Conservative-prior helpers — capability defaults until the
// calibrator has enough data to override.
// ---------------------------------------------------------------------------

/**
 * Conservative cold-start P(helpful) per capability, used when the
 * calibrator has too few (score, outcome) pairs to fit. These
 * intentionally sit below 0.5 — the directive's "conservative priors
 * by capability, not optimistic constants". They get OVERRIDDEN by
 * real calibrator output as soon as enough data lands.
 *
 * The numbers are picked so the cost-saver profile rejects on
 * cold-start unless `estimatedAvoidedTokens` is several × the
 * injection cost — i.e. only inject when the upside is obvious.
 */
export const CONSERVATIVE_COLD_START_PROB: Record<Capability, number> = {
  reasoning_reuse: 0.35,
  file_memory: 0.30,
  loop_redirect: 0.55, // higher because it's a recovery action with bounded cost
  tool_supervision: 0.50,
  context_fold: 0.40,
  context_pruning: 0.45,
};
