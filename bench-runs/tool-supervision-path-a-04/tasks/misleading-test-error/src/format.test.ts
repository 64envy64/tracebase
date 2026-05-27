import { describe, expect, it } from "vitest";
import { formatAmount } from "./format.js";

describe("formatAmount", () => {
  it("formats integer amounts", () => {
    expect(formatAmount("42")).toBe("$42.00");
  });

  it("formats decimal amounts", () => {
    const out = formatAmount("3.14");
    expect(
      out,
      `formatAmount returned ${out} for input "3.14"; the bug is in src/format.ts (decimal precision lost)`,
    ).toBe("$3.14");
  });

  it("formats embedded decimals", () => {
    const out = formatAmount("USD 9.99 paid");
    expect(
      out,
      `formatAmount returned ${out} for input "USD 9.99 paid"; src/format.ts is dropping decimal digits`,
    ).toBe("$9.99");
  });
});
