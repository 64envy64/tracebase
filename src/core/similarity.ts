import type { RecallQuery, RecallResult, SimilaritySignals } from "../types.js";
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
// Architecture (two-stage retrieval, per Bruch et al. 2023):
//   Stage 1: Candidate generation (fast, broad)
//     - Exact fingerprint lookup (O(1) index)
//     - FTS5 full-text search (BM25, O(log n))
//     - Pre-filtered SQL by language/framework/errorType
//   Stage 2: Re-ranking (precise, narrow)
//     - Jaccard token similarity (from cached tokens — no recompute)
//     - Structural feature matching (from cached features — no recompute)
//     - Quality-adjusted final score
//
// Signal combination uses adaptive weights learned from feedback
// via Thompson Sampling (see weights.ts).
//
// All scores are clamped to [0, 1] before return.
// ============================================================================

/** Default weights when no adaptive state is available. */
const DEFAULT_WEIGHTS: SignalWeights = {
  bm25: 0.50,
  jaccard: 0.30,
  structural: 0.20,
};

/**
 * Find the most relevant past traces for a given query.
 * This is the core recall algorithm.
 *
 * @param store   The trace store
 * @param query   What to search for
 * @param weights Learned signal weights (from Thompson Sampling)
 */
export function recall(
  store: TraceStore,
  query: RecallQuery,
  weights: SignalWeights = DEFAULT_WEIGHTS,
): RecallResult[] {
  const limit = query.limit ?? 5;
  const minScore = query.minScore ?? 0.1;

  // Step 1: Fingerprint the query (computed once)
  const queryFp = fingerprint(query.problem, {
    filePath: query.context?.filePath,
    language: query.context?.language,
    framework: query.context?.framework,
    errorType: query.context?.errorType,
  });

  // Step 2: Collect candidates from multiple sources (Stage 1 retrieval)
  const candidateMap = new Map<string, CandidateScore>();
  const fetchLimit = limit * 4; // Overfetch for re-ranking headroom

  // 2a: Exact fingerprint matches (highest confidence, O(1))
  const exactMatches = store.getByFingerprint(queryFp.hash, limit);
  for (const cached of exactMatches) {
    candidateMap.set(cached.trace.id, {
      trace: cached.trace,
      cachedTokens: cached.cachedTokens,
      cachedFeatures: cached.cachedFeatures,
      signals: { fingerprint: 1.0, bm25: 0, jaccard: 0, structural: 0, cosine: 0 },
    });
  }

  // 2b: FTS5 full-text search with BM25
  const ftsResults = store.searchFts(query.problem, fetchLimit);
  if (ftsResults.length > 0) {
    // BM25 normalization: log-transform for stable scaling.
    // FTS5 bm25() returns negative values (more negative = better).
    // We convert to positive and apply log1p for diminishing returns,
    // then normalize to [0, 1] within the result set.
    const rawScores = ftsResults.map((r) => Math.log1p(Math.abs(r.rank)));
    const maxLog = Math.max(...rawScores);

    for (let i = 0; i < ftsResults.length; i++) {
      const { trace, cachedTokens, cachedFeatures } = ftsResults[i]!;
      const normalized = maxLog > 0 ? rawScores[i]! / maxLog : 0;

      if (!candidateMap.has(trace.id)) {
        candidateMap.set(trace.id, {
          trace,
          cachedTokens,
          cachedFeatures,
          signals: { fingerprint: 0, bm25: 0, jaccard: 0, structural: 0, cosine: 0 },
        });
      }
      candidateMap.get(trace.id)!.signals.bm25 = normalized;
    }
  }

  // 2c: Pre-filtered candidates if context specifies structural filters
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
        candidateMap.set(cached.trace.id, {
          trace: cached.trace,
          cachedTokens: cached.cachedTokens,
          cachedFeatures: cached.cachedFeatures,
          signals: { fingerprint: 0, bm25: 0, jaccard: 0, structural: 0, cosine: 0 },
        });
      }
    }
  }

  // Step 3: Re-rank all candidates with fine-grained similarity (Stage 2)
  for (const candidate of candidateMap.values()) {
    // Use cached tokens/features when available; fall back to recomputing
    const traceTokens = candidate.cachedTokens ?? fingerprint(
      candidate.trace.problem.description,
      {
        filePath: candidate.trace.problem.filePath,
        language: candidate.trace.problem.language,
        framework: candidate.trace.problem.framework,
        errorType: candidate.trace.problem.errorType,
      },
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
        ).features;

    // Jaccard token similarity
    candidate.signals.jaccard = jaccardSimilarity(queryFp.tokens, traceTokens);

    // Structural feature similarity
    candidate.signals.structural = structuralSimilarity(queryFp.features, traceFeatures);
  }

  // Step 4: Compute final weighted scores
  const results: RecallResult[] = [];

  for (const candidate of candidateMap.values()) {
    const s = candidate.signals;
    let score: number;
    let matchType: RecallResult["matchType"];

    if (s.fingerprint === 1.0) {
      // Exact fingerprint match — highest confidence
      score = 1.0;
      matchType = "exact";
    } else {
      // Weighted combination of non-fingerprint signals
      // Weights are normalized (sum to 1.0), so score is naturally in [0, 1]
      score =
        s.bm25 * weights.bm25 +
        s.jaccard * weights.jaccard +
        s.structural * weights.structural;

      matchType = score > 0.5 ? "similar" : "related";
    }

    // Quality adjustment: mild boost/penalty based on track record
    // Maps quality 0.0–1.0 → multiplier 0.85–1.15 (narrower than before)
    const qualityMult = 0.85 + candidate.trace.quality.score * 0.30;
    score *= qualityMult;

    // Clamp to [0, 1] — documented contract
    score = Math.max(0, Math.min(1, score));

    if (score >= minScore) {
      results.push({
        trace: candidate.trace,
        score,
        matchType,
        signals: { ...s },
      });
    }
  }

  // Sort by score descending, limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Cosine similarity between two vectors.
 * Used when embeddings are available.
 */
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

interface CandidateScore {
  trace: CachedTraceRow["trace"];
  cachedTokens?: string[];
  cachedFeatures?: Record<string, unknown>;
  signals: SimilaritySignals;
}
