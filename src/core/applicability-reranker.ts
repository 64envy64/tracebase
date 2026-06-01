/**
 * Memory-aware applicability reranker (Router V2, Phase D.2 — docs/PLAN.md §4.5).
 *
 * WHY THIS EXISTS
 *   D.1 delivers good causal candidates (FP=0), but V4's serving decision abstains
 *   on a STRONG prose-only match because its license needs ≥2 corroborating body
 *   fields — intentionally conservative. A query can nail the MECHANISM deeply yet
 *   only graze the remediation, so V4 sees one field and abstains. §4.5 replaces
 *   "is this lexically relevant" with "is this lesson APPLICABLE": a holistic
 *   verdict over the structured axes, where a strong single CAUSAL field may be
 *   enough — but ONLY with contrastive sibling separation and no contradiction.
 *
 * THE CONTRACT
 *   An `ApplicabilityProvider` reads ONLY bounded, privacy-scanned query VIEWS
 *   (the D.1 literal/causal text) + the privacy-scanned structured TOKENS of the
 *   top-N family prototypes (mechanism/unlock/invariants/situation — never raw
 *   bodies, prompts, or paths) + per-candidate outcome/family SIGNALS. It returns
 *   a verdict (applicable | uncertain | inapplicable) with a BOUNDED confidence,
 *   reason enums, a featureVersion, and latency/fallback metadata. The provider-
 *   native confidence is the reranker's own applicability estimate; it is NEVER
 *   surfaced as serving confidence and NEVER changes what is served (shadow only).
 *
 * THE DETERMINISTIC BASELINE combines every axis §4.5 names:
 *   mechanism evidence · remediation evidence · invariant evidence ·
 *   discriminative sibling gap · contradictions/pitfalls · family support/
 *   diversity · stale/harmful outcomes. The "strong single field" path is a
 *   GENERAL evidence rule (max causal-field coverage ≥ STRONG_SINGLE_FIELD AND a
 *   majority discriminative gap AND no contradiction) — not fixture keywords.
 *
 * Pure + deterministic over (views, candidates): same inputs → same verdicts. No
 * DB, no I/O, no clock, no randomness, no LLM. A future neural reranker is a
 * drop-in: implement `ApplicabilityProvider`.
 */
import { tokenizeInformative, isGenericToken } from "./serving-tokenizer.js";

export const APPLICABILITY_FEATURE_VERSION = 1 as const;

/** A field corroborates when the query covers it at least this much (mirrors V4). */
export const FIELD_FLOOR = 0.2;
/**
 * A single CAUSAL field (mechanism OR remediation) is "strong" when the query
 * covers a MAJORITY of its rare tokens. 0.5 is the principled majority threshold,
 * the same a-priori constant V4 uses for its discriminative gap — chosen before
 * results, never tuned to a fixture (docs/PLAN.md §7).
 */
export const STRONG_SINGLE_FIELD = 0.5;
/** The chosen lesson must out-discriminate its nearest sibling by a majority (mirrors V4). */
export const DISCRIMINATIVE_MIN = 0.5;

export type ApplicabilityVerdict = "applicable" | "uncertain" | "inapplicable";

export type ApplicabilityReason =
  | "multi-field-corroborated" // ≥2 body fields + discriminative gap.
  | "strong-single-field-contrastive" // 1 strong causal field + discriminative gap + no contradiction.
  | "single-weak-field" // one field clears the floor but not strong → uncertain.
  | "no-sibling-separation" // evidence present but the discriminative gap failed → uncertain.
  | "contradiction" // a pitfall lesson matched → inapplicable.
  | "stale-harmful" // net-harmful / stale outcomes → inapplicable.
  | "weak-evidence"; // nothing clears the floor → inapplicable.

/** Privacy-scanned structured tokens + outcome/family signals of one prototype. */
export interface ApplicabilityCandidate {
  blockId: string;
  tokens: {
    situation: readonly string[];
    mechanism: readonly string[];
    unlock: readonly string[];
    invariants: readonly string[];
  };
  signals: {
    isPitfall: boolean;
    helpful: number;
    harmful: number;
    unresolved: number;
    /** Distinct independent supporting cases in the family. */
    familySupport: number;
    sourceDiversity: number;
  };
}

/** The bounded, scrubbed query views (D.1 compiler output) the reranker may read. */
export interface ApplicabilityQueryViews {
  literalText: string;
  causalText?: string;
}

/** Bounded evidence numerics for telemetry — never serving confidence, no raw tokens. */
export interface ApplicabilityEvidence {
  mechanism: number;
  remediation: number;
  invariants: number;
  discriminativeGap: number;
  /** 1 when a contradiction/stale signal fired, else 0. */
  contradiction: number;
  familySupport: number;
}

