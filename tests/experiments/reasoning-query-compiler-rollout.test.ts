/**
 * Phase D.1 — query-compiler rollout resolver. off|shadow only; `on` rejected.
 */
import { describe, it, expect } from "vitest";
import {
  resolveReasoningQueryCompilerMode,
  reasoningQueryCompilerOptions,
  REASONING_QUERY_COMPILER_ENV as ENV,
} from "../../src/experiments/reasoning-query-compiler-rollout.js";

describe("resolveReasoningQueryCompilerMode", () => {
  it("defaults to off when unset or empty", () => {
    expect(resolveReasoningQueryCompilerMode({}).mode).toBe("off");
    expect(resolveReasoningQueryCompilerMode({ [ENV]: "" }).mode).toBe("off");
  });
  it("accepts off and shadow (case/space-insensitive)", () => {
    expect(resolveReasoningQueryCompilerMode({ [ENV]: "off" }).mode).toBe("off");
    expect(resolveReasoningQueryCompilerMode({ [ENV]: " Shadow " }).mode).toBe("shadow");
  });
  it("rejects `on` → off with a diagnostic (causal lane is shadow-only)", () => {
    const r = resolveReasoningQueryCompilerMode({ [ENV]: "on" });
    expect(r.mode).toBe("off");
    expect(r.diagnostics.join(" ")).toMatch(/not permitted/);
  });
  it("ignores an invalid value → off with a diagnostic", () => {
    const r = resolveReasoningQueryCompilerMode({ [ENV]: "bogus" });
    expect(r.mode).toBe("off");
    expect(r.diagnostics.join(" ")).toMatch(/ignored/);
  });
  it("reasoningQueryCompilerOptions returns the resolved mode fragment", () => {
    expect(reasoningQueryCompilerOptions({ [ENV]: "shadow" })).toEqual({ queryCompilerMode: "shadow" });
    expect(reasoningQueryCompilerOptions({})).toEqual({ queryCompilerMode: "off" });
  });
});
