/**
 * ServingEvidenceV2 — structured representation contract (Router V2, Phase A).
 *
 * WHY THIS EXISTS
 *   The V1 serving evidence (src/core/serving-confidence.ts) scores a candidate
 *   on flat lexical overlap over `situation + keywords` only. Two sibling
 *   lessons that share generic surface vocabulary ("crash", "value", "access")
 *   score nearly the same, so the top-vs-second margin collapses and the policy
 *   abstains (the observed `ambiguous_margin = 28/30`, within-family recall 5%).
 *   That is a REPRESENTATION problem, not a threshold problem — so we do NOT
 *   lower a gate. We add a richer, structured second stage of evidence.
 *
 * WHAT V2 ADDS (all additive, all versioned under `featureVersion: 2`)
 *   1. A provider-neutral structured memory view (`ReasoningMemoryV2`) derived
 *      from the existing `ReasoningBlock` source of truth — no field is
 *      duplicated into storage; the view is computed on read.
 *   2. Field-aware overlap: the query is compared against the privacy-scanned
 *      structured body fields (mechanism, unlock, dead ends) — the CAUSAL core
 *      of the lesson — not just the situation line. A sibling that shares only
 *      surface words gets no causal-field credit.
 *   3. Lexical rarity: token overlaps are IDF-weighted over the BOUNDED
 *      candidate set, so the rare causal tokens that actually distinguish a
 *      family (e.g. "dereference", "idempotency") dominate the generic ones
 *      ("value", "request") that made V1 siblings look alike.
 *
 * HARD INVARIANTS (enforced here)
 *   • Candidate generation is unchanged and still FTS-over-trigger-only — this
 *     module is a SECOND stage that runs only on already-retrieved candidates.
 *     It never widens retrieval and never reads raw body text at candidate-gen
 *     time.
 *   • Structured body fields are scanned by the SAME leakage + prompt-injection
 *     guards used on every write path (src/core/guard.ts) BEFORE they are
 *     tokenized or scored. A field that trips a guard is redacted from scoring
 *     and recorded in `redactedFields` — it can never influence the decision.
 *   • Lexical rarity is computed over the bounded candidate set only — no global
 *     corpus IDF, hence NO new storage and NO migration.
 *   • Pure functions over `(query, candidate, view, rarity)`. No DB, no I/O, no
 *     `Date.now`/randomness — deterministic and replayable.
 *
 * V2 evidence is COMPOSED with V1, never a replacement: the blended confidence
 * can only LIFT V1 toward 1 in proportion to genuine structured applicability,
 * so a candidate with no causal overlap (every negative control) keeps its V1
 * confidence and the conservative V1 guards still apply on top.
 */
import type { ReasoningBlock, BlockInvariants } from "../types.js";
import { tokenizeInformative, isGenericToken } from "./serving-tokenizer.js";
import { detectLeakageExtended, detectPromptInjectionPatterns } from "./guard.js";
import {
  computeFeatures,
  type FeatureCore,
  type ServingEvidenceV1,
  type ServingCandidate,
  type ServingQuery,
} from "./serving-confidence.js";

/** Current structured-evidence feature-schema version. Bump on any field change. */
export const SERVING_FEATURE_VERSION_V2 = 2 as const;

// ---------------------------------------------------------------------------
// Provider-neutral structured memory view (ReasoningMemoryV2)
// ---------------------------------------------------------------------------

/** Compact, source-agnostic provenance for the structured view. */
export interface MemoryProvenance {
  /** Stable per-capture id (a re-capture of the same trace shares it). */
  sourceTaskId: string;
  /** Trace this lesson was distilled from, when retained. Used for source diversity. */
  parentTraceId?: string;
  /** How the lesson entered the store (trajectory vs imported vs distilled). */
  extractedFrom: ReasoningBlock["provenance"]["extractedFrom"];
}

