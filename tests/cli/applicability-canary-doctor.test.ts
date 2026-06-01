/**
 * Phase D.4 — applicability canary serving-state doctor diagnostic. Reads the
 * PERSISTED config + the env kill + shadow-rollout coherence. A live canary is a
 * `warn` (the operator must know it is serving); default-off is `info`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { applicabilityCanaryDoctorCheck } from "../../src/cli/commands/doctor.js";
import { initConfig, enableApplicabilityCanary, CANARY_POLICY_VERSION, APPLICABILITY_CANARY_KILL_ENV as KILL } from "../../src/core/config.js";

describe("applicabilityCanaryDoctorCheck (D.4 persisted state)", () => {
  let basePath: string;
  beforeEach(() => {
    basePath = realpathSync(((): string => { const p = join(tmpdir(), `tb-canary-doc-${randomUUID()}`); mkdirSync(p, { recursive: true }); return p; })());
    initConfig(basePath);
  });
  afterEach(() => rmSync(basePath, { recursive: true, force: true }));

  it("off by default → info (serving byte-identical)", () => {
    const c = applicabilityCanaryDoctorCheck(basePath, {});
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("off");
  });

  it("no project root → info off (env-only)", () => {
    expect(applicabilityCanaryDoctorCheck(undefined, {}).level).toBe("info");
  });

  it("enabled + shadow on → WARN that it is LIVE / exposing", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    const c = applicabilityCanaryDoctorCheck(basePath, { TRACEBASE_REASONING_APPLICABILITY: "shadow" });
    expect(c.level).toBe("warn");
    expect(c.message.toLowerCase()).toContain("live");
    expect(c.message.toLowerCase()).toContain("disable");
  });

  it("enabled but shadow OFF → WARN that it is INERT", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION });
    const c = applicabilityCanaryDoctorCheck(basePath, {});
    expect(c.level).toBe("warn");
    expect(c.message.toLowerCase()).toContain("inert");
  });

  it("enabled but env kill engaged → info (configured but disabled)", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION });
    const c = applicabilityCanaryDoctorCheck(basePath, { [KILL]: "off", TRACEBASE_REASONING_APPLICABILITY: "shadow" });
    expect(c.level).toBe("info");
    expect(c.message.toLowerCase()).toContain("disabled");
  });

  it("message never leaks an absolute path or the salt", () => {
    const cfg = enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION })!;
    const c = applicabilityCanaryDoctorCheck(basePath, { TRACEBASE_REASONING_APPLICABILITY: "shadow" });
    expect(c.message).not.toContain("/Users");
    expect(c.message).not.toContain(cfg.salt);
  });
});
