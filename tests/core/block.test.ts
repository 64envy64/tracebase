import { describe, it, expect } from "vitest";
import {
  extractKeywords,
  canonicalTrigger,
  fingerprintTrigger,
  createBlock,
  detectLeakage,
  bumpStat,
  wilsonLowerBound,
  refreshWilson,
  BLOCK_SCHEMA_VERSION,
  DEFAULT_BLOCK_CONFIDENCE,
} from "../../src/core/block.js";
import type { StoreBlockInput } from "../../src/types.js";

const SAMPLE_INPUT: StoreBlockInput = {
  trigger: {
    situation: "Metaclass iterates members using inspect.isfunction which skips properties",
    invariants: {
      language: "python",
      errorType: "MissingDocstring",
      apiSurface: ["inspect.isfunction"],
    },
  },
  body: {
    mechanism: "property objects are descriptors not functions",
    deadEnds: ["add property-specific branch", "iterate descriptor internals"],
    unlock: "use inspect.isdatadescriptor to cover both",
    verification: "class with method + property inherits docstrings from parent",
  },
  provenance: {
    sourceTaskId: "astropy__astropy-7166",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

describe("block — extractKeywords", () => {
  it("lowercases and dedupes tokens", () => {
    const kws = extractKeywords("Metaclass Metaclass MISSING", { });
    expect(kws).toContain("metaclass");
    expect(kws.filter(k => k === "metaclass").length).toBe(1);
  });

  it("strips stop words but preserves rare technical terms", () => {
    const kws = extractKeywords("is the inspect function for descriptors", { });
    expect(kws).not.toContain("is");
    expect(kws).not.toContain("the");
    expect(kws).toContain("inspect");
    expect(kws).toContain("descriptors");
  });

  it("prefixes invariant tokens for disambiguation", () => {
    const kws = extractKeywords("quantity ufunc bug", {
      language: "python",
      framework: "astropy",
      errorType: "ValueError",
      apiSurface: ["numpy.ndarray.__array_ufunc__"],
    });
    expect(kws).toContain("lang:python");
    expect(kws).toContain("fw:astropy");
    expect(kws).toContain("err:valueerror");
    expect(kws.some(k => k.startsWith("api:numpy"))).toBe(true);
  });

  it("is deterministic (sorted output)", () => {
    const a = extractKeywords("alpha bravo charlie", { });
    const b = extractKeywords("charlie bravo alpha", { });
    expect(a).toEqual(b);
  });
});

describe("block — fingerprint", () => {
  it("is stable across keyword reordering", () => {
    const fp1 = fingerprintTrigger({ language: "python" }, ["alpha", "bravo"]);
    const fp2 = fingerprintTrigger({ language: "python" }, ["bravo", "alpha"]);
    expect(fp1).toBe(fp2);
  });

  it("differs when invariants differ", () => {
    const fp1 = fingerprintTrigger({ language: "python" }, ["x"]);
    const fp2 = fingerprintTrigger({ language: "typescript" }, ["x"]);
    expect(fp1).not.toBe(fp2);
  });

  it("differs when api surface differs", () => {
    const fp1 = fingerprintTrigger({ apiSurface: ["foo"] }, ["x"]);
    const fp2 = fingerprintTrigger({ apiSurface: ["bar"] }, ["x"]);
    expect(fp1).not.toBe(fp2);
  });

  it("canonical form is case-insensitive", () => {
    const c1 = canonicalTrigger({ language: "Python" }, ["Alpha"]);
    const c2 = canonicalTrigger({ language: "python" }, ["alpha"]);
    expect(c1).toBe(c2);
  });
});

describe("block — createBlock", () => {
  it("fills all required fields with prior defaults", () => {
    const b = createBlock(SAMPLE_INPUT, { now: 12345 });
    expect(b.version).toBe(BLOCK_SCHEMA_VERSION);
    expect(b.trigger.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(b.trigger.keywords.length).toBeGreaterThan(0);
    expect(b.status).toBe("active");
    expect(b.quality.confidence).toBe(DEFAULT_BLOCK_CONFIDENCE);
    expect(b.quality.wilsonLowerBound).toBe(0);
    expect(b.stats.timesRetrieved).toBe(0);
    expect(b.provenance.distilledAt).toBe(12345);
    expect(b.createdAt).toBe(12345);
    expect(b.updatedAt).toBe(12345);
  });

  it("clones arrays so later mutation does not leak", () => {
    const input = { ...SAMPLE_INPUT, body: { ...SAMPLE_INPUT.body, deadEnds: ["a"] } };
    const b = createBlock(input);
    input.body.deadEnds.push("b");
    expect(b.body.deadEnds).toEqual(["a"]);
  });

  it("generates unique ids for blocks with identical content", () => {
    const b1 = createBlock(SAMPLE_INPUT);
    const b2 = createBlock(SAMPLE_INPUT);
    expect(b1.id).not.toBe(b2.id);
    // But fingerprints are identical (dedupe target).
    expect(b1.trigger.fingerprint).toBe(b2.trigger.fingerprint);
  });
});

describe("block — detectLeakage", () => {
  const cleanBlock = createBlock(SAMPLE_INPUT);

  it("accepts clean block", () => {
    expect(detectLeakage(cleanBlock)).toBeNull();
  });

  it("rejects block containing diff headers", () => {
    const leaky = {
      ...cleanBlock,
      body: {
        ...cleanBlock.body,
        unlock: "Apply: --- a/astropy/utils/misc.py\n+++ b/astropy/utils/misc.py",
      },
    };
    expect(detectLeakage(leaky)).toBe("diff-header");
  });

  it("rejects block containing patch hunks", () => {
    const leaky = {
      ...cleanBlock,
      body: {
        ...cleanBlock.body,
        mechanism: "the fix goes here\n@@ -12,7 +12,7 @@\n",
      },
    };
    expect(detectLeakage(leaky)).toBe("patch-hunk");
  });

  it("rejects block leaking pytest test IDs", () => {
    const leaky = {
      ...cleanBlock,
      body: {
        ...cleanBlock.body,
        verification: "run test_rst.py::test_rst_with_header_rows",
      },
    };
    expect(detectLeakage(leaky)).toBe("pytest-id");
  });

  it("rejects block with absolute /testbed paths", () => {
    const leaky = {
      ...cleanBlock,
      body: {
        ...cleanBlock.body,
        unlock: "edit /testbed/astropy/io/ascii/rst.py directly",
      },
    };
    expect(detectLeakage(leaky)).toBe("abs-path");
  });
});

describe("block — bumpStat and wilson", () => {
  it("wilsonLowerBound returns 0 for zero trials", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("wilsonLowerBound is conservative for small samples", () => {
    // 1/1 naive rate is 100%; Wilson lb should be well below 1.
    const lb = wilsonLowerBound(1, 1);
    expect(lb).toBeLessThan(0.5);
    expect(lb).toBeGreaterThan(0);
  });

  it("wilsonLowerBound approaches rate as n grows", () => {
    const lb10 = wilsonLowerBound(5, 10);
    const lb1000 = wilsonLowerBound(500, 1000);
    expect(lb1000).toBeGreaterThan(lb10);
    expect(lb1000).toBeCloseTo(0.5, 1);
  });

  it("bumpStat does not mutate input", () => {
    const b = createBlock(SAMPLE_INPUT);
    const b2 = bumpStat(b, "timesRetrieved", 1);
    expect(b.stats.timesRetrieved).toBe(0);
    expect(b2.stats.timesRetrieved).toBe(1);
    expect(b2).not.toBe(b);
  });

  it("bumpStat updates lastUsedAt only on injection or helpful", () => {
    const b = createBlock(SAMPLE_INPUT);
    const now = 99999;
    const afterRetr = bumpStat(b, "timesRetrieved", 1, now);
    expect(afterRetr.stats.lastUsedAt).toBeUndefined();
    const afterInj = bumpStat(b, "timesInjected", 1, now);
    expect(afterInj.stats.lastUsedAt).toBe(now);
  });

  it("refreshWilson recomputes quality.wilsonLowerBound", () => {
    let b = createBlock(SAMPLE_INPUT);
    b = bumpStat(b, "timesInjected", 10);
    b = bumpStat(b, "timesHelpful", 8);
    b = refreshWilson(b);
    expect(b.quality.wilsonLowerBound).toBeGreaterThan(0.4);
    expect(b.quality.wilsonLowerBound).toBeLessThan(0.8);
  });

  it("refreshWilson is a no-op when value unchanged", () => {
    const b = createBlock(SAMPLE_INPUT);
    const b2 = refreshWilson(b);
    // Both have wilsonLowerBound 0 (zero trials) → identity return.
    expect(b2).toBe(b);
  });
});
