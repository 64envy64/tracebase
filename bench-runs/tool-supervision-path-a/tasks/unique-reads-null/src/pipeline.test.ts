import { describe, expect, it } from "vitest";
import { runPipeline } from "./pipeline.js";
import { validate } from "./stage2.js";

describe("runPipeline", () => {
  it("emits transformed events for non-empty input", () => {
    const out = runPipeline({ rows: [{ raw: "Hello World" }, { raw: "Foo Bar" }] });
    expect(out.rejected).toBe(0);
    expect(out.emitted).toEqual(["event:hello-world", "event:foo-bar"]);
  });
});

describe("validate", () => {
  it("accepts non-empty rows", () => {
    expect(validate(["a"])).toBe(true);
  });

  it("rejects empty rows (the bug)", () => {
    expect(validate([])).toBe(false);
  });
});
