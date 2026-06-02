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
import { applicabilityCanaryDoctorCheck, semanticShadowDoctorCheck } from "../../src/cli/commands/doctor.js";
import { refreshBreaker, admitCanaryExposure, canaryEffectiveStatus, LIVE_HEARTBEAT_FRESHNESS_MS } from "../../src/experiments/canary-breaker.js";
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

// HISTORICAL breaker state ONLY — a clean (non-tripped) breaker file written by an
// old run, with NO runtime receipt. Per E.2.3 this must NOT read as LIVE_CONFIRMED
// (a historical breaker file is not a live heartbeat).
function writeHistoricalBreakerOnly(basePath: string): void {
  const store = new BlockStore(new Database(":memory:"));
  refreshBreaker(basePath, store, 1_780_000_000_000);
  store.close();
}

// A confirmed, durably-admitted exposure at `nowMs` — the REAL runtime path. Writes
// breaker state AND stamps the fresh runtime receipt (the bounded-freshness heartbeat).
function armLive(basePath: string, nowMs: number = Date.now()): void {
  const store = new BlockStore(new Database(":memory:"));
  admitCanaryExposure(basePath, store, nowMs);
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

  it("enabled + shadow on but NO heartbeat → WARN ARMED (not LIVE — honest E.2.2)", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    const c = applicabilityCanaryDoctorCheck(basePath, { TRACEBASE_REASONING_APPLICABILITY: "shadow" });
    expect(c.level).toBe("warn");
    expect(c.message).toContain("ARMED");
    expect(c.message.toLowerCase()).toContain("no confirmed exposure");
  });

  it("enabled + shadow on + FRESH runtime receipt → WARN LIVE_CONFIRMED — exposing", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    armLive(basePath); // confirmed exposure NOW → fresh runtime receipt
    const c = applicabilityCanaryDoctorCheck(basePath, { TRACEBASE_REASONING_APPLICABILITY: "shadow" });
    expect(c.level).toBe("warn");
    expect(c.message).toContain("LIVE_CONFIRMED");
    expect(c.message.toLowerCase()).toContain("exposing");
  });

  it("a HISTORICAL breaker file alone (no receipt) is NOT LIVE → ARMED (E.2.3 honesty)", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    writeHistoricalBreakerOnly(basePath); // old breaker state, no runtime receipt
    const c = applicabilityCanaryDoctorCheck(basePath, { TRACEBASE_REASONING_APPLICABILITY: "shadow" });
    expect(c.message).toContain("ARMED");
    expect(c.message).not.toContain("LIVE_CONFIRMED");
    expect(c.message.toLowerCase()).toContain("no confirmed exposure");
  });

  it("a STALE runtime receipt (past the freshness window) → ARMED, reported as stale", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    armLive(basePath, Date.now() - LIVE_HEARTBEAT_FRESHNESS_MS - 60_000); // last exposure too old
    const c = applicabilityCanaryDoctorCheck(basePath, { TRACEBASE_REASONING_APPLICABILITY: "shadow" });
    expect(c.message).toContain("ARMED");
    expect(c.message).not.toContain("LIVE_CONFIRMED");
    expect(c.message.toLowerCase()).toContain("stale");
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

describe("semanticShadowDoctorCheck (E.2.4 fail-off config)", () => {
  const pin = JSON.stringify({ model: "fake", revision: "rev-1", backend: "fake", featureVersion: 1 });

  it("reports default-off without inference traffic", () => {
    expect(semanticShadowDoctorCheck({})).toMatchObject({ level: "info" });
  });

  it("warns and stays disabled on a malformed attestation pin", () => {
    const c = semanticShadowDoctorCheck({
      TRACEBASE_SEMANTIC_SHADOW_URL: "http://x",
      TRACEBASE_SEMANTIC_SHADOW_TOKEN: "tok",
      TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: "{broken",
    });
    expect(c.level).toBe("warn");
    expect(c.message).toContain("malformed-attestation");
  });

  it("reports a pinned shadow lane as telemetry-only", () => {
    const c = semanticShadowDoctorCheck({
      TRACEBASE_SEMANTIC_SHADOW_URL: "http://x",
      TRACEBASE_SEMANTIC_SHADOW_TOKEN: "tok",
      TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: pin,
    });
    expect(c.level).toBe("info");
    expect(c.message).toContain("pinned");
  });
});

describe("canaryEffectiveStatus — ARMED / LIVE_CONFIRMED / INERT / TRIPPED (E.2.3 bounded-freshness)", () => {
  const T = 1_780_000_000_000;
  let basePath: string;
  beforeEach(() => {
    basePath = realpathSync(((): string => { const p = join(tmpdir(), `tb-canary-eff-${randomUUID()}`); mkdirSync(p, { recursive: true }); return p; })());
    initConfig(basePath);
  });
  afterEach(() => rmSync(basePath, { recursive: true, force: true }));

  it("INERT when configured-off", () => {
    expect(canaryEffectiveStatus(basePath, {}).status).toBe("INERT");
  });
  it("ARMED when enabled + clear but NO receipt (never exposed)", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    const eff = canaryEffectiveStatus(basePath, {}, T);
    expect(eff.status).toBe("ARMED");
    expect(eff.heartbeatMs).toBeUndefined();
    expect(eff.stale).toBeUndefined();
  });
  it("a HISTORICAL breaker file alone is NOT a live heartbeat → ARMED (E.2.3)", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    writeHistoricalBreakerOnly(basePath); // breaker present, NO runtime receipt
    expect(canaryEffectiveStatus(basePath, {}, T).status).toBe("ARMED");
  });
  it("LIVE_CONFIRMED only with a FRESH runtime receipt (within the window)", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    armLive(basePath, T);
    const eff = canaryEffectiveStatus(basePath, {}, T + 1000); // 1s later → fresh
    expect(eff.status).toBe("LIVE_CONFIRMED");
    expect(eff.heartbeatMs).toBe(T);
    expect(eff.stale).toBeUndefined();
  });
  it("a STALE receipt (past the freshness window) → ARMED + stale, age preserved", () => {
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    armLive(basePath, T);
    const eff = canaryEffectiveStatus(basePath, {}, T + LIVE_HEARTBEAT_FRESHNESS_MS + 1); // just past window
    expect(eff.status).toBe("ARMED");
    expect(eff.stale).toBe(true);
    expect(eff.heartbeatMs).toBe(T); // age still surfaced
  });
  it("INERT (not ARMED) when enabled but env-killed", () => {
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
