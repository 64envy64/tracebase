/**
 * Maximal Marginal Relevance (MMR) diversity reranker — May-2026 PR B1.
 *
 * Slots between the cross-encoder reranker and the isotonic gate:
 *
 *     hard filters → BM25 → cross-encoder → top-K candidates
 *                  → MMR diversity → top-K′ → isotonic gate → injection
 *
 * Ref: Carbonell & Goldstein (1998) — "The Use of MMR, Diversity-Based
 *      Reranking for Reordering Documents and Producing Summaries".
 *
 * Why
 * ---
 * BM25 + cross-encoder rank by relevance, but a top-K window often
 * contains near-duplicates: three traces that all describe the SAME
 * pattern from slightly different angles will fill all three slots and
 * starve the user of complementary alternatives. MMR rebalances the
 * shortlist to maximise utility = relevance × diversity.
 *
 * Formula
 * -------
 *     MMR(i) = λ · rel(i) − (1 − λ) · max_{j ∈ S} sim(i, j)
 *
 *   rel(i): relevance of candidate i (the upstream reranker / linear-
 *           combination score, normalized to [0, 1])
 *   sim(i, j): pairwise similarity between candidates i and j
 *   S: set of items already selected
 *   λ: relevance/diversity tradeoff knob in [0, 1]
 *         1.0 = pure relevance (MMR no-op, identical to sort by rel)
 *         0.0 = pure diversity (greedy farthest-first, may pick low-rel items)
 *         0.7 = empirical sweet spot for retrieval task
 *
 * Implementation notes
 * --------------------
 * Greedy: build S one item at a time, always picking the candidate
 * with the highest current MMR score. O(K · N) for picking K items
 * out of N — at typical N=20, K=5 this is 100 sim() calls and dwarfs
 * the BM25 / cross-encoder cost.
 *
 * Similarity function is injected so callers can use cosine over
 * embeddings when available, falling back to Jaccard over trigger
 * tokens when not. Both metrics return [0, 1].
 */

import { jaccardSimilarity } from "./fingerprint.js";

/** Default diversity/relevance tradeoff. Tunable via config. */
export const DEFAULT_MMR_LAMBDA = 0.7;

export interface MMRItem {
  /** Unique id for logging / dedup. */
  id: string;
  /** Pre-computed relevance score in [0, 1]. */
  relevance: number;
  /** Text payload used for the default Jaccard similarity. */
  text: string;
  /** Optional dense embedding for cosine similarity. */
  embedding?: number[];
}

export interface MMROptions {
  /** Relevance/diversity tradeoff in [0, 1]. Default 0.7. */
  lambda?: number;
  /** Override the default similarity function. */
  similarity?: (a: MMRItem, b: MMRItem) => number;
}

/**
 * Greedy MMR selection. Returns up to `k` items from `items` ordered
 * by greedy MMR choice (NOT by relevance alone).
 *
 * Stability: the input order is preserved as a tie-break when MMR
 * scores agree — fits the contract of being a *reranker*, not a
 * randomizer.
 *
 * Edge cases:
 *   • k <= 0 or items empty       → returns []
 *   • items.length <= k           → returns items in greedy MMR order
 *                                   (but everything ends up included)
 *   • λ outside [0, 1]            → clamped
 */
export function mmr(items: MMRItem[], k: number, opts: MMROptions = {}): MMRItem[] {
  if (k <= 0 || items.length === 0) return [];
  const lambda = Math.max(0, Math.min(1, opts.lambda ?? DEFAULT_MMR_LAMBDA));
  const sim = opts.similarity ?? defaultSimilarity;
  const target = Math.min(k, items.length);

  // Maintain (item, originalIndex) so we can tie-break on input order
  // for deterministic output under equal MMR scores.
  const pool = items.map((item, i) => ({ item, i }));
  const selected: typeof pool = [];

  while (selected.length < target && pool.length > 0) {
    let bestPoolIdx = 0;
    let bestScore = -Infinity;
    for (let p = 0; p < pool.length; p++) {
      const cand = pool[p]!.item;
      let maxSim = 0;
      for (const { item: s } of selected) {
        const v = sim(cand, s);
        if (v > maxSim) maxSim = v;
      }
      const mmrScore = lambda * cand.relevance - (1 - lambda) * maxSim;
      if (
        mmrScore > bestScore ||
        // Tie-break: prefer the item with the smaller original index
        // so the output is deterministic under equal MMR scores.
        (mmrScore === bestScore && pool[p]!.i < pool[bestPoolIdx]!.i)
      ) {
        bestScore = mmrScore;
        bestPoolIdx = p;
      }
    }
    selected.push(pool[bestPoolIdx]!);
    pool.splice(bestPoolIdx, 1);
  }

  return selected.map((s) => s.item);
}

/**
 * Default similarity: cosine on `embedding` when both items carry one,
 * else Jaccard on whitespace-tokenized `text`. Returns [0, 1].
 *
 * Cosine of two L2-normalized vectors lives in [-1, 1] but for typical
 * sentence embeddings the realised range is [0, 1] (negative cosine on
 * semantic text is rare). We clamp at 0 to keep MMR's diversity term
 * monotonic — a negative similarity would otherwise REWARD picking
 * near-opposite items, which is not what MMR is supposed to do.
 */
function defaultSimilarity(a: MMRItem, b: MMRItem): number {
  if (a.embedding && b.embedding && a.embedding.length === b.embedding.length && a.embedding.length > 0) {
    return Math.max(0, cosineSim(a.embedding, b.embedding));
  }
  const aTokens = tokenize(a.text);
  const bTokens = tokenize(b.text);
  return jaccardSimilarity(aTokens, bTokens);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
