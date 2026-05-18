/**
 * BlockServer — v2 serving base (docs/DESIGN_v2.md §L5, Phase 2).
 *
 * Pipeline:
 *     query + invariants
 *       │
 *       ├─► hard-invariant prefilter (active blocks + active facts only)
 *       │
 *       ▼
 *     lexical ranker  (FTS5 BM25 over trigger-only fields for blocks,
 *                      statement for facts)
 *       │
 *       ▼
 *     optional: semantic reranker  (plug-in slot; identity by default)
 *       │
 *       ▼
 *     calibrated gate (Calibrator slot; identity pass-through by default)
 *       │
 *       ▼
 *     injection as HYPOTHESIS  (formatInjection; never imperative)
 *
 * Non-negotiable:
 *   • Body fields never contribute to scoring.
 *   • Case refs are attached to every returned block for audit.
 *   • A shadow query skips injection but still emits events.
 *   • Calibrator is pluggable — when the isotonic calibrator ships in
 *     Phase 5, it drops into the same slot with no schema change.
 */
import { randomUUID } from "node:crypto";
import type { BlockStore } from "./block-store.js";
import { EventEmitter, type SideSink } from "./analytics.js";
import { shouldHoldOut } from "../experiments/holdout.js";
import type {
  ReasoningBlock,
  BlockCaseRef,
  BlockInvariants,
  ProjectFact,
  RetrievalEvent,
  InjectionEvent,
  FactInjectionEvent,
} from "../types.js";
import {
  type Reranker,
  type RerankerFallbackReason,
  NoopReranker,
  blockCandidatesFor,
  withRerankerFallback,
} from "./reranker.js";
import { mmr, DEFAULT_MMR_LAMBDA, type MMRItem } from "./mmr.js";

/**
 * Cascade-internal candidate shape. `linearScore` is the BM25 +
 * multi-signal output (what the calibrator was fit on). `rerankerScore`
 * + `rerankerRank` carry the cross-encoder's verdict so MMR can use
 * it as relevance rather than dropping back to BM25 — keeping the two
 * scores separate so calibration math doesn't drift.
 */
interface CascadeCandidate {
  block: ReasoningBlock;
  /** Pre-cascade score: BM25 + multi-signal. Calibrator input. */
  linearScore: number;
  /** Cross-encoder score in [0, 1] when the reranker ran successfully. */
  rerankerScore?: number;
  /** 1-based rank from the reranker. Logged for OPE replay; never used in math. */
  rerankerRank?: number;
}

