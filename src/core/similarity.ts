import type {
  RecallQuery,
  RecallResult,
  SimilaritySignals,
  SimilarityConfig,
  FeatureConfig,
} from "../types.js";
import type { TraceStore, CachedTraceRow } from "./store.js";
import type { SignalWeights } from "./weights.js";
import {
  fingerprint,
  jaccardSimilarity,
  structuralSimilarity,
  type ExtractedFeatures,
} from "./fingerprint.js";

// ============================================================================
// Similarity Engine — Multi-Signal Recall
//
// Two-stage retrieval (Bruch et al. 2023):
//   Stage 1: Candidate generation — fingerprint, FTS5, pre-filter
//   Stage 2: Re-ranking — Jaccard, structural, cosine (when available)
//
// Signal combination uses adaptive weights learned from feedback via
// Thompson Sampling (see weights.ts). All scores clamped to [0, 1].
//
// BM25 normalization uses saturation function (Robertson & Zaragoza, 2009):
//   normalized = score / (score + k)
// This maps unbounded FTS5 scores to [0, 1] with proper diminishing returns.
// ============================================================================

const DEFAULT_WEIGHTS: SignalWeights = {
  bm25: 0.40,
  jaccard: 0.25,
  structural: 0.15,
  cosine: 0,
  freshness: 0.20,
};

/** Default similarity config — all values documented and tunable. */
const DEFAULT_SIMILARITY_CONFIG = {
  cosineThreshold: 0.3,
  qualityMultiplierRange: [0.85, 1.15] as [number, number],
  similarThreshold: 0.5,
  candidateMultiplier: 4,
  freshnessHalfLifeDays: 30,
  bm25Normalization: "query-level" as const,
  bm25SaturationK: 1.5,
};

/**
 * Exponential time decay for temporal freshness signal.
 * Ref: Li & Croft (2003) "Time-based language models" —
 *      exponential decay with half-life parameter.
 *
 * f(t) = exp(-ln(2) * ageDays / halfLifeDays)
 *
 * Properties:
 *   - f(0) = 1.0 (just created)
 *   - f(halfLife) = 0.5
 *   - f(2*halfLife) = 0.25
 *   - Never reaches 0 (asymptotic decay)
 */
const LN2 = Math.LN2; // 0.693147...

/**
 * Find the most relevant past traces for a given query.
 *
 * @param store         The trace store
 * @param query         What to search for
 * @param weights       Learned signal weights (from Thompson Sampling)
 * @param cosineScores  Optional precomputed cosine similarities (traceId → score).
 *                      Populated by engine.recallAsync() when embeddings are available.
 * @param config        Similarity engine configuration (thresholds, etc.)
 * @param featureConfig Feature extraction configuration (custom extractors, weights)
 */
/**
 * Variant of `recall()` that also returns the full scored candidate
 * set BEFORE the `minScore` filter and `limit` slice. Required by the
 * trace_retrieval event log (May-2026 PR 1, review P2 #2) — off-policy
 * screening needs the full slate context, not just the top-K survivors.
 *
 * `allCandidates` is sorted by score descending. `results` is what
 * `recall()` would have returned (post-filter, post-slice).
 */
export interface RecallWithAllCandidatesResult {
  results: RecallResult[];
  allCandidates: RecallResult[];
}

export function recallWithAllCandidates(
  store: TraceStore,
  query: RecallQuery,
  weights: SignalWeights = DEFAULT_WEIGHTS,
  cosineScores?: Map<string, number>,
  config?: SimilarityConfig,
  featureConfig?: FeatureConfig,
): RecallWithAllCandidatesResult {
  return recallImpl(store, query, weights, cosineScores, config, featureConfig);
}

export function recall(
  store: TraceStore,
  query: RecallQuery,
  weights: SignalWeights = DEFAULT_WEIGHTS,
  cosineScores?: Map<string, number>,
  config?: SimilarityConfig,
  featureConfig?: FeatureConfig,
): RecallResult[] {
  return recallImpl(store, query, weights, cosineScores, config, featureConfig).results;
}

