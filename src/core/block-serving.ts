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
  ServingTelemetry,
  InjectionEvent,
  FactInjectionEvent,
  RouterShadowComparisonEvent,
  RouterShadowAgreement,
  RouterShadowFallback,
  RetrievalHybridComparisonEvent,
  RetrievalFallback,
  RetrievalDecisionAgreement,
  ReasoningEvidenceComparisonEvent,
  EvidenceComparisonAgreement,
  EvidenceFallback,
  ReasoningQueryCompilerComparisonEvent,
  QueryCompilerFallback,
  ReasoningApplicabilityComparisonEvent,
  ApplicabilityFallback,
  ApplicabilityChangedDecision,
} from "../types.js";
import {
  type Reranker,
  type RerankerFallbackReason,
  NoopReranker,
  blockCandidatesFor,
  withRerankerFallback,
} from "./reranker.js";
import { mmr, DEFAULT_MMR_LAMBDA, type MMRItem } from "./mmr.js";
import { tokenizeInformative, queryHash } from "./serving-tokenizer.js";
import {
  decideServing,
  resolveServingPolicy,
  SERVING_FEATURE_VERSION,
  type ServingPolicy,
  type ServingDecision,
  type ServingEvidenceV1,
  type ServingQuery,
  type ServingCandidate,
  type EvidenceCalibrator,
} from "./serving-confidence.js";
import { decideServingV2, type ServingModeV2 } from "./serving-decision-v2.js";
import { decideServingV3 } from "./serving-decision-v3.js";
import { decideServingV4 } from "./serving-decision-v4.js";
import {
  StructuredQueryCompiler,
  type RuntimeQueryCompiler,
  type CompiledQuery,
} from "./runtime-query-compiler.js";
import type { QueryCompilerRolloutMode } from "../experiments/reasoning-query-compiler-rollout.js";
import type { ApplicabilityRolloutMode } from "../experiments/reasoning-applicability-rollout.js";
import {
  DeterministicApplicabilityReranker,
  type ApplicabilityProvider,
  type ApplicabilityCandidate,
  type ApplicabilityResult,
} from "./applicability-reranker.js";
import { StructuredSignatureResolver, type FamilyCandidate } from "./reasoning-family.js";
import { evaluateApplicabilityCanaryExposure } from "../experiments/applicability-canary.js";
import type { ApplicabilityCanaryConfig, ApplicabilityCanaryExposureEvent } from "../types.js";
import { SERVING_FEATURE_VERSION_V2, buildStructuredView } from "./serving-evidence-v2.js";
import {
  fuseHybrid,
  RETRIEVAL_INTENT_VERSION,
  type RetrievalProvider,
  type RetrievalCandidate,
  type RetrievalIntent,
  type RetrievalRolloutMode,
  type RetrievalProvenance,
  type HybridSlateItem,
  type ProviderLocation,
} from "./retrieval-provider.js";
import { buildRetrievalIntent, buildRetrievalDocument, buildVectorOnlyDocument } from "./retrieval-dto.js";

/** Numeric alias for the event field (the const is a literal-typed `1`). */
const SERVING_FEATURE_VERSION_NUM: number = SERVING_FEATURE_VERSION;
const SERVING_FEATURE_VERSION_V2_NUM: number = SERVING_FEATURE_VERSION_V2;

/**
 * Serving representation the BlockServer routes through. `"v1"` (default) is
 * the production, byte-for-byte-unchanged path. The two `"v2-*"` modes opt into
 * the Router V2 structured/family-aware decision; they are additive, gated, and
 * fail open to V1 on any error.
 */
export type ServingMode = "v1" | ServingModeV2;

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
  /**
   * Per-call gate override on [0, 1]. When set, replaces
   * `BlockServerOptions.gateThreshold` for this single recall. Used by
   * the drift-trigger path in `src/runtime/recall.ts`: when the tool-
   * pattern detector fires (agent is stuck / repeating / pingponging),
   * the prior strongly favors "any past pattern is worth surfacing"
   * over the static production gate. The relaxed gate is applied for
   * one call only — concurrent recalls retain the configured gate.
   *
   * Out-of-range values (NaN, <0, >1) are ignored — same fail-safe
   * posture as `resolveProductionGateThreshold`.
   */
  gateOverride?: number;
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
   * Absolute evidence confidence (serving-confidence feature v1) that fed
   * the calibrator + gate for this hit — the calibrator-learnable signal,
   * recorded on the injection event so training and serving share a domain.
   */
  evidenceConfidence: number;
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
   *   - the serving-confidence decision abstained.
   */
  shouldInject: boolean;
  /**
   * The serving-confidence decision for this recall (block side): the
   * fire/abstain action, the abstention reason, the top candidate's feature
   * vector, calibrated probability, and the thresholds in force. Always
   * present for block recalls; surfaced for CLI/debug + telemetry. Absent
   * only on legacy callers that pre-date the decision layer.
   */
  servingDecision?: ServingDecision;
  /**
   * Phase C.2 shadow ServingEvidenceV3 decision, populated ONLY when
   * `evidenceMode === "shadow"`. The V3 decision is NEVER served (served stays
   * V1/V2); this surfaces what V3 WOULD have decided, for evaluation. Carries
   * the selected candidate's lane + license reason.
   */
  shadowV3?: {
    action: "inject" | "abstain";
    reason: string;
    topBlockId?: string;
    lane: string;
    licenseReason: string;
  };
  /**
   * Phase C.3 shadow ServingEvidenceV4 decision, populated ONLY when
   * `evidenceMode === "shadow"` (computed alongside V3). V4 tightens the V3
   * license with a contrastive applicability gap and is NEVER served. Carries
   * the selected candidate's lane, license/ambiguity reason, and the bounded
   * contrastive support vs its nearest sibling.
   */
  shadowV4?: {
    action: "inject" | "abstain";
    reason: string;
    topBlockId?: string;
    lane: string;
    licenseReason: string;
    discriminativeSupport?: number;
    hasCompetitor?: boolean;
  };
  /**
   * Phase D.1 shadow two-view query-compiler comparison, populated ONLY when
   * `queryCompilerMode === "shadow"`. Surfaces the per-arm V4 actions on the
   * sparse / literal-hybrid / literal+causal candidate slates; NEVER served.
   */
  shadowQueryCompiler?: {
    sparseAction: "inject" | "abstain";
    literalAction: "inject" | "abstain";
    causalAction: "inject" | "abstain";
    causalLaneInvoked: boolean;
    causalAddedDecision: boolean;
    causalSemanticOnly: number;
  };
  /**
   * Phase D.2 shadow applicability-reranker comparison, populated ONLY when
   * `applicabilityMode === "shadow"`. Surfaces the served V4 action vs the
   * reranker verdict on the top-N prototypes; NEVER served.
   */
  shadowApplicability?: {
    v4Action: "inject" | "abstain";
    verdict: "applicable" | "uncertain" | "inapplicable" | "none";
    topBlockId?: string;
    changedDecision: "none" | "reranker_only_apply" | "reranker_withholds";
    fallback: "none" | "timeout" | "error";
  };
  /**
   * Phase D.4 — applicability canary exposure, populated ONLY when the explicit-
   * opt-in canary is enabled AND the query was eligible. `treatment` means the
   * reranker block was injected (and an injection event emitted); `control`
   * preserves the baseline abstain. Absent when the canary is off — serving is
   * then byte-identical.
   */
  canaryExposure?: {
    arm: "treatment" | "control";
    blockId: string;
    propensity: number;
    unitHash: string;
  };
}

export type Calibrator = (score: number, block: ReasoningBlock) => number;

export const identityCalibrator: Calibrator = (score) => score;

/**
 * May-2026 — production gate default. Reserved for the post-calibrator
 * world: when an isotonic calibrator is fit (Phase 5), `calibratedProb`
 * stops being identity-passed-through from raw FTS bm25, and a non-
 * zero gate starts filtering low-confidence hits in the demo path.
 * Pre-calibrator the maxRel-normalized top hit is always 1.0, so any
 * gate below 1 lets it through — the gate scaffolding ships ahead of
 * the calibrator so production behavior shifts automatically when
 * the model lands.
 */
export const DEFAULT_GATE_THRESHOLD = 0.4;

/**
 * May-2026 — env override for production callsites. Lets integration
 * tests (which exercise the production code path directly, not the
 * test-friendly class default) pin gate=0 on tiny FTS corpuses where
 * IDF degenerates. Returns `DEFAULT_GATE_THRESHOLD` when the env var
 * is unset or unparseable — an invalid value is treated as "not
 * configured", never as a silent disable, since silently dropping
 * the gate would re-introduce the single-hit-1.0 pathology once the
 * calibrator ships.
 */
export function resolveProductionGateThreshold(): number {
  const raw = process.env.TRACEBASE_GATE_THRESHOLD;
  if (raw === undefined || raw === "") return DEFAULT_GATE_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_GATE_THRESHOLD;
  }
  return parsed;
}

/**
 * Resolve the effective gate for a single recall call. When the caller
 * supplied a valid `gateOverride` on the query (a finite number in [0,
 * 1]), it wins; otherwise the BlockServer-configured `gateThreshold`
 * stands. An out-of-range override is treated as "not configured" — we
 * never silently swing the gate to something the caller didn't intend.
 */
