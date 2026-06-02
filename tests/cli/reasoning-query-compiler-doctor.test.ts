/**
 * Phase D.1 — query-compiler rollout doctor diagnostic.
 */
import { describe, it, expect } from "vitest";
import { reasoningQueryCompilerDoctorCheck } from "../../src/cli/commands/doctor.js";
import { REASONING_QUERY_COMPILER_ENV as ENV } from "../../src/experiments/reasoning-query-compiler-rollout.js";

describe("reasoningQueryCompilerDoctorCheck", () => {
  it("off → info (byte-identical default)", () => {
    const c = reasoningQueryCompilerDoctorCheck({});
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("off");
  });
  it("shadow → info naming the three compared slates", () => {
    const c = reasoningQueryCompilerDoctorCheck({ [ENV]: "shadow" });
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("shadow");
    expect(c.message.toLowerCase()).toContain("causal");
  });
  it("on → warn (not permitted)", () => {
    const c = reasoningQueryCompilerDoctorCheck({ [ENV]: "on" });
    expect(c.level).toBe("warn");
    expect(c.message.toLowerCase()).toContain("not permitted");
  });
  it("message never leaks an absolute path", () => {
    const c = reasoningQueryCompilerDoctorCheck({ [ENV]: "bogus" });
    expect(c.message).not.toContain("/Users");
  });
});
