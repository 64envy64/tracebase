/**
 * Contextual bandit — May-2026 B2.
 *
 * Wraps the global Thompson Sampling state from `weights.ts` with a
 * hierarchical empirical-Bayes layer keyed on query context
 * `(language, framework, errorType)`. The right weight vector for a
 * `(python, _, TypeError)` query is rarely the right one for a
 * `(rust, _, lifetime)` query — but learning per-bucket from scratch
 * starves under-sampled buckets. Empirical Bayes splits the
 * difference: a new bucket samples from the global posterior; a
 * heavily-observed bucket dominates its own data.
 *
 * Scope — honest statement of what this learns (B2.1 RC review)
 * ---------------------------------------------------------------
 * The contextual bandit drives the V1 5-signal weighted combination
 * in `engine.ts:recall*`. Updates flow through `ReasoningLayer.feedback`
 * which routes to `updateContextualWeights`. That covers:
 *
 *   • CLI: `tracebase recall` + `tracebase feedback`
 *   • SDK middleware: OpenAI / Anthropic auto-feedback paths
 *   • MCP `recall` + `feedback` tools (V1 surfaces)
 *
 * It does NOT learn from the V2 cascade arm. V2 retrieval uses BM25
 * + reranker + isotonic calibrator — those have their own quality
 * lever (the calibrator fitted from `injection` / `agent_used` /
 * `outcome` events). Cascade rollout improves V2 ranking; the
 * contextual bandit improves V1 ranking. Two systems, two layers.
 *
 * Operational consequence: a project that runs traffic only through
 * the contextual MCP runtime (`get_reasoning_patterns` →
 * `record_reasoning_outcome`, the cascade path) will accumulate
 * cascade telemetry but will NOT shift the bandit weights. To
 * exercise B2 you need V1 feedback to flow.
 *
 * Global prior drift caveat
 * -------------------------
 * `updateContextualWeights` bumps BOTH the bucket-local counters
 * AND the global posterior on every call. If one bucket dominates
 * traffic (e.g., 99% of feedback is Python projects), the global
 * posterior reflects that bucket — not a uniform cross-bucket
 * average. Cold-start buckets then inherit a Python-biased prior.
 *
 * This is intentional: freezing the global at install-time defaults
 * would let it never learn. But for installs with a single
 * dominant bucket, consider treating bucket means as the
 * authoritative ranker and ignoring the global drift; the
 * `tracebase explain` view exposes both so the operator can spot
 * disagreement.
 *
 * Sampling formula (per signal `s`, per bucket `b`):
 *   α_eff = κ · m_s + α_obs_{s,b}
 *   β_eff = κ · (1 − m_s) + β_obs_{s,b}
 *   weight_{s,b} ~ Beta(α_eff, β_eff)
 *
 * where:
 *   m_s = global posterior mean for signal s (from AdaptiveWeightState)
 *   κ   = prior strength — defaults to 10. With κ=10 the global prior
 *         dominates until ~10 bucket-specific observations accumulate.
 *   α_obs, β_obs are the BUCKET-LOCAL raw observation counters,
 *         initialised to 0 and bumped by `helpful` / `not-helpful`
 *         feedback the same way the global state is.
 *
 * Two properties this gives us, both load-bearing:
 *
 *   1. Cold-start safety. A brand-new bucket (zero observations)
 *      effectively samples Beta(κ·m, κ·(1−m)) — same mean as the
 *      global prior, tighter spread than the global posterior. The
 *      ranker behaviour for an unseen language is "what the global
 *      model thinks on average", not garbage.
 *
 *   2. Per-context divergence on real evidence. After hundreds of
 *      bucket-local observations, α_obs ≫ κ and the global term
 *      becomes a small bias correction. The bucket's posterior is
 *      what's actually used.
 *
 * The policyId on retrieval events stays "linear.ts.v1" — the
 * sampling algorithm hasn't changed. What changed is the prior, and
 * the bucket key is stamped on the event so off-policy replay knows
 * which posterior was active. Anything more aggressive (renaming
 * the policy) would break every existing test that pins on the
 * literal version string for no semantic gain.
 *
 * Pure math; persistence lives at the engine driver layer the same
 * way weights.ts works.
 *
 * Ref: Efron & Morris (1973) — Stein-style shrinkage in empirical Bayes.
 * Ref: Riquelme, Tucker & Snoek (2018) — Bayesian contextual bandits.
 */

