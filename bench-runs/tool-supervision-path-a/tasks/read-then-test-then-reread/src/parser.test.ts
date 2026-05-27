import { describe, expect, it } from "vitest";
import { parseNum } from "./parser.js";

describe("parseNum", () => {
  it("parses integers", () => {
    expect(parseNum("hello 42 world")).toBe(42);
  });

  it("parses decimals", () => {
    expect(parseNum("price: 9.99 USD")).toBe(9.99);
    expect(parseNum("3.14")).toBe(3.14);
  });

  it("returns null when no digits", () => {
    expect(parseNum("no number here")).toBe(null);
  });
});
