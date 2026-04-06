import type { RecallQuery, RecallResult, ReasoningTrace } from "../types.js";
import type { TraceStore } from "./store.js";
import {
  fingerprint,
  jaccardSimilarity,
  structuralSimilarity,
} from "./fingerprint.js";

// ============================================================================
// Similarity Engine
//
// Combines multiple matching strategies to find the best prior solutions:
// 1. Exact fingerprint match (fastest — O(1) index lookup)
// 2. FTS5 full-text search with BM25 ranking (fast — FTS index)
// 3. Token-based Jaccard similarity (moderate — scans candidates)
// 4. Structural feature similarity (cheap post-filter)
// 5. Optional vector cosine similarity (when embeddings available)
//
// Final score = weighted combination, quality-adjusted.
// ============================================================================

/** Weights for combining different similarity signals. */
const WEIGHTS = {
  fingerprint: 1.0,   // Exact match gets full score
  bm25: 0.5,          // BM25 normalized score weight
  jaccard: 0.3,       // Token Jaccard weight
  structural: 0.2,    // Feature match weight
  cosine: 0.6,        // Vector similarity (when available)
} as const;

/** Configuration for similarity search. */
export interface SimilarityConfig {
  /** Enable vector similarity if embeddings available */
  useEmbeddings: boolean;
  /** Custom weight overrides */
  weights?: Partial<typeof WEIGHTS>;
}

const DEFAULT_CONFIG: SimilarityConfig = {
  useEmbeddings: false,
};

/**
 * Find the most relevant past traces for a given query.
 * This is the core recall algorithm.
 */
export function recall(
  store: TraceStore,
  query: RecallQuery,
  config: SimilarityConfig = DEFAULT_CONFIG,
): RecallResult[] {
  const limit = query.limit ?? 5;
  const minScore = query.minScore ?? 0.1;
  const weights = { ...WEIGHTS, ...config.weights };

  // Step 1: Fingerprint the query
  const queryFp = fingerprint(query.problem, {
    filePath: query.context?.filePath,
    language: query.context?.language,
    framework: query.context?.framework,
    errorType: query.context?.errorType,
  });

  // Step 2: Collect candidates from multiple sources
  const candidateMap = new Map<string, CandidateScore>();

  // 2a: Exact fingerprint matches (highest confidence)
  const exactMatches = store.getByFingerprint(queryFp.hash, limit);
  for (const trace of exactMatches) {
    candidateMap.set(trace.id, {
      trace,
      fingerprintScore: 1.0,
      bm25Score: 0,
      jaccardScore: 0,
      structuralScore: 0,
      cosineScore: 0,
    });
  }

  // 2b: FTS5 full-text search
  const ftsResults = store.searchFts(query.problem, limit * 3);
  const maxBm25 = ftsResults.length > 0
    ? Math.abs(ftsResults[0]!.rank)
    : 1;

  for (const { trace, rank } of ftsResults) {
    if (!candidateMap.has(trace.id)) {
      candidateMap.set(trace.id, {
        trace,
        fingerprintScore: 0,
        bm25Score: 0,
        jaccardScore: 0,
        structuralScore: 0,
        cosineScore: 0,
      });
    }
    // Normalize BM25: lower rank = better match in FTS5
    const normalized = maxBm25 === 0 ? 0 : Math.abs(rank) / maxBm25;
    candidateMap.get(trace.id)!.bm25Score = normalized;
  }

  // Step 3: Compute fine-grained similarity for all candidates
  for (const candidate of candidateMap.values()) {
    const traceFp = fingerprint(candidate.trace.problem.description, {
      filePath: candidate.trace.problem.filePath,
      language: candidate.trace.problem.language,
      framework: candidate.trace.problem.framework,
      errorType: candidate.trace.problem.errorType,
    });

    // Jaccard token similarity
    candidate.jaccardScore = jaccardSimilarity(
      queryFp.tokens,
      traceFp.tokens,
    );

    // Structural feature similarity
    candidate.structuralScore = structuralSimilarity(
      queryFp.features,
      traceFp.features,
    );
  }

  // Step 4: Compute final weighted scores
  const results: RecallResult[] = [];

  for (const candidate of candidateMap.values()) {
    let score: number;
    let matchType: RecallResult["matchType"];

    if (candidate.fingerprintScore === 1.0) {
      // Exact match — high confidence
      score = 1.0;
      matchType = "exact";
    } else {
      // Weighted combination of signals
      score =
        candidate.bm25Score * weights.bm25 +
        candidate.jaccardScore * weights.jaccard +
        candidate.structuralScore * weights.structural;

      if (config.useEmbeddings && candidate.cosineScore > 0) {
        score = score * 0.4 + candidate.cosineScore * weights.cosine;
      }

      // Normalize to 0–1
      const maxPossible = config.useEmbeddings
        ? weights.bm25 + weights.jaccard + weights.structural * 0.4 + weights.cosine
        : weights.bm25 + weights.jaccard + weights.structural;
      score = score / maxPossible;

      matchType = score > 0.6 ? "similar" : "related";
    }

    // Quality adjustment: boost traces with proven track record
    score *= qualityMultiplier(candidate.trace.quality.score);

    if (score >= minScore) {
      results.push({ trace: candidate.trace, score, matchType });
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
  if (a.length !== b.length) return 0;

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
  trace: ReasoningTrace;
  fingerprintScore: number;
  bm25Score: number;
  jaccardScore: number;
  structuralScore: number;
  cosineScore: number;
}

/**
 * Quality multiplier: a trace with proven usefulness gets a boost.
 * Uses a sigmoid-like curve centered at 0.5.
 */
function qualityMultiplier(qualityScore: number): number {
  // Maps quality 0.0–1.0 to multiplier 0.7–1.3
  return 0.7 + qualityScore * 0.6;
}
