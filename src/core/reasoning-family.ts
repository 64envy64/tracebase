/**
 * Reasoning-family layer — production family contract (Router V2, Phase B).
 *
 * WHY THIS EXISTS
 *   The V1 ambiguity gate compares the top candidate BLOCK with the runner-up
 *   BLOCK. When the top two candidates are near-duplicate captures of the SAME
 *   lesson, their confidences are nearly equal, the scalar margin collapses, and
 *   the policy abstains on a lesson it should serve. Conversely, two genuinely
 *   different sibling lessons SHOULD trip the margin. A block-vs-block scalar
 *   cannot tell those cases apart. This layer aggregates candidates into
 *   FAMILIES first, then compares the top family with the runner-up family.
 *
 * THE CONTRACT (docs/PLAN.md §4.4)
 *   • Duplicate captures (same trigger fingerprint) collapse to ONE distinct
 *     case — they can never manufacture confidence.
 *   • Independent supporting cases (distinct fingerprint AND distinct source)
 *     may RAISE confidence, with diminishing returns and a bounded cap.
 *   • Pitfall lessons and net-harmful outcomes REDUCE confidence.
 *   • Provenance and attribution are preserved: every family records its member
 *     and distinct-case ids, the prototype it would serve, and its source set.
 *
 * RESOLVER BOUNDARY (non-negotiable)
 *   `src/eval/family-fingerprint.ts` is a DOGFOOD OBSERVABILITY heuristic
 *   (top-salient-token SHA1) and is NOT promoted here. The production resolver
 *   is a separate, extensible `FamilyResolver` contract whose default reasons
 *   over STRUCTURED invariants + discriminative trigger vocabulary, not an
 *   opaque hash. Swapping in an embedding- or learned-cluster resolver later is
 *   a drop-in: implement `FamilyResolver`.
 *
 * Pure + deterministic: clustering iterates candidates in a stable id order;
 * no DB, no I/O, no `Date.now`/randomness. Family aggregation runs on the
 * BOUNDED retrieved candidate set only, so it needs no new storage and no
 * migration.
 */
import type { ReasoningBlock } from "../types.js";
import { tokenizeInformative, isGenericToken } from "./serving-tokenizer.js";
import type { ServingEvidenceV2 } from "./serving-evidence-v2.js";

// ---------------------------------------------------------------------------
// Family contract
// ---------------------------------------------------------------------------

/**
 * A recurring reasoning class, aggregated from the retrieved candidates.
 * Mirrors the forward `ReasoningFamily` contract in docs/PLAN.md §4.4.
 */
export interface ReasoningFamily {
  id: string;
  /** Block id we would actually inject for this family (best-matching member). */
  prototypeBlockId: string;
  /** Every candidate block assigned to this family. */
  memberBlockIds: string[];
  /** Unique problem signatures (trigger fingerprints) — duplicates collapsed. */
  distinctCaseIds: string[];
  /** Distinct, independently-sourced supporting cases (corroboration). */
  supportingCaseIds: string[];
  /** Distinct pitfall-kind members (contradiction sources). */
  pitfallCaseIds: string[];
  /** Count of distinct provenance sources backing the family. */
  sourceDiversity: number;
  helpfulOutcomes: number;
  harmfulOutcomes: number;
  unresolvedOutcomes: number;
  /** Best single-member V2 confidence (the anchor). */
  baseConfidence: number;
  /** Bounded lift from independent corroboration (≥0). */
  supportBoost: number;
  /** Bounded multiplicative penalty from pitfalls / harmful outcomes ∈ [0,1). */
  contradictionPenalty: number;
  /** Final aggregate family confidence ∈ [0,1]. */
  confidence: number;
}

/** One candidate handed to the resolver: a block plus its computed V2 evidence. */
export interface FamilyCandidate {
  block: ReasoningBlock;
  evidence: ServingEvidenceV2;
}

