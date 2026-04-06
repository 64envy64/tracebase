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
// Two-stage retrieval (Bruch et al. 2023):
//   Stage 1: Candidate generation — fingerprint, FTS5, pre-filter
//   Stage 2: Re-ranking — Jaccard, structural, cosine (when available)
//
// Signal combination uses adaptive weights learned from feedback via
// Thompson Sampling (see weights.ts). All scores clamped to [0, 1].
// ============================================================================

const DEFAULT_WEIGHTS: SignalWeights = {
  bm25: 0.50,
  jaccard: 0.30,
  structural: 0.20,
  cosine: 0,
};

/**
 * Find the most relevant past traces for a given query.
 *
 * @param store         The trace store
 * @param query         What to search for
 * @param weights       Learned signal weights
 * @param cosineScores  Optional precomputed cosine similarities (traceId → score).
 *                      Populated by engine.recallAsync() when embeddings are available.
 */
export function recall(
  store: TraceStore,
  query: RecallQuery,
  weights: SignalWeights = DEFAULT_WEIGHTS,
  cosineScores?: Map<string, number>,
): RecallResult[] {
  const limit = query.limit ?? 5;
  const minScore = query.minScore ?? 0.1;

  // Step 1: Fingerprint the query
  const queryFp = fingerprint(query.problem, {
    filePath: query.context?.filePath,
    language: query.context?.language,
    framework: query.context?.framework,
    errorType: query.context?.errorType,
  });

  // Step 2: Collect candidates from multiple sources
  const candidateMap = new Map<string, CandidateScore>();
  const fetchLimit = limit * 4;

  // 2a: Exact fingerprint matches
  const exactMatches = store.getByFingerprint(queryFp.hash, limit);
  for (const cached of exactMatches) {
    candidateMap.set(cached.trace.id, makeCandidateFromCached(cached, 1.0));
  }

  // 2b: FTS5 full-text search with BM25
  const ftsResults = store.searchFts(query.problem, fetchLimit);
  if (ftsResults.length > 0) {
    const rawScores = ftsResults.map((r) => Math.log1p(Math.abs(r.rank)));
    const maxLog = Math.max(...rawScores);

    for (let i = 0; i < ftsResults.length; i++) {
      const { trace, cachedTokens, cachedFeatures } = ftsResults[i]!;
      const normalized = maxLog > 0 ? rawScores[i]! / maxLog : 0;

      if (!candidateMap.has(trace.id)) {
        candidateMap.set(trace.id, makeCandidateFromCached(
          { trace, cachedTokens, cachedFeatures }, 0,
        ));
      }
      candidateMap.get(trace.id)!.signals.bm25 = normalized;
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
      if (cosine < 0.3) continue; // only high-similarity candidates
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
  for (const candidate of candidateMap.values()) {
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

    candidate.signals.jaccard = jaccardSimilarity(queryFp.tokens, traceTokens);
    candidate.signals.structural = structuralSimilarity(queryFp.features, traceFeatures);

    // Cosine from precomputed map (may already be set from 2d)
    if (cosineScores && !candidate.signals.cosine) {
      candidate.signals.cosine = cosineScores.get(candidate.trace.id) ?? 0;
    }
  }

  // Step 4: Compute final weighted scores
  const results: RecallResult[] = [];

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
        s.bm25 * weights.bm25 +
        s.jaccard * weights.jaccard +
        s.structural * weights.structural +
        s.cosine * weights.cosine;

      matchType = score > 0.5 ? "similar" : "related";
    }

    // Quality adjustment: 0.85–1.15 multiplier
    const qualityMult = 0.85 + candidate.trace.quality.score * 0.30;
    score *= qualityMult;

    // Clamp to [0, 1]
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

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
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
    },
  };
}
