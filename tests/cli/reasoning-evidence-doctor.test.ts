/**
 * doctor — ServingEvidenceV3 rollout diagnostic (off|shadow; `on` refused).
 */
import { describe, it, expect } from "vitest";
import { reasoningEvidenceDoctorCheck } from "../../src/cli/commands/doctor.js";
import { REASONING_EVIDENCE_ENV } from "../../src/experiments/reasoning-evidence-rollout.js";

describe("doctor / reasoning-evidence rollout check", () => {
  it("unset => off, info", () => {
    const c = reasoningEvidenceDoctorCheck({});
    expect(c.name).toBe("reasoning-evidence");
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("off");
  });

  it("shadow => info", () => {
    const c = reasoningEvidenceDoctorCheck({ [REASONING_EVIDENCE_ENV]: "shadow" });
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("shadow");
  });

  it("on => WARN (refused; shadow-only)", () => {
    const c = reasoningEvidenceDoctorCheck({ [REASONING_EVIDENCE_ENV]: "on" });
    expect(c.level).toBe("warn");
    expect(c.message.toLowerCase()).toContain("not permitted");
  });

  it("invalid => WARN, never echoes the raw value", () => {
    const c = reasoningEvidenceDoctorCheck({ [REASONING_EVIDENCE_ENV]: "/Users/secret/typo" });
    expect(c.level).toBe("warn");
    expect(c.message).not.toContain("/Users");
  });
});