/** Cascade telemetry — stamped onto the retrieval event. */
interface CascadeTelemetry {
  rerankerName: string;
  rerankerFellBack: boolean;
  rerankerFallbackReason?: RerankerFallbackReason;
  mmrLambda: number;
  cascadePolicyId: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BlockRecallQuery {
  /** Free-text query: error message, task description, or both. */
  text: string;
  /**
   * Hard pre-filter. If query sets language=python, any block whose
   * `trigger.invariants.language` is also set to a different language is
   * eliminated before ranking. Unset fields = no filtering on that
   * dimension.
   */
  invariants?: BlockInvariants;
  /** For fact scope filtering (e.g. "repo:myorg/app"). */
  scope?: string;
  /** Max blocks. Default 5. */
  limit?: number;
  /** Max facts. Default 5. */
  factLimit?: number;
  /** Max case refs to attach per block. Default 3. */
  refLimit?: number;
  /** Shadow control query — events emitted but no injection fires. Default false. */
  shadow?: boolean;
  /** Optional caller-supplied query id for correlation. Default auto-uuid. */
  queryId?: string;
  /** Optional run id for grouping events in analytics. */
  runId?: string;
  /**
   * Optional experimental-holdout input. When provided *and* the
   * query is eligible (at least one candidate retrieved) *and* the
   * deterministic assignment lands the query in the holdout cohort,
   * `recall` suppresses injection for the run and marks the
   * retrieval event with `controlReason: "holdout"`.
   *
   * Default off: when `experiment` is omitted, behaviour is 100%
   * identical to pre-Phase-3 serving — no holdout, no new event
   * fields, no side effects. A caller that supplies `experiment`
   * without a `fingerprint` is a silent no-op: deterministic
   * assignment requires the fingerprint, and we would rather skip
   * the experiment for that run than fabricate a cohort.
   */
  experiment?: ExperimentInput;
}

/**
 * Deterministic holdout-assignment input for one retrieval call.
 * See `src/experiments/holdout.ts` for the assignment semantics.
 */
export interface ExperimentInput {
  /** Holdout rate on [0, 1]. 0 disables, 1 always holds out. */
  rate: number;
  /**
   * Workspace-scoped salt — must be stable per workspace and
   * isolated across workspaces. Supplied by the caller.
   */
  salt: string;
  /**
   * Stable query fingerprint. Same problem shape → same cohort.
   * When missing, the experiment is silently skipped for this run
   * (safe no-op) rather than falling back to a non-deterministic
   * decision.
   */
  fingerprint?: string;
}

export interface BlockHit {
  block: ReasoningBlock;
  /** Normalized 0..1 ranker score (higher = more relevant). */
  score: number;
  /**
   * Cross-encoder relevance in [0, 1]. Present when the B1 cascade
   * ran a non-Noop reranker and didn't fall back. Optional for back-
   * compat with sync `recall()` and library consumers that haven't
   * configured a reranker. Logged to the retrieval event so off-policy
   * screening can distinguish "cross-encoder ranked this high" from
   * "BM25 ranked this high".
   */
  rerankerScore?: number;
  /**
   * 1-based position the reranker assigned this candidate (1 = best).
   * Only present when `rerankerScore` is present.
   */
  rerankerRank?: number;
  /** Gate output: calibrated P(helpful). Identity by default. */
  calibratedProb: number;
  /**
   * Binding contract: true iff this hit WILL be included in the
   * injection payload AND produce an `injection` analytics event.
   * False for hits below the gate threshold and for every hit of a
   * shadow query. Consumers formatting the prompt must filter by
   * this flag — otherwise prompt content drifts from analytics.
   */
  passesGate: boolean;
  /** Top-N case refs for audit. Never used in scoring. */
  refs: BlockCaseRef[];
}

export interface FactHit {
  fact: ProjectFact;
  /** Raw ranker score; currently fact.confidence until Phase 5's fact calibrator ships. */
  score: number;
  /**
   * Gated probability: score after any calibrator. Currently equals
   * `score` (no fact-side calibrator yet), but the field is present
   * so downstream consumers can treat blocks and facts symmetrically.
   */
  calibratedProb: number;
  /**
   * Binding contract: true iff this fact WILL appear in the
   * injection payload AND produce a `fact_injection` analytics
   * event. False below gate and for shadow queries. Parallel to
   * BlockHit.passesGate.
   */
  passesGate: boolean;
}

export interface RecallV2Result {
  queryId: string;
  shadow: boolean;
  /**
   * Present only for experimental holdout controls. Manual / diagnostic
   * shadow keeps this undefined for back-compat.
   */
  controlReason?: "shadow" | "holdout";
  blocks: BlockHit[];
  facts: FactHit[];
  /**
   * Whether the server recommends injection at all. False if:
   *   - this is a shadow query, or
   *   - no hit exceeds the gate threshold.
   */
  shouldInject: boolean;
}

export type Calibrator = (score: number, block: ReasoningBlock) => number;

export const identityCalibrator: Calibrator = (score) => score;

export interface BlockServerOptions {
  /**
   * Minimum calibrated probability for `shouldInject = true`.
   * Default 0 — everything passes. Bump in production once the
   * isotonic calibrator is fitted.
   */
  gateThreshold?: number;
  /** Maps raw ranker score + block → P(helpful). Identity by default. */
  calibrator?: Calibrator;
  /**
   * If true, emit retrieval / injection events to the store's event log.
   * Default true. Tests can disable for noise-free assertions.
   */
  emitEvents?: boolean;
  /** Override Date.now() for deterministic tests. */
  now?: () => number;
  /**
   * Unified emission channel. When provided, retrieval / injection
   * events flow through this emitter and benefit from whatever side
   * sinks it carries. If unset, a default emitter is built from
   * `store` and (optionally) `sideSink`.
   *
   * Prefer this over `sideSink` when `emitAgentUsed` / `emitOutcome`
   * are also called in the same deployment — a single shared emitter
   * ensures all four event types reach the same destinations.
   */
  emitter?: EventEmitter;
  /**
   * Convenience: when no `emitter` is provided, this side-channel is
   * attached to the default emitter for retrieval / injection events.
   * Ignored when `emitter` is provided (configure the emitter instead).
   * Errors are swallowed so a bad sink never breaks retrieval.
   */
  sideSink?: SideSink;
  /**
   * Cross-encoder reranker for the May-2026 B1 cascade. When set,
   * BlockServer fetches a wider candidate window (`fetchSize * 2`),
   * runs the reranker, then keeps the top `limit` for MMR. Defaults
   * to `NoopReranker` (architecture exercised but no reordering).
   *
   * Failures (timeout, network, malformed response) gracefully fall
   * back to the pre-rerank ordering — see `withRerankerFallback`.
   */
  reranker?: Reranker;
  /** Hard timeout for one reranker call. Default 300ms. */
  rerankerTimeoutMs?: number;
  /**
   * MMR diversity tradeoff in [0, 1]. 1.0 = pure relevance (MMR is a
   * no-op), 0.0 = pure diversity. Default 0.7 — empirical sweet spot.
   * Set to 1.0 to disable MMR entirely without touching reranker.
   */
  mmrLambda?: number;
  /**
   * Pre-reranker over-fetch multiplier. The reranker / MMR cascade is
   * pointless without enough candidates to choose from. Default 4 —
   * with limit=5 we fetch ~20 before reranking. Set to 1 to disable
   * the over-fetch path (useful for benchmarks).
   */
  cascadeFetchMultiplier?: number;
}

// ---------------------------------------------------------------------------
// BlockServer
// ---------------------------------------------------------------------------

export class BlockServer {
  private readonly store: BlockStore;
  private readonly gateThreshold: number;
  private readonly calibrator: Calibrator;
  private readonly emitEvents: boolean;
  private readonly now: () => number;
  private readonly emitter: EventEmitter;
  // May-2026 B1 cascade — reranker + MMR.
  private readonly reranker: Reranker;
  private readonly rerankerTimeoutMs: number;
  private readonly mmrLambda: number;
  private readonly cascadeFetchMultiplier: number;