/** Explainable evidence for one accepted family link (member → anchor). */
export interface FamilyJoinEvidence {
  /** Block id of the cluster anchor the member linked to. */
  anchor: string;
  /** Block id of the member that joined. */
  member: string;
  keywordJaccard: number;
  errorTypeMatch: boolean;
  apiOverlap: number;
  /** Which linkage rule fired. */
  rule: "strong-vocabulary" | "vocabulary+structured";
}

/**
 * Assignment of candidates to families. Extensible: a resolver only owns the
 * GROUPING decision (which blocks share a family). Confidence aggregation is
 * shared and lives in `aggregateFamilies`.
 */
export interface FamilyAssignment {
  /** Family key per candidate, in the SAME order as the input candidates. */
  familyKeyByIndex: string[];
  /** Explainable evidence for every accepted link (empty for singletons). */
  joins: FamilyJoinEvidence[];
  /**
   * Count of links a single-link resolver WOULD have made but anchor-coherence
   * rejected: a candidate that linked to a non-anchor member of an existing
   * cluster but NOT to that cluster's anchor (a prevented transitive bridge).
   */
  bridgesPrevented: number;
}

/**
 * Pluggable family resolver. Implementations MUST be deterministic for a given
 * candidate set (same input order → same grouping) and MUST NOT read raw body
 * text beyond the privacy-scanned signals already on the candidate.
 */
export interface FamilyResolver {
  readonly name: string;
  resolve(candidates: readonly FamilyCandidate[]): FamilyAssignment;
}

// ---------------------------------------------------------------------------
// Default resolver: multi-axis strong-link + anchor (leader) clustering
// ---------------------------------------------------------------------------

/**
 * Vocabulary similarity above which two candidates link on mechanism vocabulary
 * ALONE (a genuine paraphrase of the same mechanism). Principled, not tuned.
 */
const STRONG_JACCARD = 0.6;
/**
 * Vocabulary similarity that links ONLY when a structured axis (errorType or an
 * apiSurface element) corroborates it. Below this, no link regardless of
 * structured overlap — so a generic shared errorType or one shared API can
 * never collapse two different mechanisms into one family.
 */
const MODERATE_JACCARD = 0.34;

