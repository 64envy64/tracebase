import { describe, it, expect } from "vitest";
import { mmr, DEFAULT_MMR_LAMBDA, type MMRItem } from "../../src/core/mmr.js";

const item = (id: string, relevance: number, text: string, embedding?: number[]): MMRItem => ({
  id,
  relevance,
  text,
  ...(embedding ? { embedding } : {}),
});

describe("MMR", () => {
  it("returns empty when k <= 0 or no items", () => {
    expect(mmr([], 5)).toEqual([]);
    expect(mmr([item("a", 0.5, "x")], 0)).toEqual([]);
    expect(mmr([item("a", 0.5, "x")], -1)).toEqual([]);
  });

  it("λ=1.0 degenerates to sort-by-relevance (MMR no-op)", () => {
    const items = [
      item("low", 0.2, "alpha bravo"),
      item("hi", 0.9, "charlie delta"),
      item("mid", 0.5, "echo foxtrot"),
    ];
    const out = mmr(items, 3, { lambda: 1.0 });
    expect(out.map((i) => i.id)).toEqual(["hi", "mid", "low"]);
  });

  it("λ=0.7 reorders to break up near-duplicate top items", () => {
    // Two near-duplicates with high relevance plus one diverse item
    // with slightly lower relevance. Pure-relevance ordering would put
    // both duplicates at the top; MMR should slot the diverse item in
    // between (or above the duplicate).
    const items = [
      item("dup1", 0.92, "react hooks setState batching async behavior"),
      item("dup2", 0.91, "react hooks setState batching async timing"),
      item("diverse", 0.80, "python decorator dunder method resolution"),
    ];
    const out = mmr(items, 3, { lambda: 0.7 });
    // First pick goes to highest relevance.
    expect(out[0]!.id).toBe("dup1");
    // Second pick should NOT be the near-duplicate; the diverse item
    // wins because its similarity to dup1 is near zero.
    expect(out[1]!.id).toBe("diverse");
    expect(out[2]!.id).toBe("dup2");
  });

  it("λ=0.0 is pure-diversity (farthest-first selection)", () => {
    const items = [
      item("a", 0.9, "shared lorem ipsum"),
      item("b", 0.85, "shared lorem ipsum dolor"),
      item("c", 0.5, "completely different bird waterfall"),
    ];
    const out = mmr(items, 2, { lambda: 0.0 });
    // First pick: arbitrary (relevance is zeroed out by λ=0).
    // Second pick: the item LEAST similar to the first.
    expect(out.map((i) => i.id)).toContain("c");
  });

  it("preserves input order on ties (deterministic)", () => {
    const items = [
      item("first", 0.5, "shared text foo"),
      item("second", 0.5, "shared text foo"),
      item("third", 0.5, "shared text foo"),
    ];
    const out = mmr(items, 3, { lambda: 0.7 });
    expect(out.map((i) => i.id)).toEqual(["first", "second", "third"]);
  });

  it("uses embedding cosine when both items carry vectors", () => {
    // Two near-orthogonal vectors → low cosine sim → MMR should
    // happily pick both even at low λ.
    const items = [
      item("a", 0.9, "tokens irrelevant", [1, 0, 0]),
      item("b", 0.8, "tokens irrelevant", [0, 1, 0]),
    ];
    const out = mmr(items, 2, { lambda: 0.5 });
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("DEFAULT_MMR_LAMBDA is 0.7 (empirical sweet spot)", () => {
    expect(DEFAULT_MMR_LAMBDA).toBe(0.7);
  });

  it("returns at most min(items.length, k) items", () => {
    const items = [item("a", 0.5, "x"), item("b", 0.3, "y")];
    expect(mmr(items, 5)).toHaveLength(2);
    expect(mmr(items, 1)).toHaveLength(1);
  });

  it("custom similarity function is honored", () => {
    // Force every pair to look identical → MMR will pick by relevance
    // for the first slot and then refuse to add anything else (every
    // remaining item has max diversity penalty).
    const allIdentical = () => 1.0;
    const items = [
      item("a", 0.9, "x"),
      item("b", 0.8, "y"),
      item("c", 0.7, "z"),
    ];
    const out = mmr(items, 3, { lambda: 0.5, similarity: allIdentical });
    // Loop still picks 3 (it always picks at least one per iteration);
    // but with diversity penalty=1.0, every choice after the first
    // ties — and we tie-break on input order so b precedes c.
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
