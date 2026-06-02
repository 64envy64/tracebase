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
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import type { AnalyticsEvent } from "../../src/types.js";
import { applicabilityCanaryDoctorCheck } from "../../src/cli/commands/doctor.js";
import { refreshBreaker, canaryEffectiveStatus } from "../../src/experiments/canary-breaker.js";
import { initConfig, enableApplicabilityCanary, CANARY_POLICY_VERSION, APPLICABILITY_CANARY_KILL_ENV as KILL } from "../../src/core/config.js";

// Trip the breaker for `basePath` by re-deriving from a store with a harmful trial.
function tripBreaker(basePath: string): void {
  const store = new BlockStore(new Database(":memory:"));
  const TS = 1_780_000_000_000;
  const ev: AnalyticsEvent[] = [
    { event: "reasoning.applicability_comparison", ts: TS, queryId: "q", runId: "r", queryHash: "h", corpusSize: 1, candidateCount: 1, v4Action: "abstain", v4TopBlockId: "b", applicabilityTopBlockId: "b", applicabilityProvider: CANARY_POLICY_VERSION, applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "reranker_only_apply", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 5 } as AnalyticsEvent,
    { event: "reasoning.applicability_canary_exposure", ts: TS, queryId: "q", runId: "r", queryHash: "h", unitHash: "u", arm: "treatment", propensity: 0.05, policyVersion: CANARY_POLICY_VERSION, applicabilityFeatureVersion: 1, blockId: "b", eligibilityReason: "v4_abstain_reranker_applicable", outcomeCompatible: true } as AnalyticsEvent,
    { event: "injection", ts: TS, queryId: "q", runId: "r", blockId: "b", score: 1, calibratedProb: 1 } as AnalyticsEvent,
    { event: "outcome", ts: TS, queryId: "q", runId: "r", resolved: false, regressed: true, control: false } as AnalyticsEvent,
  ];
  ev.forEach((e) => store.appendEvent(e));
  refreshBreaker(basePath, store, TS + 1000);
  store.close();
}

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

  it("breaker TRIPPED → WARN reported distinctly as TRIPPED, with a reset-breaker fix", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    tripBreaker(basePath);
    const c = applicabilityCanaryDoctorCheck(basePath, { TRACEBASE_REASONING_APPLICABILITY: "shadow" });
    expect(c.level).toBe("warn");
    expect(c.message).toContain("TRIPPED");
    expect(c.message.toLowerCase()).toContain("harm_rate_exceeded");
    expect(c.fix).toContain("reset-breaker");
  });
});

describe("canaryEffectiveStatus — LIVE / INERT / TRIPPED", () => {
  let basePath: string;
  beforeEach(() => {
    basePath = realpathSync(((): string => { const p = join(tmpdir(), `tb-canary-eff-${randomUUID()}`); mkdirSync(p, { recursive: true }); return p; })());
    initConfig(basePath);
  });
  afterEach(() => rmSync(basePath, { recursive: true, force: true }));

  it("INERT when configured-off", () => {
    expect(canaryEffectiveStatus(basePath, {}).status).toBe("INERT");
  });
  it("LIVE when enabled + no kill + breaker clear", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    expect(canaryEffectiveStatus(basePath, {}).status).toBe("LIVE");
  });
  it("INERT (not TRIPPED) when enabled but env-killed", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    expect(canaryEffectiveStatus(basePath, { [KILL]: "off" }).status).toBe("INERT");
  });
  it("TRIPPED takes precedence once the breaker latches", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    tripBreaker(basePath);
    const eff = canaryEffectiveStatus(basePath, {});
    expect(eff.status).toBe("TRIPPED");
    expect(eff.killReason).toContain("breaker_tripped");
  });
});
