/**
 * doctor — Phase C hybrid retrieval rollout diagnostic.
 */
import { describe, it, expect } from "vitest";
import { reasoningRetrievalDoctorCheck } from "../../src/cli/commands/doctor.js";
import { REASONING_RETRIEVAL_ENV } from "../../src/experiments/reasoning-retrieval-rollout.js";

describe("doctor / reasoning-retrieval rollout check", () => {
  it("unset => off, info, no warning", () => {
    const c = reasoningRetrievalDoctorCheck({});
    expect(c.name).toBe("reasoning-retrieval");
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("off");
  });

  it("shadow => info", () => {
    const c = reasoningRetrievalDoctorCheck({ [REASONING_RETRIEVAL_ENV]: "shadow" });
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("shadow");
  });

  it("on => pass", () => {
    const c = reasoningRetrievalDoctorCheck({ [REASONING_RETRIEVAL_ENV]: "on" });
    expect(c.level).toBe("pass");
  });

  it("invalid value => off + visible WARN, never echoes the raw value", () => {
    const c = reasoningRetrievalDoctorCheck({ [REASONING_RETRIEVAL_ENV]: "/Users/secret/typo" });
    expect(c.level).toBe("warn");
    expect(c.message.toLowerCase()).toContain("invalid");
    expect(c.message).not.toContain("/Users");
    expect(c.fix).toContain("off | shadow | on");
  });
});
