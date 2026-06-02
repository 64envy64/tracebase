/**
 * Phase D.2 — DeterministicApplicabilityReranker (PLAN §4.5).
 *
 * The general evidence rule: a STRONG single causal field becomes `applicable`
 * ONLY with a discriminative sibling gap AND no contradiction; multi-field stays
 * applicable; pitfalls/harmful are inapplicable; invariant-only (misleading API)
 * never licenses; ambiguous siblings are uncertain, not applicable. No fixture
 * keywords — the rule is structural.
 */
import { describe, it, expect } from "vitest";
import {
  DeterministicApplicabilityReranker,
  type ApplicabilityCandidate,
  type ApplicabilityQueryViews,
} from "../../src/core/applicability-reranker.js";
import { tokenizeInformative, isGenericToken } from "../../src/core/serving-tokenizer.js";

const reranker = new DeterministicApplicabilityReranker();
const ctx = { deadlineMs: 1000, now: () => 0 };
const toks = (s: string): string[] => tokenizeInformative(s).filter((t) => !isGenericToken(t));

function cand(o: {
  id: string;
  mechanism?: string;
  unlock?: string;
  invariants?: string[];
  isPitfall?: boolean;
  helpful?: number;
  harmful?: number;
  familySupport?: number;
  sourceDiversity?: number;
}): ApplicabilityCandidate {
  return {
    blockId: o.id,
    tokens: {
      situation: [],
      mechanism: toks(o.mechanism ?? ""),
      unlock: toks(o.unlock ?? ""),
      invariants: o.invariants ?? [],
    },
    signals: {
      isPitfall: o.isPitfall ?? false,
      helpful: o.helpful ?? 0,
      harmful: o.harmful ?? 0,
      unresolved: 0,
      familySupport: o.familySupport ?? 1,
      sourceDiversity: o.sourceDiversity ?? 1,
    },
  };
}

// float-accumulation vs a numeric sibling (float-equality) — same domain.
const ACC = cand({
  id: "acc",
  mechanism: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result",
  unlock: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift",
});
const EQ = cand({
  id: "eq",
  mechanism: "comparing floating point results with strict equality fails because the same value has more than one bit representation after rounding",
  unlock: "compare with a tolerance epsilon instead of strict equality or use a decimal type",
});

const STRONG_MECH_ONLY: ApplicabilityQueryViews = {
  literalText: "Accumulator.fold() src/calc/engine.ts",
  // Deep mechanism match, NO remediation words → one strong causal field.
  causalText: "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with operation order",
};

describe("DeterministicApplicabilityReranker", () => {
  it("rules a STRONG single causal field APPLICABLE with a discriminative gap + no contradiction (the §4.5 capability V4 abstains on)", async () => {
    const r = (await reranker.rank(STRONG_MECH_ONLY, [ACC, EQ], ctx))!;
    const top = r[0]!;
    expect(top.blockId).toBe("acc");
    expect(top.verdict).toBe("applicable");
    expect(top.reasons).toContain("strong-single-field-contrastive");
    expect(top.evidence.mechanism).toBeGreaterThanOrEqual(0.5);
    expect(top.evidence.discriminativeGap).toBeGreaterThanOrEqual(0.5);
  });

  it("a pitfall match is INAPPLICABLE (contradiction) even with strong evidence", async () => {
    const pitfall = cand({ id: "acc", mechanism: ACC.tokens.mechanism.join(" "), unlock: ACC.tokens.unlock.join(" "), isPitfall: true });
    const r = (await reranker.rank(STRONG_MECH_ONLY, [pitfall, EQ], ctx))!;
    const acc = r.find((x) => x.blockId === "acc")!;
    expect(acc.verdict).toBe("inapplicable");
    expect(acc.reasons).toContain("contradiction");
  });

  it("a net-harmful / stale lesson is INAPPLICABLE", async () => {
    const stale = cand({ id: "acc", mechanism: ACC.tokens.mechanism.join(" "), unlock: ACC.tokens.unlock.join(" "), helpful: 1, harmful: 3 });
    const r = (await reranker.rank(STRONG_MECH_ONLY, [stale, EQ], ctx))!;
    const acc = r.find((x) => x.blockId === "acc")!;
    expect(acc.verdict).toBe("inapplicable");
    expect(acc.reasons).toContain("stale-harmful");
  });

  it("an invariant-only (misleading API) match never becomes applicable", async () => {
    const apiBlock = cand({ id: "api", mechanism: "an unrelated mechanism about layout reflow", unlock: "batch dom writes", invariants: ["api:array.reduce", "lang:ts"] });
    const q: ApplicabilityQueryViews = { literalText: "Array.reduce() lang ts api array reduce", causalText: "the total is computed with array reduce" };
    const r = (await reranker.rank(q, [apiBlock, EQ], ctx))!;
    const api = r.find((x) => x.blockId === "api")!;
    expect(api.verdict).not.toBe("applicable");
  });

  it("a same-domain sibling collision is UNCERTAIN, not applicable (no discriminative gap)", async () => {
    // A display-rounding query: shares float vocab with BOTH siblings → low gap.
    const collision: ApplicabilityQueryViews = { literalText: "Widget.render() src/ui/x.ts", causalText: "the floating point value is rounded to one decimal place purely for display" };
    const r = (await reranker.rank(collision, [ACC, EQ], ctx))!;
    expect(r.every((x) => x.verdict !== "applicable")).toBe(true);
  });

  it("returns null on a blown deadline (fail-open contract)", async () => {
    let t = 0;
    const r = await reranker.rank(STRONG_MECH_ONLY, [ACC, EQ], { deadlineMs: 0, now: () => (t += 10) });
    expect(r).toBeNull();
  });

  it("is deterministic + bounded: same inputs → identical verdicts/confidence", async () => {
    const a = await reranker.rank(STRONG_MECH_ONLY, [ACC, EQ], ctx);
    const b = await reranker.rank(STRONG_MECH_ONLY, [EQ, ACC], ctx); // order flipped
    expect(a![0]!.blockId).toBe(b![0]!.blockId); // stable top regardless of input order
    expect(a![0]!.confidence).toBe(b!.find((x) => x.blockId === a![0]!.blockId)!.confidence);
    for (const x of a!) expect(x.confidence).toBeGreaterThanOrEqual(0), expect(x.confidence).toBeLessThanOrEqual(1);
  });
});