  constructor(store: BlockStore, opts: BlockServerOptions = {}) {
    this.store = store;
    this.gateThreshold = opts.gateThreshold ?? 0;
    this.calibrator = opts.calibrator ?? identityCalibrator;
    this.emitEvents = opts.emitEvents ?? true;
    this.now = opts.now ?? Date.now;
    // Unified emission: either the caller-supplied emitter (preferred,
    // shared with emit helpers) or a fresh one wrapping the store and
    // optional sideSink shim.
    this.emitter = opts.emitter ?? new EventEmitter(store, opts.sideSink);
    this.reranker = opts.reranker ?? new NoopReranker();
    this.rerankerTimeoutMs = opts.rerankerTimeoutMs ?? 300;
    this.mmrLambda = opts.mmrLambda ?? DEFAULT_MMR_LAMBDA;
    this.cascadeFetchMultiplier = Math.max(1, opts.cascadeFetchMultiplier ?? 4);
  }

  /**
   * Run retrieval (synchronous, cascade-free). Returns hits plus a
   * `shouldInject` recommendation. Emits a `retrieval` event (always)
   * and one `injection` event per block and one `fact_injection` event
   * per fact that pass the gate (unless the query is shadow). Blocks
   * and facts attribute independently at aggregation time.
   *
   * Use `recallAsync()` instead when the May-2026 B1 cascade
   * (cross-encoder reranker + MMR) is desired. `recall()` is kept
   * synchronous for back-compat with the existing MCP path and tests;
   * it ignores the reranker / mmrLambda options entirely.
   */
  recall(query: BlockRecallQuery): RecallV2Result {
    const queryId = query.queryId ?? randomUUID();
    const manualShadow = query.shadow ?? false;
    const limit = query.limit ?? 5;
    const factLimit = query.factLimit ?? 5;
    const refLimit = query.refLimit ?? 3;

    const blocks = this.searchBlocks(query.text, query.invariants, limit);
    const rawFacts = this.searchFacts(query.text, query.invariants, query.scope, factLimit);

    return this.finalizeRecall(query, queryId, manualShadow, refLimit, blocks, rawFacts);
  }

  /**
   * Async variant of `recall()` that runs the May-2026 B1 cascade:
   *
   *     hard-filter → BM25 over-fetch → cross-encoder rerank
   *                 → MMR diversity → calibrator gate → events
   *
   * The reranker call is bounded by `rerankerTimeoutMs` and falls back
   * to the pre-rerank ordering on timeout / error / malformed response
   * — the cascade NEVER blocks injection unbounded and NEVER throws.
   *
   * Configure via `BlockServerOptions`:
   *   • `reranker`: any `Reranker` impl (NoopReranker default).
   *   • `mmrLambda`: relevance/diversity tradeoff. 1.0 disables MMR.
   *   • `cascadeFetchMultiplier`: over-fetch ratio (default 4× limit).
   *
   * With the default `NoopReranker` and lambda=0.7 the cascade still
   * runs (MMR over BM25 candidates), so a default install gets free
   * deduplication. Behaviour matches `recall()` only when
   * `mmrLambda === 1` AND reranker is `NoopReranker`.
   */
  async recallAsync(query: BlockRecallQuery): Promise<RecallV2Result> {
    const queryId = query.queryId ?? randomUUID();
    const manualShadow = query.shadow ?? false;
    const limit = query.limit ?? 5;
    const factLimit = query.factLimit ?? 5;
    const refLimit = query.refLimit ?? 3;

    // Stage 1+2: hard-filter + BM25 with cascade over-fetch.
    const fetchLimit = limit * this.cascadeFetchMultiplier;
    const wideBlocks = this.searchBlocks(query.text, query.invariants, fetchLimit);

    // Capture the full pre-cascade slate for the retrieval event so B3
    // replay-screening has every counter-factual the policy under
    // evaluation needs. The cascade narrows from this slate by
    // reranking + MMR + limit; without logging the original we'd only
    // be able to evaluate "did the policy agree with us on the winners",
    // not "could a different policy have picked something better".
    const slate: CascadeCandidate[] = wideBlocks.map((b) => ({
      block: b.block,
      linearScore: b.score,
    }));

    // Stage 3: cross-encoder rerank — informs both ordering AND
    // downstream MMR relevance. B1.1 fix for P1 #1: pre-hardening MMR
    // used the BM25 linearScore as relevance, which threw away every
    // bit of work the cross-encoder did.
    const { reranked: cascadeRanked, telemetry } = await this.applyReranker(
      query.text,
      slate,
    );

    // Stage 4: MMR diversity, narrowing to `limit`. Uses rerankerScore
    // when available (the real relevance signal post-rerank); falls
    // back to linearScore for the NoopReranker path.
    const finalBlocks = this.applyMMR(cascadeRanked, limit);

    // Facts stay on the existing simpler path — cross-encoder rerank
    // for L4 semantic memory lands in a future PR; today's fact recall
    // is confidence-based and already produces a small list.
    const rawFacts = this.searchFacts(query.text, query.invariants, query.scope, factLimit);

    return this.finalizeRecall(
      query,
      queryId,
      manualShadow,
      refLimit,
      // finalizeRecall expects { block, score } pairs — pass the score
      // the calibrator was fit on (linear), NOT the reranker score.
      // Calibrator math stays valid; reranker info is logged separately.
      finalBlocks.map((c) => ({ block: c.block, score: c.linearScore })),
      rawFacts,
      { cascade: cascadeRanked, telemetry },
    );
  }

