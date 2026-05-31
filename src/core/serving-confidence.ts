/**
 * Serving-confidence decision layer.
 *
 * This module owns the FIRE-vs-ABSTAIN decision for reasoning-block
 * injection. It is deliberately a separate boundary from `block-serving.ts`
 * (which owns retrieval/ranking/telemetry plumbing): ranking decides
 * *order*, this module decides *whether the top candidate is good enough to
 * inject at all*.
 *
 * Why this exists (the bug it fixes):
 *   The legacy path fed the gate a query-LOCAL max-normalized BM25 score,
 *   so the top hit was always ~1.0 and — with an identity calibrator — every
 *   non-empty recall fired (~100% fire-rate). The gate was inert.
 *
 * The fix, implemented here:
 *   - rank score is ORDERING ONLY (passed through as `rankScore`);
 *   - an ABSOLUTE, corpus-size-invariant `evidenceConfidence` is computed
 *     from lexical coverage + structured exact matches (API/error/symbol/
 *     path), so N=1 corpora and N=10000 corpora score the same evidence the
 *     same way;
 *   - a conservative POLICY abstains on weak / generic-only / ambiguous
 *     evidence by default;
 *   - the calibrator is fed `evidenceConfidence` (a meaningful signal),
 *     never the always-1.0 rank score.
 *
 * Extensibility: `ServingEvidenceV1` is versioned. Future signals
 * (embeddings, repo/file proximity, outcome priors, model-specific
 * calibration) add fields under a new `featureVersion` without breaking the
 * stored telemetry contract or the calibrator-version guard.
 *
 * No DB or I/O here — pure functions over `(query, candidates, policy,
 * calibrate)`. `block-serving.ts` calls in; nothing calls out.
 */
import type { ReasoningBlock, BlockInvariants } from "../types.js";
import { tokenizeInformative, isGenericToken } from "./serving-tokenizer.js";

// ---------------------------------------------------------------------------
// Feature vector (versioned)
// ---------------------------------------------------------------------------

/** Current evidence feature-schema version. Bump on any field change. */
export const SERVING_FEATURE_VERSION = 1 as const;

/**
 * Structured evidence + lexical-coverage feature vector for one candidate.
 *
 * Designed for forward growth: embeddings cosine, repo/file proximity,
 * outcome priors, and model-specific calibration are all additive fields
 * under a future `featureVersion: 2`. The calibrator-version guard
 * (`calibratorAcceptsFeatures`) rejects models trained on a different
 * version, so adding fields never silently mis-serves.
 */
