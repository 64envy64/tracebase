import type Database from "better-sqlite3";
import type { AdaptiveWeightState, BetaParams, SimilaritySignals } from "../types.js";

// ============================================================================
// Adaptive Weight Learning via Thompson Sampling
//
// Each similarity signal (BM25, Jaccard, Structural, Cosine, Freshness) is
// modelled as a Bernoulli bandit arm with a Beta prior. When a recalled
// trace receives feedback:
//   - helpful=true:  alpha_s += contribution_s
//   - helpful=false: beta_s  += contribution_s
//
// Two readouts:
//   - `computeWeightsMean(state)`  — posterior means; used by `getWeights()`
//     and `explain` for deterministic diagnostics. NO exploration.
//   - `sampleWeights(state, ..., rng)` — draws one sample per signal from
//     the Beta posterior, normalizes, returns one weight vector PER CALL.
//     This is the actual Thompson Sampling — used by the recall path so
//     uncertain signals still get explored.
//
// Pre-May-2026 PR 2: `computeWeights` (now `computeWeightsMean`) was used
// at recall time, which effectively disabled exploration even though all
// the Beta machinery was in place. PR 2 corrects this without changing
// state representation — the same `(alpha, beta)` posteriors back both
// readouts.
//
// This module stays pure math. Event-log handling (deduplication of
// `(queryId, traceId)` pairs, ambiguous-feedback skipping) lives at the
// engine driver layer — see `ReasoningLayer.resolveFeedbackContext`.
//
// Ref: Thompson (1933); Agrawal & Goyal (2012) — provable regret bounds.
// Ref: Chapelle & Li (2011) — empirical effectiveness vs UCB1.
// Ref: Marsaglia & Tsang (2000) — gamma sampling via squeeze method
//      (`sampleGamma` below; Beta via the gamma-ratio identity).
// ============================================================================

const CONFIG_KEY = "adaptive_weights";

const DEFAULT_STATE: AdaptiveWeightState = {
  bm25: { alpha: 5, beta: 5 },       // mean=0.50
  jaccard: { alpha: 3, beta: 7 },     // mean=0.30
  structural: { alpha: 2, beta: 8 },  // mean=0.20
  cosine: { alpha: 4, beta: 6 },      // mean=0.40 (when embeddings enabled)
  freshness: { alpha: 2, beta: 8 },   // mean=0.20 (soft preference for recency)
  updatedAt: 0,
  feedbackCount: 0,
};

/** Resolved signal weights (posterior means, normalized). */
export interface SignalWeights {
  bm25: number;
  jaccard: number;
  structural: number;
  cosine: number;
  freshness: number;
}

/** Load learned weights from DB, or return defaults. */
export function loadWeightState(db: Database.Database): AdaptiveWeightState {
  try {
    const row = db
      .prepare("SELECT value FROM config WHERE key = ?")
      .get(CONFIG_KEY) as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<AdaptiveWeightState>;
      // Backward compat: add cosine/freshness if migrating from older state
      return {
        bm25: parsed.bm25 ?? DEFAULT_STATE.bm25,
        jaccard: parsed.jaccard ?? DEFAULT_STATE.jaccard,
        structural: parsed.structural ?? DEFAULT_STATE.structural,
        cosine: parsed.cosine ?? DEFAULT_STATE.cosine,
        freshness: parsed.freshness ?? DEFAULT_STATE.freshness,
        updatedAt: parsed.updatedAt ?? 0,
        feedbackCount: parsed.feedbackCount ?? 0,
      };
    }
  } catch {
    // Config table might not exist yet
  }
  return { ...DEFAULT_STATE };
}

/** Persist weight state to DB. */
export function saveWeightState(
  db: Database.Database,
  state: AdaptiveWeightState,
): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    CONFIG_KEY,
    JSON.stringify(state),
  );
}

/**
 * Posterior-mean weights — deterministic, no exploration.
 *
 * Use for diagnostics (`tracebase explain`), telemetry (`getWeights()`),
 * and any place a caller needs a stable answer to "what does the model
 * think the weight of signal X is, on average?". The actual recall path
 * uses `sampleWeights` instead so under-explored arms still get pulled.
 *
 * @param state         Current Beta parameters
 * @param hasEmbeddings Whether cosine signal is available.
 *                      If false, cosine weight is 0 and the rest
 *                      are re-normalized to sum to 1.
 */
export function computeWeightsMean(
  state: AdaptiveWeightState,
  hasEmbeddings = false,
): SignalWeights {
  const meanBm25 = posteriorMean(state.bm25);
  const meanJaccard = posteriorMean(state.jaccard);
  const meanStructural = posteriorMean(state.structural);
  const meanCosine = hasEmbeddings ? posteriorMean(state.cosine) : 0;
  const meanFreshness = posteriorMean(state.freshness);

  return renormalize(
    meanBm25,
    meanJaccard,
    meanStructural,
    meanCosine,
    meanFreshness,
    hasEmbeddings,
  );
}

/**
 * Thompson sample of the weight vector. Each signal's weight is drawn
 * independently from its own Beta posterior; the five draws are then
 * normalized to sum to 1. Repeated calls return different vectors
 * proportional to the posterior uncertainty.
 *
 * Two consequences for ranking:
 *  - Under-explored signals (low α+β) get noisier draws → more
 *    exploration. As α+β grows the draws concentrate near the mean.
 *  - Two queries on the same input may use slightly different weight
 *    vectors — that's the feature, not a bug. The retrieval event logs
 *    the actual draw so off-policy screening can replay deterministically.
 *
 * @param state          Current Beta parameters
 * @param hasEmbeddings  Whether cosine signal participates
 * @param rng            Uniform [0, 1) source. Defaults to `Math.random`.
 *                       Tests / OPE replay pass a seeded PRNG.
 */