export function resolveQueryGate(
  override: number | undefined,
  configured: number,
): number {
  if (override === undefined) return configured;
  if (!Number.isFinite(override) || override < 0 || override > 1) {
    return configured;
  }
  return override;
}

/**
 * Default gate threshold for drift-triggered recalls — half of
 * production. The agent being in a tool loop is a strong prior that
 * "any past pattern is worth surfacing", so we deliberately accept
 * lower-confidence hits that the static production gate would filter.
 * This is the only place the drift path is allowed to relax safety
 * checks; everything else (FTS sanitization, leakage scans, holdout
 * eligibility) continues to apply unchanged.
 */
export const DEFAULT_DRIFT_GATE_THRESHOLD = DEFAULT_GATE_THRESHOLD * 0.5;

export interface BlockServerOptions {
  /**
   * Minimum calibrated probability for `shouldInject = true`. Defaults
   * to 0 (everything passes) so unit tests with tiny corpuses can
   * observe hits. Production callsites should pass
   * `DEFAULT_GATE_THRESHOLD` so weak single-hit matches do not pollute
   * the live context window.
   */
  gateThreshold?: number;
  /** Maps raw ranker score + block → P(helpful). Identity by default. */
  calibrator?: Calibrator;
  /**
   * Version of the supplied `calibrator`, stamped on serving telemetry.
   * "identity" (default) when unfitted; the fitted model's featureVersion
   * when a real calibrator is wired in. Lets the aggregator split calibrated
   * vs uncalibrated traffic without inspecting the function.
   */
  calibratorVersion?: number | "identity";
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
  /**
   * Serving representation. Default `"v1"` — the production decision path is
   * unchanged. `"v2-representation"` / `"v2-family"` opt into the Router V2
   * structured + family-aware decision (additive; fails open to V1). The
   * candidate-generation, retrieval, telemetry, holdout, and privacy paths are
   * IDENTICAL across modes — only the FIRE-vs-ABSTAIN evidence + margin differ.
   */
  servingMode?: ServingMode;
  /**
   * Router V2 SHADOW evaluation (rollout=shadow). When set, every recall
   * ALSO computes this V2 decision side-by-side on the SAME candidate slate and
   * emits a privacy-safe `router.shadow_comparison` event — WITHOUT affecting
   * the injected context (which still follows `servingMode`). Undefined by
   * default (no shadow work, no comparison event). The rollout resolver sets
   * this to `"v2-family"` only in shadow mode.
   */
  shadowEvaluate?: ServingModeV2;
  /**
   * Phase C hybrid retrieval rollout. Default `"off"` — sparse FTS only, no
   * provider invoked, byte-for-byte the legacy slate. `"shadow"` serves the
   * sparse slate unchanged but records a sparse-vs-hybrid comparison;
   * `"on"` serves the fused hybrid slate (fail-open to sparse). The hybrid path
   * is async (providers are async) and runs via `recallHybrid` /
   * `emitHybridComparison`; the sync `recall()` fast path is always sparse.
   */
  retrievalMode?: RetrievalRolloutMode;
  /**
   * Semantic candidate provider for hybrid retrieval. Required for shadow/on to
   * contribute anything; absent ⇒ the hybrid path falls open to sparse. Must
   * be deterministic and fail-open (return null on any failure). Defaults to
   * none.
   */
  retrievalProvider?: RetrievalProvider;
  /** Hard wall-clock budget for one semantic provider call. Default 250ms. */
  retrievalDeadlineMs?: number;
  /**
   * Phase C.2 ServingEvidenceV3 rollout. Default `"off"`. `"shadow"` computes
   * the V3 semantic-license decision side-by-side and persists a comparison,
   * WITHOUT serving it (served stays V1/V2). There is no production `"on"`.
   */
  evidenceMode?: "off" | "shadow";
  /**
   * Phase D.1 two-view query-compiler rollout. Default `"off"` — candidate
   * generation is byte-identical and the compiler is never invoked. `"shadow"`
   * serves the existing path unchanged but compiles the literal/causal views and
   * records a sparse / literal-hybrid / literal+causal candidate comparison
   * (V4 over each), local-only. There is no production `"on"`.
   */
  queryCompilerMode?: QueryCompilerRolloutMode;
  /**
   * The runtime query compiler used in `queryCompilerMode="shadow"`. Pure +
   * deterministic. Defaults to `StructuredQueryCompiler`.
   */
  queryCompiler?: RuntimeQueryCompiler;
  /**
   * Phase D.2 memory-applicability reranker rollout. Default `"off"` — the
   * reranker is never invoked and serving is byte-identical. `"shadow"` runs the
   * reranker over the top-N prototypes after candidate generation and records a
   * V4-vs-reranker comparison, WITHOUT serving it. There is no production `"on"`.
   */
  applicabilityMode?: ApplicabilityRolloutMode;
  /** The applicability reranker used in `applicabilityMode="shadow"`. Defaults to the deterministic baseline. */
  applicabilityProvider?: ApplicabilityProvider;
  /** Hard wall-clock budget for one reranker call. Default 250ms. */
  applicabilityDeadlineMs?: number;
}

// ---------------------------------------------------------------------------
// FTS stop-word list — MOVED to serving-tokenizer.ts
// ---------------------------------------------------------------------------
//
// The stop-word / informative-token policy is now canonical in
// `serving-tokenizer.ts`, shared by FTS sanitization, serving evidence, and
// offline eval so retrieval and gating cannot diverge. `sanitizeFtsQuery`
// below builds its FTS string from `tokenizeInformative`. Back-compat:
// `STOP_WORDS` is re-exported here as `FTS_STOP_WORDS` for existing importers.
export { STOP_WORDS as FTS_STOP_WORDS } from "./serving-tokenizer.js";

// ---------------------------------------------------------------------------
// BlockServer
// ---------------------------------------------------------------------------

export class BlockServer {
  private readonly store: BlockStore;
  private readonly gateThreshold: number;
  /**
   * Conservative serving-confidence policy (evidence floor, margin,
   * meaningful-match minimum). The calibrated gate inside it tracks
   * `gateThreshold`; the other guards are corpus-size-invariant and apply
   * even when the gate is 0 (e.g. unit tests), which is what stops the
   * legacy 100%-fire-rate on weak/ambiguous matches.
   */
  private readonly policy: ServingPolicy;
  // Mutable so a freshly-fitted calibrator can be hot-swapped without
  // restarting the MCP server. The auto-refit loop in
  // `src/lifecycle/calibrator-refit.ts` calls `setCalibrator()` after
  // it persists a new isotonic model — production traffic immediately
  // routes through the better-fit model on the next recall.
  private calibrator: Calibrator;
  /** Version tag for the active calibrator; stamped on serving telemetry. */
  private calibratorVersion: number | "identity";
  private readonly emitEvents: boolean;
  private readonly now: () => number;
  private readonly emitter: EventEmitter;
  // May-2026 B1 cascade — reranker + MMR.
  private readonly reranker: Reranker;
  private readonly rerankerTimeoutMs: number;
  private readonly mmrLambda: number;
  private readonly cascadeFetchMultiplier: number;
  /** Serving representation (v1 default; v2-* opt-in, fail-open). */
  private readonly servingMode: ServingMode;
  /** Router V2 shadow evaluation (rollout=shadow); undefined = no shadow work. */
  private readonly shadowEvaluate: ServingModeV2 | undefined;
  /** Phase C hybrid retrieval rollout (off default; shadow/on opt-in, fail-open). */
  private readonly retrievalMode: RetrievalRolloutMode;
  private readonly retrievalProvider: RetrievalProvider | undefined;
  private readonly retrievalDeadlineMs: number;
  /** Phase C.2 ServingEvidenceV3 rollout (off default; shadow computes V3, never serves it). */
  private readonly evidenceMode: "off" | "shadow";
  /** Phase D.1 two-view query-compiler rollout (off default; shadow compares candidate slates). */
  private readonly queryCompilerMode: QueryCompilerRolloutMode;
  private readonly queryCompiler: RuntimeQueryCompiler;
  /** Phase D.2 applicability-reranker rollout (off default; shadow compares V4 vs reranker). */
  private readonly applicabilityMode: ApplicabilityRolloutMode;
  private readonly applicabilityProvider: ApplicabilityProvider;
  private readonly applicabilityDeadlineMs: number;