export interface ServingEvidenceV1 {
  featureVersion: typeof SERVING_FEATURE_VERSION;
  /** # informative (non-stop) tokens in the query. */
  informativeQueryTokenCount: number;
  /** # informative query tokens also present in the block trigger. */
  matchedInformativeTokenCount: number;
  /** matched / informativeQueryTokenCount ∈ [0,1]. How much of the user's intent the block covers. */
  queryCoverage: number;
  /** matched / informative-block-token-count ∈ [0,1]. How focused the block is on the query. */
  triggerCoverage: number;
  /** Query apiSurface ∩ block apiSurface non-empty. */
  apiSurfaceExactMatch: boolean;
  /** Query errorType === block errorType (both set). */
  errorTypeExactMatch: boolean;
  /** A discriminative, identifier-like token matched a curated block keyword. */
  symbolExactMatch: boolean;
  /** A path/filename token from the query matched a block token. */
  pathTokenMatch: boolean;
  /** Overlap exists but is ENTIRELY generic vocabulary (no discriminative / structured match). */
  genericOnly: boolean;
  /** Ranker score — ORDERING ONLY. Never used as confidence. */
  rankScore: number;
  /** Absolute, corpus-size-invariant confidence ∈ [0,1] derived from the features above. */
  evidenceConfidence: number;
  /** evidenceConfidence of the runner-up candidate (0 when none). */
  secondBestEvidenceConfidence: number;
  /** top.evidenceConfidence − secondBest.evidenceConfidence. */
  margin: number;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type ServingAction = "inject" | "abstain";

export type ServingReason =
  | "no_candidates"
  | "weak_evidence"
  | "generic_only"
  | "ambiguous_margin"
  | "below_calibrated_threshold"
  | "injected";

export interface ServingDecision {
  action: ServingAction;
  reason: ServingReason;
  /** Top (best-ranked) candidate id, when there was at least one candidate. */
  topCandidateId?: string;
  /** Feature vector of the top candidate, when computed. */
  features?: ServingEvidenceV1;
  /** Calibrated P(helpful) for the top candidate, when the gate stage was reached. */
  calibratedProb?: number;
  /** Effective calibrated-prob gate at decision time. */
  threshold: number;
  /** Effective top-vs-second margin gate at decision time. */
  marginThreshold: number;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Conservative-by-default serving policy. Each knob is an absolute,
 * corpus-size-invariant guard — none is benchmark- or fixture-specific.
 * Operators may override via env (see `resolveServingPolicy`), which emits
 * a diagnostic so an override is never silent.
 */
export interface ServingPolicy {
  /** Min calibrated P(helpful) to inject. */
  gateThreshold: number;
  /** Min top-vs-second evidenceConfidence separation; below ⇒ ambiguous abstain. */
  marginThreshold: number;
  /** Absolute floor on the top candidate's evidenceConfidence. */
  minEvidenceConfidence: number;
  /** Meaningful (non-generic) token matches required, unless an exact structured match is present. */
  minMeaningfulMatches: number;
}

/** Min calibrated probability to inject. Mirrors the production gate default. */
export const DEFAULT_GATE_THRESHOLD = 0.4;
/** Min top-vs-second evidenceConfidence separation to avoid an ambiguous-pick abstain. */
export const DEFAULT_MARGIN_THRESHOLD = 0.15;
/** Absolute evidenceConfidence floor — a lone candidate still must clear this. */
export const DEFAULT_MIN_EVIDENCE_CONFIDENCE = 0.35;
/** Default meaningful-match requirement. One-token matches pass only with structured exactness. */
export const DEFAULT_MIN_MEANINGFUL_MATCHES = 2;

export const DEFAULT_SERVING_POLICY: ServingPolicy = {
  gateThreshold: DEFAULT_GATE_THRESHOLD,
  marginThreshold: DEFAULT_MARGIN_THRESHOLD,
  minEvidenceConfidence: DEFAULT_MIN_EVIDENCE_CONFIDENCE,
  minMeaningfulMatches: DEFAULT_MIN_MEANINGFUL_MATCHES,
};

/** Diagnostic note describing any env override applied to the policy. */
export interface PolicyResolution {
  policy: ServingPolicy;
  /** Human-readable notes about overrides applied (empty when all defaults). */
  diagnostics: string[];
}

/**
 * Resolve the operational policy from defaults + caller overrides + env.
 * Env overrides are explicit operational config — each one applied emits a
 * diagnostic so a tuned threshold is never silent. Out-of-range values are
 * ignored (treated as "not configured"), never as a silent disable.
 *
 * Env keys (all optional, all ∈ valid range):
 *   TRACEBASE_GATE_THRESHOLD            gateThreshold ∈ [0,1]
 *   TRACEBASE_SERVING_MARGIN            marginThreshold ∈ [0,1]
 *   TRACEBASE_SERVING_MIN_EVIDENCE      minEvidenceConfidence ∈ [0,1]
 *   TRACEBASE_SERVING_MIN_MATCHES       minMeaningfulMatches ∈ integer ≥ 0
 */
export function resolveServingPolicy(
  overrides: Partial<ServingPolicy> = {},
  env: NodeJS.ProcessEnv = process.env,
): PolicyResolution {
  const diagnostics: string[] = [];
  const policy: ServingPolicy = { ...DEFAULT_SERVING_POLICY, ...overrides };

  const applyNum = (
    key: string,
    field: keyof ServingPolicy,
    min: number,
    max: number,
    integer = false,
  ): void => {
    const raw = env[key];
    if (raw === undefined || raw === "") return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
      diagnostics.push(`${key}="${raw}" ignored (out of range [${min},${max}]${integer ? ", integer" : ""}); using ${String(policy[field])}`);
      return;
    }
    policy[field] = parsed;
    diagnostics.push(`${key} override: ${field}=${parsed}`);
  };

  applyNum("TRACEBASE_GATE_THRESHOLD", "gateThreshold", 0, 1);
  applyNum("TRACEBASE_SERVING_MARGIN", "marginThreshold", 0, 1);
  applyNum("TRACEBASE_SERVING_MIN_EVIDENCE", "minEvidenceConfidence", 0, 1);
  applyNum("TRACEBASE_SERVING_MIN_MATCHES", "minMeaningfulMatches", 0, 100, true);