import type Database from "better-sqlite3";
import type {
  AdaptiveWeightState,
  BetaParams,
  SimilaritySignals,
} from "../types.js";
import {
  computeWeightsMean,
  loadWeightState,
  saveWeightState,
  type SignalWeights,
} from "./weights.js";

/**
 * Per-signal raw observation counters. Stored EXCLUDING the κ·mean
 * prior — the prior is applied at sample time so updates to the
 * global posterior automatically flow into every bucket without a
 * rewrite step.
 */
export interface BucketObservations {
  bm25: { alphaObs: number; betaObs: number };
  jaccard: { alphaObs: number; betaObs: number };
  structural: { alphaObs: number; betaObs: number };
  cosine: { alphaObs: number; betaObs: number };
  freshness: { alphaObs: number; betaObs: number };
  feedbackCount: number;
  updatedAt: number;
}

/** A normalized context bucket identifier. */
export type BucketKey = string;

/** Free-form context features the engine extracts from the query. */
export interface BucketContext {
  language?: string;
  framework?: string;
  errorType?: string;
}

/**
 * Top-level contextual state. The global Beta posteriors live in
 * `weights.ts` for back-compat — this state just adds the bucket
 * layer on top.
 */
export interface ContextualWeightState {
  /** Buckets keyed by `bucketKeyFor(context)`. */
  buckets: Record<BucketKey, BucketObservations>;
  /** When the last bucket update landed. */
  updatedAt: number;
  /** Total per-bucket feedback events landed across all buckets. */
  totalBucketFeedback: number;
}

/** Default prior strength. */
export const DEFAULT_BUCKET_STRENGTH = 10;

/** Sentinel for an unset context dimension. Kept short for storage. */
const ANY = "_";

const CONFIG_KEY = "contextual_weights";

const DEFAULT_STATE: ContextualWeightState = {
  buckets: {},
  updatedAt: 0,
  totalBucketFeedback: 0,
};

/**
 * Normalize a context into a deterministic bucket key. Case-insensitive;
 * missing fields collapse to a single sentinel so distinct
 * "no-language" queries share a bucket. Result format:
 *
 *   `<language>|<framework>|<errorType>`
 *
 * with each component lowercased + whitespace-trimmed or set to `_`.
 */
export function bucketKeyFor(ctx: BucketContext | undefined): BucketKey {
  const norm = (v: string | undefined) => {
    if (!v) return ANY;
    const t = v.trim().toLowerCase();
    return t.length === 0 ? ANY : t;
  };
  return `${norm(ctx?.language)}|${norm(ctx?.framework)}|${norm(ctx?.errorType)}`;
}

/**
 * Load contextual state from the same config table the global state
 * uses. Returns the default empty state on any failure — there is no
 * "contextual state required" path; new installs start with no
 * buckets and behave identically to pre-B2.
 */
export function loadContextualState(db: Database.Database): ContextualWeightState {
  try {
    const row = db
      .prepare("SELECT value FROM config WHERE key = ?")
      .get(CONFIG_KEY) as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<ContextualWeightState>;
      return {
        buckets: parsed.buckets ?? {},
        updatedAt: parsed.updatedAt ?? 0,
        totalBucketFeedback: parsed.totalBucketFeedback ?? 0,
      };
    }
  } catch {
    // config table not initialised yet — fall through
  }
  return { ...DEFAULT_STATE, buckets: {} };
}

export function saveContextualState(
  db: Database.Database,
  state: ContextualWeightState,
): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    CONFIG_KEY,
    JSON.stringify(state),
  );
}