  /**
   * Apply the configured reranker to a candidate window. Returns
   * enriched candidates carrying both `linearScore` (BM25, for the
   * calibrator) and `rerankerScore` + `rerankerRank` (cross-encoder,
   * for MMR + telemetry). NoopReranker fills `rerankerScore` with a
   * constant — MMR's relevance term still uses it, which is identical
   * to using `linearScore` after normalization since constants drop
   * out of the relative ordering.
   *
   * `withRerankerFallback` enforces the timeout + cancellation +
   * graceful-fallback + numeric-validation contracts. Failure modes
   * collapse to `{rerankerScore: undefined, telemetry.fellBack: true}`.
   */
  private async applyReranker(
    queryText: string,
    candidates: CascadeCandidate[],
  ): Promise<{ reranked: CascadeCandidate[]; telemetry: CascadeTelemetry }> {
    const cascadePolicyId = "linear+rerank+mmr.v1";
    const baseTelemetry: CascadeTelemetry = {
      rerankerName: this.reranker.name,
      rerankerFellBack: false,
      mmrLambda: this.mmrLambda,
      cascadePolicyId,
    };

    if (candidates.length <= 1) {
      return { reranked: candidates, telemetry: baseTelemetry };
    }
    const rerankCandidates = blockCandidatesFor(
      candidates.map((c) => ({ block: c.block, score: c.linearScore })),
    );
    const byId = new Map(candidates.map((c) => [c.block.id, c]));
    const result = await withRerankerFallback(
      this.reranker,
      queryText,
      rerankCandidates,
      { timeoutMs: this.rerankerTimeoutMs },
    );

    if (result.fellBack || !result.scores) {
      // Fallback: preserve pre-rerank order, no rerankerScore stamped.
      return {
        reranked: candidates,
        telemetry: {
          ...baseTelemetry,
          rerankerFellBack: true,
          ...(result.reason ? { rerankerFallbackReason: result.reason } : {}),
        },
      };
    }

    // Success: pair each reordered candidate with its reranker score
    // and 1-based rank. byId lookup avoids relying on stable map insert
    // order in the post-sort array.
    const reranked: CascadeCandidate[] = result.reranked.map((rc, i) => {
      const cand = byId.get(rc.blockId)!;
      return {
        ...cand,
        rerankerScore: result.scores![i],
        rerankerRank: i + 1,
      };
    }).filter((c) => c.block !== undefined);
    return { reranked, telemetry: baseTelemetry };
  }

  /**
   * Apply greedy MMR over the reranked window. Relevance is `rerankerScore`
   * when available (B1.1 fix for P1 #1 — pre-hardening MMR silently
   * used linearScore, which made the reranker's reorder cosmetic),
   * else `linearScore` for the NoopReranker / fellBack path. Inter-doc
   * similarity uses Jaccard over trigger text. When `mmrLambda` is 1.0,
   * MMR degenerates to "sort by relevance" — fast path.
   */
  private applyMMR(candidates: CascadeCandidate[], k: number): CascadeCandidate[] {
    if (this.mmrLambda >= 1 || candidates.length <= 1) {
      // When relevance==1.0, the post-rerank order is already optimal.
      // Take it as-is and slice to k. (`reranked` from applyReranker
      // is sorted DESC by rerankerScore when present.)
      return candidates.slice(0, k);
    }
    const items: MMRItem[] = candidates.map((c) => ({
      id: c.block.id,
      relevance: c.rerankerScore ?? c.linearScore,
      text: c.block.trigger.situation,
    }));
    const picked = mmr(items, k, { lambda: this.mmrLambda });
    const byId = new Map(candidates.map((c) => [c.block.id, c]));
    return picked.map((it) => byId.get(it.id)!).filter(Boolean);
  }

