/**
 * Phase D.2 — applicability rollout doctor diagnostic.
 */
import { describe, it, expect } from "vitest";
import { reasoningApplicabilityDoctorCheck } from "../../src/cli/commands/doctor.js";
import { REASONING_APPLICABILITY_ENV as ENV } from "../../src/experiments/reasoning-applicability-rollout.js";

describe("reasoningApplicabilityDoctorCheck", () => {
  it("off → info (byte-identical default)", () => {
    const c = reasoningApplicabilityDoctorCheck({});
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("off");
  });
  it("shadow → info naming the V4-vs-reranker comparison", () => {
    const c = reasoningApplicabilityDoctorCheck({ [ENV]: "shadow" });
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("shadow");
    expect(c.message.toLowerCase()).toContain("reranker");
  });
  it("on → warn (not permitted)", () => {
    const c = reasoningApplicabilityDoctorCheck({ [ENV]: "on" });
    expect(c.level).toBe("warn");
    expect(c.message.toLowerCase()).toContain("not permitted");
  });
  it("message never leaks an absolute path", () => {
    const c = reasoningApplicabilityDoctorCheck({ [ENV]: "bogus" });
    expect(c.message).not.toContain("/Users");
  });
});