export interface ApplicabilityResult {
  blockId: string;
  verdict: ApplicabilityVerdict;
  /** Bounded applicability confidence ∈ [0,1]. NOT a serving confidence. */
  confidence: number;
  reasons: ApplicabilityReason[];
  featureVersion: number;
  evidence: ApplicabilityEvidence;
}

export interface ApplicabilityContext {
  deadlineMs: number;
  now: () => number;
}

/**
 * A pluggable applicability reranker. MUST be deterministic for fixed inputs and
 * MUST return `null` (not throw) on any failure/timeout so the caller can fall
 * open to the unchanged V4 decision.
 */
export interface ApplicabilityProvider {
  readonly name: string;
  readonly featureVersion: number;
  rank(
    query: ApplicabilityQueryViews,
    candidates: readonly ApplicabilityCandidate[],
    ctx: ApplicabilityContext,
  ): Promise<ApplicabilityResult[] | null>;
}

// ---------------------------------------------------------------------------
// Deterministic local baseline
// ---------------------------------------------------------------------------

function meaningful(text: string): string[] {
  return tokenizeInformative(text).filter((t) => !isGenericToken(t));
}

/** Smoothed IDF over the candidate prototypes (bounded; no global corpus). */
function buildRarity(candidates: readonly ApplicabilityCandidate[]): (t: string) => number {
  const n = candidates.length;
  const df = new Map<string, number>();
  for (const c of candidates) {
    const seen = new Set<string>([...c.tokens.situation, ...c.tokens.mechanism, ...c.tokens.unlock, ...c.tokens.invariants]);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return (t: string): number => {
    const d = df.get(t) ?? 0;
    if (d === 0) return 0;
    const idf = Math.log((n + 1) / (d + 0.5));
    return idf > 0 ? idf : 0;
  };
}

/**
 * Discriminative FIELD coverage: the rarity-weighted fraction of a lesson's
 * FIELD (its mechanism/remediation/invariant tokens) that the query contains via
 * tokens that DISCRIMINATE this lesson from its siblings. Direction matters —
 * this answers "how much of THIS lesson's mechanism is present in the query"
 * (field-recall), NOT "how much of the query this field covers" (which a short
 * query inflates: a single coincidental rare token like "one" would clear a
 * query-coverage floor). Iterating the FIELD makes a lone coincidental match a
 * tiny fraction of a rich mechanism, so only a query that genuinely carries the
 * lesson's causal content scores high. `excludeShared` drops tokens the lesson
 * shares with a sibling so shared domain vocabulary ("floating", "point") never
 * earns applicability.
 */
function discFieldCoverage(
  queryTokens: Set<string>,
  fieldTokens: readonly string[],
  rarity: (t: string) => number,
  excludeShared?: Set<string>,
): number {
  let num = 0;
  let denom = 0;
  for (const t of fieldTokens) {
    const w = rarity(t);
    denom += w;
    if (queryTokens.has(t) && !(excludeShared?.has(t) ?? false)) num += w;
  }
  return denom > 0 ? clamp01(num / denom) : 0;
}

export class DeterministicApplicabilityReranker implements ApplicabilityProvider {
  readonly name = "deterministic-applicability.v1";
  readonly featureVersion = APPLICABILITY_FEATURE_VERSION;

  async rank(
    query: ApplicabilityQueryViews,
    candidates: readonly ApplicabilityCandidate[],
    ctx: ApplicabilityContext,
  ): Promise<ApplicabilityResult[] | null> {
    const start = ctx.now();
    if (candidates.length === 0) return [];
    const rarity = buildRarity(candidates);
    // Causal view drives the BODY (mechanism/remediation) match; the literal view
    // drives the structured INVARIANT match. No causal view ⇒ literal for both.
    const causalTokens = new Set(meaningful(query.causalText ?? query.literalText));
    const literalTokens = new Set(meaningful(query.literalText));

    const bodyUnion = (c: ApplicabilityCandidate): Set<string> =>
      new Set<string>([...c.tokens.mechanism, ...c.tokens.unlock, ...c.tokens.invariants]);

    let results: ApplicabilityResult[];
    try {
    results = candidates.map((c) => {
      if (ctx.now() - start > ctx.deadlineMs) throw new Error("applicability-deadline"); // caught → null below
      // Tokens this candidate SHARES with any OTHER candidate's body — the
      // non-discriminative vocabulary (order-invariant; mirrors V4's vs-all rule).
      const otherUnion = new Set<string>();
      for (const o of candidates) {
        if (o.blockId === c.blockId) continue;
        for (const t of bodyUnion(o)) otherUnion.add(t);
      }

      // RAW field coverage (all matches) vs DISCRIMINATIVE field coverage (matches
      // on tokens unique to this lesson vs its siblings). Applicability is decided
      // on the DISCRIMINATIVE coverage — shared domain vocabulary cannot earn it.
      const rawMechanism = discFieldCoverage(causalTokens, c.tokens.mechanism, rarity);
      const rawRemediation = discFieldCoverage(causalTokens, c.tokens.unlock, rarity);
      const mechanism = discFieldCoverage(causalTokens, c.tokens.mechanism, rarity, otherUnion);
      const remediation = discFieldCoverage(causalTokens, c.tokens.unlock, rarity, otherUnion);
      const invariants = discFieldCoverage(literalTokens, c.tokens.invariants, rarity, otherUnion);

      // Discriminative gap (telemetry): fraction of body-matched query tokens
      // unique to this candidate among the slate.
      const selBody = bodyUnion(c);
      const matched = [...causalTokens].filter((t) => selBody.has(t));
      const discriminativeGap = matched.length ? matched.filter((t) => !otherUnion.has(t)).length / matched.length : 0;

      const contradiction = c.signals.isPitfall || (c.signals.harmful > 0 && c.signals.harmful >= c.signals.helpful);

      const fieldsAboveFloor = [mechanism, remediation, invariants].filter((x) => x >= FIELD_FLOOR).length;
      // Only a CAUSAL field (mechanism/remediation) can be the "strong single" —
      // an invariant/API-only match (misleading API overlap) never licenses alone.
      const strongCausalSingle = Math.max(mechanism, remediation) >= STRONG_SINGLE_FIELD;
      // Had real (raw) evidence but it was SHARED with a sibling → ambiguous.
      const hadSharedEvidence = Math.max(rawMechanism, rawRemediation) >= STRONG_SINGLE_FIELD;

      let verdict: ApplicabilityVerdict;
      const reasons: ApplicabilityReason[] = [];
      if (contradiction) {
        verdict = "inapplicable";
        reasons.push(c.signals.isPitfall ? "contradiction" : "stale-harmful");
      } else if (fieldsAboveFloor >= 2) {
        verdict = "applicable";
        reasons.push("multi-field-corroborated");
      } else if (strongCausalSingle) {
        verdict = "applicable";
        reasons.push("strong-single-field-contrastive");
      } else if (hadSharedEvidence) {
        // Strong overlap that did NOT discriminate from a sibling → not applicable.
        verdict = "uncertain";
        reasons.push("no-sibling-separation");
      } else if (fieldsAboveFloor === 1) {
        verdict = "uncertain";
        reasons.push("single-weak-field");
      } else {
        verdict = "inapplicable";
        reasons.push("weak-evidence");
      }

      // Bounded applicability confidence (NOT a serving confidence): causal-leaning
      // blend over DISCRIMINATIVE evidence, zeroed by contradiction, mildly lifted
      // by independent family support.
      let confidence = clamp01(0.4 * mechanism + 0.3 * remediation + 0.1 * invariants + 0.2 * discriminativeGap);
      if (contradiction) confidence = clamp01(confidence * 0.2);
      else if (c.signals.familySupport >= 2 && c.signals.sourceDiversity >= 2) confidence = clamp01(confidence + (1 - confidence) * 0.1);

      return {
        blockId: c.blockId,
        verdict,
        confidence: round4(confidence),
        reasons,
        featureVersion: APPLICABILITY_FEATURE_VERSION,
        evidence: {
          mechanism: round4(mechanism),
          remediation: round4(remediation),
          invariants: round4(invariants),
          discriminativeGap: round4(discriminativeGap),
          contradiction: contradiction ? 1 : 0,
          familySupport: c.signals.familySupport,
        },
      };
    });
    } catch {
      return null; // deadline / unexpected failure → fail open to the unchanged V4 decision.
    }

    // Deterministic order: applicable > uncertain > inapplicable, then confidence
    // desc, then blockId for stability.
    const rank = (v: ApplicabilityVerdict): number => (v === "applicable" ? 2 : v === "uncertain" ? 1 : 0);
    results.sort((a, b) => rank(b.verdict) - rank(a.verdict) || b.confidence - a.confidence || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0));
    return results;
  }
}

/** Human-readable one-liner for doctor/report tooling (privacy-safe: numerics + enums). */
export function explainApplicability(r: ApplicabilityResult): string {
  const e = r.evidence;
  return `appl=${r.verdict} conf=${r.confidence} [${r.reasons.join(",")}] mech=${e.mechanism} rem=${e.remediation} inv=${e.invariants} disc=${e.discriminativeGap} contra=${e.contradiction}`;
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