/**
 * Outcome rollup for one lesson, read from the block's analytics counters.
 * `harmful > helpful` is a contradiction signal the family layer uses to
 * REDUCE confidence; duplicate captures cannot inflate these because they are
 * raw per-block counts the family layer aggregates over DISTINCT cases only.
 */
export interface MemoryOutcomeSummary {
  helpful: number;
  harmful: number;
  unresolved: number;
}

/**
 * Provider-neutral structured lesson, derived from a `ReasoningBlock`. This is
 * the shape the router reasons over — it deliberately mirrors the forward
 * `ReasoningMemoryV2` contract in docs/PLAN.md §4.1 without duplicating storage.
 */
export interface ReasoningMemoryV2 {
  /** Stable problem signature (the trigger fingerprint — already the dedupe key). */
  problemSignature: string;
  /** Contexts where the lesson applies, derived from structured invariants. */
  applicability: string[];
  mechanism: string;
  unlock: string;
  deadEnds: string[];
  verification: string;
  /** Structured invariant tokens (lang/framework/errorType/apiSurface). */
  invariants: string[];
  apiSurface?: string[];
  errorTypes?: string[];
  /** `pitfall` lessons are corrective: matching one is a contradiction signal. */
  kind: ReasoningBlock["kind"];
  provenance: MemoryProvenance;
  outcomes: MemoryOutcomeSummary;
}

/** Derive applicability tags from structured invariants (provider-neutral). */
function applicabilityOf(inv: BlockInvariants): string[] {
  const tags: string[] = [];
  if (inv.language) tags.push(`lang:${inv.language.toLowerCase()}`);
  if (inv.framework) tags.push(`fw:${inv.framework.toLowerCase()}`);
  if (inv.errorType) tags.push(`err:${inv.errorType.toLowerCase()}`);
  for (const api of inv.apiSurface ?? []) tags.push(`api:${api.toLowerCase()}`);
  return tags;
}

/**
 * Project a stored block onto the provider-neutral structured view. Reuses the
 * `ReasoningBlock` source of truth; adds no persisted fields. V1 rows degrade
 * safely — every field has a defined fallback, so a legacy block with an empty
 * body still produces a valid (low-signal) view.
 */
export function toReasoningMemoryV2(block: ReasoningBlock): ReasoningMemoryV2 {
  const inv = block.trigger.invariants ?? {};
  const stats = block.stats;
  return {
    problemSignature: block.trigger.fingerprint,
    applicability: applicabilityOf(inv),
    mechanism: block.body?.mechanism ?? "",
    unlock: block.body?.unlock ?? "",
    deadEnds: block.body?.deadEnds ?? [],
    verification: block.body?.verification ?? "",
    invariants: applicabilityOf(inv),
    ...(inv.apiSurface && inv.apiSurface.length > 0 ? { apiSurface: inv.apiSurface } : {}),
    ...(inv.errorType ? { errorTypes: [inv.errorType] } : {}),
    kind: block.kind ?? "success",
    provenance: {
      sourceTaskId: block.provenance?.sourceTaskId ?? block.id,
      ...(block.provenance?.parentTraceId ? { parentTraceId: block.provenance.parentTraceId } : {}),
      extractedFrom: block.provenance?.extractedFrom ?? "distilled",
    },
    outcomes: {
      helpful: stats?.timesHelpful ?? 0,
      harmful: stats?.timesCounterproductive ?? 0,
      // "unresolved" = injected/used but never resolved either way.
      unresolved: Math.max(0, (stats?.timesAgentUsed ?? 0) - (stats?.timesHelpful ?? 0) - (stats?.timesCounterproductive ?? 0)),
    },
  };
}

// ---------------------------------------------------------------------------
// Privacy-scanned structured view (the fields actually scored)
// ---------------------------------------------------------------------------

/** The body fields V2 may score. `situation` is the V1 trigger and is scored by V1. */
export type ScorableField = "mechanism" | "unlock" | "deadEnds" | "verification";