  constructor(store: BlockStore, opts: BlockServerOptions = {}) {
    this.store = store;
    // Class default stays 0 so unit tests with tiny single-block
    // corpuses (where FTS5 IDF degenerates) still observe hits.
    // Production callsites read `resolveProductionGateThreshold()`
    // which returns `DEFAULT_GATE_THRESHOLD` unless the env var
    // `TRACEBASE_GATE_THRESHOLD` overrides — the gate becomes
    // meaningful once an isotonic calibrator is fit and
    // `calibratedProb` stops being identity-passed-through.
    this.gateThreshold = opts.gateThreshold ?? 0;
    // Evidence-policy guards (margin / floor / meaningful-match minimum)
    // come from defaults + env; the calibrated-gate field tracks the
    // configured gateThreshold so a per-call override still flows through.
    this.policy = resolveServingPolicy({ gateThreshold: this.gateThreshold }).policy;
    this.calibrator = opts.calibrator ?? identityCalibrator;
    this.calibratorVersion = opts.calibratorVersion ?? "identity";
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
    this.servingMode = opts.servingMode ?? "v1";
    this.shadowEvaluate = opts.shadowEvaluate;
    this.retrievalMode = opts.retrievalMode ?? "off";
    this.retrievalProvider = opts.retrievalProvider;
    this.retrievalDeadlineMs = Math.max(1, opts.retrievalDeadlineMs ?? 250);
    this.evidenceMode = opts.evidenceMode ?? "off";
    this.queryCompilerMode = opts.queryCompilerMode ?? "off";
    this.queryCompiler = opts.queryCompiler ?? new StructuredQueryCompiler();
    this.applicabilityMode = opts.applicabilityMode ?? "off";
    this.applicabilityProvider = opts.applicabilityProvider ?? new DeterministicApplicabilityReranker();
    this.applicabilityDeadlineMs = Math.max(1, opts.applicabilityDeadlineMs ?? 250);
  }

  /** Hybrid retrieval rollout mode (off default). The recall entry routes
   *  shadow/on through the async hybrid path; off stays on sync sparse. */
  /** ServingEvidenceV3 rollout mode (off default; shadow computes V3, never serves it). */
  get evidenceRollout(): "off" | "shadow" {
    return this.evidenceMode;
  }

  get retrievalRollout(): RetrievalRolloutMode {
    return this.retrievalMode;
  }

  /** Phase D.1 query-compiler rollout mode (off default; shadow compares candidate slates). */
  get queryCompilerRollout(): QueryCompilerRolloutMode {
    return this.queryCompilerMode;
  }

  /** Phase D.2 applicability-reranker rollout mode (off default; shadow compares V4 vs reranker). */
  get applicabilityRollout(): ApplicabilityRolloutMode {
    return this.applicabilityMode;
  }

