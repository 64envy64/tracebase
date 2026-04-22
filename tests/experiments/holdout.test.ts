import { describe, it, expect } from "vitest";
import {
  CONTROL_REASON_HOLDOUT,
  CONTROL_REASON_SHADOW,
  shouldHoldOut,
} from "../../src/experiments/holdout.js";

describe("shouldHoldOut — determinism", () => {
  it("returns the same decision for the same (fingerprint, rate, salt)", () => {
    const fp = "fp:astropy.property-docstrings";
    const salt = "ws-abcdef";
    const rate = 0.1;
    const a = shouldHoldOut(fp, rate, salt);
    const b = shouldHoldOut(fp, rate, salt);
    const c = shouldHoldOut(fp, rate, salt);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("the same fingerprint lands in the same cohort across independent calls", () => {
    // Repeated attempts at an identical problem must always be
    // controlled (or always served) — the §L6 causal comparison
    // depends on a stable per-problem assignment.
    const fp = "fp:claim-water-damage.routing";
    const salt = "ws-1";
    const decisions = new Set<boolean>();
    for (let i = 0; i < 50; i++) {
      decisions.add(shouldHoldOut(fp, 0.5, salt));
    }
    expect(decisions.size).toBe(1);
  });
});

describe("shouldHoldOut — rate boundaries", () => {
  it("rate = 0 always returns false, regardless of fingerprint or salt", () => {
    expect(shouldHoldOut("fp-a", 0, "s")).toBe(false);
    expect(shouldHoldOut("fp-b", 0, "s")).toBe(false);
    expect(shouldHoldOut("", 0, "")).toBe(false);
  });

  it("negative / NaN rates are clamped to 0", () => {
    expect(shouldHoldOut("fp-a", -0.5, "s")).toBe(false);
    expect(shouldHoldOut("fp-a", Number.NaN, "s")).toBe(false);
  });

  it("rate = 1 always returns true, and rate > 1 is clamped up", () => {
    expect(shouldHoldOut("fp-a", 1, "s")).toBe(true);
    expect(shouldHoldOut("fp-a", 1.5, "s")).toBe(true);
  });
});

describe("shouldHoldOut — distribution", () => {
  it("holds out approximately `rate` fraction of fingerprints", () => {
    // 1000 distinct fingerprints at rate=0.2 should come out ~20%,
    // within a reasonably loose tolerance (sha256 is uniform in
    // expectation; sample-level variance is bounded).
    const salt = "ws-dist";
    const rate = 0.2;
    let held = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      if (shouldHoldOut(`fp-${i}`, rate, salt)) held++;
    }
    const observed = held / n;
    expect(observed).toBeGreaterThan(rate - 0.05);
    expect(observed).toBeLessThan(rate + 0.05);
  });

  it("is monotonic in rate — increasing the rate never un-holds an already-held fingerprint", () => {
    const salt = "ws-monotone";
    const fingerprints = Array.from({ length: 200 }, (_, i) => `fp-${i}`);
    const at10 = new Set(fingerprints.filter((fp) => shouldHoldOut(fp, 0.1, salt)));
    const at50 = new Set(fingerprints.filter((fp) => shouldHoldOut(fp, 0.5, salt)));
    // Every holdout at rate=0.1 must remain a holdout at rate=0.5.
    for (const fp of at10) {
      expect(at50.has(fp)).toBe(true);
    }
  });
});

describe("shouldHoldOut — salt isolation", () => {
  it("different salts give different cohort splits for the same fingerprints", () => {
    // Cross-workspace contamination would ruin causal inference.
    // A different salt must produce a meaningfully different split
    // across a large enough fingerprint population.
    const a = new Set<string>();
    const b = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const fp = `fp-${i}`;
      if (shouldHoldOut(fp, 0.3, "ws-A")) a.add(fp);
      if (shouldHoldOut(fp, 0.3, "ws-B")) b.add(fp);
    }
    const intersection = new Set([...a].filter((fp) => b.has(fp)));
    // If salts were ignored, |a ∩ b| would be ≈ |a| (≈ 150). In
    // reality we expect ≈ rate² * 500 ≈ 45. Anything above ~80 would
    // suggest the salt isn't actually participating in the hash.
    expect(intersection.size).toBeLessThan(80);
  });

  it("an empty salt still returns a valid boolean and stays deterministic", () => {
    const once = shouldHoldOut("fp-empty-salt", 0.5, "");
    const twice = shouldHoldOut("fp-empty-salt", 0.5, "");
    expect(typeof once).toBe("boolean");
    expect(once).toBe(twice);
  });

  it("treats `salt || fingerprint` unambiguously (no concat-collision)", () => {
    // With a naive `salt + fingerprint` scheme, ("ab", "c") and
    // ("a", "bc") would hash the same. The null-byte separator in
    // the implementation rules that out.
    const left = shouldHoldOut("c", 0.5, "ab");
    const right = shouldHoldOut("bc", 0.5, "a");
    // We don't assert which is true, only that at least one differs
    // — proving the separator matters.
    const forced = new Set<boolean>();
    for (let i = 0; i < 100; i++) {
      const L = shouldHoldOut(`p${i}`, 0.5, `sa${i}`);
      const R = shouldHoldOut(`a${i}p${i}`, 0.5, `s`);
      forced.add(L === R);
    }
    // It would be astronomically unlikely for every pair to agree
    // if the separator genuinely participates in the hash.
    expect(forced.has(false)).toBe(true);
    // Use `left` / `right` so TS doesn't complain about unused bindings.
    void left;
    void right;
  });
});

describe("control-reason constants", () => {
  it("expose the two cohort tags verbatim so callers cannot typo them", () => {
    expect(CONTROL_REASON_HOLDOUT).toBe("holdout");
    expect(CONTROL_REASON_SHADOW).toBe("shadow");
  });
});