/** Discriminative (structured + meaningful) signature of a candidate's trigger. */
function signatureOf(block: ReasoningBlock): {
  errorType?: string;
  apis: Set<string>;
  keywords: Set<string>;
} {
  const inv = block.trigger.invariants ?? {};
  const keywords = new Set<string>();
  for (const t of tokenizeInformative(block.trigger.situation)) {
    if (!isGenericToken(t)) keywords.add(t);
  }
  for (const kw of block.trigger.keywords ?? []) {
    for (const t of tokenizeInformative(kw)) if (!isGenericToken(t)) keywords.add(t);
  }
  return {
    ...(inv.errorType ? { errorType: inv.errorType.toLowerCase() } : {}),
    apis: new Set((inv.apiSurface ?? []).map((a) => a.toLowerCase())),
    keywords,
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

interface PairEvidence {
  keywordJaccard: number;
  errorTypeMatch: boolean;
  apiOverlap: number;
  linked: boolean;
  rule?: "strong-vocabulary" | "vocabulary+structured";
}

/**
 * Multi-axis link evidence between two candidates. Mechanism VOCABULARY is the
 * backbone; structured axes only CORROBORATE it. Two blocks link when:
 *   - vocabulary alone is strongly similar (Jaccard ≥ STRONG_JACCARD), OR
 *   - vocabulary is moderately similar (≥ MODERATE_JACCARD) AND a structured
 *     axis (same errorType, or ≥1 shared apiSurface) corroborates.
 * A structured axis ALONE (generic errorType / one shared API) with weak
 * vocabulary does NOT link — that is the bridge/over-merge failure this fixes.
 */
function joinEvidence(a: ReasoningBlock, b: ReasoningBlock): PairEvidence {
  const sa = signatureOf(a);
  const sb = signatureOf(b);
  const kw = jaccard(sa.keywords, sb.keywords);
  const errorTypeMatch = !!sa.errorType && !!sb.errorType && sa.errorType === sb.errorType;
  let apiOverlap = 0;
  for (const api of sa.apis) if (sb.apis.has(api)) apiOverlap++;
  const corroborated = errorTypeMatch || apiOverlap >= 1;
  if (kw >= STRONG_JACCARD) {
    return { keywordJaccard: kw, errorTypeMatch, apiOverlap, linked: true, rule: "strong-vocabulary" };
  }
  if (kw >= MODERATE_JACCARD && corroborated) {
    return { keywordJaccard: kw, errorTypeMatch, apiOverlap, linked: true, rule: "vocabulary+structured" };
  }
  return { keywordJaccard: kw, errorTypeMatch, apiOverlap, linked: false };
}

/**
 * Default deterministic resolver. Anchor (leader) clustering over a stable
 * (block-id-sorted) candidate order: a candidate joins the existing cluster
 * whose ANCHOR (lowest-id member) it strong-links to (lowest anchor id wins
 * ties); otherwise it founds a new cluster as its own anchor.
 *
 * Why anchor clustering and not single-link union-find: requiring every member
 * to link to a common anchor structurally prevents transitive bridge merges
 * (A~B, B~C, A≁C never collapse into one family — C must link to A, not to B).
 * It is deterministic, bounded over the candidate set, records explainable join
 * evidence, and preserves duplicate-collapse (identical triggers link trivially
 * via Jaccard 1.0). Swappable: any `FamilyResolver` can replace it later.
 */
export class StructuredSignatureResolver implements FamilyResolver {
  readonly name = "structured-signature.v2";

  resolve(candidates: readonly FamilyCandidate[]): FamilyAssignment {
    const n = candidates.length;
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) =>
      candidates[i]!.block.id < candidates[j]!.block.id ? -1 : candidates[i]!.block.id > candidates[j]!.block.id ? 1 : 0,
    );

    interface Cluster { anchorIdx: number; members: number[] }
    const clusters: Cluster[] = [];
    const clusterByIdx = new Map<number, Cluster>();
    const joins: FamilyJoinEvidence[] = [];
    let bridgesPrevented = 0;

    for (const idx of order) {
      const block = candidates[idx]!.block;
      let best: { cluster: Cluster; ev: PairEvidence; anchorId: string } | undefined;
      let bridgedNonAnchor = false;

      for (const cluster of clusters) {
        const anchorBlock = candidates[cluster.anchorIdx]!.block;
        const anchorEv = joinEvidence(block, anchorBlock);
        if (anchorEv.linked) {
          const anchorId = anchorBlock.id;
          if (!best || anchorId < best.anchorId) best = { cluster, ev: anchorEv, anchorId };
        } else {
          // Linked to a non-anchor member but not the anchor → a bridge that
          // single-link would have merged. Anchor clustering refuses it.
          for (const m of cluster.members) {
            if (m === cluster.anchorIdx) continue;
            if (joinEvidence(block, candidates[m]!.block).linked) {
              bridgedNonAnchor = true;
              break;
            }
          }
        }
      }

      if (best) {
        best.cluster.members.push(idx);
        clusterByIdx.set(idx, best.cluster);
        joins.push({
          anchor: best.anchorId,
          member: block.id,
          keywordJaccard: round4(best.ev.keywordJaccard),
          errorTypeMatch: best.ev.errorTypeMatch,
          apiOverlap: best.ev.apiOverlap,
          rule: best.ev.rule!,
        });
      } else {
        const cluster: Cluster = { anchorIdx: idx, members: [idx] };
        clusters.push(cluster);
        clusterByIdx.set(idx, cluster);
        if (bridgedNonAnchor) bridgesPrevented++;
      }
    }

    const familyKeyByIndex = candidates.map((_, i) => {
      const cluster = clusterByIdx.get(i)!;
      return `fam:${candidates[cluster.anchorIdx]!.block.id}`;
    });
    return { familyKeyByIndex, joins, bridgesPrevented };
  }
}