  /**
   * Shared post-search finalization: calibrate → holdout decision →
   * build hits → emit events → assemble result. Used by both `recall()`
   * (sync, cascade-free) and `recallAsync()` (cascade-on).
   *
   * `cascadeInfo` is optional: only `recallAsync()` produces it. When
   * present, BlockHits gain `rerankerScore` + `rerankerRank` and the
   * retrieval event carries the full pre-cascade slate plus cascade
   * telemetry (reranker name, fallback reason, MMR lambda).
   */
  private finalizeRecall(
    query: BlockRecallQuery,
    queryId: string,
    manualShadow: boolean,
    refLimit: number,
    blocks: Array<{ block: ReasoningBlock; score: number }>,
    rawFacts: Array<{ fact: ProjectFact; score: number }>,
    cascadeInfo?: { cascade: CascadeCandidate[]; telemetry: CascadeTelemetry },
  ): RecallV2Result {

    // Pre-compute calibrated probabilities once. Both the holdout
    // eligibility decision and the final BlockHit / FactHit
    // construction below key off the exact same calibrated value,
    // so a query cannot be "eligible for holdout" but then fail to
    // produce an injection in treatment, nor vice-versa.
    const blockCalibrated = blocks.map(({ block, score }) => ({
      block,
      score,
      calibratedProb: clamp01(this.calibrator(score, block)),
      refs: this.store.listCaseRefs(block.id).slice(0, refLimit),
    }));
    const factCalibrated = rawFacts.map(({ fact, score }) => ({
      fact,
      score,
      calibratedProb: clamp01(fact.confidence),
    }));

    // Phase 3.2 — experimental holdout.
    //
    // Only applies when:
    //   1. the caller did not already set a manual shadow (manual
    //      shadow stays exactly as it was; it keeps an undefined
    //      `controlReason` for back-compat so analytics still treats
    //      it as diagnostic-only);
    //   2. the query is gate-eligible — at least one block or fact
    //      candidate would pass the calibrator + gateThreshold
    //      *absent* the holdout. A run whose candidates all fall
    //      below the gate would not emit any injection event in
    //      treatment either, so marking such a run as holdout would
    //      contaminate the control cohort with "nothing-to-compare"
    //      queries and understate the causal lift;
    //   3. the experiment input is complete — `rate`, `salt`, and a
    //      `fingerprint` all present. A missing fingerprint is a
    //      silent no-op: without it assignment cannot be
    //      deterministic, and we would rather skip the experiment
    //      than fabricate a cohort;
    //   4. the deterministic `shouldHoldOut` decision lands this
    //      fingerprint in the holdout.
    //
    // When all four conditions hold, the run is treated as shadow
    // (no injection events, passesGate = false everywhere,
    // shouldInject = false, formatInjection renders empty) and the
    // retrieval event carries `controlReason: "holdout"`.
    const wouldInjectAbsentShadow =
      blockCalibrated.some((h) => h.calibratedProb >= this.gateThreshold) ||
      factCalibrated.some((h) => h.calibratedProb >= this.gateThreshold);
    const holdoutApplied =
      !manualShadow &&
      wouldInjectAbsentShadow &&
      !!query.experiment?.fingerprint &&
      shouldHoldOut(
        query.experiment.fingerprint,
        query.experiment.rate,
        query.experiment.salt,
      );
    const shadow = manualShadow || holdoutApplied;
    const controlReason: "shadow" | "holdout" | undefined = holdoutApplied ? "holdout" : undefined;

    // Finalise hits. `passesGate` is the single-source-of-truth the
    // injection formatter and analytics emission both key off, and
    // it reuses the calibrator output computed above so holdout
    // eligibility and downstream gate decision cannot drift.
    //
    // Build a cascade lookup so each BlockHit can carry the
    // (rerankerScore, rerankerRank) it earned during the cascade.
    // When `cascadeInfo` is absent (sync recall path), the lookup
    // is empty and BlockHits have no reranker fields — the same
    // shape as before B1.1.
    const cascadeById = new Map<string, CascadeCandidate>();
    if (cascadeInfo) {
      for (const c of cascadeInfo.cascade) cascadeById.set(c.block.id, c);
    }
    const blockHits: BlockHit[] = blockCalibrated.map((h) => {
      const cascade = cascadeById.get(h.block.id);
      const hit: BlockHit = {
        block: h.block,
        score: h.score,
        calibratedProb: h.calibratedProb,
        passesGate: !shadow && h.calibratedProb >= this.gateThreshold,
        refs: h.refs,
      };
      if (cascade?.rerankerScore !== undefined) {
        hit.rerankerScore = cascade.rerankerScore;
      }
      if (cascade?.rerankerRank !== undefined) {
        hit.rerankerRank = cascade.rerankerRank;
      }
      return hit;
    });

    // Facts: no calibrator slot yet (Phase 5). Same gate threshold
    // as blocks; per-item-type thresholds can be introduced later
    // without changing the event schema.
    const factHits: FactHit[] = factCalibrated.map((h) => ({
      fact: h.fact,
      score: h.score,
      calibratedProb: h.calibratedProb,
      passesGate: !shadow && h.calibratedProb >= this.gateThreshold,
    }));

    // shouldInject: true iff any hit passes the gate. passesGate
    // already encodes "not shadow", so this is a simple disjunction.
    const shouldInject =
      blockHits.some((h) => h.passesGate) || factHits.some((h) => h.passesGate);

    // Emit events. One injection event per hit with passesGate=true —
    // one-to-one correspondence with what the formatter will render.
    if (this.emitEvents) {
      this.emitRetrieval(
        queryId,
        blockHits,
        factHits,
        shadow,
        controlReason,
        query.runId,
        cascadeInfo,
      );
      for (const h of blockHits) {
        if (h.passesGate) this.emitInjection(queryId, h, query.runId);
      }
      for (const h of factHits) {
        if (h.passesGate) this.emitFactInjection(queryId, h, query.runId);
      }
    }

    return {
      queryId,
      shadow,
      ...(controlReason ? { controlReason } : {}),
      blocks: blockHits,
      facts: factHits,
      shouldInject,
    };
  }

