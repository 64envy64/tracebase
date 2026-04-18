import { describe, it, expect } from "vitest";
import { fitIsotonic, predictIsotonic, isMonotone } from "../../src/lifecycle/isotonic.js";

function randomPoints(n: number, seed = 1): Array<{ x: number; y: number }> {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  return Array.from({ length: n }, () => ({ x: rnd(), y: Math.round(rnd()) }));
}

// ---------------------------------------------------------------------------
// fitIsotonic — basic correctness
// ---------------------------------------------------------------------------

describe("fitIsotonic — PAVA", () => {
  it("fits monotone data without merging", () => {
    const model = fitIsotonic([
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.3 },
      { x: 0.5, y: 0.5 },
      { x: 0.9, y: 0.9 },
    ]);
    // Already monotone — no merges. breakpoints mirror the input.
    expect(model.breakpoints.length).toBe(4);
    expect(model.n).toBe(4);
    expect(isMonotone(model)).toBe(true);
  });

  it("merges adjacent violators into a pooled average", () => {
    const model = fitIsotonic([
      { x: 0.1, y: 0.0 },
      { x: 0.2, y: 1.0 },
      { x: 0.3, y: 0.0 }, // violator
      { x: 0.4, y: 1.0 },
    ]);
    // The middle violation (1.0 followed by 0.0) must get pooled.
    // Expected: blocks {0.1:0}, merged-pool of (0.2, 1.0)+(0.3, 0.0)=(0.25, 0.5), {0.4:1.0}.
    expect(isMonotone(model)).toBe(true);
    // Exactly 3 blocks: the first, the pooled middle, the last.
    expect(model.breakpoints.length).toBe(3);
    // Middle block is the pooled average.
    expect(model.breakpoints[1]!.x).toBeCloseTo(0.25);
    expect(model.breakpoints[1]!.y).toBeCloseTo(0.5);
  });

  it("handles a reverse-sorted input by pooling into a single block", () => {
    const model = fitIsotonic([
      { x: 0.1, y: 1.0 },
      { x: 0.2, y: 0.8 },
      { x: 0.3, y: 0.6 },
      { x: 0.4, y: 0.4 },
      { x: 0.5, y: 0.2 },
    ]);
    // Every adjacent pair violates → single block with average y = 0.6.
    expect(model.breakpoints.length).toBe(1);
    expect(model.breakpoints[0]!.y).toBeCloseTo(0.6);
    expect(isMonotone(model)).toBe(true);
  });

  it("returns an empty model on empty input", () => {
    const model = fitIsotonic([]);
    expect(model.breakpoints).toEqual([]);
    expect(model.n).toBe(0);
  });

  it("always produces monotone output on random data", () => {
    const model = fitIsotonic(randomPoints(200, 7));
    expect(isMonotone(model)).toBe(true);
  });

  it("uses the provided timestamp on `fittedAt`", () => {
    const model = fitIsotonic([{ x: 0, y: 0 }, { x: 1, y: 1 }], 12345);
    expect(model.fittedAt).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// predictIsotonic
// ---------------------------------------------------------------------------

describe("predictIsotonic", () => {
  it("clamps to the leftmost y below the first breakpoint", () => {
    const model = fitIsotonic([
      { x: 0.2, y: 0.1 },
      { x: 0.8, y: 0.9 },
    ]);
    expect(predictIsotonic(model, 0.0)).toBe(0.1);
    expect(predictIsotonic(model, -10)).toBe(0.1);
  });

  it("clamps to the rightmost y above the last breakpoint", () => {
    const model = fitIsotonic([
      { x: 0.2, y: 0.1 },
      { x: 0.8, y: 0.9 },
    ]);
    expect(predictIsotonic(model, 1.0)).toBe(0.9);
    expect(predictIsotonic(model, 10)).toBe(0.9);
  });

  it("linearly interpolates between breakpoints", () => {
    const model = fitIsotonic([
      { x: 0.0, y: 0.0 },
      { x: 1.0, y: 1.0 },
    ]);
    expect(predictIsotonic(model, 0.25)).toBeCloseTo(0.25);
    expect(predictIsotonic(model, 0.5)).toBeCloseTo(0.5);
    expect(predictIsotonic(model, 0.75)).toBeCloseTo(0.75);
  });

  it("falls back to identity when the model is empty", () => {
    const model = fitIsotonic([]);
    expect(predictIsotonic(model, 0.42)).toBe(0.42);
  });

  it("is always monotone non-decreasing over its domain", () => {
    const model = fitIsotonic([
      { x: 0.1, y: 0 },
      { x: 0.2, y: 1 },
      { x: 0.3, y: 0 },
      { x: 0.4, y: 1 },
      { x: 0.5, y: 1 },
    ]);
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const x = i / 100;
      const y = predictIsotonic(model, x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it("recovers the pooled value for points inside a merged block", () => {
    // One clear violator run pooled to mean.
    const model = fitIsotonic([
      { x: 0.0, y: 0.0 },
      { x: 0.5, y: 1.0 }, // pooled with next
      { x: 0.6, y: 0.0 }, // pooled with previous → (0.55, 0.5)
      { x: 1.0, y: 1.0 },
    ]);
    // The pooled block has x ≈ 0.55, y ≈ 0.5. Sample at that x.
    expect(predictIsotonic(model, 0.55)).toBeCloseTo(0.5, 1);
  });
});

// ---------------------------------------------------------------------------
// isMonotone
// ---------------------------------------------------------------------------

describe("isMonotone", () => {
  it("returns true for a well-formed fitted model", () => {
    const model = fitIsotonic([
      { x: 0.1, y: 0.0 },
      { x: 0.5, y: 0.5 },
      { x: 0.9, y: 1.0 },
    ]);
    expect(isMonotone(model)).toBe(true);
  });

  it("returns false when ys decrease (manually-corrupted model)", () => {
    expect(
      isMonotone({
        breakpoints: [
          { x: 0.1, y: 0.9 },
          { x: 0.9, y: 0.1 },
        ],
        n: 2,
        fittedAt: 0,
      }),
    ).toBe(false);
  });

  it("returns false when xs are not sorted", () => {
    expect(
      isMonotone({
        breakpoints: [
          { x: 0.9, y: 0.1 },
          { x: 0.1, y: 0.9 },
        ],
        n: 2,
        fittedAt: 0,
      }),
    ).toBe(false);
  });
});