const SCORABLE_FIELDS: readonly ScorableField[] = ["mechanism", "unlock", "deadEnds", "verification"];

/**
 * The privacy-scanned, tokenized structured view used for second-stage
 * scoring. Each scorable body field is run through the leakage + prompt-
 * injection guards; a field that trips a guard is REDACTED (no tokens kept)
 * and named in `redactedFields`, so it can never influence the decision.
 */
export interface StructuredMemoryView {
  blockId: string;
  /** Meaningful (non-generic) tokens of the trigger situation + keywords. */
  situationTokens: Set<string>;
  /** Meaningful (non-generic) tokens per scorable body field. Empty when redacted. */
  fieldTokens: Record<ScorableField, Set<string>>;
  /** Union of situation + kept-body tokens (used to build the rarity model). */
  allTokens: Set<string>;
  /** Body fields dropped by a privacy guard, with the pattern name that tripped. */
  redactedFields: Array<{ field: ScorableField; pattern: string }>;
  memory: ReasoningMemoryV2;
}

function rawField(block: ReasoningBlock, field: ScorableField): string {
  const body = block.body;
  if (!body) return "";
  if (field === "deadEnds") return (body.deadEnds ?? []).join(" • ");
  return (body[field] as string | undefined) ?? "";
}

/** Meaningful (non-generic, len>=2) token set of a free-text field. */
function meaningfulFieldTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenizeInformative(text)) {
    if (!isGenericToken(t)) out.add(t);
  }
  return out;
}

/**
 * Build the privacy-scanned structured view for one candidate block. Runs the
 * shared leakage + injection guards on every scorable body field BEFORE
 * tokenizing it. A tripped field is redacted and recorded — defense in depth
 * on top of the capture-time scan, so even a block that predates a guard (or a
 * future field) cannot leak through the serving path.
 */
export function buildStructuredView(block: ReasoningBlock): StructuredMemoryView {
  const fieldTokens = {
    mechanism: new Set<string>(),
    unlock: new Set<string>(),
    deadEnds: new Set<string>(),
    verification: new Set<string>(),
  } as Record<ScorableField, Set<string>>;
  const allTokens = new Set<string>();
  const redactedFields: Array<{ field: ScorableField; pattern: string }> = [];

  // Situation + curated keywords are the privacy-safe trigger (already scanned
  // at capture and used by FTS); include their meaningful tokens so the rarity
  // model sees the full candidate vocabulary.
  const situationTokens = new Set<string>();
  for (const t of tokenizeInformative(block.trigger?.situation ?? "")) {
    if (!isGenericToken(t)) situationTokens.add(t);
  }
  for (const kw of block.trigger?.keywords ?? []) {
    for (const t of tokenizeInformative(kw)) if (!isGenericToken(t)) situationTokens.add(t);
  }
  for (const t of situationTokens) allTokens.add(t);

  for (const field of SCORABLE_FIELDS) {
    const text = rawField(block, field);
    if (!text) continue;
    const leak = detectLeakageExtended(text);
    const inj = leak ? null : detectPromptInjectionPatterns(text);
    if (leak || inj) {
      redactedFields.push({ field, pattern: leak ?? inj ?? "unknown" });
      continue; // redacted: no tokens kept, field cannot be scored.
    }
    const toks = meaningfulFieldTokens(text);
    fieldTokens[field] = toks;
    for (const t of toks) allTokens.add(t);
  }

  return {
    blockId: block.id,
    situationTokens,
    fieldTokens,
    allTokens,
    redactedFields,
    memory: toReasoningMemoryV2(block),
  };
}

// ---------------------------------------------------------------------------
// Bounded lexical rarity (IDF over the candidate set — no global corpus)
// ---------------------------------------------------------------------------

/**
 * Inverse-document-frequency weights over a BOUNDED candidate set. A token's
 * rarity is high when it appears in the structured fields of FEW candidates —
 * exactly the causal tokens that distinguish one family from its siblings.
 * Built over the retrieved candidates only, so it needs no persisted corpus
 * statistics and no migration.
 */