  // -------------------------------------------------------------------------
  // Private: block retrieval
  // -------------------------------------------------------------------------

  private searchBlocks(
    text: string,
    invariants: BlockInvariants | undefined,
    limit: number,
  ): Array<{ block: ReasoningBlock; score: number }> {
    const fts = this.sanitizeFtsQuery(text);
    if (!fts) return [];

    const invLang = invariants?.language ?? null;
    const invFw = invariants?.framework ?? null;
    const invErr = invariants?.errorType ?? null;
    const queryApi = invariants?.apiSurface ?? [];

    // Over-fetch so that after the prefilter we still have enough candidates.
    // We over-fetch more generously when an apiSurface constraint is in
    // play because the JS-side intersection may reject a fair chunk.
    const fetchSize = Math.max(limit * (queryApi.length > 0 ? 8 : 4), 20);

    // Hard prefilter encoded in WHERE: if the block sets an invariant AND
    // the query sets the same invariant, they must agree. Unset = accept.
    const sql = `
      SELECT rb.*, bm25(reasoning_blocks_fts, 2.0, 1.0) AS raw_rank
      FROM reasoning_blocks_fts
      JOIN reasoning_blocks rb ON rb.rowid = reasoning_blocks_fts.rowid
      WHERE reasoning_blocks_fts MATCH @fts
        AND rb.status = 'active'
        AND (rb.trig_language   IS NULL OR @inv_lang IS NULL OR rb.trig_language   = @inv_lang)
        AND (rb.trig_framework  IS NULL OR @inv_fw   IS NULL OR rb.trig_framework  = @inv_fw)
        AND (rb.trig_error_type IS NULL OR @inv_err  IS NULL OR rb.trig_error_type = @inv_err)
      ORDER BY raw_rank
      LIMIT @fetchSize
    `;

    let rows: Array<Record<string, unknown> & { raw_rank: number }>;
    try {
      rows = this.store.rawDb.prepare(sql).all({
        fts,
        inv_lang: invLang,
        inv_fw: invFw,
        inv_err: invErr,
        fetchSize,
      }) as Array<Record<string, unknown> & { raw_rank: number }>;
    } catch {
      // FTS query failure (malformed tokens etc.) — return nothing rather
      // than silently corrupting ranking.
      return [];
    }

    if (rows.length === 0) return [];

    // apiSurface is stored as a JSON array. SQLite json_each/EXISTS would
    // work but adds significant SQL complexity for a rarely-triggered
    // filter; intersect in JS on the over-fetched candidate set instead.
    // Semantics: if query supplies a non-empty apiSurface AND the block
    // supplies a non-empty apiSurface, require at least one element
    // overlap. Either side empty = accept (same rule as scalar invariants).
    const filtered = queryApi.length > 0
      ? rows.filter((r) => {
          let blockApi: string[] = [];
          try {
            blockApi = JSON.parse(r.trig_api_surface as string) as string[];
          } catch {
            blockApi = [];
          }
          if (blockApi.length === 0) return true;
          const qSet = new Set(queryApi);
          return blockApi.some((a) => qSet.has(a));
        })
      : rows;

    if (filtered.length === 0) return [];

    // FTS5 bm25 returns negative values; lower == better. Convert to
    // positive "relevance" and query-level-normalize to 0..1.
    const relevances = filtered.map((r) => -r.raw_rank);
    const maxRel = Math.max(...relevances, Number.EPSILON);
    return filtered.slice(0, limit).map((r) => ({
      block: this.storeRowToBlock(r),
      score: clamp01(-r.raw_rank / maxRel),
    }));
  }

  private searchFacts(
    text: string,
    invariants: BlockInvariants | undefined,
    scope: string | undefined,
    limit: number,
  ): Array<{ fact: ProjectFact; score: number }> {
    // Store-side retrieval already applies hard-invariant prefilter,
    // hierarchical scope resolution, and FTS when text is present.
    // Scoring is confidence-based until Phase 5 ships a fact calibrator.
    const facts = this.store.searchFacts({
      text,
      scope,
      invariants,
      status: "active",
      limit,
    });
    return facts.map((fact) => ({ fact, score: fact.confidence }));
  }