function recallImpl(
  store: TraceStore,
  query: RecallQuery,
  weights: SignalWeights = DEFAULT_WEIGHTS,
  cosineScores?: Map<string, number>,
  config?: SimilarityConfig,
  featureConfig?: FeatureConfig,
): RecallWithAllCandidatesResult {
  const limit = query.limit ?? 5;
  const minScore = query.minScore ?? 0.1;
  const simConfig = resolveConfig(config);

  // Step 1: Fingerprint the query
  const queryFp = fingerprint(
    query.problem,
    {
      filePath: query.context?.filePath,
      language: query.context?.language,
      framework: query.context?.framework,
      errorType: query.context?.errorType,
    },
    featureConfig,
  );

  // Step 2: Collect candidates from multiple sources
  const candidateMap = new Map<string, CandidateScore>();
  const fetchLimit = limit * simConfig.candidateMultiplier;

  // 2a: Exact fingerprint matches
  const exactMatches = store.getByFingerprint(queryFp.hash, limit);
  for (const cached of exactMatches) {
    candidateMap.set(cached.trace.id, makeCandidateFromCached(cached, 1.0));
  }

  // 2b: FTS5 full-text search with BM25
  const ftsResults = store.searchFts(query.problem, fetchLimit);
  if (ftsResults.length > 0) {
    // Compute normalized BM25 scores based on configured strategy.
    // FTS5 rank is negative (more negative = better match), so we use abs values.
    const rawScores = ftsResults.map((r) => Math.abs(r.rank));
    const normalizedScores = normalizeBm25(rawScores, simConfig);

    for (let i = 0; i < ftsResults.length; i++) {
      const { trace, cachedTokens, cachedFeatures } = ftsResults[i]!;

      if (!candidateMap.has(trace.id)) {
        candidateMap.set(trace.id, makeCandidateFromCached(
          { trace, cachedTokens, cachedFeatures }, 0,
        ));
      }
      candidateMap.get(trace.id)!.signals.bm25 = normalizedScores[i]!;
    }
  }

  // 2c: Pre-filtered candidates by structural context
  if (query.context?.language || query.context?.framework || query.context?.errorType) {
    const filtered = store.getCandidatesFiltered(
      {
        language: query.context.language,
        framework: query.context.framework,
        errorType: query.context.errorType,
      },
      fetchLimit,
    );
    for (const cached of filtered) {
      if (!candidateMap.has(cached.trace.id)) {
        candidateMap.set(cached.trace.id, makeCandidateFromCached(cached, 0));
      }
    }
  }

  // 2d: If cosine scores are provided (from embeddings), add high-cosine candidates
  if (cosineScores) {
    for (const [traceId, cosine] of cosineScores) {
      if (cosine < simConfig.cosineThreshold) continue;
      const existing = candidateMap.get(traceId);
      if (existing) {
        existing.signals.cosine = cosine;
      }
      // Note: we don't add brand new candidates from cosine-only,
      // because we'd need the full trace object. The engine pre-filters
      // cosineScores to only include IDs already in the store.
    }
  }

  // Step 3: Re-rank with fine-grained similarity
  const structuralWeights = featureConfig?.structuralWeights;
  for (const candidate of candidateMap.values()) {
    const traceTokens = candidate.cachedTokens ?? fingerprint(
      candidate.trace.problem.description,
      {
        filePath: candidate.trace.problem.filePath,
        language: candidate.trace.problem.language,
        framework: candidate.trace.problem.framework,
        errorType: candidate.trace.problem.errorType,
      },
      featureConfig,
    ).tokens;

    const traceFeatures: ExtractedFeatures = candidate.cachedFeatures
      ? (candidate.cachedFeatures as unknown as ExtractedFeatures)
      : fingerprint(
          candidate.trace.problem.description,
          {
            filePath: candidate.trace.problem.filePath,
            language: candidate.trace.problem.language,
            framework: candidate.trace.problem.framework,
            errorType: candidate.trace.problem.errorType,
          },
          featureConfig,
        ).features;

    candidate.signals.jaccard = jaccardSimilarity(queryFp.tokens, traceTokens);
    candidate.signals.structural = structuralSimilarity(
      queryFp.features,
      traceFeatures,
      structuralWeights,
    );

    // Cosine from precomputed map (may already be set from 2d)
    if (cosineScores && !candidate.signals.cosine) {
      candidate.signals.cosine = cosineScores.get(candidate.trace.id) ?? 0;
    }

    // Temporal freshness: exponential decay from creation time
    const ageDays = (Date.now() - candidate.trace.createdAt) / (1000 * 60 * 60 * 24);
    candidate.signals.freshness = Math.exp(-LN2 * ageDays / simConfig.freshnessHalfLifeDays);
  }

  // Step 4: Compute final weighted scores.
  //
  // BM25 small-corpus damping (May-2026 PR 2): when the searchable
  // corpus is tiny, BM25 carries no real signal — every match looks
  // top-ranked by construction. Damp its contribution by `n/20` (up
  // to n=20) and redistribute the freed mass across the remaining
  // signals proportionally to their weights, so the unit total of
  // the linear combination is preserved.
  //
  // CRITICAL: `nEligible` is the count after hard filters but BEFORE
  // FTS match. A legitimately rare query that produces 2 FTS hits
  // against a 5000-row searchable corpus must NOT trip the damping
  // path — the corpus is plenty large, BM25 just happened to be
  // narrow this query.
  const nEligible = store.countEligible({
    language: query.context?.language,
    framework: query.context?.framework,
    errorType: query.context?.errorType,
  });
  const dampedWeights = applySmallCorpusDamping(weights, nEligible);

  const [qMin, qMax] = simConfig.qualityMultiplierRange;
  const qRange = qMax - qMin;
  const allCandidates: RecallResult[] = [];

  for (const candidate of candidateMap.values()) {
    const s = candidate.signals;
    let score: number;
    let matchType: RecallResult["matchType"];

    if (s.fingerprint === 1.0) {
      score = 1.0;
      matchType = "exact";
    } else {
      // Weighted combination — weights are normalized (sum to 1.0)
      score =
        s.bm25 * dampedWeights.bm25 +
        s.jaccard * dampedWeights.jaccard +
        s.structural * dampedWeights.structural +
        s.cosine * dampedWeights.cosine +
        s.freshness * dampedWeights.freshness;

      matchType = score > simConfig.similarThreshold ? "similar" : "related";
    }

    // Quality adjustment: configurable multiplier range
    const qualityMult = qMin + candidate.trace.quality.score * qRange;
    score *= qualityMult;

    // Clamp to [0, 1]
    score = Math.max(0, Math.min(1, score));

    // Push EVERY scored candidate into `allCandidates` regardless of
    // minScore — the OPE / replay-screening substrate needs the full
    // slate context for honest propensity estimation. The user-facing
    // `results` array is filtered + sliced below.
    allCandidates.push({
      trace: candidate.trace,
      score,
      matchType,
      signals: { ...s },
    });
  }

  allCandidates.sort((a, b) => b.score - a.score);
  const results = allCandidates
    .filter((r) => r.score >= minScore)
    .slice(0, limit);
  return { results, allCandidates };
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// ============================================================================
// Internal
// ============================================================================

function resolveConfig(overrides?: SimilarityConfig) {
  return {
    cosineThreshold: overrides?.cosineThreshold ?? DEFAULT_SIMILARITY_CONFIG.cosineThreshold,
    qualityMultiplierRange: overrides?.qualityMultiplierRange ?? DEFAULT_SIMILARITY_CONFIG.qualityMultiplierRange,
    similarThreshold: overrides?.similarThreshold ?? DEFAULT_SIMILARITY_CONFIG.similarThreshold,
    candidateMultiplier: overrides?.candidateMultiplier ?? DEFAULT_SIMILARITY_CONFIG.candidateMultiplier,
    freshnessHalfLifeDays: overrides?.freshnessHalfLifeDays ?? DEFAULT_SIMILARITY_CONFIG.freshnessHalfLifeDays,
    bm25Normalization: overrides?.bm25Normalization ?? DEFAULT_SIMILARITY_CONFIG.bm25Normalization,
    bm25SaturationK: overrides?.bm25SaturationK ?? DEFAULT_SIMILARITY_CONFIG.bm25SaturationK,
  };
}

/**
 * Normalize raw BM25 scores to [0, 1] using the configured strategy.
 *
 * "query-level" (default):
 *   Ref: Zhai & Lafferty (2004) — query-level normalization.
 *   Divides each score by the batch maximum. Standard in multi-signal
 *   fusion (CombMNZ, LambdaMART, etc.). Works correctly for any corpus
 *   size including a single document.
 *
 * "saturation":
 *   Ref: Robertson & Zaragoza (2009) — BM25 saturation function.
 *   Uses score / (score + k) for absolute calibration. Best for large
 *   corpora where BM25 produces meaningful absolute scores.
 */
function normalizeBm25(
  rawScores: number[],
  config: ReturnType<typeof resolveConfig>,
): number[] {
  if (rawScores.length === 0) return [];

  if (config.bm25Normalization === "saturation") {
    const k = config.bm25SaturationK;
    return rawScores.map((s) => s / (s + k));
  }

  // Query-level normalization (default)
  const maxScore = Math.max(...rawScores);
  if (maxScore === 0) return rawScores.map(() => 0);
  return rawScores.map((s) => s / maxScore);
}

/**
 * Small-corpus damping with mass-preserving renormalization.
 *
 * Audit issue #4 — on a corpus of N < 20 traces, BM25 saturates near 1.0
 * for every match because there's nothing for it to discriminate
 * against. Naive remedy "scale BM25 down" collapses the total score,
 * making `similarThreshold` and `qualityMultiplier` behave erratically.
 *
 * Proper fix:
 *   damp        = min(1, nEligible / DAMPING_FLOOR)
 *   bm25_eff    = bm25_weight × damp
 *   freed_mass  = bm25_weight × (1 − damp)
 *   share other = freed_mass × (w_x / (jaccard + structural + cosine + freshness))
 *
 * The total weight still sums to 1, so downstream thresholds are
 * unchanged. The other signals get a bigger say specifically when
 * BM25 has nothing useful to add.
 *
 * Defaults: `DAMPING_FLOOR = 20`. Below n=20 BM25 is essentially noise;
 * the linear ramp from 0→1 over [0, 20] avoids a hard discontinuity that
 * would create cliff artefacts at the boundary.
 */
export const SMALL_CORPUS_DAMPING_FLOOR = 20;
/** @internal exported for tests; use via the recall path in production. */
export function applySmallCorpusDamping(
  weights: import("./weights.js").SignalWeights,
  nEligible: number,
): import("./weights.js").SignalWeights {
  if (nEligible >= SMALL_CORPUS_DAMPING_FLOOR) return weights;
  const damp = Math.max(0, Math.min(1, nEligible / SMALL_CORPUS_DAMPING_FLOOR));
  const bm25Eff = weights.bm25 * damp;
  const freed = weights.bm25 - bm25Eff; // ≥ 0
  const otherSum =
    weights.jaccard + weights.structural + weights.cosine + weights.freshness;
  if (otherSum === 0) {
    // No other signals carry weight — nothing to redistribute to.
    // Return the damped vector as-is; the renormalization is a no-op.
    return {
      bm25: bm25Eff,
      jaccard: weights.jaccard,
      structural: weights.structural,
      cosine: weights.cosine,
      freshness: weights.freshness,
    };
  }
  const share = freed / otherSum;
  return {
    bm25: bm25Eff,
    jaccard: weights.jaccard * (1 + share),
    structural: weights.structural * (1 + share),
    cosine: weights.cosine * (1 + share),
    freshness: weights.freshness * (1 + share),
  };
}

interface CandidateScore {
  trace: CachedTraceRow["trace"];
  cachedTokens?: string[];
  cachedFeatures?: Record<string, unknown>;
  signals: SimilaritySignals;
}

function makeCandidateFromCached(
  cached: CachedTraceRow,
  fingerprintScore: number,
): CandidateScore {
  return {
    trace: cached.trace,
    cachedTokens: cached.cachedTokens,
    cachedFeatures: cached.cachedFeatures,
    signals: {
      fingerprint: fingerprintScore,
      bm25: 0,
      jaccard: 0,
      structural: 0,
      cosine: 0,
      freshness: 0,
    },
  };
}
