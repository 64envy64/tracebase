/**
 * Provider-neutral hybrid retrieval substrate (Router V2, Phase C).
 *
 * WHY
 *   The V1/V2 candidate slate is generated ONLY by FTS5/BM25 over the trigger
 *   columns (situation + keywords). A lesson whose TRIGGER does not lexically
 *   match the query is never retrieved — so V2's structured evidence never gets
 *   to score it, no matter how well the body (mechanism/unlock) matches. Phase C
 *   adds an OPTIONAL second candidate source that can surface those blocks, then
 *   fuses the two ranked lists with principled rank fusion.
 *
 * CONTRACT (non-negotiable)
 *   • FTS5 stays the ALWAYS-AVAILABLE fast path. A provider is purely additive.
 *   • A provider returns `null` on ANY unavailability / failure / timeout; the
 *     caller falls back to the sparse slate. Hybrid can never break a recall.
 *   • Providers are model- and vendor-neutral. This module ships the contract,
 *     the deterministic union/dedupe/fusion, and a Noop provider. Real dense
 *     providers (Qwen3, BGE-M3, …) are documented adapters that implement
 *     `RetrievalProvider`; none is downloaded or hardcoded here.
 *   • Fusion is Reciprocal Rank Fusion (RRF) — a parameter-light, rank-only
 *     method (Cormack, Clarke & Büttcher, SIGIR 2009) that needs NO per-list
 *     weights, so nothing is benchmark-tuned. The only constant, k=60, is the
 *     value from the original paper.
 *   • Pure + deterministic: same inputs → same fused order. No DB, no I/O here.
 */
import type { ReasoningBlock, BlockInvariants } from "../types.js";

/**
 * Hybrid retrieval rollout mode. Defined here (core) so block-serving can
 * reference it without importing the experiments layer (which depends on core).
 */
export type RetrievalRolloutMode = "off" | "shadow" | "on";

/** The query a provider sees. No raw transcript — text + structured invariants. */
export interface RetrievalQuery {
  text: string;
  invariants?: BlockInvariants;
  /** Soft cap on how many candidates the provider should return. */
  limit: number;
}

/** Bounded context a provider may read. Keeps providers off global state. */
export interface RetrievalContext {
  /** The active blocks the provider may consider (already bounded by the caller). */
  activeBlocks: readonly ReasoningBlock[];
  /** Wall-clock budget for the provider; it MUST return (or null) within this. */
  deadlineMs: number;
  /** Injectable clock for deterministic tests. */
  now: () => number;
}

/** One ranked candidate from a provider. `score` orders WITHIN the provider only. */
export interface RetrievalCandidate {
  blockId: string;
  /** Provider-native relevance (higher = better). Used only to rank this list. */
  score: number;
}

/**
 * A retrieval provider. MUST be deterministic for fixed inputs and MUST return
 * `null` (not throw) on any failure so the caller can fall back to sparse.
 */
export interface RetrievalProvider {
  readonly name: string;
  retrieve(query: RetrievalQuery, ctx: RetrievalContext): Promise<RetrievalCandidate[] | null>;
}

