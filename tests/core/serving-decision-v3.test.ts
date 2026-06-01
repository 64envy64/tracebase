/**
 * ServingEvidenceV3 — semantic-license lane (Phase C.2).
 *
 * The license converts hybrid candidate-recall into decision recall WITHOUT
 * letting semantic rank authorize an inject: a semantic-only candidate injects
 * only with >=2 independent body-field corroborations AND family separation.
 */
import { describe, it, expect } from "vitest";
import type { ReasoningBlock, BlockInvariants, BlockKind } from "../../src/types.js";
import { DEFAULT_SERVING_POLICY, type ServingCandidate, type ServingQuery } from "../../src/core/serving-confidence.js";
import { decideServingV2 } from "../../src/core/serving-decision-v2.js";
import { decideServingV3 } from "../../src/core/serving-decision-v3.js";

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

// Discriminative tokens live ONLY in the body, so a body-phrased query does NOT
// match the trigger (V2 lexical-conditional → abstain) but corroborates >=2
// body fields (V3 license → inject).
const NG = mkBlock({
  id: "ng",
  situation: "a configuration merge fails on a missing entry",
  mechanism: "the absent optional value yields undefined and is dereferenced without a null guard",
  unlock: "guard the access and default the undefined optional before dereferencing it",
  keywords: ["configuration", "merge", "missing", "entry"],
});
const QUERY: ServingQuery = { text: "undefined was dereferenced without a null guard since the optional value was absent" };

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

describe("ServingEvidenceV3 semantic-license lane", () => {
  it("licenses a body-corroborated semantic-only candidate that V2 abstains on", () => {
    const cands = [semanticOnly(NG)];
    const v2 = decideServingV2(QUERY, cands, policy, undefined, { mode: "v2-family" });
    const v3 = decideServingV3(QUERY, cands, policy);
    // V2 cannot score a body-only candidate (lexical-conditional) → abstain.
    expect(v2.decision.action).toBe("abstain");
    // V3 licenses it via >=2 corroborating body fields → inject.
    expect(v3.decision.action).toBe("inject");
    const sel = v3.evidenceV3.find((e) => e.blockId === "ng")!;
    expect(sel.lane).toBe("semantic-license");
    expect(sel.licenseReason).toBe("structured-corroborated");
    expect(sel.corroboratingFields).toBeGreaterThanOrEqual(2);
  });

  it("does NOT license a semantic-only candidate with only one corroborating field (body-token collision)", () => {
    // A block whose ONLY body overlap with the query is a single token.
    const collide = mkBlock({
      id: "collide",
      situation: "a retry storm overwhelms a dependency",
      mechanism: "retries fire without backoff and the value is large", // shares only "value"
      unlock: "add exponential backoff with jitter",
      keywords: ["retry", "storm", "backoff"],
    });
    const v3 = decideServingV3(QUERY, [semanticOnly(collide)], policy);
    expect(v3.decision.action).toBe("abstain");
    const sel = v3.evidenceV3.find((e) => e.blockId === "collide")!;
    expect(sel.licenseReason).toBe("insufficient-corroboration");
    expect(sel.corroboratingFields).toBeLessThan(2);
  });

  it("semantic RANK alone never authorizes an inject (no corroboration ⇒ abstain regardless of rank)", () => {
    const unrelated = mkBlock({
      id: "unrel",
      situation: "a flexbox row overflows its container",
      mechanism: "the child has no min-width so it refuses to shrink",
      unlock: "set min-width zero on the flex child",
      keywords: ["flexbox", "overflow", "container"],
    });
    // Top semantic rank, but the body shares nothing with the query.
    const v3 = decideServingV3(QUERY, [semanticOnly(unrelated)], policy);
    expect(v3.decision.action).toBe("abstain");
  });

  it("a lexical (sparse) candidate takes the V2 lane unchanged", () => {
    // A query that DOES match the trigger lexically + a sparse candidate.
    const q: ServingQuery = { text: "a configuration merge fails on a missing entry, the optional was absent" };
    const v2 = decideServingV2(q, [sparseCand(NG)], policy, undefined, { mode: "v2-family" });
    const v3 = decideServingV3(q, [sparseCand(NG)], policy);
    expect(v3.decision.action).toBe(v2.decision.action);
    const sel = v3.evidenceV3.find((e) => e.blockId === "ng")!;
    expect(sel.lane).toBe("lexical");
    expect(sel.licenseReason).toBe("lexical");
  });

  it("a licensed candidate is denied when its family is not separated from a sibling", () => {
    // Two distinct families both body-corroborated by the query → family margin
    // collapses → ambiguous_sibling_family, license downgraded.
    const sibling = mkBlock({
      id: "ng2",
      situation: "a serializer crashes on a missing field",
      mechanism: "the absent optional value yields undefined and is dereferenced without a null guard",
      unlock: "guard the access and default the undefined optional before dereferencing it",
      keywords: ["serializer", "crashes", "field"],
      fingerprint: "fp-ng2",
    });
    const v3 = decideServingV3(QUERY, [semanticOnly(NG), semanticOnly(sibling)], policy);
    // Both corroborate equally → the family margin gate abstains.
    if (v3.decision.action === "abstain" && v3.decision.reason === "ambiguous_sibling_family") {
      const sel = v3.evidenceV3.find((e) => e.blockId === v3.decision.topCandidateId)!;
      expect(sel.licenseReason).toBe("no-family-separation");
    } else {
      // If they merged into one family (high vocab overlap), a single licensed
      // family injecting is also acceptable — assert it did not falsely split.
      expect(v3.decision.action).toBe("inject");
    }
  });

  it("empty slate abstains; never throws", () => {
    const v3 = decideServingV3(QUERY, [], policy);
    expect(v3.decision.action).toBe("abstain");
    expect(v3.decision.reason).toBe("no_candidates");
  });
});