  /**
   * Hot-swap the calibrator. Called by the auto-refit loop after a new
   * isotonic model lands in `calibrator_models`. The swap is atomic — the
   * NEXT recall on this BlockServer instance sees the new model; in-flight
   * recalls (`recallAsync` on the cascade path) keep the reference they
   * captured at the start of their call, so a swap mid-recall cannot
   * produce a mixed-scoring result.
   */
  setCalibrator(calibrator: Calibrator, version: number | "identity" = "identity"): void {
    this.calibrator = calibrator;
    this.calibratorVersion = version;
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
    const startedAt = this.now();
    const queryId = query.queryId ?? randomUUID();
    const manualShadow = query.shadow ?? false;
    const limit = query.limit ?? 5;
    const factLimit = query.factLimit ?? 5;
    const refLimit = query.refLimit ?? 3;

    const blocks = this.searchBlocks(query.text, query.invariants, limit);
    const rawFacts = this.searchFacts(query.text, query.invariants, query.scope, factLimit);

    return this.finalizeRecall(query, queryId, manualShadow, refLimit, blocks, rawFacts, startedAt);
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
    const startedAt = this.now();
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
      startedAt,
      { cascade: cascadeRanked, telemetry },
    );
  }

  // -------------------------------------------------------------------------
  // Phase C — hybrid retrieval (sparse FTS ⊕ optional semantic provider)
  // -------------------------------------------------------------------------

  /**
   * Serve the FUSED hybrid slate (rollout=on). Builds the sparse FTS slate
   * (always available), unions it with the optional semantic provider's
   * candidates via RRF, and decides on the fused top-N. Fail-open: if no
   * provider is configured or it returns null/times-out/throws, the fused slate
   * is exactly the sparse slate, so this degrades to the sparse decision.
   */
  async recallHybrid(query: BlockRecallQuery): Promise<RecallV2Result> {
    const startedAt = this.now();
    const queryId = query.queryId ?? randomUUID();
    const manualShadow = query.shadow ?? false;
    const limit = query.limit ?? 5;
    const factLimit = query.factLimit ?? 5;
    const refLimit = query.refLimit ?? 3;
    const fetchLimit = limit * this.cascadeFetchMultiplier;

    const sparse = this.searchBlocks(query.text, query.invariants, fetchLimit);
    let slate = fuseHybrid(sparse, null, (id) => this.store.getBlock(id), limit, "none").slate;
    try {
      const sem = await this.semanticSlate(query, fetchLimit);
      slate = fuseHybrid(sparse, sem.candidates, (id) => this.store.getBlock(id), limit, sem.providerClass).slate;
    } catch {
      // fail open to the sparse-with-provenance slate already set above.
    }
    const rawFacts = this.searchFacts(query.text, query.invariants, query.scope, factLimit);
    return this.finalizeRecall(query, queryId, manualShadow, refLimit, slate, rawFacts, startedAt);
  }

  /**
   * Compute the hybrid slate side-by-side and emit a privacy-safe
   * `retrieval.hybrid_comparison` event (rollout=shadow). NEVER serves anything
   * and NEVER throws — the served result is whatever the caller already
   * produced from the sparse path. A distinct, additive, local-only stream.
   */
  async emitHybridComparison(query: BlockRecallQuery, queryId: string): Promise<void> {
    if (this.retrievalMode !== "shadow") return;
    try {
      const t0 = this.now();
      const limit = query.limit ?? 5;
      const fetchLimit = limit * this.cascadeFetchMultiplier;
      const sparse = this.searchBlocks(query.text, query.invariants, fetchLimit);
      const sparseTop = sparse.slice(0, limit);
      const sem = await this.semanticSlate(query, fetchLimit);
      const fused = fuseHybrid(sparse, sem.candidates, (id) => this.store.getBlock(id), limit, sem.providerClass);
      const sparseDecision = this.decideOnSlate(query, sparseTop);
      const hybridDecision = this.decideOnSlate(query, fused.slate);
      const event: RetrievalHybridComparisonEvent = {
        event: "retrieval.hybrid_comparison",
        ts: this.now(),
        queryId,
        ...(query.runId ? { runId: query.runId } : {}),
        queryHash: queryHash(query.text),
        corpusSize: this.store.countBlocks("active"),
        provider: sem.provider,
        fallback: sem.fallback,
        providerLatencyMs: sem.latencyMs,
        hybridLatencyMs: Math.max(0, this.now() - t0),
        sparseSlateSize: fused.telemetry.sparseSlateSize,
        semanticSlateSize: fused.telemetry.semanticSlateSize,
        hybridSlateSize: fused.telemetry.fusedSlateSize,
        overlap: fused.telemetry.overlap,
        semanticOnly: fused.telemetry.semanticOnly,
        rankMovement: fused.telemetry.rankMovement,
        sparseAction: sparseDecision.action,
        hybridAction: hybridDecision.action,
        ...(sparseDecision.topCandidateId ? { sparseTopBlockId: sparseDecision.topCandidateId } : {}),
        ...(hybridDecision.topCandidateId ? { hybridTopBlockId: hybridDecision.topCandidateId } : {}),
        decisionAgreement: retrievalDecisionAgreement(
          sparseDecision.action,
          sparseDecision.topCandidateId,
          hybridDecision.action,
          hybridDecision.topCandidateId,
        ),
        featureVersion: hybridDecision.featureVersion,
      };
      this.emitter.emit(event, query.runId ? { runId: query.runId } : undefined);
    } catch {
      // shadow telemetry must never break or alter a recall.
    }
  }

  /**
   * Phase D.1 two-view query-compiler comparison (queryCompilerMode=shadow).
   * Compiles the literal/causal views, builds three candidate slates —
   *   sparse baseline      = FTS over the raw query;
   *   literal-hybrid       = FTS(literal view) ⊕ semantic(literal view);
   *   literal+causal       = literal-hybrid ⊕ semantic(causal view), invoked by
   *                          the cascade ONLY when the literal arm abstained;
   * adjudicates each with the shadow V4 decision, and emits a privacy-safe
   * `reasoning.query_compiler_comparison` event. NEVER serves, NEVER throws —
   * the served result is whatever the caller already produced. Returns the
   * shadow summary for the recall result. Off ⇒ never called (byte-identical).
   */
  async emitQueryCompilerComparison(
    query: BlockRecallQuery,
    queryId: string,
  ): Promise<NonNullable<RecallV2Result["shadowQueryCompiler"]> | undefined> {
    if (this.queryCompilerMode !== "shadow") return undefined;
    const t0 = this.now();
    let fallback: QueryCompilerFallback = "none";
    let providerFallback: RetrievalFallback = "none";
    try {
      const limit = query.limit ?? 5;
      const fetchLimit = limit * this.cascadeFetchMultiplier;
      const lookup = (id: string): ReasoningBlock | null => this.store.getBlock(id);

      const compiled: CompiledQuery = this.queryCompiler.compile(query.text, query.invariants);

      // Arm 1 — sparse baseline: FTS over the raw query (current behaviour).
      const sparseRaw = this.searchBlocks(query.text, query.invariants, fetchLimit);
      const sparseSlate = fuseHybrid(sparseRaw, null, lookup, limit, "none").slate;

      // Arm 2 — literal-hybrid: FTS(literal view) ⊕ semantic(literal view).
      const sparseLiteral = this.searchBlocks(compiled.literal.text, compiled.literal.invariants, fetchLimit);
      const litIntent: RetrievalIntent = {
        ...buildRetrievalIntent(compiled.literal.text, compiled.literal.invariants, fetchLimit),
        view: "literal",
        intentVersion: RETRIEVAL_INTENT_VERSION,
      };
      const semLit = await this.semanticSlate(query, fetchLimit, litIntent);
      if (semLit.fallback !== "none") providerFallback = semLit.fallback;
      const literalFused = fuseHybrid(sparseLiteral, semLit.candidates, lookup, limit, semLit.providerClass);
      const literalSlate = literalFused.slate;
      const literalDecision = this.decideV4OnSlate(compiled.literal.text, compiled.literal.invariants, literalSlate);

      // Arm 3 — literal+causal: add semantic(causal view) — cascade-gated: only
      // when the literal arm abstained (the fast slate was insufficient) AND the
      // compiler produced a causal view.
      let causalSlate = literalSlate;
      let causalLaneInvoked = false;
      let causalSemanticOnly = 0;
      if (compiled.causal && literalDecision.action === "abstain") {
        causalLaneInvoked = true;
        const causIntent: RetrievalIntent = {
          ...buildRetrievalIntent(compiled.causal.text, undefined, fetchLimit),
          view: "causal",
          intentVersion: RETRIEVAL_INTENT_VERSION,
        };
        const semCau = await this.semanticSlate(query, fetchLimit, causIntent);
        if (semCau.fallback !== "none" && providerFallback === "none") providerFallback = semCau.fallback;
        // Union the two semantic candidate lists (literal ⊕ causal), keeping the
        // best per-block score, then fuse with the literal FTS slate.
        const merged = mergeCandidates(semLit.candidates, semCau.candidates);
        const causalFused = fuseHybrid(sparseLiteral, merged, lookup, limit, semCau.providerClass);
        causalSlate = causalFused.slate;
        causalSemanticOnly = causalFused.telemetry.semanticOnly;
      }

      const sparseDecision = this.decideV4OnSlate(query.text, query.invariants, sparseSlate);
      // The causal arm is adjudicated on the causal view when the cascade ran it;
      // otherwise it mirrors the literal arm (same slate + view).
      const causalServingText = causalLaneInvoked && compiled.causal ? compiled.causal.text : compiled.literal.text;
      const causalServingInv = causalLaneInvoked && compiled.causal ? undefined : compiled.literal.invariants;
      const causalDecision = this.decideV4OnSlate(causalServingText, causalServingInv, causalSlate);
      const causalAddedDecision =
        causalDecision.action === "inject" && sparseDecision.action === "abstain" && literalDecision.action === "abstain";

      const event: ReasoningQueryCompilerComparisonEvent = {
        event: "reasoning.query_compiler_comparison",
        ts: this.now(),
        queryId,
        ...(query.runId ? { runId: query.runId } : {}),
        queryHash: queryHash(query.text),
        compiler: compiled.compiler,
        literalViewHash: compiled.literal.viewHash,
        ...(compiled.causal ? { causalViewHash: compiled.causal.viewHash } : {}),
        corpusSize: this.store.countBlocks("active"),
        sparseSlateSize: sparseSlate.length,
        literalSlateSize: literalSlate.length,
        causalSlateSize: causalSlate.length,
        literalSemanticOnly: literalFused.telemetry.semanticOnly,
        causalSemanticOnly,
        causalLaneInvoked,
        sparseV4Action: sparseDecision.action,
        literalV4Action: literalDecision.action,
        causalV4Action: causalDecision.action,
        ...(sparseDecision.topCandidateId ? { sparseV4TopBlockId: sparseDecision.topCandidateId } : {}),
        ...(literalDecision.topCandidateId ? { literalV4TopBlockId: literalDecision.topCandidateId } : {}),
        ...(causalDecision.topCandidateId ? { causalV4TopBlockId: causalDecision.topCandidateId } : {}),
        causalAddedDecision,
        providerFallback,
        fallback,
        incrementalLatencyMs: Math.max(0, this.now() - t0),
      };
      this.emitter.emit(event, query.runId ? { runId: query.runId } : undefined);
      return {
        sparseAction: sparseDecision.action,
        literalAction: literalDecision.action,
        causalAction: causalDecision.action,
        causalLaneInvoked,
        causalAddedDecision,
        causalSemanticOnly,
      };
    } catch {
      fallback = "error";
      return undefined; // shadow telemetry must never break or alter a recall.
    }
  }

  /**
   * Phase D.2 memory-applicability reranker comparison (applicabilityMode=shadow).
   * Runs AFTER candidate generation: builds the hybrid slate, takes the served V4
   * decision as the baseline, then runs the applicability reranker over the top-N
   * family prototypes (bounded, async, strict timeout) and emits a privacy-safe
   * `reasoning.applicability_comparison` event. NEVER serves, NEVER throws — fails
   * open to the unchanged V4 decision. Returns the shadow summary. Off ⇒ never
   * called (serving byte-identical).
   */
  async emitApplicabilityComparison(
    query: BlockRecallQuery,
    queryId: string,
  ): Promise<NonNullable<RecallV2Result["shadowApplicability"]> | undefined> {
    if (this.applicabilityMode !== "shadow") return undefined;
    const t0 = this.now();
    let fallback: ApplicabilityFallback = "none";
    try {
      const limit = query.limit ?? 5;
      const fetchLimit = limit * this.cascadeFetchMultiplier;
      const lookup = (id: string): ReasoningBlock | null => this.store.getBlock(id);

      // Build the same bounded slate V4 sees (sparse ⊕ optional semantic).
      const sparse = this.searchBlocks(query.text, query.invariants, fetchLimit);
      const sem = await this.semanticSlate(query, fetchLimit);
      const slate = fuseHybrid(sparse, sem.candidates, lookup, limit, sem.providerClass).slate;

      // Baseline: the served V4 decision on this slate.
      const v4 = this.decideV4OnSlate(query.text, query.invariants, slate);

      // Reranker candidates: top-N prototypes with privacy-scanned tokens + family
      // / outcome signals. Family support/diversity from a cheap signature group.
      const blocks = slate.map((s) => s.block);
      const familyByIdx = this.familyGrouping(blocks);
      const candidates: ApplicabilityCandidate[] = blocks.map((b, i) => {
        const view = buildStructuredView(b);
        const fam = familyByIdx[i]!;
        const s = b.stats;
        const helpful = s?.timesHelpful ?? 0;
        const harmful = s?.timesCounterproductive ?? 0;
        return {
          blockId: b.id,
          tokens: {
            situation: [...view.situationTokens],
            mechanism: [...view.fieldTokens.mechanism],
            unlock: [...view.fieldTokens.unlock],
            invariants: view.memory.invariants,
          },
          signals: {
            isPitfall: (b.kind ?? "success") === "pitfall",
            helpful,
            harmful,
            unresolved: Math.max(0, (s?.timesAgentUsed ?? 0) - helpful - harmful),
            familySupport: fam.support,
            sourceDiversity: fam.sourceDiversity,
          },
        };
      });

      const compiled: CompiledQuery = this.queryCompiler.compile(query.text, query.invariants);
      const views = { literalText: compiled.literal.text, ...(compiled.causal ? { causalText: compiled.causal.text } : {}) };

      // Bounded, strict-timeout reranker call; null ⇒ fail open to V4.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof APPLICABILITY_TIMEOUT>((res) => {
        timer = setTimeout(() => res(APPLICABILITY_TIMEOUT), this.applicabilityDeadlineMs);
        timer.unref?.();
      });
      const ctx = { deadlineMs: this.applicabilityDeadlineMs, now: this.now };
      const raced = await Promise.race([this.applicabilityProvider.rank(views, candidates, ctx), timeout]);
      if (timer) clearTimeout(timer);

      let results: ApplicabilityResult[] | null = null;
      if (raced === APPLICABILITY_TIMEOUT) fallback = "timeout";
      else results = raced;

      const top = results && results.length > 0 ? results[0]! : undefined;
      const verdict: "applicable" | "uncertain" | "inapplicable" | "none" = top ? top.verdict : "none";
      const rerankerInjects = verdict === "applicable";
      const v4Injects = v4.action === "inject";
      const changedDecision: ApplicabilityChangedDecision =
        rerankerInjects && !v4Injects ? "reranker_only_apply" : !rerankerInjects && v4Injects ? "reranker_withholds" : "none";

      const verdictCounts = { applicable: 0, uncertain: 0, inapplicable: 0 };
      const reasonCounts: Record<string, number> = {};
      for (const r of results ?? []) {
        verdictCounts[r.verdict]++;
        for (const reason of r.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      }

      const event: ReasoningApplicabilityComparisonEvent = {
        event: "reasoning.applicability_comparison",
        ts: this.now(),
        queryId,
        ...(query.runId ? { runId: query.runId } : {}),
        queryHash: queryHash(query.text),
        corpusSize: this.store.countBlocks("active"),
        candidateCount: candidates.length,
        v4Action: v4.action,
        ...(v4.topCandidateId ? { v4TopBlockId: v4.topCandidateId } : {}),
        applicabilityProvider: this.applicabilityProvider.name,
        applicabilityFeatureVersion: this.applicabilityProvider.featureVersion,
        applicabilityVerdict: verdict,
        ...(top ? { applicabilityTopBlockId: top.blockId, applicabilityConfidence: top.confidence } : {}),
        changedDecision,
        verdictCounts,
        reasonCounts,
        fallback,
        latencyMs: Math.max(0, this.now() - t0),
      };
      this.emitter.emit(event, query.runId ? { runId: query.runId } : undefined);
      return {
        v4Action: v4.action,
        verdict,
        ...(top ? { topBlockId: top.blockId } : {}),
        changedDecision,
        fallback,
      };
    } catch {
      fallback = "error";
      return undefined; // shadow telemetry must never break or alter a recall.
    }
  }

  /**
   * Phase D.4 — apply the explicit-opt-in applicability canary AFTER recall +
   * the D.2 shadow evaluation. Reads the served `shadowApplicability` verdict;
   * eligible ONLY when V4 abstained AND the reranker says `applicable`. On the
   * treatment arm it injects the reranker-selected block (emitting a real
   * `injection` event so the apply becomes observable in the D.3 ledger) and
   * augments the served result; control preserves the baseline abstain. Always
   * emits a privacy-safe exposure event for an eligible query (both arms).
   *
   * NEVER throws and is a strict NO-OP when the canary is disabled, the query is
   * in the global holdout, or it is ineligible — so disabled serving is
   * byte-identical. Precedence (holdout / disabled) is enforced here AND by the
   * caller's `resolveCanaryServingState`.
   */
  applyApplicabilityCanary(
    query: BlockRecallQuery,
    served: RecallV2Result,
    fingerprint: string,
    config: ApplicabilityCanaryConfig,
  ): RecallV2Result {
    try {
      const shadow = served.shadowApplicability;
      const decision = evaluateApplicabilityCanaryExposure({
        servingEnabled: config.enabled,
        config: { salt: config.salt, rate: config.rate, policyVersion: config.policyVersion, enabled: config.enabled },
        fingerprint,
        holdout: served.controlReason === "holdout" || served.shadow,
        shadow,
        applicabilityFeatureVersion: this.applicabilityProvider.featureVersion,
        currentFeatureVersion: this.applicabilityProvider.featureVersion,
      });
      if (!decision.exposed) return served; // disabled / holdout / ineligible → no-op (byte-identical)

      const exposure: ApplicabilityCanaryExposureEvent = {
        event: "reasoning.applicability_canary_exposure",
        ts: this.now(),
        queryId: served.queryId,
        ...(query.runId ? { runId: query.runId } : {}),
        queryHash: queryHash(query.text),
        unitHash: decision.unitHash,
        arm: decision.arm,
        propensity: decision.propensity,
        policyVersion: decision.policyVersion,
        applicabilityFeatureVersion: this.applicabilityProvider.featureVersion,
        blockId: decision.blockId,
        eligibilityReason: decision.eligibilityReason,
        outcomeCompatible: decision.outcomeCompatible,
      };
      this.emitter.emit(exposure, query.runId ? { runId: query.runId } : undefined);

      if (decision.arm !== "treatment") {
        // Control: preserve the baseline abstain; record the (non-injecting) exposure.
        return { ...served, canaryExposure: { arm: "control", blockId: decision.blockId, propensity: decision.propensity, unitHash: decision.unitHash } };
      }

      // Treatment: inject the reranker-selected block (if it still resolves).
      const block = this.store.getBlock(decision.blockId);
      if (!block) return { ...served, canaryExposure: { arm: "treatment", blockId: decision.blockId, propensity: decision.propensity, unitHash: decision.unitHash } };
      const hit: BlockHit = { block, score: 1, calibratedProb: 1, evidenceConfidence: 1, passesGate: true, refs: [] };
      this.emitInjection(served.queryId, hit, query.runId); // authoritative — the apply is now observable
      return {
        ...served,
        shouldInject: true,
        blocks: [hit, ...served.blocks.filter((h) => h.block.id !== block.id)],
        canaryExposure: { arm: "treatment", blockId: decision.blockId, propensity: decision.propensity, unitHash: decision.unitHash },
      };
    } catch {
      return served; // a canary failure must never break or alter the served recall.
    }
  }

  /**
   * Cheap, deterministic family grouping of a slate (distinct-case support +
   * source diversity per block) using the structured-signature resolver — which
   * reads only the trigger, no evidence. Used to feed the reranker's family axis.
   */
  private familyGrouping(blocks: readonly ReasoningBlock[]): Array<{ support: number; sourceDiversity: number }> {
    if (blocks.length === 0) return [];
    const famCands = blocks.map((b) => ({ block: b }) as unknown as FamilyCandidate);
    const { familyKeyByIndex } = new StructuredSignatureResolver().resolve(famCands);
    const fingerprints = new Map<string, Set<string>>();
    const sources = new Map<string, Set<string>>();
    blocks.forEach((b, i) => {
      const key = familyKeyByIndex[i]!;
      (fingerprints.get(key) ?? fingerprints.set(key, new Set()).get(key)!).add(b.trigger.fingerprint);
      const src = b.provenance?.parentTraceId ?? b.provenance?.sourceTaskId ?? b.id;
      (sources.get(key) ?? sources.set(key, new Set()).get(key)!).add(src);
    });
    return blocks.map((_, i) => {
      const key = familyKeyByIndex[i]!;
      return { support: fingerprints.get(key)?.size ?? 1, sourceDiversity: sources.get(key)?.size ?? 1 };
    });
  }

  /**
   * Adjudicate a hybrid slate with the shadow V4 contrastive decision. The slate
   * carries fusion provenance (semanticOnly), which V4's semantic-license lane
   * needs. Fails open to abstain — shadow comparison can never break a recall.
   */
  private decideV4OnSlate(
    servingText: string,
    invariants: BlockInvariants | undefined,
    slate: readonly HybridSlateItem[],
  ): { action: "inject" | "abstain"; topCandidateId?: string } {
    try {
      const policy: ServingPolicy = { ...this.policy, gateThreshold: this.gateThreshold };
      const calibrate = (conf: number, block: ReasoningBlock): number => clamp01(this.calibrator(conf, block));
      // Each arm is adjudicated on the VIEW that generated its slate — the
      // literal arm on the literal view, the causal arm on the distilled
      // mechanism intent — so the serving evidence sees the same focused signal
      // the retrieval lane used (not the symbol-diluted original).
      const sq: ServingQuery = { text: servingText, ...(invariants ? { invariants } : {}) };
      const candidates: ServingCandidate[] = slate.map((it) => ({ block: it.block, rankScore: it.score, provenance: it.provenance }));
      const { decision } = decideServingV4(sq, candidates, policy, calibrate);
      return { action: decision.action, ...(decision.topCandidateId ? { topCandidateId: decision.topCandidateId } : {}) };
    } catch {
      return { action: "abstain" };
    }
  }

  /**
   * Run the configured serving decision on a candidate slate WITHOUT emitting
   * any event (used by the shadow comparison). Mirrors `finalizeRecall`'s
   * dispatch; fails open to V1 like the served path.
   */
  private decideOnSlate(
    query: BlockRecallQuery,
    slate: ReadonlyArray<{ block: ReasoningBlock; score: number }>,
  ): { action: "inject" | "abstain"; topCandidateId?: string; featureVersion: number } {
    const policy: ServingPolicy = { ...this.policy, gateThreshold: this.gateThreshold };
    const calibrate = (conf: number, block: ReasoningBlock): number => clamp01(this.calibrator(conf, block));
    const sq: ServingQuery = { text: query.text, ...(query.invariants ? { invariants: query.invariants } : {}) };
    const candidates: ServingCandidate[] = slate.map(({ block, score }) => ({ block, rankScore: score }));
    if (this.servingMode === "v1") {
      const { decision } = decideServing(sq, candidates, policy, calibrate);
      return { action: decision.action, ...(decision.topCandidateId ? { topCandidateId: decision.topCandidateId } : {}), featureVersion: SERVING_FEATURE_VERSION_NUM };
    }
    try {
      const r = decideServingV2(sq, candidates, policy, calibrate, { mode: this.servingMode });
      return { action: r.decision.action, ...(r.decision.topCandidateId ? { topCandidateId: r.decision.topCandidateId } : {}), featureVersion: SERVING_FEATURE_VERSION_V2_NUM };
    } catch {
      const { decision } = decideServing(sq, candidates, policy, calibrate);
      return { action: decision.action, ...(decision.topCandidateId ? { topCandidateId: decision.topCandidateId } : {}), featureVersion: SERVING_FEATURE_VERSION_NUM };
    }
  }

  /**
   * Invoke the semantic provider with a hard wall-clock deadline + fail-open
   * classification. Returns a CLOSED fallback enum (never a raw error) plus the
   * provider's candidates (or null). Scans only the active blocks, bounded by
   * HYBRID_SCAN_CAP.
   */
  private async semanticSlate(
    query: BlockRecallQuery,
    limit: number,
    /**
     * Phase D.1: an explicit, pre-built intent (a compiled literal/causal view).
     * Defaults to the plain whole-query intent — so the existing hybrid path is
     * byte-identical. Either way the provider sees ONLY the scrubbed DTO.
     */
    intentOverride?: RetrievalIntent,
  ): Promise<{ candidates: RetrievalCandidate[] | null; provider: string; fallback: RetrievalFallback; latencyMs: number; providerClass: ProviderLocation | "none" }> {
    const provider = this.retrievalProvider;
    if (!provider) return { candidates: null, provider: "none", fallback: "unavailable", latencyMs: 0, providerClass: "none" };
    // Remote opt-in guard: a remote-capable adapter is NEVER engaged implicitly.
    if (provider.capabilities.location === "remote" && !provider.capabilities.explicitOptIn) {
      return { candidates: null, provider: provider.name, fallback: "unavailable", latencyMs: 0, providerClass: "none" };
    }
    const t0 = this.now();
    // Build the privacy-hardened DTOs HERE — the provider never sees raw query
    // text or raw blocks. Vector-only adapters get opaque vector refs only.
    const intent = intentOverride ?? buildRetrievalIntent(query.text, query.invariants, limit);
    const active = this.store.listBlocks({ status: "active" }).slice(0, HYBRID_SCAN_CAP);
    const documents =
      provider.capabilities.payload === "vector-only"
        ? active.map((b) => buildVectorOnlyDocument(b))
        : active.map((b) => buildRetrievalDocument(b));
    const ctx = { documents, deadlineMs: this.retrievalDeadlineMs, now: this.now };
    let candidates: RetrievalCandidate[] | null = null;
    let fallback: RetrievalFallback = "none";
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof RETRIEVAL_TIMEOUT>((res) => {
        timer = setTimeout(() => res(RETRIEVAL_TIMEOUT), this.retrievalDeadlineMs);
        timer.unref?.();
      });
      const raced = await Promise.race([provider.retrieve(intent, ctx), timeout]);
      if (timer) clearTimeout(timer);
      if (raced === RETRIEVAL_TIMEOUT) fallback = "timeout";
      else if (raced === null) fallback = "unavailable";
      else {
        candidates = raced;
        fallback = "none";
      }
    } catch {
      fallback = "error";
    }
    const providerClass: ProviderLocation | "none" = candidates ? provider.capabilities.location : "none";
    return { candidates, provider: provider.name, fallback, latencyMs: Math.max(0, this.now() - t0), providerClass };
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
    blocks: Array<{ block: ReasoningBlock; score: number; provenance?: RetrievalProvenance }>,
    rawFacts: Array<{ fact: ProjectFact; score: number }>,
    startedAt: number,
    cascadeInfo?: { cascade: CascadeCandidate[]; telemetry: CascadeTelemetry },
  ): RecallV2Result {

    // Pre-compute calibrated probabilities once. Both the holdout
    // eligibility decision and the final BlockHit / FactHit
    // construction below key off the exact same calibrated value,
    // so a query cannot be "eligible for holdout" but then fail to
    // produce an injection in treatment, nor vice-versa.
    // Per-call gate (drift trigger relaxes this; the rest of the
    // production traffic uses the configured `gateThreshold`).
    const effectiveGate = resolveQueryGate(query.gateOverride, this.gateThreshold);

    // ── Serving-confidence decision ─────────────────────────────────────
    // Ranking already ordered `blocks` (BM25 → optional cascade). The
    // decision layer (src/core/serving-confidence.ts) now owns FIRE-vs-
    // ABSTAIN: it derives absolute, corpus-size-invariant evidence for the
    // top candidate (lexical coverage + structured API/error/symbol/path
    // matches), demands a top-vs-second margin, and feeds the calibrator
    // `evidenceConfidence` — NEVER the legacy max-normalized rank score
    // that pinned the top hit at 1.0 and produced a ~100% fire-rate.
    // Drift mode (tool-loop): the drift trigger is the only caller that sets
    // `gateOverride`, signalling "the agent is stuck — surface any relevant
    // past pattern, strict precision is counter-productive here". Relax the
    // WHOLE policy to match that intent (floor down to the gate, single match
    // allowed, no ambiguity gate), not just the calibrated threshold. Normal
    // traffic (no override) keeps the full conservative policy.
    const driftRelaxed = query.gateOverride !== undefined;
    const policy: ServingPolicy = driftRelaxed
      ? {
          gateThreshold: effectiveGate,
          marginThreshold: 0,
          minEvidenceConfidence: Math.min(this.policy.minEvidenceConfidence, effectiveGate),
          minMeaningfulMatches: 1,
        }
      : { ...this.policy, gateThreshold: effectiveGate };
    const evidenceCalibrate = (conf: number, block: ReasoningBlock): number =>
      clamp01(this.calibrator(conf, block));
    const servingQuery = { text: query.text, invariants: query.invariants };
    const servingCandidates = blocks.map(({ block, score, provenance }) => ({ block, rankScore: score, ...(provenance ? { provenance } : {}) }));

    // Mode dispatch. V1 is the production default. The V2 modes opt into the
    // structured / family-aware decision but are wrapped so ANY failure falls
    // back to the conservative V1 decision — Router V2 can never break a recall.
    let servingDecision: ServingDecision;
    let perCandidate: ServingEvidenceV1[];
    let effectiveFeatureVersion = SERVING_FEATURE_VERSION_NUM;
    const decideStartedAt = this.now();
    if (this.servingMode === "v1") {
      ({ decision: servingDecision, perCandidate } = decideServing(
        servingQuery,
        servingCandidates,
        policy,
        evidenceCalibrate,
      ));
    } else {
      try {
        const r = decideServingV2(servingQuery, servingCandidates, policy, evidenceCalibrate, {
          mode: this.servingMode,
        });
        servingDecision = r.decision;
        perCandidate = r.perCandidate;
        effectiveFeatureVersion = SERVING_FEATURE_VERSION_V2_NUM;
      } catch {
        ({ decision: servingDecision, perCandidate } = decideServing(
          servingQuery,
          servingCandidates,
          policy,
          evidenceCalibrate,
        ));
      }
    }

    // Wall-clock of the SERVED decision (V1 in shadow mode) — recorded on the
    // shadow comparison so V2 overhead can be measured against it.
    const primaryDecisionMs = Math.max(0, this.now() - decideStartedAt);

    // Calibrated probability keys off `evidenceConfidence` so telemetry,
    // holdout eligibility, and the gate all read the same number.
    const blockCalibrated = blocks.map(({ block, score }, i) => ({
      block,
      score,
      features: perCandidate[i] as ServingEvidenceV1 | undefined,
      calibratedProb: perCandidate[i]
        ? evidenceCalibrate(perCandidate[i].evidenceConfidence, block)
        : 0,
      refs: this.store.listCaseRefs(block.id).slice(0, refLimit),
    }));
    const factCalibrated = rawFacts.map(({ fact, score }) => ({
      fact,
      score,
      calibratedProb: clamp01(fact.confidence),
    }));

    // Phase 3.2 — experimental holdout. Eligibility now reads the serving
    // decision ("would treatment actually inject?") instead of a bare gate
    // comparison, so a held-out run mirrors exactly what treatment would
    // have done. The four conditions are unchanged: not already a manual
    // shadow, gate-eligible, complete experiment input, and the
    // deterministic assignment lands in the holdout cohort.
    const wouldInjectAbsentShadow =
      servingDecision.action === "inject" ||
      factCalibrated.some((h) => h.calibratedProb >= effectiveGate);
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

    // Conservative single-injection: only the TOP block fires, and only
    // when the decision said "inject" and we are not shadowing. Weak /
    // ambiguous siblings never fire — the margin gate guarantees the top
    // is clearly separated before any injection. `passesGate` remains the
    // single source of truth the formatter + analytics key off.
    const topInjects = !shadow && servingDecision.action === "inject";
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
        evidenceConfidence: h.features?.evidenceConfidence ?? 0,
        // Only the single authorized block injects — the one the decision
        // selected by calibrated confidence, not necessarily the BM25 top.
        passesGate: topInjects && h.block.id === servingDecision.topCandidateId,
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

    // Facts keep their existing curated-confidence gate: they carry an
    // explicit author confidence and do not suffer the weak-lexical-match
    // pathology that motivated the block decision layer.
    const factHits: FactHit[] = factCalibrated.map((h) => ({
      fact: h.fact,
      score: h.score,
      calibratedProb: h.calibratedProb,
      passesGate: !shadow && h.calibratedProb >= effectiveGate,
    }));

    const shouldInject =
      blockHits.some((h) => h.passesGate) || factHits.some((h) => h.passesGate);

    // Phase 1 — privacy-safe serving telemetry, stamped on the retrieval
    // event so it lands for EVERY recall (inject, abstain, zero-hit). Only
    // the queryHash is persisted, never the raw prompt.
    const serving: ServingTelemetry = {
      retrievalId: queryId,
      queryHash: queryHash(query.text),
      ...(query.scope ? { scope: query.scope } : {}),
      corpusSize: this.store.countBlocks("active"),
      candidateCount: blocks.length,
      evidenceConfidence: servingDecision.features?.evidenceConfidence ?? 0,
      margin: servingDecision.features?.margin ?? 0,
      calibratedProb: servingDecision.calibratedProb ?? 0,
      decision: servingDecision.action,
      reason: servingDecision.reason,
      featureVersion: effectiveFeatureVersion,
      calibratorVersion: this.calibratorVersion,
      latencyMs: Math.max(0, this.now() - startedAt),
      injectedBlockIds: blockHits.filter((h) => h.passesGate).map((h) => h.block.id),
    };

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
        serving,
      );
      for (const h of blockHits) {
        if (h.passesGate) this.emitInjection(queryId, h, query.runId);
      }
      for (const h of factHits) {
        if (h.passesGate) this.emitFactInjection(queryId, h, query.runId);
      }
    }

    // Router V2 shadow comparison (rollout=shadow). Computed on the SAME
    // candidate slate; NEVER alters the injected payload above. A distinct,
    // additive, privacy-safe, LOCAL-ONLY telemetry stream — emitted whenever
    // shadow evaluation is configured (independent of `emitEvents`, which
    // governs the V1 retrieval/injection stream other paths may re-emit).
    if (this.shadowEvaluate) {
      this.emitShadowComparison(
        queryId,
        query,
        servingQuery,
        servingCandidates,
        policy,
        evidenceCalibrate,
        servingDecision,
        effectiveFeatureVersion,
        primaryDecisionMs,
      );
    }

    // Phase C.2/C.3 ServingEvidenceV3 + V4 shadow comparison (evidenceMode=shadow).
    // Computed on the SAME served candidate slate (fusion provenance is present
    // on the hybrid path); NEVER served. Distinct, additive, local-only stream.
    let shadowV3: RecallV2Result["shadowV3"];
    let shadowV4: RecallV2Result["shadowV4"];
    if (this.evidenceMode === "shadow") {
      const evidenceShadow = this.emitEvidenceComparison(
        queryId,
        query,
        servingQuery,
        servingCandidates,
        policy,
        evidenceCalibrate,
        servingDecision,
        effectiveFeatureVersion,
      );
      shadowV3 = evidenceShadow.shadowV3;
      shadowV4 = evidenceShadow.shadowV4;
    }

    return {
      queryId,
      shadow,
      ...(controlReason ? { controlReason } : {}),
      blocks: blockHits,
      facts: factHits,
      shouldInject,
      servingDecision,
      ...(shadowV3 ? { shadowV3 } : {}),
      ...(shadowV4 ? { shadowV4 } : {}),
    };
  }

  /**
   * Compute the shadow ServingEvidenceV3 decision on the served slate and emit a
   * privacy-safe `reasoning.evidence_comparison` event. NEVER serves and NEVER
   * throws — fails open (records fallback "error", returns the served decision
   * as the V3 summary). Returns the shadow-V3 summary for the recall result.
   */
  private emitEvidenceComparison(
    queryId: string,
    query: BlockRecallQuery,
    servingQuery: ServingQuery,
    servingCandidates: readonly ServingCandidate[],
    policy: ServingPolicy,
    calibrate: EvidenceCalibrator,
    servedDecision: ServingDecision,
    servedFeatureVersion: number,
  ): { shadowV3: NonNullable<RecallV2Result["shadowV3"]>; shadowV4: NonNullable<RecallV2Result["shadowV4"]> } {
    const t0 = this.now();
    let fallback: EvidenceFallback = "none";
    let v3Action: "inject" | "abstain" = servedDecision.action;
    let v3Reason = servedDecision.reason;
    let v3Top = servedDecision.topCandidateId;
    let lane = "lexical";
    let licenseReason = "lexical";
    let licensedCandidates = 0;
    let redactedFieldCount = 0;
    try {
      const r = decideServingV3(servingQuery, servingCandidates, policy, calibrate);
      v3Action = r.decision.action;
      v3Reason = r.decision.reason;
      v3Top = r.decision.topCandidateId;
      const sel = r.evidenceV3.find((e) => e.blockId === r.decision.topCandidateId) ?? r.evidenceV3[0];
      if (sel) {
        lane = sel.lane;
        licenseReason = sel.licenseReason;
      }
      for (const e of r.evidenceV3) {
        if (e.licenseReason === "structured-corroborated") licensedCandidates++;
        redactedFieldCount += e.base.redactedFields.length;
      }
    } catch {
      fallback = "error";
    }

    // Phase C.3 contrastive V4 — computed on the SAME slate, independently
    // fail-open (a V4 error never disturbs the V3 summary or the served path).
    let v4Action: "inject" | "abstain" = servedDecision.action;
    let v4Reason = servedDecision.reason;
    let v4Top = servedDecision.topCandidateId;
    let v4Lane = "lexical";
    let v4LicenseReason = "lexical";
    let v4LicensedCandidates = 0;
    let v4DiscriminativeSupport: number | undefined;
    let v4HasCompetitor: boolean | undefined;
    let v4FamilySeparation: number | undefined;
    try {
      const r4 = decideServingV4(servingQuery, servingCandidates, policy, calibrate);
      v4Action = r4.decision.action;
      v4Reason = r4.decision.reason;
      v4Top = r4.decision.topCandidateId;
      const sel4 = r4.evidenceV4.find((e) => e.blockId === r4.decision.topCandidateId) ?? r4.evidenceV4[0];
      if (sel4) {
        v4Lane = sel4.lane;
        v4LicenseReason = sel4.licenseReason;
        if (sel4.contrastive) {
          v4DiscriminativeSupport = sel4.contrastive.discriminativeSupport;
          v4HasCompetitor = sel4.contrastive.hasCompetitor;
          v4FamilySeparation = sel4.contrastive.familySeparation;
        }
      }
      v4LicensedCandidates = r4.evidenceV4.filter((e) => e.licenseReason === "structured-corroborated").length;
    } catch {
      fallback = "error";
    }

    const semanticOnlyCandidates = servingCandidates.filter((c) => c.provenance?.semanticOnly).length;
    const event: ReasoningEvidenceComparisonEvent = {
      event: "reasoning.evidence_comparison",
      ts: this.now(),
      queryId,
      ...(query.runId ? { runId: query.runId } : {}),
      queryHash: queryHash(query.text),
      corpusSize: this.store.countBlocks("active"),
      candidateCount: servingCandidates.length,
      servedAction: servedDecision.action,
      servedReason: servedDecision.reason,
      ...(servedDecision.topCandidateId ? { servedTopBlockId: servedDecision.topCandidateId } : {}),
      servedFeatureVersion,
      v3Action,
      v3Reason,
      ...(v3Top ? { v3TopBlockId: v3Top } : {}),
      lane,
      licenseReason,
      agreement: evidenceComparisonAgreement(servedDecision.action, servedDecision.topCandidateId, v3Action, v3Top),
      semanticOnlyCandidates,
      licensedCandidates,
      redactedFieldCount,
      fallback,
      latencyMs: Math.max(0, this.now() - t0),
      v4Action,
      v4Reason,
      ...(v4Top ? { v4TopBlockId: v4Top } : {}),
      v4LicenseReason,
      ...(v4DiscriminativeSupport !== undefined ? { v4DiscriminativeSupport } : {}),
      ...(v4HasCompetitor !== undefined ? { v4HasCompetitor } : {}),
      ...(v4FamilySeparation !== undefined ? { v4FamilySeparation } : {}),
      v4LicensedCandidates,
    };
    this.emitter.emit(event, query.runId ? { runId: query.runId } : undefined);
    return {
      shadowV3: { action: v3Action, reason: v3Reason, ...(v3Top ? { topBlockId: v3Top } : {}), lane, licenseReason },
      shadowV4: {
        action: v4Action,
        reason: v4Reason,
        ...(v4Top ? { topBlockId: v4Top } : {}),
        lane: v4Lane,
        licenseReason: v4LicenseReason,
        ...(v4DiscriminativeSupport !== undefined ? { discriminativeSupport: v4DiscriminativeSupport } : {}),
        ...(v4HasCompetitor !== undefined ? { hasCompetitor: v4HasCompetitor } : {}),
      },
    };
  }

  /**
   * Compute the Router V2 shadow decision side-by-side with the served V1
   * decision (same candidate slate) and emit a privacy-safe
   * `router.shadow_comparison` event. Fails open: if the V2 decision throws,
   * the comparison is emitted with `v2FallbackReason` and abstain defaults —
   * shadow evaluation can never break a recall or alter injection.
   */
  private emitShadowComparison(
    queryId: string,
    query: BlockRecallQuery,
    servingQuery: ServingQuery,
    servingCandidates: readonly ServingCandidate[],
    policy: ServingPolicy,
    calibrate: EvidenceCalibrator,
    v1Decision: ServingDecision,
    v1FeatureVersion: number,
    v1LatencyMs: number,
  ): void {
    const mode = this.shadowEvaluate;
    if (!mode) return;

    const t0 = this.now();
    let v2Action: "inject" | "abstain" = "abstain";
    let v2Reason = "error";
    let v2TopBlockId: string | undefined;
    let v2Confidence = 0;
    let v2Margin = 0;
    let resolverName = "n/a";
    let familyCount = 0;
    let topFamilySupport = 0;
    let topFamilySourceDiversity = 0;
    let topFamilyContradiction = 0;
    let runnerUpFamilyConfidence = 0;
    let familyMargin = 0;
    let bridgesPrevented = 0;
    let redactedFieldCount = 0;
    let v2FallbackReason: RouterShadowFallback | undefined;
    try {
      const r = decideServingV2(servingQuery, servingCandidates, policy, calibrate, { mode });
      const d = r.decision;
      v2Action = d.action;
      v2Reason = d.reason;
      v2TopBlockId = d.topCandidateId;
      v2Confidence = round4(d.calibratedProb ?? d.features?.evidenceConfidence ?? 0);
      v2Margin = round4(d.features?.margin ?? 0);
      for (const e of r.evidenceV2) redactedFieldCount += e.redactedFields.length;
      if (r.family) {
        resolverName = r.family.resolverName;
        familyCount = r.family.familyCount;
        topFamilySupport = r.family.topFamilySupport;
        topFamilySourceDiversity = r.family.topFamilySourceDiversity;
        topFamilyContradiction = round4(r.family.topFamilyContradiction);
        runnerUpFamilyConfidence = round4(r.family.runnerUpFamilyConfidence);
        familyMargin = round4(r.family.familyMargin);
        bridgesPrevented = r.family.bridgesPrevented;
      }
    } catch (err) {
      // Persist ONLY a closed-enum class — never the raw message (which could
      // embed a path/secret/prompt). The raw text is surfaced for LOCAL
      // debugging only, on ephemeral stderr, behind the existing debug flag.
      v2FallbackReason = classifyShadowFallback(err);
      if (process.env.TRACEBASE_DEBUG) {
        const raw = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[tracebase] router-v2 shadow fallback (${v2FallbackReason}): ${raw}\n`);
      }
    }
    const v2OverheadMs = Math.max(0, this.now() - t0);

    const v1Action = v1Decision.action;
    const v1TopBlockId = v1Decision.topCandidateId;
    const event: RouterShadowComparisonEvent = {
      event: "router.shadow_comparison",
      ts: this.now(),
      queryId,
      ...(query.runId ? { runId: query.runId } : {}),
      queryHash: queryHash(query.text),
      corpusSize: this.store.countBlocks("active"),
      candidateCount: servingCandidates.length,
      v1Action,
      v1Reason: v1Decision.reason,
      ...(v1TopBlockId ? { v1TopBlockId } : {}),
      v1Confidence: round4(v1Decision.calibratedProb ?? v1Decision.features?.evidenceConfidence ?? 0),
      v1Margin: round4(v1Decision.features?.margin ?? 0),
      v1FeatureVersion,
      v1LatencyMs,
      v2Action,
      v2Reason,
      ...(v2TopBlockId ? { v2TopBlockId } : {}),
      v2Confidence,
      v2Margin,
      v2FeatureVersion: SERVING_FEATURE_VERSION_V2_NUM,
      v2LatencyMs: v2OverheadMs,
      v2OverheadMs,
      agreement: shadowAgreement(v1Action, v1TopBlockId, v2Action, v2TopBlockId),
      resolverName,
      familyCount,
      topFamilySupport,
      topFamilySourceDiversity,
      topFamilyContradiction,
      runnerUpFamilyConfidence,
      familyMargin,
      bridgesPrevented,
      redactedFieldCount,
      ...(v2FallbackReason ? { v2FallbackReason } : {}),
    };
    this.emitter.emit(event, query.runId ? { runId: query.runId } : undefined);
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
    //
    // May-2026 — we deliberately keep the maxRel normalization here
    // and rely on `sanitizeFtsQuery`'s stop-word / tool-word filter
    // to prevent the "single noise-token hit gets score=1.0" pathology
    // upstream: queries dominated by stop-words now produce no FTS
    // candidates at all. An absolute saturating scale was tried and
    // rejected because in unit tests (N=1 FTS corpus where IDF
    // degenerates) it underflows the gate; the cascade reranker +
    // isotonic calibrator slots are where corpus-size-invariant
    // confidence is meant to live, not in the raw BM25 mapping.
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
    // Canonical informative tokens — the SAME splitter + stop-word policy
    // the serving-confidence layer uses, so retrieval and gating cannot
    // diverge on what counts as a signal. An all-stop-word / all-noise
    // query yields zero tokens → no FTS match → the serving layer abstains
    // (correct: pure prompt noise must not retrieve a block). Note this
    // intentionally drops the old "fall back to the unfiltered list" path —
    // a noisy match is exactly what the precision policy exists to suppress.
    const words = tokenizeInformative(query);
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
    serving?: ServingTelemetry,
  ): void {
    const ev: RetrievalEvent = {
      ts: this.now(),
      queryId,
      event: "retrieval",
      ...(serving ? { serving } : {}),
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
      evidenceConfidence: hit.evidenceConfidence,
      featureVersion: SERVING_FEATURE_VERSION_NUM,
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

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * Union two semantic candidate lists (Phase D.1 literal ⊕ causal lanes), keeping
 * the BEST score per blockId. `null` inputs are treated as empty; returns `null`
 * only when both are null (so fuseHybrid sees the fail-open identity). Pure +
 * deterministic (no ordering dependence — the caller re-sorts by score).
 */
function mergeCandidates(
  a: RetrievalCandidate[] | null,
  b: RetrievalCandidate[] | null,
): RetrievalCandidate[] | null {
  if (!a && !b) return null;
  const best = new Map<string, number>();
  for (const c of a ?? []) best.set(c.blockId, Math.max(best.get(c.blockId) ?? -Infinity, c.score));
  for (const c of b ?? []) best.set(c.blockId, Math.max(best.get(c.blockId) ?? -Infinity, c.score));
  return [...best.entries()].map(([blockId, score]) => ({ blockId, score }));
}

/**
 * Map a thrown value to a CLOSED fallback class. The message is read here only
 * to classify; it is never returned or persisted, so no raw exception text
 * (which could contain a path / secret / prompt fragment) can leak. Exported
 * for the privacy regression test.
 */
export function classifyShadowFallback(err: unknown): RouterShadowFallback {
  if (!(err instanceof Error)) return "unknown";
  const hay = `${err.name} ${err.message}`.toLowerCase();
  if (/\b(timeout|timed out|abort(ed)?|deadline)\b/.test(hay)) return "timeout";
  if (/\b(valid|invalid|schema|assert|malformed)\b/.test(hay)) return "validation";
  return "error";
}

/** Classify how the served V1 decision and the shadow V2 decision agreed. */
function shadowAgreement(
  v1Action: "inject" | "abstain",
  v1Top: string | undefined,
  v2Action: "inject" | "abstain",
  v2Top: string | undefined,
): RouterShadowAgreement {
  const v1Inj = v1Action === "inject";
  const v2Inj = v2Action === "inject";
  if (!v1Inj && !v2Inj) return "agree_abstain";
  if (v1Inj && !v2Inj) return "v1_only_inject";
  if (!v1Inj && v2Inj) return "v2_only_inject";
  return v1Top && v2Top && v1Top === v2Top ? "agree_inject_same" : "agree_inject_diff";
}

// ---------------------------------------------------------------------------
// Phase C hybrid retrieval helpers
// ---------------------------------------------------------------------------

/** Max active blocks a semantic provider may scan per recall (bounded cost). */
const HYBRID_SCAN_CAP = 2000;

/** Sentinel for a provider call that blew the wall-clock deadline. */
const RETRIEVAL_TIMEOUT: unique symbol = Symbol("retrieval-timeout");

/** Sentinel for an applicability-reranker call that blew the wall-clock deadline (Phase D.2). */
const APPLICABILITY_TIMEOUT: unique symbol = Symbol("applicability-timeout");

/** Classify how the sparse-slate decision compared to the hybrid-slate decision. */
function retrievalDecisionAgreement(
  sparseAction: "inject" | "abstain",
  sparseTop: string | undefined,
  hybridAction: "inject" | "abstain",
  hybridTop: string | undefined,
): RetrievalDecisionAgreement {
  const si = sparseAction === "inject";
  const hi = hybridAction === "inject";
  if (!si && !hi) return "agree_abstain";
  if (si && !hi) return "sparse_only_inject";
  if (!si && hi) return "hybrid_only_inject";
  return sparseTop && hybridTop && sparseTop === hybridTop ? "agree_inject_same" : "agree_inject_diff";
}

/** Classify how the served V1/V2 decision compared to the shadow V3 decision. */
function evidenceComparisonAgreement(
  servedAction: "inject" | "abstain",
  servedTop: string | undefined,
  v3Action: "inject" | "abstain",
  v3Top: string | undefined,
): EvidenceComparisonAgreement {
  const si = servedAction === "inject";
  const vi = v3Action === "inject";
  if (!si && !vi) return "agree_abstain";
  if (si && !vi) return "v2_only_inject";
  if (!si && vi) return "v3_only_inject";
  return servedTop && v3Top && servedTop === v3Top ? "agree_inject_same" : "agree_inject_diff";
}
