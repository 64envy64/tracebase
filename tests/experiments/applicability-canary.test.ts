/**
 * Phase D.3 — dormant canary contract. Default-OFF; kill switch is absolute;
 * deterministic bounded assignment with logged propensity. NOT wired to serving.
 */
import { describe, it, expect } from "vitest";
import {
  assignCanary,
  resolveCanaryConfig,
  DISABLED_CANARY,
  APPLICABILITY_CANARY_ENV as ENV,
  type CanaryConfig,
} from "../../src/experiments/applicability-canary.js";

describe("applicability canary contract", () => {
  it("defaults to disabled: every unit is control with propensity 0", () => {
    for (const unit of ["a", "b", "fingerprint-xyz", ""]) {
      const a = assignCanary(unit);
      expect(a.arm).toBe("control");
      expect(a.propensity).toBe(0);
      expect(a.killed).toBe(true);
    }
  });

  it("kill switch is absolute: disabled forces control even at rate 1.0", () => {
    const cfg: CanaryConfig = { enabled: false, salt: "s", rate: 1, policyVersion: "p" };
    expect(assignCanary("anything", cfg).arm).toBe("control");
  });

  it("when enabled: deterministic, bounded, with the rate as propensity", () => {
    const cfg: CanaryConfig = { enabled: true, salt: "salt-1", rate: 0.5, policyVersion: "deterministic-applicability.v1" };
    const first = assignCanary("unit-42", cfg);
    expect(assignCanary("unit-42", cfg)).toEqual(first); // deterministic
    expect(first.propensity).toBe(0.5);
    expect(first.killed).toBe(false);
    // Roughly half of many distinct units land in treatment (bounded assignment).
    const n = 400;
    let treated = 0;
    for (let i = 0; i < n; i++) if (assignCanary(`u${i}`, cfg).arm === "treatment") treated++;
    expect(treated).toBeGreaterThan(n * 0.35);
    expect(treated).toBeLessThan(n * 0.65);
  });

  it("rate 0 never treats; rate clamps to [0,1]", () => {
    expect(assignCanary("u", { enabled: true, salt: "s", rate: 0, policyVersion: "p" }).arm).toBe("control");
    expect(assignCanary("u", { enabled: true, salt: "s", rate: 5, policyVersion: "p" }).propensity).toBe(1);
  });

  it("resolveCanaryConfig defaults DISABLED and only accepts explicit on:<rate>", () => {
    expect(resolveCanaryConfig({}).config).toEqual(DISABLED_CANARY);
    expect(resolveCanaryConfig({ [ENV]: "off" }).config.enabled).toBe(false);
    expect(resolveCanaryConfig({ [ENV]: "true" }).config.enabled).toBe(false); // not understood → disabled
    const on = resolveCanaryConfig({ [ENV]: "on:0.05" });
    expect(on.config.enabled).toBe(true);
    expect(on.config.rate).toBe(0.05);
    expect(on.diagnostics.join(" ")).toMatch(/dormant|does NOT wire/i);
  });
});