  private sanitizeFtsQuery(query: string): string {
    const cleaned = query.replace(/[*"():^~{}[\]\\]/g, " ").trim();
    if (!cleaned) return "";
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    const joiner = words.length <= 3 ? " " : " OR ";
    return words.map((w) => `"${w}"`).join(joiner);
  }

  /**
   * Build a ReasoningBlock from a raw row. We reach into the private
   * mapper by round-tripping through the store, but since the row came
   * from the same table, we can call `getBlock` by id for correctness.
   * This avoids duplicating the mapper here.
   */
  private storeRowToBlock(row: Record<string, unknown>): ReasoningBlock {
    const id = row.id as string;
    const b = this.store.getBlock(id);
    if (!b) {
      throw new Error(`block ${id} vanished between rank and fetch`);
    }
    return b;
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  private emitRetrieval(
    queryId: string,
    blockHits: BlockHit[],
    factHits: FactHit[],
    shadow: boolean,
    controlReason: "shadow" | "holdout" | undefined,
    runId?: string,
    cascadeInfo?: { cascade: CascadeCandidate[]; telemetry: CascadeTelemetry },
  ): void {
    const ev: RetrievalEvent = {
      ts: this.now(),
      queryId,
      event: "retrieval",
      candidates: blockHits.map((h) => {
        const c: RetrievalEvent["candidates"][number] = {
          blockId: h.block.id,
          score: h.score,
        };
        if (h.rerankerScore !== undefined) c.rerankerScore = h.rerankerScore;
        if (h.rerankerRank !== undefined) c.rerankerRank = h.rerankerRank;
        return c;
      }),
      shadow,
      // Only write `controlReason` when we have one. Manual shadow
      // keeps an undefined tag so back-compat readers classify it
      // as diagnostic. Only experimental holdout carries "holdout".
      ...(controlReason ? { controlReason } : {}),
      ...(factHits.length > 0
        ? { factCandidates: factHits.map((h) => ({ factId: h.fact.id, score: h.score })) }
        : {}),
      // B1.1 hardening (P2 #2): the full pre-cascade slate is required
      // for honest B3 replay-screening. Logged only when the cascade
      // ran (recallAsync); sync recall() retains the prior compact event.
      ...(cascadeInfo
        ? {
            preCascadeSlate: cascadeInfo.cascade.map((c) => ({
              blockId: c.block.id,
              score: c.linearScore,
            })),
            rerankerName: cascadeInfo.telemetry.rerankerName,
            rerankerFellBack: cascadeInfo.telemetry.rerankerFellBack,
            ...(cascadeInfo.telemetry.rerankerFallbackReason
              ? { rerankerFallbackReason: cascadeInfo.telemetry.rerankerFallbackReason }
              : {}),
            mmrLambda: cascadeInfo.telemetry.mmrLambda,
            cascadePolicyId: cascadeInfo.telemetry.cascadePolicyId,
          }
        : {}),
    };
    this.emitter.emit(ev, runId !== undefined ? { runId } : undefined);
  }

  private emitInjection(queryId: string, hit: BlockHit, runId?: string): void {
    const ev: InjectionEvent = {
      ts: this.now(),
      queryId,
      event: "injection",
      blockId: hit.block.id,
      score: hit.score,
      calibratedProb: hit.calibratedProb,
    };
    this.emitter.emit(ev, runId !== undefined ? { runId } : undefined);
  }

  private emitFactInjection(queryId: string, hit: FactHit, runId?: string): void {
    const ev: FactInjectionEvent = {
      ts: this.now(),
      queryId,
      event: "fact_injection",
      factId: hit.fact.id,
      score: hit.score,
      calibratedProb: hit.calibratedProb,
    };
    this.emitter.emit(ev, runId !== undefined ? { runId } : undefined);
  }
}

// ---------------------------------------------------------------------------
// Injection formatter — tool-path voice (the legacy shape).
//
// Renders the markdown+xml payload the MCP `get_reasoning_patterns`
// tool has always returned: explicit "Hypothesis" headings, audit
// sub-tags, optional XML tagging for LLMs tuned for XML. The new
// silent / hook-driven path lives in `build-injection-payload.ts`
// and intentionally does NOT share rendering with this function:
// the silent voice is prose, has no audit ribbons, and wraps in a
// `<tracebase queryId="…">` block that the tool voice never emits.
//
// Both paths obey the same `passesGate` contract — only above-gate
// hits render — and both short-circuit on shadow / no-inject
// results. The two payloads stay in lockstep with the analytics
// events that fire in `BlockServer.recall`.
// ---------------------------------------------------------------------------

export interface InjectionFormatOptions {
  /**
   * Output shape. Markdown is the default and what the MCP tool
   * returns. XML is preserved for LLMs / clients tuned to consume
   * XML-tagged context. Both honour the same gate contract.
   */
  format?: "markdown" | "xml";
  /** Include block id + case ref ids for audit. Default true. */
  includeAudit?: boolean;
  /** Include project facts section. Default true. */
  includeFacts?: boolean;
}

/**
 * Turn a recall result into a text blob to inject into the agent's prompt.
 *
 * Gate contract: the formatter renders *exactly* the hits that the
 * server decided to inject (hit.passesGate === true) and nothing else.
 * Low-confidence hits stay in `result.blocks` / `result.facts` for
 * inspection but never reach the prompt — this keeps the injection
 * payload and the `injection` / `fact_injection` analytics events in
 * one-to-one correspondence. Shadow queries always render empty.
 *
 * Framing is always declarative-hypothesis. The agent is free to
 * ignore the contents if the current task does not actually match
 * the block's mechanism.
 */
export function formatInjection(
  result: RecallV2Result,
  opts: InjectionFormatOptions = {},
): string {
  const format = opts.format ?? "markdown";
  const includeAudit = opts.includeAudit ?? true;
  const includeFacts = opts.includeFacts ?? true;

  if (!result.shouldInject) return "";

  const renderableBlocks = result.blocks.filter((h) => h.passesGate);
  const renderableFacts = result.facts.filter((h) => h.passesGate);
  if (renderableBlocks.length === 0 && renderableFacts.length === 0) {
    return "";
  }

  const lines: string[] = [];
  if (format === "markdown") {
    if (renderableBlocks.length > 0) {
      lines.push("## Prior reasoning hypotheses");
      lines.push("");
      lines.push(
        "_The following are hypotheses drawn from prior cases — they may or may not apply to the current task. Consider each, verify independently, discard if the mechanism does not match._",
      );
      lines.push("");
      for (const hit of renderableBlocks) {
        lines.push(renderBlockHitMarkdown(hit, includeAudit));
        lines.push("");
      }
    }
    if (includeFacts && renderableFacts.length > 0) {
      lines.push("## Known project facts");
      lines.push("");
      for (const f of renderableFacts) {
        lines.push(renderFactHitMarkdown(f, includeAudit));
      }
    }
  } else {
    if (renderableBlocks.length > 0) {
      lines.push("<prior_reasoning>");
      for (const hit of renderableBlocks) {
        lines.push(renderBlockHitXml(hit, includeAudit));
      }
      lines.push("</prior_reasoning>");
    }
    if (includeFacts && renderableFacts.length > 0) {
      lines.push("<project_facts>");
      for (const f of renderableFacts) {
        lines.push(renderFactHitXml(f, includeAudit));
      }
      lines.push("</project_facts>");
    }
  }

  return lines.join("\n").trimEnd();
}

function renderBlockHitMarkdown(hit: BlockHit, audit: boolean): string {
  const parts: string[] = [];
  parts.push(`### Hypothesis: ${hit.block.trigger.situation}`);
  parts.push("");
  parts.push(`_If this pattern applies:_ the mechanism is *${hit.block.body.mechanism}*.`);
  if (hit.block.body.deadEnds.length > 0) {
    parts.push("");
    parts.push("_Known dead ends to avoid:_");
    for (const de of hit.block.body.deadEnds) parts.push(`- ${de}`);
  }
  parts.push("");
  parts.push(`_Possible unlock:_ ${hit.block.body.unlock}`);
  parts.push("");
  parts.push(`_You can verify by:_ ${hit.block.body.verification}`);
  if (audit) {
    parts.push("");
    const refList = hit.refs.map((r) => `${r.traceId} (${r.role})`).join(", ");
    parts.push(
      `<sub>Audit: block ${hit.block.id}, calibrated ${hit.calibratedProb.toFixed(2)}, evidence: ${refList || "none"}</sub>`,
    );
  }
  return parts.join("\n");
}

function renderBlockHitXml(hit: BlockHit, audit: boolean): string {
  const parts: string[] = [];
  parts.push(`  <hypothesis id="${hit.block.id}" calibrated="${hit.calibratedProb.toFixed(3)}">`);
  parts.push(`    <situation>${escapeXml(hit.block.trigger.situation)}</situation>`);
  parts.push(`    <mechanism>${escapeXml(hit.block.body.mechanism)}</mechanism>`);
  if (hit.block.body.deadEnds.length > 0) {
    parts.push("    <dead_ends>");
    for (const de of hit.block.body.deadEnds) {
      parts.push(`      <item>${escapeXml(de)}</item>`);
    }
    parts.push("    </dead_ends>");
  }
  parts.push(`    <unlock>${escapeXml(hit.block.body.unlock)}</unlock>`);
  parts.push(`    <verification>${escapeXml(hit.block.body.verification)}</verification>`);
  if (audit) {
    for (const r of hit.refs) {
      parts.push(`    <evidence trace="${escapeXml(r.traceId)}" role="${r.role}"/>`);
    }
  }
  parts.push("  </hypothesis>");
  return parts.join("\n");
}

function renderFactHitMarkdown(f: FactHit, audit: boolean): string {
  const tag = `(${f.fact.factType}, scope=${f.fact.scope})`;
  const audStr = audit ? ` <sub>[id ${f.fact.id}, conf ${f.fact.confidence.toFixed(2)}]</sub>` : "";
  return `- **${tag}** ${f.fact.statement}${audStr}`;
}

function renderFactHitXml(f: FactHit, audit: boolean): string {
  const auditAttrs = audit
    ? ` id="${f.fact.id}" confidence="${f.fact.confidence.toFixed(3)}"`
    : "";
  return `  <fact scope="${escapeXml(f.fact.scope)}" type="${f.fact.factType}"${auditAttrs}>${escapeXml(f.fact.statement)}</fact>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