/** Build a fresh BucketObservations with all counters at zero. */
function emptyBucket(): BucketObservations {
  return {
    bm25: { alphaObs: 0, betaObs: 0 },
    jaccard: { alphaObs: 0, betaObs: 0 },
    structural: { alphaObs: 0, betaObs: 0 },
    cosine: { alphaObs: 0, betaObs: 0 },
    freshness: { alphaObs: 0, betaObs: 0 },
    feedbackCount: 0,
    updatedAt: 0,
  };
}

/**
 * Compute the effective `(α_eff, β_eff)` for one signal in one bucket.
 *
 *   α_eff = strength · m + α_obs
 *   β_eff = strength · (1 − m) + β_obs
 *
 * where `m` is the global posterior mean for that signal. New buckets
 * (zero observations) sample from `Beta(strength·m, strength·(1−m))`,
 * identical expected value as the global prior. Heavily-observed
 * buckets dominate via `α_obs ≫ strength`.
 */
function effectiveBeta(
  globalMean: number,
  obs: { alphaObs: number; betaObs: number },
  strength: number,
): BetaParams {
  return {
    alpha: strength * globalMean + obs.alphaObs,
    beta: strength * (1 - globalMean) + obs.betaObs,
  };
}

export interface SampleContextualOptions {
  /** Empirical-Bayes prior strength κ. Defaults to DEFAULT_BUCKET_STRENGTH. */
  strength?: number;
  /** Whether the cosine signal participates. */
  hasEmbeddings?: boolean;
  /** Uniform [0, 1) RNG. Defaults to Math.random. */
  rng?: () => number;
}

/**
 * Draw a contextual Thompson sample. Falls back to the global
 * posterior for unrecognised buckets (zero observations); diverges
 * smoothly as bucket data accumulates.
 *
 * Returns the normalized weight vector exactly as `sampleWeights`
 * would — the caller can drop this in wherever sampleWeights was used.
 */
export function sampleContextualWeights(
  globalState: AdaptiveWeightState,
  contextual: ContextualWeightState,
  context: BucketContext | undefined,
  opts: SampleContextualOptions = {},
): SignalWeights {
  const strength = opts.strength ?? DEFAULT_BUCKET_STRENGTH;
  const hasEmbeddings = opts.hasEmbeddings ?? false;
  const rng = opts.rng ?? Math.random;

  const bucket = contextual.buckets[bucketKeyFor(context)] ?? emptyBucket();
  const means = computeWeightsMean(globalState, /*hasEmbeddings*/ true);

  const sBm25 = sampleBeta(
    effectiveBeta(means.bm25, bucket.bm25, strength),
    rng,
  );
  const sJaccard = sampleBeta(
    effectiveBeta(means.jaccard, bucket.jaccard, strength),
    rng,
  );
  const sStructural = sampleBeta(
    effectiveBeta(means.structural, bucket.structural, strength),
    rng,
  );
  const sCosine = hasEmbeddings
    ? sampleBeta(effectiveBeta(means.cosine, bucket.cosine, strength), rng)
    : 0;
  const sFreshness = sampleBeta(
    effectiveBeta(means.freshness, bucket.freshness, strength),
    rng,
  );

  return renormalize(sBm25, sJaccard, sStructural, sCosine, sFreshness, hasEmbeddings);
}

/**
 * Deterministic contextual mean — same shape as `computeWeightsMean`
 * but evaluated at the bucket's effective posterior mean rather than
 * the global one. Used by diagnostics (`explain`-style surfaces); the
 * recall path uses `sampleContextualWeights`.
 */
export function meanContextualWeights(
  globalState: AdaptiveWeightState,
  contextual: ContextualWeightState,
  context: BucketContext | undefined,
  opts: { strength?: number; hasEmbeddings?: boolean } = {},
): SignalWeights {
  const strength = opts.strength ?? DEFAULT_BUCKET_STRENGTH;
  const hasEmbeddings = opts.hasEmbeddings ?? false;
  const bucket = contextual.buckets[bucketKeyFor(context)] ?? emptyBucket();
  const means = computeWeightsMean(globalState, /*hasEmbeddings*/ true);

  const eff = (m: number, o: { alphaObs: number; betaObs: number }) => {
    const eb = effectiveBeta(m, o, strength);
    return eb.alpha / (eb.alpha + eb.beta);
  };
  const mBm25 = eff(means.bm25, bucket.bm25);
  const mJaccard = eff(means.jaccard, bucket.jaccard);
  const mStructural = eff(means.structural, bucket.structural);
  const mCosine = hasEmbeddings ? eff(means.cosine, bucket.cosine) : 0;
  const mFreshness = eff(means.freshness, bucket.freshness);
  return renormalize(mBm25, mJaccard, mStructural, mCosine, mFreshness, hasEmbeddings);
}

