import { describe, expect, it } from "vitest";
import { add, multiply } from "./calc.js";

describe("calc", () => {
  it("add returns the sum", () => {
    expect(add(2, 3)).toBe(5);
    expect(add(10, 7)).toBe(17);
    expect(add(-4, 4)).toBe(0);
  });

  it("multiply returns the product", () => {
    expect(multiply(3, 4)).toBe(12);
  });
});