export interface RarityModel {
  readonly n: number;
  weight(token: string): number;
}

/**
 * Smoothed IDF: `ln((N + 1) / (df + 0.5))`, floored at 0. A token that appears
 * in NO candidate (df = 0) is non-discriminative for THIS retrieval — it weighs
 * 0, so query tokens absent from every candidate's fields neither help nor (the
 * bug this fixes) inflate the denominator and suppress the coverage of tokens
 * that DO match. With N=1 the surviving tokens are uniform (rarity degenerates
 * to plain coverage); discrimination grows with the candidate count.
 */
export function buildRarityModel(views: readonly StructuredMemoryView[]): RarityModel {
  const n = views.length;
  const df = new Map<string, number>();
  for (const v of views) {
    for (const t of v.allTokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return {
    n,
    weight(token: string): number {
      const d = df.get(token) ?? 0;
      if (d === 0) return 0; // absent from all candidates → not discriminative here.
      const idf = Math.log((n + 1) / (d + 0.5));
      return idf > 0 ? idf : 0;
    },
  };
}

// ---------------------------------------------------------------------------
// ServingEvidenceV2
// ---------------------------------------------------------------------------

/** Rarity-weighted query coverage per scored field, each ∈ [0,1]. */
export interface FieldOverlapV2 {
  situation: number;
  mechanism: number;
  unlock: number;
  deadEnds: number;
  invariants: number;
}

/**
 * Family-level signals attached to a candidate. Defaults (single distinct
 * case, no contradiction) are filled here; the family layer
 * (src/core/reasoning-family.ts) overwrites them after aggregation.
 */
export interface FamilyEvidenceV2 {
  familyId?: string;
  /** Distinct independent supporting cases in the family (duplicates collapsed). */
  support: number;
  /** Contradiction weight from pitfall lessons / harmful outcomes (≥0). */
  contradiction: number;
  /** Distinct provenance sources backing the family. */
  sourceDiversity: number;
}

/**
 * Structured second-stage evidence for one candidate. Embeds the V1 evidence
 * (the literal problem signals + lexical coverage are NOT re-derived) and adds
 * the field-aware, rarity-weighted, family-aware signals under featureVersion 2.
 */
export interface ServingEvidenceV2 {
  featureVersion: typeof SERVING_FEATURE_VERSION_V2;
  blockId: string;
  /** V1 literal signals + coverage, reused verbatim (source of truth). */
  base: ServingEvidenceV1;
  /** Rarity-weighted per-field overlap. */
  fieldOverlap: FieldOverlapV2;
  /** Overall meaningful, rarity-weighted query coverage across kept fields ∈ [0,1]. */
  rarityWeightedCoverage: number;
  /** Causal-field applicability ∈ [0,1] — the lift signal. */
  structuredApplicability: number;
  /** Body fields dropped by a privacy guard (audit; empty on a clean block). */
  redactedFields: Array<{ field: ScorableField; pattern: string }>;
  /** V1 confidence, carried through for explainability. */
  v1Confidence: number;
  /** Blended V2 confidence ∈ [0,1] — never below v1Confidence. */
  evidenceConfidence: number;
  family: FamilyEvidenceV2;
  rankScore: number;
  rerankerScore?: number;
}

// Causal-leaning field weights for the applicability blend. Chosen on principle
// (the mechanism + unlock are the transferable core of a lesson), NOT tuned to
// any corpus. They sum to 1. `deadEnds` and `verification` are deliberately
// EXCLUDED from the positive blend: a dead-end match is a CONTRADICTION signal
// (the query resembles the wrong approach) handled by the family layer, and
// `verification` is low-signal boilerplate.
const FIELD_WEIGHTS = { situation: 0.3, mechanism: 0.4, unlock: 0.2, invariants: 0.1 } as const;

// Lexical-view sub-weights mirror V1's own coverage blend (0.7 query / 0.3
// trigger). Structured applicability AMPLIFIES that lexical relevance rather
// than adding independently — `STRUCT_AMP` caps the amplification so a perfect
// structured match can at most DOUBLE the lexical confidence (a clean, a-priori
// prior: structured evidence is worth at most as much as the lexical evidence
// it is conditioned on, NOT swept against the corpus). This conditional form is
// what keeps an unrelated query — near-zero trigger coverage — below the
// evidence floor even when it incidentally shares a rare body token, while
// still opening the family margin for a genuinely-matching lesson. When a
// feature-versioned calibrator is fit on outcomes (Phase E), it replaces this.
const W_LEXICAL_QUERY = 0.7;
const W_LEXICAL_TRIGGER = 0.3;
const STRUCT_AMP = 1.0;

/** Rarity-weighted coverage of `queryTokens` by `fieldTokens` ∈ [0,1]. */
function rarityCoverage(
  queryTokens: readonly string[],
  fieldTokens: Set<string>,
  rarity: RarityModel,
): number {
  let denom = 0;
  let num = 0;
  for (const t of queryTokens) {
    const w = rarity.weight(t);
    denom += w;
    if (fieldTokens.has(t)) num += w;
  }
  return denom > 0 ? clamp01(num / denom) : 0;
}

/**
 * Compute the structured second-stage evidence for one candidate.
 *
 * `view` MUST be the privacy-scanned view for `candidate.block` and `rarity`
 * MUST be built over the full candidate set (so the IDF is shared). The blended
 * confidence lifts V1 toward 1 in proportion to genuine structured
 * applicability:
 *
 *     evidenceConfidence = v1 + (1 - v1) * structuredApplicability
 *
 * This is monotonic, bounded, and conservative: applicability ≈ 0 (every
 * negative control, every causal-mismatched sibling) leaves V1 untouched, so
 * V2 cannot manufacture a false fire that V1 wouldn't already make.
 */
export function computeEvidenceV2(
  query: ServingQuery,
  candidate: ServingCandidate,
  view: StructuredMemoryView,
  rarity: RarityModel,
  /** Optional precomputed V1 core (the decision layer shares one to avoid recompute). */
  precomputedCore?: FeatureCore,
): ServingEvidenceV2 {
  const core = precomputedCore ?? computeFeatures(query, candidate);
  const base: ServingEvidenceV1 = {
    ...core.features,
    secondBestEvidenceConfidence: 0,
    margin: 0,
  };
  const v1Confidence = base.evidenceConfidence;

  // Meaningful query tokens drive the rarity-weighted overlap. Generic tokens
  // are dropped so shared filler vocabulary cannot earn structured credit.
  const queryMeaningful = tokenizeInformative(query.text).filter((t) => !isGenericToken(t));

  const situationTokens = view.situationTokens;
  const invariantTokens = new Set<string>(view.memory.invariants);

  const fieldOverlap: FieldOverlapV2 = {
    situation: rarityCoverage(queryMeaningful, situationTokens, rarity),
    mechanism: rarityCoverage(queryMeaningful, view.fieldTokens.mechanism, rarity),
    unlock: rarityCoverage(queryMeaningful, view.fieldTokens.unlock, rarity),
    deadEnds: rarityCoverage(queryMeaningful, view.fieldTokens.deadEnds, rarity),
    invariants: rarityCoverage(queryMeaningful, invariantTokens, rarity),
  };

  // Causal-field applicability (telemetry / explainability): a weighted blend
  // that leans on the transferable core (mechanism, unlock). `deadEnds` and
  // `verification` are excluded — a dead-end match is a contradiction signal
  // (family layer), verification is boilerplate.
  const structuredApplicability = clamp01(
    FIELD_WEIGHTS.situation * fieldOverlap.situation +
      FIELD_WEIGHTS.mechanism * fieldOverlap.mechanism +
      FIELD_WEIGHTS.unlock * fieldOverlap.unlock +
      FIELD_WEIGHTS.invariants * fieldOverlap.invariants,
  );

  // The DISCRIMINATIVE confidence term: rarity-weighted coverage of the query
  // by the union of the candidate's privacy-safe structured tokens (situation +
  // mechanism + unlock + invariants; dead-ends excluded). Rarity discounts
  // common tokens that appear across many candidates, so the few rare causal
  // tokens that actually identify a family dominate.
  const unionTokens = new Set<string>([
    ...situationTokens,
    ...view.fieldTokens.mechanism,
    ...view.fieldTokens.unlock,
    ...invariantTokens,
  ]);
  const rarityWeightedCoverage = rarityCoverage(queryMeaningful, unionTokens, rarity);

  // Lexical relevance of the query to the candidate's TRIGGER (V1's coverage
  // blend WITHOUT V1's saturating symbol-match floor — that floor pins every
  // candidate at 0.75 on a common identifier-like word like "because" and is
  // exactly the margin-collapse pathology this fixes). This term ANCHORS
  // precision: a query that does not lexically resemble the trigger stays low.
  const lexicalConfidence = clamp01(W_LEXICAL_QUERY * base.queryCoverage + W_LEXICAL_TRIGGER * base.triggerCoverage);
  // Structured applicability AMPLIFIES lexical relevance, conditional on it. It
  // can at most double the lexical confidence (STRUCT_AMP=1) and can NEVER
  // create confidence from a near-zero lexical match — so an unrelated query
  // whose rarity-weighted body overlap incidentally saturates to 1 still stays
  // below the floor, while a genuinely-matching lesson is lifted and its family
  // margin opens.
  let evidenceConfidence = lexicalConfidence * (1 + STRUCT_AMP * rarityWeightedCoverage);
  // Genuine structured-invariant exact matches are high precision on their own.
  if (base.apiSurfaceExactMatch) evidenceConfidence = Math.max(evidenceConfidence, 0.8);
  if (base.errorTypeExactMatch) evidenceConfidence = Math.max(evidenceConfidence, 0.75);
  evidenceConfidence = clamp01(evidenceConfidence);

  return {
    featureVersion: SERVING_FEATURE_VERSION_V2,
    blockId: candidate.block.id,
    base,
    fieldOverlap: round4Fields(fieldOverlap),
    rarityWeightedCoverage: round4(rarityWeightedCoverage),
    structuredApplicability: round4(structuredApplicability),
    redactedFields: view.redactedFields,
    v1Confidence: round4(v1Confidence),
    evidenceConfidence: round4(evidenceConfidence),
    family: { support: 1, contradiction: 0, sourceDiversity: 1 },
    rankScore: candidate.rankScore,
  };
}

/** Human-readable one-liner for CLI/debug output. */
export function explainEvidenceV2(e: ServingEvidenceV2): string {
  const fo = e.fieldOverlap;
  const fam = e.family.familyId
    ? ` fam=${e.family.familyId}[s=${e.family.support},c=${round4(e.family.contradiction)},div=${e.family.sourceDiversity}]`
    : "";
  const red = e.redactedFields.length ? ` redacted=${e.redactedFields.map((r) => r.field).join(",")}` : "";
  return (
    `v2 conf=${e.evidenceConfidence} (v1=${e.v1Confidence} appl=${e.structuredApplicability})` +
    ` fields[sit=${fo.situation} mech=${fo.mechanism} unlock=${fo.unlock} inv=${fo.invariants}]${fam}${red}`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function round4Fields(f: FieldOverlapV2): FieldOverlapV2 {
  return {
    situation: round4(f.situation),
    mechanism: round4(f.mechanism),
    unlock: round4(f.unlock),
    deadEnds: round4(f.deadEnds),
    invariants: round4(f.invariants),
  };
}
