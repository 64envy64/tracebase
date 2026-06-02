/**
 * Reasoning-family resolver hardening — adversarial bridge-clustering tests.
 *
 * The hardened resolver (structured-signature.v2) must:
 *   - NOT collapse different mechanisms that merely share a generic errorType;
 *   - NOT collapse different failure modes that merely share one apiSurface;
 *   - prevent transitive bridges (A~B, B~C, A≁C must NOT form one giant family);
 *   - keep a genuinely-paraphrased recurring mechanism in ONE family;
 *   - be deterministic regardless of candidate input order;
 *   - never let duplicate captures inflate confidence;
 *   - record explainable join evidence + bridge-prevention stats.
 */
import { describe, it, expect } from "vitest";
import type { ReasoningBlock, BlockInvariants } from "../../src/types.js";
import {
  aggregateFamilies,
  StructuredSignatureResolver,
  summarizeFamilyDecision,
  type FamilyCandidate,
} from "../../src/core/reasoning-family.js";
import { SERVING_FEATURE_VERSION_V2, type ServingEvidenceV2 } from "../../src/core/serving-evidence-v2.js";

function stubEv2(blockId: string, conf: number): ServingEvidenceV2 {
  return {
    featureVersion: SERVING_FEATURE_VERSION_V2,
    blockId,
    base: {
      featureVersion: 1,
      informativeQueryTokenCount: 3,
      matchedInformativeTokenCount: 2,
      queryCoverage: 0.5,
      triggerCoverage: 0.5,
      apiSurfaceExactMatch: false,
      errorTypeExactMatch: false,
      symbolExactMatch: false,
      pathTokenMatch: false,
      genericOnly: false,
      rankScore: 1,
      evidenceConfidence: conf,
      secondBestEvidenceConfidence: 0,
      margin: 0,
    },
    fieldOverlap: { situation: 0, mechanism: 0, unlock: 0, deadEnds: 0, invariants: 0 },
    rarityWeightedCoverage: 0,
    structuredApplicability: 0,
    redactedFields: [],
    v1Confidence: conf,
    evidenceConfidence: conf,
    family: { support: 1, contradiction: 0, sourceDiversity: 1 },
    rankScore: 1,
  };
}

/** A family candidate whose discriminative vocabulary lives in `keywords`. */
function fc(o: {
  id: string;
  keywords: string[];
  errorType?: string;
  apiSurface?: string[];
  fingerprint?: string;
  conf?: number;
}): FamilyCandidate {
  const invariants: BlockInvariants = {
    ...(o.errorType ? { errorType: o.errorType } : {}),
    ...(o.apiSurface ? { apiSurface: o.apiSurface } : {}),
  };
  const block = {
    id: o.id,
    kind: "success",
    trigger: { situation: "case", invariants, keywords: o.keywords, fingerprint: o.fingerprint ?? `fp-${o.id}` },
    body: { mechanism: "", deadEnds: [], unlock: "", verification: "" },
    provenance: { sourceTaskId: `t-${o.id}`, extractedFrom: "imported", distilledAt: 1, distilledBy: "manual" },
    stats: { timesRetrieved: 0, timesInjected: 0, timesAgentUsed: 0, timesHelpful: 0, timesCounterproductive: 0, cumulativeTokensSaved: 0, cumulativeStepsSaved: 0 },
    quality: { confidence: 0.5 },
    version: 2,
    createdAt: 1,
    updatedAt: 1,
    status: "active",
  } as unknown as ReasoningBlock;
  return { block, evidence: stubEv2(o.id, o.conf ?? 0.6) };
}

/** Distinct family count for a candidate set. */
function familyCount(cands: FamilyCandidate[]): number {
  return aggregateFamilies(cands).families.length;
}