// ---------------------------------------------------------------------------
// Aggregation (shared across resolvers)
// ---------------------------------------------------------------------------

/** Bounded lift coefficient for independent corroboration. */
const SUPPORT_K = 0.5;
/** A distinct pitfall member contributes this much contradiction weight. */
const PITFALL_CONTRADICTION = 0.5;
/** Net-harmful outcomes contribute this much contradiction weight. */
const HARMFUL_CONTRADICTION = 0.3;
/** Hard cap on total contradiction weight — never fully zero a family out. */
const CONTRADICTION_CAP = 0.8;

export interface FamilyAggregation {
  resolverName: string;
  /** Families sorted by confidence DESC (ties broken by stable family id). */
  families: ReasoningFamily[];
  /** blockId → familyId, for stamping per-candidate family evidence. */
  familyByBlockId: Map<string, string>;
  /** Explainable evidence for every accepted family link. */
  joins: FamilyJoinEvidence[];
  /** Transitive bridge merges the anchor-coherence rule refused (see resolver). */
  bridgesPrevented: number;
}

/**
 * Aggregate candidates into families and compute each family's confidence.
 *
 * Confidence model (all bounded, all principled — none tuned to a fixture):
 *   base        = max member V2 confidence (best single piece of evidence)
 *   supportBoost= (1 - base) * SUPPORT_K * (1 - 1/independentCases)   [≥2 only]
 *   penalty     = min(CAP, pitfall? PITFALL : 0 + harmful>helpful? HARMFUL : 0)
 *   confidence  = clamp01((base + supportBoost) * (1 - penalty))
 *
 * Duplicate captures (same trigger fingerprint) collapse to ONE distinct case,
 * so they never raise the max beyond their single value and never count as
 * independent support.
 */