  return { policy, diagnostics };
}

// ---------------------------------------------------------------------------
// Calibrator boundary
// ---------------------------------------------------------------------------

/**
 * Calibrator fed by THIS module. Input is `evidenceConfidence` (the absolute
 * feature-derived signal), NOT the legacy normalized rank score. Structurally
 * compatible with the existing `Calibrator = (score, block) => number` slot,
 * but the *semantics* of the first argument changed — hence the version guard.
 */
export type EvidenceCalibrator = (evidenceConfidence: number, block: ReasoningBlock) => number;

/** Identity calibrator over evidenceConfidence — the conservative fallback. */
export const identityEvidenceCalibrator: EvidenceCalibrator = (c) => clamp01(c);

// ---------------------------------------------------------------------------
// Candidate input
// ---------------------------------------------------------------------------

export interface ServingCandidate {
  block: ReasoningBlock;
  /** Ranker score (BM25/cascade). ORDERING ONLY. */
  rankScore: number;
}

export interface ServingQuery {
  text: string;
  invariants?: BlockInvariants;
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

/** Identifier-like discriminative token: long, or snake/dotted (kept by the tokenizer). */
function isIdentifierLike(tok: string): boolean {
  return tok.length >= 6 || tok.includes("_");
}

/** Path/filename tokens from raw query text (segments of slash-paths or dotted filenames). */
function pathSegments(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    if (!raw.includes("/") && !/\.[a-z]{1,4}$/i.test(raw)) continue;
    for (const seg of raw.split(/[/\\.]+/)) {
      const t = seg.toLowerCase();
      if (t.length >= 3 && !/^\d+$/.test(t)) out.add(t);
    }
  }
  return out;
}

/** Informative token set of a block's trigger (situation text + curated keywords). */
export function blockTriggerTokens(block: ReasoningBlock): {
  all: Set<string>;
  keywords: Set<string>;
} {
  const all = new Set<string>(tokenizeInformative(block.trigger.situation));
  const keywords = new Set<string>();
  for (const kw of block.trigger.keywords ?? []) {
    for (const t of tokenizeInformative(kw)) {
      all.add(t);
      keywords.add(t);
    }
  }
  return { all, keywords };
}

interface FeatureCore {
  features: Omit<ServingEvidenceV1, "secondBestEvidenceConfidence" | "margin">;
  meaningfulMatchCount: number;
  hasExactStructured: boolean;
}

/**
 * Compute the per-candidate feature core (everything except the
 * second-best/margin fields, which are filled in by `decideServing` once the
 * runner-up is known).
 */
export function computeFeatures(query: ServingQuery, candidate: ServingCandidate): FeatureCore {
  const queryTokens = tokenizeInformative(query.text);
  const queryTokenSet = new Set(queryTokens);
  const { all: blockTokens, keywords: blockKeywords } = blockTriggerTokens(candidate.block);

  // Lexical overlap.
  let matched = 0;
  let meaningfulMatchCount = 0;
  let symbolExactMatch = false;
  for (const t of queryTokenSet) {
    if (blockTokens.has(t)) {
      matched++;
      if (!isGenericToken(t)) {
        meaningfulMatchCount++;
        if (isIdentifierLike(t) && blockKeywords.has(t)) symbolExactMatch = true;
      }
    }
  }

  const informativeQueryTokenCount = queryTokens.length;
  const queryCoverage = informativeQueryTokenCount > 0 ? matched / informativeQueryTokenCount : 0;
  const triggerCoverage = blockTokens.size > 0 ? matched / blockTokens.size : 0;

  // Structured invariant matches.
  const qInv = query.invariants;
  const bInv: BlockInvariants = candidate.block.trigger.invariants ?? {};
  const apiSurfaceExactMatch = apiOverlap(qInv?.apiSurface, bInv.apiSurface);
  const errorTypeExactMatch =
    !!qInv?.errorType && !!bInv.errorType && qInv.errorType === bInv.errorType;

  // Path/filename overlap.
  const qPaths = pathSegments(query.text);
  let pathTokenMatch = false;
  for (const p of qPaths) {
    if (blockTokens.has(p)) {
      pathTokenMatch = true;
      break;
    }
  }

  const hasExactStructured = apiSurfaceExactMatch || errorTypeExactMatch || symbolExactMatch;
  // Generic-only: there IS overlap, but no meaningful token, no structured
  // match, and no path match — i.e. the overlap is entirely generic vocab.
  const genericOnly =
    matched > 0 && meaningfulMatchCount === 0 && !hasExactStructured && !pathTokenMatch;

  const evidenceConfidence = computeEvidenceConfidence({
    queryCoverage,
    triggerCoverage,
    apiSurfaceExactMatch,
    errorTypeExactMatch,
    symbolExactMatch,
    genericOnly,
  });

  return {
    features: {
      featureVersion: SERVING_FEATURE_VERSION,
      informativeQueryTokenCount,
      matchedInformativeTokenCount: matched,
      queryCoverage: round4(queryCoverage),
      triggerCoverage: round4(triggerCoverage),
      apiSurfaceExactMatch,
      errorTypeExactMatch,
      symbolExactMatch,
      pathTokenMatch,
      genericOnly,
      rankScore: candidate.rankScore,
      evidenceConfidence: round4(evidenceConfidence),
    },
    meaningfulMatchCount,
    hasExactStructured,
  };
}

/** Weight on query coverage in the evidence-confidence blend. */
const W_QUERY_COVERAGE = 0.7;
/** Weight on trigger coverage in the evidence-confidence blend. */
const W_TRIGGER_COVERAGE = 0.3;

/**
 * Transparent feature → confidence blend. Coverage-dominant baseline,
 * floored upward by exact structured matches (which are high precision even
 * at low coverage), and capped low for generic-only overlap. The calibrator
 * (once fitted on outcomes) refines this into a true P(helpful); pre-fit it
 * is the identity and the POLICY guards enforce precision.
 */
export function computeEvidenceConfidence(f: {
  queryCoverage: number;
  triggerCoverage: number;
  apiSurfaceExactMatch: boolean;
  errorTypeExactMatch: boolean;
  symbolExactMatch: boolean;
  genericOnly: boolean;
}): number {
  let conf = W_QUERY_COVERAGE * f.queryCoverage + W_TRIGGER_COVERAGE * f.triggerCoverage;
  if (f.apiSurfaceExactMatch) conf = Math.max(conf, 0.8);
  if (f.errorTypeExactMatch) conf = Math.max(conf, 0.75);
  // An exact identifier match (the query names the precise symbol the block
  // is about) is a strong structured signal, on par with an errorType match.
  if (f.symbolExactMatch) conf = Math.max(conf, 0.75);
  if (f.genericOnly) conf = Math.min(conf, 0.2);
  return clamp01(conf);
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * The serving decision. `candidates` MUST already be in rank order (best
 * first) — ranking is `block-serving`'s job; this only decides fire/abstain
 * for the top candidate, using the runner-up for the ambiguity margin.
 *
 * Conservative defaults (all enforced here):
 *   - generic-only overlap                  → abstain
 *   - < minMeaningfulMatches AND no exact    → abstain (one-token pass needs structured exactness)
 *   - evidenceConfidence < absolute floor    → abstain (lone candidate still needs absolute evidence)
 *   - top−second margin < marginThreshold    → abstain (ambiguous siblings)
 *   - calibratedProb < gateThreshold         → abstain
 *   - else                                   → inject
 */
export function decideServing(
  query: ServingQuery,
  candidates: readonly ServingCandidate[],
  policy: ServingPolicy,
  calibrate: EvidenceCalibrator = identityEvidenceCalibrator,
): { decision: ServingDecision; perCandidate: ServingEvidenceV1[] } {
  const base = {
    threshold: policy.gateThreshold,
    marginThreshold: policy.marginThreshold,
  };

  if (candidates.length === 0) {
    return {
      decision: { action: "abstain", reason: "no_candidates", ...base },
      perCandidate: [],
    };
  }

  // Features + calibrated confidence for EVERY candidate. Ranking gave the
  // order; the calibrator (fed `evidenceConfidence`, never the rank score)
  // decides which candidate is most likely to help. We authorize THAT one —
  // not blindly the BM25 top — so a trained calibrator can break a lexical
  // tie. Pre-fit (identity) the calibrated value equals the evidence, so the
  // selection reduces to "highest evidence".
  const scored = candidates.map((c) => {
    const core = computeFeatures(query, c);
    return {
      c,
      core,
      calibratedProb: clamp01(calibrate(core.features.evidenceConfidence, c.block)),
    };
  });
  // Selection order: highest calibrated confidence first; stable on ties
  // (keeps the original rank order via index).
  const ordered = scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.calibratedProb - a.s.calibratedProb || a.i - b.i)
    .map((x) => x.s);
  const best = ordered[0]!;
  const runnerUp = ordered[1];
  const secondEvidence = runnerUp ? runnerUp.core.features.evidenceConfidence : 0;
  const secondCalibrated = runnerUp ? runnerUp.calibratedProb : 0;

  const bestFeatures: ServingEvidenceV1 = {
    ...best.core.features,
    secondBestEvidenceConfidence: round4(secondEvidence),
    margin: round4(best.core.features.evidenceConfidence - secondEvidence),
  };
  // Telemetry slate, in candidate (rank) order. secondBest / margin are only
  // meaningful on the selected candidate; zero on the rest.
  const perCandidate: ServingEvidenceV1[] = scored.map((s) =>
    s.c.block.id === best.c.block.id
      ? bestFeatures
      : { ...s.core.features, secondBestEvidenceConfidence: 0, margin: 0 },
  );

  const decide = (
    action: ServingAction,
    reason: ServingReason,
    calibratedProb?: number,
  ): ServingDecision => ({
    action,
    reason,
    topCandidateId: best.c.block.id,
    features: bestFeatures,
    ...(calibratedProb !== undefined ? { calibratedProb: round4(calibratedProb) } : {}),
    ...base,
  });

  // 1. Generic-only overlap always abstains.
  if (bestFeatures.genericOnly) {
    return { decision: decide("abstain", "generic_only"), perCandidate };
  }
  // 2. Weak evidence: require ≥ minMeaningfulMatches meaningful matches, OR an
  //    exact structured match (the only thing that licenses a one-token pass).
  if (best.core.meaningfulMatchCount < policy.minMeaningfulMatches && !best.core.hasExactStructured) {
    return { decision: decide("abstain", "weak_evidence"), perCandidate };
  }
  // 3. Absolute evidence floor — a lone candidate still must clear it.
  if (bestFeatures.evidenceConfidence < policy.minEvidenceConfidence) {
    return { decision: decide("abstain", "weak_evidence"), perCandidate };
  }
  // 4. Ambiguity margin on CALIBRATED confidence — a trained calibrator can
  //    separate lexical siblings; pre-fit (identity) this equals the evidence
  //    margin, so equal-evidence siblings still abstain by default.
  if (runnerUp && best.calibratedProb - secondCalibrated < policy.marginThreshold) {
    return { decision: decide("abstain", "ambiguous_margin", best.calibratedProb), perCandidate };
  }
  // 5. Calibrated gate.
  if (best.calibratedProb < policy.gateThreshold) {
    return { decision: decide("abstain", "below_calibrated_threshold", best.calibratedProb), perCandidate };
  }
  return { decision: decide("inject", "injected", best.calibratedProb), perCandidate };
}

/** Human-readable one-liner for CLI/debug output. */
export function explainDecision(d: ServingDecision): string {
  const f = d.features;
  const head = d.action === "inject" ? "INJECT" : "ABSTAIN";
  const why: Record<ServingReason, string> = {
    no_candidates: "no candidates retrieved",
    weak_evidence: "evidence below absolute floor / too few meaningful matches",
    generic_only: "overlap is generic vocabulary only",
    ambiguous_margin: "top candidate not separated from runner-up",
    below_calibrated_threshold: "calibrated P(helpful) below gate",
    injected: "evidence and margin cleared all gates",
  };
  const detail = f
    ? ` [conf=${f.evidenceConfidence} margin=${f.margin} matches=${f.matchedInformativeTokenCount}/${f.informativeQueryTokenCount}` +
      `${f.apiSurfaceExactMatch ? " api" : ""}${f.errorTypeExactMatch ? " err" : ""}${f.symbolExactMatch ? " sym" : ""}${f.pathTokenMatch ? " path" : ""}]`
    : "";
  const prob = d.calibratedProb !== undefined ? ` p=${d.calibratedProb} gate=${d.threshold}` : ` gate=${d.threshold}`;
  return `${head}: ${why[d.reason]}${detail}${prob}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((x) => set.has(x));
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
