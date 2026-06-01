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

// ---------------------------------------------------------------------------
// Privacy-hardened DTO boundary (Phase C.2)
// ---------------------------------------------------------------------------
//
// A provider receives ONLY bounded, privacy-scanned DTOs — never raw query
// text, raw ReasoningBlock objects, bodies, or filesystem paths. This is the
// generic boundary a future REMOTE (hosted) adapter would cross, so it is
// safe by construction: there is no API surface through which raw content can
// reach a provider implicitly.

/**
 * Sanitized, bounded retrieval intent handed to a provider. The text has been
 * leakage/injection-scrubbed and length-bounded by `buildRetrievalIntent`
 * (src/core/retrieval-dto.ts); a remote adapter never sees the raw prompt.
 */
export interface RetrievalIntent {
  text: string;
  invariants?: BlockInvariants;
  /** Soft cap on how many candidates the provider should return. */
  limit: number;
}

/** Approved, privacy-scanned structured token sets of a candidate document. */
export interface RetrievalDocumentTokens {
  situation: readonly string[];
  mechanism: readonly string[];
  unlock: readonly string[];
  invariants: readonly string[];
}

/**
 * One candidate document a provider may score. Carries an OPAQUE block id plus
 * either approved scanned token sets (sanitized-text providers) or an opaque
 * vector reference (vector-only providers). Never the raw block, body, or path.
 */
export interface RetrievalDocument {
  blockId: string;
  /** Privacy-scanned token sets. Present for `sanitized-text` payload providers. */
  tokens?: RetrievalDocumentTokens;
  /** Opaque vector reference for `vector-only` providers; the floats stay local. */
  vectorRef?: { model: string; dims: number };
}

export type ProviderLocation = "local" | "remote";
export type ProviderPayload = "sanitized-text" | "vector-only";

/** What a provider IS and what payload it is allowed to receive. */
export interface RetrievalProviderCapabilities {
  location: ProviderLocation;
  payload: ProviderPayload;
  /**
   * A `remote` provider is invoked ONLY when this is true — remote adapters are
   * never engaged implicitly. The caller refuses a remote provider without it.
   */
  explicitOptIn: boolean;
}

/** Bounded, DTO-only context a provider may read. No raw blocks, no global state. */
export interface RetrievalContext {
  /** Privacy-scanned candidate documents (already bounded by the caller). */
  documents: readonly RetrievalDocument[];
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
 * `null` (not throw) on any failure so the caller can fall back to sparse. It
 * declares its capabilities so the boundary can enforce the remote opt-in.
 */
export interface RetrievalProvider {
  readonly name: string;
  readonly capabilities: RetrievalProviderCapabilities;
  retrieve(intent: RetrievalIntent, ctx: RetrievalContext): Promise<RetrievalCandidate[] | null>;
}

/** The absolute fallback: never contributes candidates. Used for `off`. */
export class NoopRetrievalProvider implements RetrievalProvider {
  readonly name = "noop";
  readonly capabilities: RetrievalProviderCapabilities = {
    location: "local",
    payload: "sanitized-text",
    explicitOptIn: false,
  };
  async retrieve(): Promise<RetrievalCandidate[] | null> {
    return null;
  }
}

/**
 * Fusion provenance for one served candidate — threaded into the serving slate
 * so V3 (and telemetry) can reason about WHERE a candidate came from. RRF score
 * is ordering-only; provider-native scores never become confidence.
 */
export interface RetrievalProvenance {
  /** 1-based rank in the sparse FTS list (absent ⇒ not retrieved by FTS). */
  sparseRank?: number;
  /** 1-based rank in the semantic provider list (absent ⇒ not proposed). */
  semanticRank?: number;
  /** 1-based rank in the served fused slate. */
  fusedRank: number;
  /** True iff the semantic provider surfaced this block and FTS did not. */
  semanticOnly: boolean;
  /** Class of the contributing semantic provider (`none` ⇒ sparse-only). */
  providerClass: ProviderLocation | "none";
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

/** A fused, served candidate with its block, ordering score, and provenance. */
export interface HybridSlateItem {
  block: ReasoningBlock;
  /** RRF score — ORDERING ONLY. serving-confidence derives its own evidence. */
  score: number;
  provenance: RetrievalProvenance;
}

export interface HybridSlate {
  slate: HybridSlateItem[];
  telemetry: HybridFusionTelemetry;
}

/**
 * Fuse the always-available sparse slate with an optional semantic candidate
 * list. `semantic` is `null` (provider unavailable) ⇒ returns the sparse slate
 * verbatim (the fail-open identity). `lookup` resolves a semantic-only blockId
 * to its block; unresolvable ids are dropped. The fused slate is bounded to
 * `topN`. Each item carries fusion provenance (sparse/semantic/fused ranks,
 * semanticOnly, providerClass). RRF score is ORDERING ONLY.
 */
export function fuseHybrid(
  sparse: ReadonlyArray<{ block: ReasoningBlock; score: number }>,
  semantic: readonly RetrievalCandidate[] | null,
  lookup: (blockId: string) => ReasoningBlock | null,
  topN: number,
  providerClass: ProviderLocation | "none" = "none",
): HybridSlate {
  const sparseIds = sparse.map((s) => s.block.id);
  const sparseRank = new Map<string, number>();
  sparseIds.forEach((id, i) => sparseRank.set(id, i + 1));

  if (!semantic || semantic.length === 0) {
    // Fail-open identity: sparse only, no movement, provider class "none".
    return {
      slate: sparse.slice(0, topN).map((s, i) => ({
        block: s.block,
        score: s.score,
        provenance: { sparseRank: i + 1, fusedRank: i + 1, semanticOnly: false, providerClass: "none" as const },
      })),
      telemetry: {
        sparseSlateSize: sparse.length,
        semanticSlateSize: 0,
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
  const semanticRankMap = new Map<string, number>();
  semanticRanked.forEach((id, i) => semanticRankMap.set(id, i + 1));

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
  const slate: HybridSlateItem[] = servedSlate.map((r, i) => {
    const id = r.block.id;
    const sRank = sparseRank.get(id);
    const semRank = semanticRankMap.get(id);
    if (sRank !== undefined) rankMovement += Math.abs(i + 1 - sRank);
    return {
      block: r.block,
      score: r.rrfScore,
      provenance: {
        ...(sRank !== undefined ? { sparseRank: sRank } : {}),
        ...(semRank !== undefined ? { semanticRank: semRank } : {}),
        fusedRank: i + 1,
        semanticOnly: sRank === undefined,
        providerClass,
      },
    };
  });

  const overlap = sparseIds.filter((id) => semanticSet.has(id)).length;
  const semanticOnly = semanticRanked.filter((id) => !sparseRank.has(id)).length;

  return {
    slate,
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
