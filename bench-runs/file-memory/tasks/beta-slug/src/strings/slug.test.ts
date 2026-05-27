import { describe, it, expect } from "vitest";
import { slug } from "./slug";

describe("slug", () => {
  it("lowercases ASCII titles", () => {
    expect(slug("Hello World")).toBe("hello-world");
  });

  it("preserves digits", () => {
    expect(slug("React 18 Release")).toBe("react-18-release");
  });

  it("folds non-ASCII letters via NFD (does NOT drop them)", () => {
    expect(slug("café-récipé")).toBe("cafe-recipe");
  });

  it("folds umlauts and accents", () => {
    expect(slug("naïve résumé")).toBe("naive-resume");
  });

  it("collapses multiple punctuation marks", () => {
    expect(slug("Hello!!! World???")).toBe("hello-world");
  });

  it("trims leading/trailing separators", () => {
    expect(slug("  --hello world--  ")).toBe("hello-world");
  });
});
