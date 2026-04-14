import type Database from "better-sqlite3";
import type { AdaptiveWeightState, BetaParams, SimilaritySignals } from "../types.js";

// ============================================================================
// Adaptive Weight Learning via Thompson Sampling
//
// Each similarity signal (BM25, Jaccard, Structural, Cosine) is modeled as a
// Bernoulli bandit arm with a Beta prior. When a recalled trace receives feedback:
//   - helpful=true:  alpha_s += contribution_s
//   - helpful=false: beta_s  += contribution_s
//
// Weights are the posterior means: w_s = alpha_s / (alpha_s + beta_s),
// normalized to sum to 1. Cosine is included only when embeddings are active.
//
// Ref: Thompson (1933); Agrawal & Goyal (2012) — provable regret bounds.
// Ref: Chapelle & Li (2011) — empirical effectiveness.
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
 * Compute normalized signal weights from Beta posteriors.
 *
 * @param state         Current Beta parameters
 * @param hasEmbeddings Whether cosine signal is available.
 *                      If false, cosine weight is 0 and the rest
 *                      are re-normalized to sum to 1.
 */
export function computeWeights(
  state: AdaptiveWeightState,
  hasEmbeddings = false,
): SignalWeights {
  const meanBm25 = posteriorMean(state.bm25);
  const meanJaccard = posteriorMean(state.jaccard);
  const meanStructural = posteriorMean(state.structural);
  const meanCosine = hasEmbeddings ? posteriorMean(state.cosine) : 0;
  const meanFreshness = posteriorMean(state.freshness);

  const sum = meanBm25 + meanJaccard + meanStructural + meanCosine + meanFreshness;

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
    bm25: meanBm25 / sum,
    jaccard: meanJaccard / sum,
    structural: meanStructural / sum,
    cosine: meanCosine / sum,
    freshness: meanFreshness / sum,
  };
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
