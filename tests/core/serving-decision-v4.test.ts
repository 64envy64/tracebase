/**
 * ServingEvidenceV4 — contrastive applicability lane (Phase C.3).
 *
 * V4 tightens V3's semantic license with a CONTRASTIVE gap: a semantic-only
 * candidate licenses only when the MAJORITY of its corroborating body tokens
 * discriminate it from the strongest competing sibling/family. It can only ever
 * downgrade a V3 license (precision-monotonic), and abstains conservatively when
 * sibling context is missing or ambiguous.
 */
import { describe, it, expect } from "vitest";
import type { ReasoningBlock, BlockInvariants, BlockKind } from "../../src/types.js";
import { DEFAULT_SERVING_POLICY, type ServingCandidate, type ServingQuery } from "../../src/core/serving-confidence.js";
import { decideServingV3 } from "../../src/core/serving-decision-v3.js";
import { decideServingV4 } from "../../src/core/serving-decision-v4.js";

function mkBlock(o: {
  id: string;
  situation: string;
  mechanism?: string;
  unlock?: string;
  keywords?: string[];
  invariants?: BlockInvariants;
  kind?: BlockKind;
  fingerprint?: string;
}): ReasoningBlock {
  return {
    id: o.id,
    version: 2,
    kind: o.kind ?? "success",
    trigger: { situation: o.situation, invariants: o.invariants ?? {}, keywords: o.keywords ?? [], fingerprint: o.fingerprint ?? `fp-${o.id}` },
    body: { mechanism: o.mechanism ?? "", deadEnds: [], unlock: o.unlock ?? "", verification: "re-run" },
    provenance: { sourceTaskId: `t-${o.id}`, extractedFrom: "imported", distilledAt: 1, distilledBy: "manual" },
    stats: { timesRetrieved: 0, timesInjected: 0, timesAgentUsed: 0, timesHelpful: 0, timesCounterproductive: 0, cumulativeTokensSaved: 0, cumulativeStepsSaved: 0 },
    quality: { confidence: 0.5 },
    createdAt: 1,
    updatedAt: 1,
    status: "active",
  } as unknown as ReasoningBlock;
}

const semanticOnly = (block: ReasoningBlock): ServingCandidate => ({
  block,
  rankScore: 0.9,
  provenance: { semanticRank: 1, fusedRank: 1, semanticOnly: true, providerClass: "local" },
});
const sparseCand = (block: ReasoningBlock): ServingCandidate => ({
  block,
  rankScore: 0.9,
  provenance: { sparseRank: 1, fusedRank: 1, semanticOnly: false, providerClass: "none" },
});

const policy = DEFAULT_SERVING_POLICY;

// Same-domain numeric siblings (different mechanisms, different triggers).
const FLOAT_ACC = mkBlock({
  id: "float-acc",
  situation: "a running total disagrees with the expected sum by a tiny amount",
  mechanism: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result",
  unlock: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift",
  keywords: ["running", "total", "sum"],
});
const FLOAT_EQ = mkBlock({
  id: "float-eq",
  situation: "two computed numbers that should be equal compare as different",
  mechanism: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding",
  unlock: "compare with a tolerance epsilon instead of strict equality or use a decimal type for exact representation",
  keywords: ["compare", "equal", "different"],
});
// A genuine accumulation paraphrase (matches float-acc on UNIQUE tokens).
const TRUE_ACC: ServingQuery = { text: "rounding error accumulates across a long floating point summation so the order of additions changes the result" };
// A same-domain COLLISION: shares only generic float vocabulary, different problem.
const COLLISION: ServingQuery = { text: "a slider snaps to coarse steps because the floating point value is rounded to one decimal place purely for display" };

const NG = mkBlock({
  id: "ng",
  situation: "a configuration merge fails on a missing entry",
  mechanism: "the absent optional value yields undefined and is dereferenced without a null guard",
  unlock: "guard the access and default the undefined optional before dereferencing it",
  keywords: ["configuration", "merge", "missing", "entry"],
});
const UNRELATED = mkBlock({
  id: "flex",
  situation: "a flexbox row overflows its container",
  mechanism: "the child has no min width so it refuses to shrink below its content",
  unlock: "set min width zero on the flex child so it can shrink",
  keywords: ["flexbox", "row", "container"],
});
const NG_BODY_QUERY: ServingQuery = { text: "undefined was dereferenced without a null guard since the optional value was absent" };

