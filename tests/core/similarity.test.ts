import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  applySmallCorpusDamping,
  SMALL_CORPUS_DAMPING_FLOOR,
} from "../../src/core/similarity.js";

describe("applySmallCorpusDamping — May-2026 PR 2 (audit #4)", () => {
  // Reference weights — already normalized, mirror DEFAULT_STATE means.
  const W = {
    bm25: 0.50,
    jaccard: 0.20,
    structural: 0.10,
    cosine: 0.10,
    freshness: 0.10,
  };

  it("is a no-op when the eligible corpus is at or above the floor", () => {
    const out = applySmallCorpusDamping(W, SMALL_CORPUS_DAMPING_FLOOR);
    expect(out).toEqual(W);
    const out2 = applySmallCorpusDamping(W, SMALL_CORPUS_DAMPING_FLOOR + 100);
    expect(out2).toEqual(W);
  });

  it("preserves unit total across renormalization for every n in [0, floor)", () => {
    for (let n = 0; n < SMALL_CORPUS_DAMPING_FLOOR; n++) {
      const out = applySmallCorpusDamping(W, n);
      const sum = out.bm25 + out.jaccard + out.structural + out.cosine + out.freshness;
      expect(sum).toBeCloseTo(1.0, 9);
    }
  });

  it("reduces BM25 weight proportionally to corpus size", () => {
    // At n=0, BM25 contribution should be 0 (fully damped).
    const at0 = applySmallCorpusDamping(W, 0);
    expect(at0.bm25).toBeCloseTo(0, 9);
    // At n=10, half-damped: bm25 → 0.50 × 0.5 = 0.25.
    const at10 = applySmallCorpusDamping(W, 10);
    expect(at10.bm25).toBeCloseTo(0.25, 9);
    // At n=19, almost no damping.
    const at19 = applySmallCorpusDamping(W, 19);
    expect(at19.bm25).toBeGreaterThan(0.45);
    expect(at19.bm25).toBeLessThan(0.50);
  });

  it("redistributes freed mass proportionally across other signals", () => {
    // At n=0, freed mass = 0.50. Other signals split it proportionally
    // to their original weights (jaccard=0.20, structural=0.10,
    // cosine=0.10, freshness=0.10 → sum=0.50). Each gets doubled.
    const out = applySmallCorpusDamping(W, 0);
    expect(out.jaccard).toBeCloseTo(0.40, 9);
    expect(out.structural).toBeCloseTo(0.20, 9);
    expect(out.cosine).toBeCloseTo(0.20, 9);
    expect(out.freshness).toBeCloseTo(0.20, 9);
  });

  it("handles the pathological case where no other signal carries weight", () => {
    const bm25Only = { bm25: 1, jaccard: 0, structural: 0, cosine: 0, freshness: 0 };
    const out = applySmallCorpusDamping(bm25Only, 0);
    // Nothing to redistribute to — damped vector returned as-is.
    expect(out.bm25).toBe(0);
    expect(out.jaccard).toBe(0);
    expect(out.structural).toBe(0);
    expect(out.cosine).toBe(0);
    expect(out.freshness).toBe(0);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it("handles large sparse vectors", () => {
    const a = new Array(1000).fill(0);
    const b = new Array(1000).fill(0);
    a[0] = 1;
    a[500] = 1;
    b[0] = 1;
    b[999] = 1;

    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});
