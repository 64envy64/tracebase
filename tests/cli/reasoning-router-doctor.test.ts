/**
 * doctor — Router V2 rollout diagnostic surface (Step 2).
 *
 * The typo-fail-safe contract: an unrecognized TRACEBASE_REASONING_ROUTER value
 * resolves to `off` AND is surfaced as a visible WARN (never silent), without
 * echoing the raw (possibly path-like) value.
 */
import { describe, it, expect } from "vitest";
import { reasoningRouterDoctorCheck } from "../../src/cli/commands/doctor.js";
import { REASONING_ROUTER_ENV } from "../../src/experiments/reasoning-router-rollout.js";

describe("doctor / reasoning-router rollout check", () => {
  it("unset => off, info, no warning", () => {
    const c = reasoningRouterDoctorCheck({});
    expect(c.name).toBe("reasoning-router");
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("off");
  });

  it("shadow => info, reports the shadow mode", () => {
    const c = reasoningRouterDoctorCheck({ [REASONING_ROUTER_ENV]: "shadow" });
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("shadow");
  });

  it("on => pass", () => {
    const c = reasoningRouterDoctorCheck({ [REASONING_ROUTER_ENV]: "on" });
    expect(c.level).toBe("pass");
    expect(c.message.toLowerCase()).toContain("on");
  });

  it("invalid value => off + visible WARN, and never echoes the raw value", () => {
    const c = reasoningRouterDoctorCheck({ [REASONING_ROUTER_ENV]: "/Users/secret/typo-as-path" });
    expect(c.level).toBe("warn");
    expect(c.message.toLowerCase()).toContain("invalid");
    expect(c.message).not.toContain("/Users"); // the raw (path-like) value is never echoed
    expect(c.fix).toContain("off | shadow | on");
  });
});