/** The absolute fallback: never contributes candidates. Used for `off`. */
export class NoopRetrievalProvider implements RetrievalProvider {
  readonly name = "noop";
  async retrieve(): Promise<RetrievalCandidate[] | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/** RRF dampening constant from the original paper. Not tuned. */
export const RRF_K = 60;

/** One ranked list entering the fusion, tagged by its source. */
export interface RankedSlate {
  source: string;
  /** Block ids in rank order (best first). */
  blockIds: readonly string[];
}

/** A fused candidate with explainable provenance. */
export interface FusedCandidate {
  blockId: string;
  /** RRF score = Σ_sources 1 / (k + rank), rank is 1-based. */
  rrfScore: number;
  /** 1-based rank in each contributing source (absent ⇒ not in that list). */
  ranks: Record<string, number>;
}

/**
 * Reciprocal Rank Fusion over any number of ranked lists. Deterministic:
 * sorts by RRF score desc, breaking ties by blockId for stability. Dedupes by
 * blockId. The fused score for a block is Σ over the lists that contain it of
 * 1/(k + rank). A block in several lists naturally outranks one in a single
 * list, with no per-list weight to tune.
 */
export function rrfFuse(slates: readonly RankedSlate[], k: number = RRF_K): FusedCandidate[] {
  const acc = new Map<string, FusedCandidate>();
  for (const slate of slates) {
    slate.blockIds.forEach((blockId, i) => {
      const rank = i + 1;
      const cur = acc.get(blockId) ?? { blockId, rrfScore: 0, ranks: {} };
      // First (best) occurrence within a single list wins that list's rank.
      if (cur.ranks[slate.source] === undefined) {
        cur.ranks[slate.source] = rank;
        cur.rrfScore += 1 / (k + rank);
      }
      acc.set(blockId, cur);
    });
  }
  return [...acc.values()].sort(
    (a, b) => b.rrfScore - a.rrfScore || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// Hybrid union (sparse ⊕ semantic)
// ---------------------------------------------------------------------------

/** Privacy-safe, explainable telemetry about one fusion. */
export interface HybridFusionTelemetry {
  sparseSlateSize: number;
  semanticSlateSize: number;
  /** Distinct blocks in the fused slate before the top-N cut. */
  fusedSlateSize: number;
  /** Blocks present in BOTH sparse and semantic lists. */
  overlap: number;
  /** Blocks only the semantic provider surfaced (the recall lever). */
  semanticOnly: number;
  /**
   * Rank movement: sum of |fusedRank − sparseRank| over blocks present in both
   * the sparse slate and the served (top-N) fused slate. 0 ⇒ fusion preserved
   * the sparse order; higher ⇒ the semantic list reordered the served slate.
   */
  rankMovement: number;
}

export interface HybridSlate {
  /** Fused, deduped, top-N slate in `{block, score}` shape for finalizeRecall. */
  slate: Array<{ block: ReasoningBlock; score: number }>;
  telemetry: HybridFusionTelemetry;
}

/**
 * Fuse the always-available sparse slate with an optional semantic candidate
 * list. `semantic` is `null` (provider unavailable) ⇒ returns the sparse slate
 * verbatim (the fail-open identity). `lookup` resolves a semantic-only blockId
 * to its block; unresolvable ids are dropped. The fused slate is bounded to
 * `topN`. `score` carries the RRF score (ORDERING ONLY — serving-confidence
 * derives its own evidence and never reads it as confidence).
 */
export function fuseHybrid(
  sparse: ReadonlyArray<{ block: ReasoningBlock; score: number }>,
  semantic: readonly RetrievalCandidate[] | null,
  lookup: (blockId: string) => ReasoningBlock | null,
  topN: number,
): HybridSlate {
  const sparseIds = sparse.map((s) => s.block.id);
  const sparseRank = new Map<string, number>();
  sparseIds.forEach((id, i) => sparseRank.set(id, i + 1));

  if (!semantic || semantic.length === 0) {
    // Fail-open identity: sparse only, no movement.
    return {
      slate: sparse.slice(0, topN).map((s) => ({ block: s.block, score: s.score })),
      telemetry: {
        sparseSlateSize: sparse.length,
        semanticSlateSize: semantic ? 0 : 0,
        fusedSlateSize: sparse.length,
        overlap: 0,
        semanticOnly: 0,
        rankMovement: 0,
      },
    };
  }

  const semanticRanked = [...semantic]
    .sort((a, b) => b.score - a.score || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0))
    .map((c) => c.blockId);
  const semanticSet = new Set(semanticRanked);

  const fused = rrfFuse([
    { source: "sparse", blockIds: sparseIds },
    { source: "semantic", blockIds: semanticRanked },
  ]);

  // Resolve blocks: sparse provides its own; semantic-only ids are looked up.
  const blockById = new Map<string, ReasoningBlock>();
  for (const s of sparse) blockById.set(s.block.id, s.block);

  const resolved: Array<{ block: ReasoningBlock; rrfScore: number }> = [];
  for (const f of fused) {
    const block = blockById.get(f.blockId) ?? lookup(f.blockId);
    if (block) resolved.push({ block, rrfScore: f.rrfScore });
  }

  const servedSlate = resolved.slice(0, topN);
  let rankMovement = 0;
  servedSlate.forEach((r, i) => {
    const prev = sparseRank.get(r.block.id);
    if (prev !== undefined) rankMovement += Math.abs(i + 1 - prev);
  });

  const overlap = sparseIds.filter((id) => semanticSet.has(id)).length;
  const semanticOnly = semanticRanked.filter((id) => !sparseRank.has(id)).length;

  return {
    slate: servedSlate.map((r) => ({ block: r.block, score: r.rrfScore })),
    telemetry: {
      sparseSlateSize: sparse.length,
      semanticSlateSize: semanticRanked.length,
      fusedSlateSize: resolved.length,
      overlap,
      semanticOnly,
      rankMovement,
    },
  };
}
