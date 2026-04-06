import { describe, it, expect } from "vitest";
import {
  fingerprint,
  jaccardSimilarity,
  structuralSimilarity,
} from "../../src/core/fingerprint.js";

describe("fingerprint", () => {
  it("produces deterministic hashes", () => {
    const a = fingerprint("TypeError: Cannot read property 'map' of undefined");
    const b = fingerprint("TypeError: Cannot read property 'map' of undefined");
    expect(a.hash).toBe(b.hash);
    expect(a.canonical).toBe(b.canonical);
  });

  it("produces different hashes for different problems", () => {
    const a = fingerprint("TypeError: Cannot read property 'map' of undefined");
    const b = fingerprint("ENOENT: no such file or directory");
    expect(a.hash).not.toBe(b.hash);
  });

  it("extracts error types", () => {
    const result = fingerprint("TypeError: Cannot read property 'map' of undefined");
    expect(result.features.errorType).toBe("typeerror");
  });

  it("extracts Node.js error codes", () => {
    const result = fingerprint("ENOENT: no such file or directory, open '/tmp/foo.txt'");
    expect(result.features.errorType).toBe("enoent");
  });

  it("extracts language from context", () => {
    const result = fingerprint("Some error", {
      filePath: "src/app.tsx",
    });
    expect(result.features.language).toBe("typescript");
    expect(result.features.fileExtension).toBe("tsx");
  });

  it("extracts framework from description", () => {
    const result = fingerprint(
      "React component re-renders infinitely when using useEffect",
    );
    expect(result.features.framework).toBe("react");
  });

  it("extracts framework from context", () => {
    const result = fingerprint("Some error", {
      framework: "Express",
    });
    expect(result.features.framework).toBe("express");
  });

  it("tokenizes camelCase", () => {
    const result = fingerprint("handleUserClick throws TypeError");
    expect(result.tokens).toContain("handle");
    expect(result.tokens).toContain("user");
    expect(result.tokens).toContain("click");
  });

  it("tokenizes file paths", () => {
    const result = fingerprint("Error in src/components/UserList.tsx");
    expect(result.tokens).toContain("src");
    expect(result.tokens).toContain("components");
    expect(result.tokens).toContain("user");
    expect(result.tokens).toContain("list");
  });

  it("removes stop words from keywords", () => {
    const result = fingerprint("the function is not working with the data");
    expect(result.features.keywords).not.toContain("the");
    expect(result.features.keywords).not.toContain("is");
    expect(result.features.keywords).not.toContain("not");
    expect(result.features.keywords).toContain("function");
    expect(result.features.keywords).toContain("working");
    expect(result.features.keywords).toContain("data");
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical sets", () => {
    expect(jaccardSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(1.0);
  });

  it("returns 0.0 for disjoint sets", () => {
    expect(jaccardSimilarity(["a", "b"], ["c", "d"])).toBe(0.0);
  });

  it("returns correct value for partial overlap", () => {
    const result = jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"]);
    // intersection = {b,c} = 2, union = {a,b,c,d} = 4 → 0.5
    expect(result).toBeCloseTo(0.5);
  });

  it("handles empty sets", () => {
    expect(jaccardSimilarity([], [])).toBe(0);
    expect(jaccardSimilarity(["a"], [])).toBe(0);
  });
});

describe("structuralSimilarity", () => {
  it("returns high score for same error type and language", () => {
    const score = structuralSimilarity(
      { errorType: "typeerror", language: "typescript", keywords: ["map", "undefined"] },
      { errorType: "typeerror", language: "typescript", keywords: ["map", "null"] },
    );
    expect(score).toBeGreaterThan(0.7);
  });

  it("returns lower score for different error types", () => {
    const same = structuralSimilarity(
      { errorType: "typeerror", language: "typescript", keywords: [] },
      { errorType: "typeerror", language: "typescript", keywords: [] },
    );
    const different = structuralSimilarity(
      { errorType: "typeerror", language: "typescript", keywords: [] },
      { errorType: "enoent", language: "typescript", keywords: [] },
    );
    expect(same).toBeGreaterThan(different);
  });

  it("returns 0 for completely different features", () => {
    const score = structuralSimilarity(
      { errorType: "typeerror", language: "python", framework: "django", keywords: ["orm"] },
      { errorType: "enoent", language: "rust", framework: "axum", keywords: ["tcp"] },
    );
    expect(score).toBe(0);
  });
});
