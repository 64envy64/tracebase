/**
 * Phase D.3 — applicability canary doctor readiness output (dormant, default-off).
 */
import { describe, it, expect } from "vitest";
import { applicabilityCanaryDoctorCheck } from "../../src/cli/commands/doctor.js";
import { APPLICABILITY_CANARY_ENV as ENV } from "../../src/experiments/applicability-canary.js";

describe("applicabilityCanaryDoctorCheck", () => {
  it("default → info: disabled / kill switch engaged / dormant", () => {
    const c = applicabilityCanaryDoctorCheck({});
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("disabled");
    expect(c.message.toLowerCase()).toContain("dormant");
  });
  it("an on:<rate> request → warn that it is still DORMANT (not wired to serving)", () => {
    const c = applicabilityCanaryDoctorCheck({ [ENV]: "on:0.1" });
    expect(c.level).toBe("warn");
    expect(c.message.toLowerCase()).toContain("dormant");
    expect(c.message.toLowerCase()).toContain("not wired");
  });
  it("message never leaks an absolute path", () => {
    expect(applicabilityCanaryDoctorCheck({ [ENV]: "bogus" }).message).not.toContain("/Users");
  });
});
