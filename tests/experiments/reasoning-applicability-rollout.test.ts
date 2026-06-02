/**
 * Phase D.2 — applicability rollout resolver. off|shadow only; `on` rejected.
 */
import { describe, it, expect } from "vitest";
import {
  resolveReasoningApplicabilityMode,
  reasoningApplicabilityOptions,
  REASONING_APPLICABILITY_ENV as ENV,
} from "../../src/experiments/reasoning-applicability-rollout.js";

describe("resolveReasoningApplicabilityMode", () => {
  it("defaults to off when unset or empty", () => {
    expect(resolveReasoningApplicabilityMode({}).mode).toBe("off");
    expect(resolveReasoningApplicabilityMode({ [ENV]: "" }).mode).toBe("off");
  });
  it("accepts off and shadow (case/space-insensitive)", () => {
    expect(resolveReasoningApplicabilityMode({ [ENV]: "off" }).mode).toBe("off");
    expect(resolveReasoningApplicabilityMode({ [ENV]: " Shadow " }).mode).toBe("shadow");
  });
  it("rejects `on` → off with a diagnostic (reranker is shadow-only)", () => {
    const r = resolveReasoningApplicabilityMode({ [ENV]: "on" });
    expect(r.mode).toBe("off");
    expect(r.diagnostics.join(" ")).toMatch(/not permitted/);
  });
  it("ignores an invalid value → off with a diagnostic", () => {
    const r = resolveReasoningApplicabilityMode({ [ENV]: "bogus" });
    expect(r.mode).toBe("off");
    expect(r.diagnostics.join(" ")).toMatch(/ignored/);
  });
  it("reasoningApplicabilityOptions returns the resolved mode fragment", () => {
    expect(reasoningApplicabilityOptions({ [ENV]: "shadow" })).toEqual({ applicabilityMode: "shadow" });
    expect(reasoningApplicabilityOptions({})).toEqual({ applicabilityMode: "off" });
  });
});