export function aggregateFamilies(
  candidates: readonly FamilyCandidate[],
  resolver: FamilyResolver = new StructuredSignatureResolver(),
): FamilyAggregation {
  if (candidates.length === 0) {
    return { resolverName: resolver.name, families: [], familyByBlockId: new Map(), joins: [], bridgesPrevented: 0 };
  }
  const assignment = resolver.resolve(candidates);
  const groups = new Map<string, FamilyCandidate[]>();
  candidates.forEach((c, i) => {
    const key = assignment.familyKeyByIndex[i] ?? `fam:${c.block.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  });

  const families: ReasoningFamily[] = [];
  for (const [id, members] of groups) {
    // Distinct cases = unique trigger fingerprints. Duplicates collapse to the
    // highest-confidence representative.
    const byFingerprint = new Map<string, FamilyCandidate>();
    for (const m of members) {
      const fp = m.block.trigger.fingerprint;
      const prev = byFingerprint.get(fp);
      if (!prev || m.evidence.evidenceConfidence > prev.evidence.evidenceConfidence) {
        byFingerprint.set(fp, m);
      }
    }
    const distinct = [...byFingerprint.values()];

    // Prototype: the highest-V2-confidence distinct case (what we'd inject).
    const prototype = distinct.reduce((best, c) =>
      c.evidence.evidenceConfidence > best.evidence.evidenceConfidence ? c : best,
    );
    const baseConfidence = prototype.evidence.evidenceConfidence;

    // Independent supporting cases: distinct fingerprint AND distinct source.
    const sources = new Set<string>();
    for (const c of distinct) {
      const p = c.block.provenance;
      sources.add(p?.parentTraceId ?? p?.sourceTaskId ?? c.block.id);
    }
    const sourceDiversity = sources.size;
    const independentCases = Math.min(distinct.length, sourceDiversity);

    const supportBoost =
      independentCases >= 2 ? (1 - baseConfidence) * SUPPORT_K * (1 - 1 / independentCases) : 0;

    // Contradiction: distinct pitfall members + net-harmful outcomes.
    const pitfalls = distinct.filter((c) => (c.block.kind ?? "success") === "pitfall");
    let helpful = 0;
    let harmful = 0;
    let unresolved = 0;
    for (const c of distinct) {
      const s = c.block.stats;
      const h = s?.timesHelpful ?? 0;
      const x = s?.timesCounterproductive ?? 0;
      helpful += h;
      harmful += x;
      unresolved += Math.max(0, (s?.timesAgentUsed ?? 0) - h - x);
    }
    const pitfallTerm = pitfalls.length > 0 ? PITFALL_CONTRADICTION : 0;
    const harmfulTerm = harmful > helpful ? HARMFUL_CONTRADICTION : 0;
    const contradictionPenalty = Math.min(CONTRADICTION_CAP, pitfallTerm + harmfulTerm);

    const confidence = clamp01((baseConfidence + supportBoost) * (1 - contradictionPenalty));

    families.push({
      id,
      prototypeBlockId: prototype.block.id,
      memberBlockIds: members.map((m) => m.block.id),
      distinctCaseIds: distinct.map((d) => d.block.id),
      supportingCaseIds: distinct.filter((d) => d.block.id !== prototype.block.id).map((d) => d.block.id),
      pitfallCaseIds: pitfalls.map((p) => p.block.id),
      sourceDiversity,
      helpfulOutcomes: helpful,
      harmfulOutcomes: harmful,
      unresolvedOutcomes: unresolved,
      baseConfidence: round4(baseConfidence),
      supportBoost: round4(supportBoost),
      contradictionPenalty: round4(contradictionPenalty),
      confidence: round4(confidence),
    });
  }

  families.sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const familyByBlockId = new Map<string, string>();
  for (const f of families) for (const bid of f.memberBlockIds) familyByBlockId.set(bid, f.id);

  return {
    resolverName: resolver.name,
    families,
    familyByBlockId,
    joins: assignment.joins,
    bridgesPrevented: assignment.bridgesPrevented,
  };
}

// ---------------------------------------------------------------------------
// Family-level decision telemetry (top vs runner-up family)
// ---------------------------------------------------------------------------

export interface FamilyDecisionTelemetry {
  resolverName: string;
  familyCount: number;
  topFamilyId?: string;
  topFamilyConfidence: number;
  prototypeBlockId?: string;
  runnerUpFamilyId?: string;
  runnerUpFamilyConfidence: number;
  /** topFamily.confidence − runnerUpFamily.confidence ∈ [0,1]. */
  familyMargin: number;
  topFamilySupport: number;
  topFamilyContradiction: number;
  topFamilySourceDiversity: number;
  /** Transitive bridge merges the resolver refused on this candidate slate. */
  bridgesPrevented: number;
}

/** Summarize the aggregation into the top-vs-runner-up family decision telemetry. */
export function summarizeFamilyDecision(agg: FamilyAggregation): FamilyDecisionTelemetry {
  const top = agg.families[0];
  const runnerUp = agg.families[1];
  return {
    resolverName: agg.resolverName,
    familyCount: agg.families.length,
    ...(top ? { topFamilyId: top.id, prototypeBlockId: top.prototypeBlockId } : {}),
    topFamilyConfidence: top ? top.confidence : 0,
    ...(runnerUp ? { runnerUpFamilyId: runnerUp.id } : {}),
    runnerUpFamilyConfidence: runnerUp ? runnerUp.confidence : 0,
    familyMargin: round4((top ? top.confidence : 0) - (runnerUp ? runnerUp.confidence : 0)),
    topFamilySupport: top ? top.distinctCaseIds.length : 0,
    topFamilyContradiction: top ? top.contradictionPenalty : 0,
    topFamilySourceDiversity: top ? top.sourceDiversity : 0,
    bridgesPrevented: agg.bridgesPrevented,
  };
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