describe("reasoning-family resolver — bridge hardening (v2)", () => {
  it("same generic errorType, different mechanisms => SEPARATE families", () => {
    const cands = [
      fc({ id: "a", errorType: "TypeError", keywords: ["null", "undefined", "dereference", "guard", "optional"] }),
      fc({ id: "b", errorType: "TypeError", keywords: ["timeout", "retry", "backoff", "jitter", "storm"] }),
    ];
    expect(familyCount(cands)).toBe(2);
  });

  it("one shared apiSurface, different failure modes => SEPARATE families", () => {
    const cands = [
      fc({ id: "a", apiSurface: ["fetch"], keywords: ["cors", "preflight", "header", "allow", "origin"] }),
      fc({ id: "b", apiSurface: ["fetch"], keywords: ["timeout", "abort", "retry", "backoff", "deadline"] }),
    ];
    expect(familyCount(cands)).toBe(2);
  });

  it("moderate vocabulary WITHOUT structured corroboration => SEPARATE", () => {
    // ∩={shared1,shared2}=2, union=6 → Jaccard 0.33 (< MODERATE 0.34), no errorType/api.
    const cands = [
      fc({ id: "a", keywords: ["shared1", "shared2", "alpha", "beta"] }),
      fc({ id: "b", keywords: ["shared1", "shared2", "gamma", "delta"] }),
    ];
    expect(familyCount(cands)).toBe(2);
  });

  it("moderate vocabulary WITH a corroborating errorType => SAME family", () => {
    // ∩={s1,s2}=2, union={s1,s2,alpha,beta}=4 → Jaccard 0.5: in [MODERATE 0.34,
    // STRONG 0.6), so it links ONLY because the shared errorType corroborates.
    const cands = [
      fc({ id: "a", errorType: "ValueError", keywords: ["s1", "s2", "alpha"] }),
      fc({ id: "b", errorType: "ValueError", keywords: ["s1", "s2", "beta"] }),
    ];
    const agg = aggregateFamilies(cands);
    expect(agg.families.length).toBe(1);
    expect(agg.joins.some((j) => j.rule === "vocabulary+structured")).toBe(true);

    // Same vocabulary, but NO structured corroboration => stays SEPARATE.
    const noStruct = aggregateFamilies([
      fc({ id: "a", keywords: ["s1", "s2", "alpha"] }),
      fc({ id: "b", keywords: ["s1", "s2", "beta"] }),
    ]);
    expect(noStruct.families.length).toBe(2);
  });

  it("A~B and B~C but A≁C => NO accidental giant family (bridge prevented)", () => {
    // a∩b={beta,gamma,delta}=3/5=0.6 strong; b∩c={gamma,delta,epsilon}=3/5=0.6 strong;
    // a∩c={gamma,delta}=2/6=0.33 (<0.6, no structure) => not linked.
    const cands = [
      fc({ id: "a", keywords: ["alpha", "beta", "gamma", "delta"] }),
      fc({ id: "b", keywords: ["beta", "gamma", "delta", "epsilon"] }),
      fc({ id: "c", keywords: ["gamma", "delta", "epsilon", "zeta"] }),
    ];
    const agg = aggregateFamilies(cands);
    expect(agg.families.length).toBe(2); // {a,b} + {c}, NOT one giant {a,b,c}
    expect(agg.familyByBlockId.get("a")).not.toBe(agg.familyByBlockId.get("c"));
    expect(agg.bridgesPrevented).toBeGreaterThanOrEqual(1);
    expect(summarizeFamilyDecision(agg).bridgesPrevented).toBeGreaterThanOrEqual(1);
  });

  it("true paraphrased recurring mechanism => SAME family (strong vocabulary)", () => {
    const cands = [
      fc({ id: "a", fingerprint: "fp-1", keywords: ["null", "undefined", "dereference", "guard", "optional"] }),
      fc({ id: "b", fingerprint: "fp-2", keywords: ["null", "undefined", "dereference", "guard", "absent"] }),
    ];
    const agg = aggregateFamilies(cands);
    expect(agg.families.length).toBe(1);
    expect(agg.joins[0]?.rule).toBe("strong-vocabulary");
  });

  it("is deterministic regardless of candidate input order", () => {
    const a = fc({ id: "a", keywords: ["alpha", "beta", "gamma", "delta"] });
    const b = fc({ id: "b", keywords: ["beta", "gamma", "delta", "epsilon"] });
    const c = fc({ id: "c", keywords: ["timeout", "retry", "backoff", "jitter"] });
    const grouping = (cands: FamilyCandidate[]) => {
      const agg = aggregateFamilies(cands);
      return [...agg.familyByBlockId.entries()].sort(([x], [y]) => (x < y ? -1 : 1));
    };
    expect(grouping([a, b, c])).toEqual(grouping([c, b, a]));
    expect(grouping([a, b, c])).toEqual(grouping([b, a, c]));
  });

  it("duplicate captures (same fingerprint) never inflate confidence", () => {
    const single = aggregateFamilies([fc({ id: "x", fingerprint: "dup", keywords: ["null", "guard", "undefined"], conf: 0.6 })]);
    const many = aggregateFamilies([
      fc({ id: "x1", fingerprint: "dup", keywords: ["null", "guard", "undefined"], conf: 0.6 }),
      fc({ id: "x2", fingerprint: "dup", keywords: ["null", "guard", "undefined"], conf: 0.6 }),
      fc({ id: "x3", fingerprint: "dup", keywords: ["null", "guard", "undefined"], conf: 0.6 }),
    ]);
    expect(many.families.length).toBe(1);
    expect(many.families[0]!.distinctCaseIds.length).toBe(1);
    expect(many.families[0]!.confidence).toBeCloseTo(single.families[0]!.confidence, 10);
  });

  it("records explainable join evidence for accepted links", () => {
    const agg = aggregateFamilies([
      fc({ id: "a", fingerprint: "fp-1", keywords: ["null", "undefined", "dereference", "guard", "optional"] }),
      fc({ id: "b", fingerprint: "fp-2", keywords: ["null", "undefined", "dereference", "guard", "absent"] }),
    ]);
    expect(agg.joins.length).toBe(1);
    const j = agg.joins[0]!;
    expect(j.anchor).toBe("a");
    expect(j.member).toBe("b");
    expect(j.keywordJaccard).toBeGreaterThan(0.6);
    expect(["strong-vocabulary", "vocabulary+structured"]).toContain(j.rule);
  });
});