export function sampleWeights(
  state: AdaptiveWeightState,
  hasEmbeddings = false,
  rng: () => number = Math.random,
): SignalWeights {
  const sBm25 = sampleBeta(state.bm25.alpha, state.bm25.beta, rng);
  const sJaccard = sampleBeta(state.jaccard.alpha, state.jaccard.beta, rng);
  const sStructural = sampleBeta(state.structural.alpha, state.structural.beta, rng);
  const sCosine = hasEmbeddings ? sampleBeta(state.cosine.alpha, state.cosine.beta, rng) : 0;
  const sFreshness = sampleBeta(state.freshness.alpha, state.freshness.beta, rng);

  return renormalize(sBm25, sJaccard, sStructural, sCosine, sFreshness, hasEmbeddings);
}

/**
 * Deterministic 32-bit-seeded PRNG. Mulberry32 — fast, sufficient
 * statistical quality for Monte Carlo / replay purposes. Used by the
 * V1 recall path to make each retrieval reproducible from its logged
 * `seed` field.
 *
 * Not cryptographically secure. Do not use for security tokens.
 */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0; // coerce to uint32
  return function () {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renormalize(
  bm25: number,
  jaccard: number,
  structural: number,
  cosine: number,
  freshness: number,
  hasEmbeddings: boolean,
): SignalWeights {
  const sum = bm25 + jaccard + structural + cosine + freshness;
  if (sum === 0) {
    // Pathological case: all draws were exactly zero. Fall back to
    // uniform across the active signals so the ranker still produces
    // a sensible ordering.
    const n = hasEmbeddings ? 5 : 4;
    return {
      bm25: 1 / n,
      jaccard: 1 / n,
      structural: 1 / n,
      cosine: hasEmbeddings ? 1 / n : 0,
      freshness: 1 / n,
    };
  }
  return {
    bm25: bm25 / sum,
    jaccard: jaccard / sum,
    structural: structural / sum,
    cosine: cosine / sum,
    freshness: freshness / sum,
  };
}

// ----------------------------------------------------------------------------
// Beta / gamma sampling primitives. Inline so the module stays self-contained
// — `simple-statistics` doesn't expose a seedable Beta and pulling in another
// dep for ~50 LOC of math would be overkill.
// ----------------------------------------------------------------------------

/**
 * Sample from Beta(α, β) via the gamma-ratio identity:
 *   X ~ Gamma(α, 1), Y ~ Gamma(β, 1)  ⇒  X / (X + Y) ~ Beta(α, β)
 */
function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  if (x + y === 0) return 0.5; // pathological; never happens in practice
  return x / (x + y);
}

/**
 * Sample from Gamma(shape, 1) via Marsaglia & Tsang (2000) squeeze method.
 * For shape < 1, lifts via Boost trick: G(shape) = G(shape + 1) · U^(1/shape).
 */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    const u = rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u === 0 ? Number.MIN_VALUE : u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // The loop is finite with probability 1; in practice 1–2 iterations.
  for (let i = 0; i < 1000; i++) {
    let x = sampleNormal(rng);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  // Fallback only reachable on a degenerate RNG. Return the mean of
  // Gamma(shape, 1), which equals `shape` — preserves invariants
  // downstream rather than NaN-propagating.
  return shape;
}

/** Standard normal via Box-Muller. */
function sampleNormal(rng: () => number): number {
  const u1 = rng() || Number.MIN_VALUE; // avoid log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Back-compat alias for `computeWeightsMean`. Kept so external callers
 * (`src/index.ts` public export, `cli/commands/explain.ts`) continue to
 * compile across the rename. Internal call sites use the new name.
 *
 * @deprecated since May-2026 PR 2 — prefer `computeWeightsMean` or
 *             `sampleWeights` depending on whether you want diagnostics
 *             or exploration. This alias may be removed in a future
 *             major version.
 */
export function computeWeights(
  state: AdaptiveWeightState,
  hasEmbeddings = false,
): SignalWeights {
  return computeWeightsMean(state, hasEmbeddings);
}

/**
 * Update weight state based on feedback.
 */
export function updateWeights(
  db: Database.Database,
  state: AdaptiveWeightState,
  signals: SimilaritySignals,
  helpful: boolean,
): AdaptiveWeightState {
  const updates: Array<[keyof Pick<AdaptiveWeightState, "bm25" | "jaccard" | "structural" | "cosine" | "freshness">, number]> = [
    ["bm25", signals.bm25],
    ["jaccard", signals.jaccard],
    ["structural", signals.structural],
    ["cosine", signals.cosine],
    ["freshness", signals.freshness],
  ];

  for (const [signal, contribution] of updates) {
    if (contribution <= 0) continue;
    if (helpful) {
      state[signal].alpha += contribution;
    } else {
      state[signal].beta += contribution;
    }
  }

  state.feedbackCount += 1;
  state.updatedAt = Date.now();

  saveWeightState(db, state);
  return state;
}

function posteriorMean(params: BetaParams): number {
  return params.alpha / (params.alpha + params.beta);
}
