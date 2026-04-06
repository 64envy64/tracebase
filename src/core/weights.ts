import type Database from "better-sqlite3";
import type { AdaptiveWeightState, BetaParams, SimilaritySignals } from "../types.js";

// ============================================================================
// Adaptive Weight Learning via Thompson Sampling
//
// Each similarity signal (BM25, Jaccard, Structural) is modeled as a Bernoulli
// bandit arm with a Beta prior. When a recalled trace receives feedback:
//   - helpful=true:  alpha_s += contribution_s (reward proportional to signal)
//   - helpful=false: beta_s  += contribution_s (penalty proportional to signal)
//
// Weights are the posterior means: w_s = alpha_s / (alpha_s + beta_s),
// normalized to sum to 1.
//
// Ref: Thompson (1933); Agrawal & Goyal (2012), "Analysis of Thompson Sampling
//      for the Multi-armed Bandit Problem" — provably optimal regret bounds.
// Ref: Chapelle & Li (2011), "An Empirical Evaluation of Thompson Sampling"
//      — practical effectiveness across diverse settings.
// ============================================================================

const CONFIG_KEY = "adaptive_weights";

/**
 * Default priors — encode our initial weight beliefs.
 * Prior strength ~10 means "roughly equivalent to 10 feedback observations."
 * This prevents wild swings early on while still adapting.
 *
 * Initial weights: BM25=0.50, Jaccard=0.30, Structural=0.20
 */
const DEFAULT_STATE: AdaptiveWeightState = {
  bm25: { alpha: 5, beta: 5 },       // mean=0.50
  jaccard: { alpha: 3, beta: 7 },     // mean=0.30
  structural: { alpha: 2, beta: 8 },  // mean=0.20
  updatedAt: 0,
  feedbackCount: 0,
};

/** Resolved signal weights (posterior means, normalized). */
export interface SignalWeights {
  bm25: number;
  jaccard: number;
  structural: number;
}

/** Load learned weights from DB, or return defaults. */
export function loadWeightState(db: Database.Database): AdaptiveWeightState {
  try {
    const row = db
      .prepare("SELECT value FROM config WHERE key = ?")
      .get(CONFIG_KEY) as { value: string } | undefined;
    if (row) {
      return JSON.parse(row.value) as AdaptiveWeightState;
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
 * Returns weights that sum to 1.0.
 */
export function computeWeights(state: AdaptiveWeightState): SignalWeights {
  const meanBm25 = posteriorMean(state.bm25);
  const meanJaccard = posteriorMean(state.jaccard);
  const meanStructural = posteriorMean(state.structural);

  const sum = meanBm25 + meanJaccard + meanStructural;

  // Guard against degenerate state (all zero)
  if (sum === 0) {
    return { bm25: 1 / 3, jaccard: 1 / 3, structural: 1 / 3 };
  }

  return {
    bm25: meanBm25 / sum,
    jaccard: meanJaccard / sum,
    structural: meanStructural / sum,
  };
}

/**
 * Update weight state based on feedback.
 *
 * @param state   Current Beta parameters
 * @param signals Per-signal contributions from the recall that received feedback
 * @param helpful Whether the user found the recall helpful
 * @returns Updated state (also saves to DB)
 */
export function updateWeights(
  db: Database.Database,
  state: AdaptiveWeightState,
  signals: SimilaritySignals,
  helpful: boolean,
): AdaptiveWeightState {
  // Only update for signals that actually contributed
  const updates: Array<[keyof Pick<AdaptiveWeightState, "bm25" | "jaccard" | "structural">, number]> = [
    ["bm25", signals.bm25],
    ["jaccard", signals.jaccard],
    ["structural", signals.structural],
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

/** Posterior mean of a Beta distribution: E[θ] = α / (α + β). */
function posteriorMean(params: BetaParams): number {
  return params.alpha / (params.alpha + params.beta);
}