describe("ServingEvidenceV4 contrastive lane", () => {
  it("ABSTAINS on a same-domain sibling collision that V3 licenses (the headline)", () => {
    // Singleton domain (no sibling in slate) — reproduces the exact Phase C.2 leak.
    const v3solo = decideServingV3(COLLISION, [semanticOnly(FLOAT_ACC)], policy);
    const v4solo = decideServingV4(COLLISION, [semanticOnly(FLOAT_ACC)], policy);
    expect(v3solo.decision.action).toBe("inject"); // V3 leaks: ≥2 fields, no sibling to contrast
    expect(v4solo.decision.action).toBe("abstain"); // V4: missing competitor → conservative abstain
    const selSolo = v4solo.evidenceV4.find((e) => e.blockId === v4solo.decision.topCandidateId)!;
    expect(selSolo.licenseReason).toBe("no-competitor");
    expect(selSolo.contrastive?.hasCompetitor).toBe(false);

    // With the float-equality sibling present, V4 still abstains (low discriminative support).
    const v4pair = decideServingV4(COLLISION, [semanticOnly(FLOAT_ACC), semanticOnly(FLOAT_EQ)], policy);
    expect(v4pair.decision.action).toBe("abstain");
    const selPair = v4pair.evidenceV4.find((e) => e.blockId === v4pair.decision.topCandidateId)!;
    expect(["ambiguous-sibling", "no-family-separation"]).toContain(selPair.licenseReason);
    expect(selPair.contrastive!.discriminativeSupport).toBeLessThan(0.5);
  });

  it("LICENSES a genuine paraphrase that discriminates from its competitor", () => {
    // float-acc matches on UNIQUE tokens (accumulate/summation/order); the float-eq
    // sibling shares only generic float vocab → high discriminative support.
    const v4 = decideServingV4(TRUE_ACC, [semanticOnly(FLOAT_ACC), semanticOnly(FLOAT_EQ)], policy);
    expect(v4.decision.action).toBe("inject");
    const sel = v4.evidenceV4.find((e) => e.blockId === v4.decision.topCandidateId)!;
    expect(sel.blockId).toBe("float-acc");
    expect(sel.lane).toBe("semantic-license");
    expect(sel.licenseReason).toBe("structured-corroborated");
    expect(sel.contrastive!.hasCompetitor).toBe(true);
    expect(sel.contrastive!.discriminativeSupport).toBeGreaterThanOrEqual(0.5);
  });

  it("LICENSES a discriminative body paraphrase against an unrelated competitor", () => {
    const v4 = decideServingV4(NG_BODY_QUERY, [semanticOnly(NG), semanticOnly(UNRELATED)], policy);
    expect(v4.decision.action).toBe("inject");
    const sel = v4.evidenceV4.find((e) => e.blockId === "ng")!;
    expect(sel.licenseReason).toBe("structured-corroborated");
    expect(sel.contrastive!.discriminativeSupport).toBeGreaterThanOrEqual(0.5);
  });

  it("is precision-monotonic: V4 never injects where V3 abstains", () => {
    const cases: Array<[ServingQuery, ServingCandidate[]]> = [
      [COLLISION, [semanticOnly(FLOAT_ACC), semanticOnly(FLOAT_EQ)]],
      [TRUE_ACC, [semanticOnly(FLOAT_ACC), semanticOnly(FLOAT_EQ)]],
      [NG_BODY_QUERY, [semanticOnly(NG), semanticOnly(UNRELATED)]],
      [COLLISION, [semanticOnly(FLOAT_ACC)]],
    ];
    for (const [q, cands] of cases) {
      const v3 = decideServingV3(q, cands, policy);
      const v4 = decideServingV4(q, cands, policy);
      if (v4.decision.action === "inject") expect(v3.decision.action).toBe("inject");
    }
  });

  it("a lexical (sparse) candidate takes the V2 lane unchanged", () => {
    const q: ServingQuery = { text: "a configuration merge fails on a missing entry, the optional was absent" };
    const v4 = decideServingV4(q, [sparseCand(NG)], policy);
    const sel = v4.evidenceV4.find((e) => e.blockId === "ng")!;
    expect(sel.lane).toBe("lexical");
    expect(sel.licenseReason).toBe("lexical");
    expect(sel.contrastive).toBeUndefined();
  });

  it("empty slate abstains; never throws", () => {
    const v4 = decideServingV4(COLLISION, [], policy);
    expect(v4.decision.action).toBe("abstain");
    expect(v4.decision.reason).toBe("no_candidates");
  });
});