/**
 * Apply feedback to the contextual layer.
 *
 * Updates BOTH:
 *   1. The bucket-local observation counters (so the bucket diverges
 *      from the global prior as evidence accumulates).
 *   2. The global AdaptiveWeightState (so the prior `m` evolves with
 *      cross-bucket evidence — a signal that's globally helpful
 *      should keep nudging the global mean for new buckets to
 *      inherit, not stay frozen at the install-time defaults).
 *
 * Both writes persist. Cross-bucket coherence is the reason we keep
 * the global state evolving alongside the buckets rather than
 * freezing it at first launch.
 */
export function updateContextualWeights(
  db: Database.Database,
  globalState: AdaptiveWeightState,
  contextual: ContextualWeightState,
  context: BucketContext | undefined,
  signals: SimilaritySignals,
  helpful: boolean,
): { global: AdaptiveWeightState; contextual: ContextualWeightState } {
  // 1. Update global state in the same shape as `updateWeights` in
  //    weights.ts. We inline the math here so the caller doesn't need
  //    to chain two writes; the persistence boundary stays one helper.
  const sigs: Array<[keyof Pick<AdaptiveWeightState, "bm25" | "jaccard" | "structural" | "cosine" | "freshness">, number]> = [
    ["bm25", signals.bm25],
    ["jaccard", signals.jaccard],
    ["structural", signals.structural],
    ["cosine", signals.cosine],
    ["freshness", signals.freshness],
  ];
  for (const [signal, contribution] of sigs) {
    if (contribution <= 0) continue;
    if (helpful) globalState[signal].alpha += contribution;
    else globalState[signal].beta += contribution;
  }
  globalState.feedbackCount += 1;
  globalState.updatedAt = Date.now();
  saveWeightState(db, globalState);

  // 2. Update the per-bucket observation counters.
  const key = bucketKeyFor(context);
  const bucket = contextual.buckets[key] ?? emptyBucket();
  for (const [signal, contribution] of sigs) {
    if (contribution <= 0) continue;
    if (helpful) bucket[signal].alphaObs += contribution;
    else bucket[signal].betaObs += contribution;
  }
  bucket.feedbackCount += 1;
  bucket.updatedAt = Date.now();
  contextual.buckets[key] = bucket;
  contextual.updatedAt = bucket.updatedAt;
  contextual.totalBucketFeedback += 1;
  saveContextualState(db, contextual);

  return { global: globalState, contextual };
}

/** Combined loader for the engine's recall path. */
export function loadContextualBandit(db: Database.Database): {
  global: AdaptiveWeightState;
  contextual: ContextualWeightState;
} {
  return {
    global: loadWeightState(db),
    contextual: loadContextualState(db),
  };
}

// ----------------------------------------------------------------------------
// Beta sampling primitives — copied locally rather than exported from
// weights.ts so the modules stay decoupled. Marsaglia-Tsang gamma trick;
// see weights.ts for the canonical reference + tuning notes.
// ----------------------------------------------------------------------------

function sampleBeta(params: BetaParams, rng: () => number): number {
  const x = sampleGamma(params.alpha, rng);
  const y = sampleGamma(params.beta, rng);
  if (x + y === 0) return 0.5;
  return x / (x + y);
}

function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    const u = rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u === 0 ? Number.MIN_VALUE : u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 1000; i++) {
    const x = sampleNormal(rng);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return shape;
}

function sampleNormal(rng: () => number): number {
  const u1 = rng() || Number.MIN_VALUE;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
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
