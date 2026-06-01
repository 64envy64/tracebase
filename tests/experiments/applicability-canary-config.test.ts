/**
 * Phase D.4 — persisted applicability-canary config lifecycle. Explicit opt-in
 * only (policy acknowledgement required); env may ONLY disable, never enable.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  initConfig,
  enableApplicabilityCanary,
  disableApplicabilityCanary,
  readApplicabilityCanaryConfig,
  resolveCanaryServingState,
  CANARY_POLICY_VERSION,
  DEFAULT_CANARY_RATE,
  MAX_CANARY_RATE,
  APPLICABILITY_CANARY_KILL_ENV as KILL,
} from "../../src/core/config.js";

describe("applicability canary config lifecycle", () => {
  let basePath: string;
  beforeEach(() => {
    basePath = realpathSync(((): string => { const p = join(tmpdir(), `tb-canary-${randomUUID()}`); mkdirSync(p, { recursive: true }); return p; })());
    initConfig(basePath);
  });
  afterEach(() => rmSync(basePath, { recursive: true, force: true }));

  it("is ABSENT by default (no canary key) → byte-identical serving", () => {
    expect(readApplicabilityCanaryConfig(basePath)).toBeNull();
  });

  it("enable REQUIRES an explicit policy acknowledgement", () => {
    expect(() => enableApplicabilityCanary(basePath, { policyAck: "wrong" })).toThrow(/policy acknowledgement|--ack/);
    expect(() => enableApplicabilityCanary(basePath, { policyAck: "" })).toThrow();
    const c = enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION });
    expect(c!.enabled).toBe(true);
    expect(c!.rate).toBe(DEFAULT_CANARY_RATE);
    expect(c!.policyVersion).toBe(CANARY_POLICY_VERSION);
  });

  it("enable REJECTS rates above the pre-reg cap (never clamps)", () => {
    expect(() => enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0 })).toThrow();
    expect(() => enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 1.5 })).toThrow();
    expect(() => enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.06 })).toThrow(/0\.05|cap/);
    expect(MAX_CANARY_RATE).toBe(0.05);
    // The cap itself is allowed.
    expect(enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 })!.rate).toBe(0.05);
  });

  it("preserves salt + createdAt across disable / re-enable (stable assignment)", () => {
    const first = enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 })!;
    const disabled = disableApplicabilityCanary(basePath)!;
    expect(disabled.enabled).toBe(false);
    expect(disabled.salt).toBe(first.salt);
    const reenabled = enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.03 })!;
    expect(reenabled.salt).toBe(first.salt); // stable
    expect(reenabled.createdAt).toBe(first.createdAt);
    expect(reenabled.rate).toBe(0.03);
  });

  it("a persisted rate above the cap collapses to OFF (malformed/out-of-policy)", () => {
    // Hand-edit the config to an out-of-policy rate (simulating tampering / a
    // future version). extract must reject it rather than serve above the cap.
    enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    const file = join(basePath, ".tracebase", "config.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { experiment: { applicabilityCanary: { rate: number } } };
    raw.experiment.applicabilityCanary.rate = 0.5;
    writeFileSync(file, JSON.stringify(raw));
    expect(readApplicabilityCanaryConfig(basePath)).toBeNull(); // collapses to off
    expect(resolveCanaryServingState(readApplicabilityCanaryConfig(basePath), {}).enabled).toBe(false);
  });

  it("resolveCanaryServingState: env may DISABLE but NEVER enable", () => {
    const persisted = enableApplicabilityCanary(basePath, { policyAck: CANARY_POLICY_VERSION })!;
    // enabled persisted + no env → enabled.
    expect(resolveCanaryServingState(persisted, {}).enabled).toBe(true);
    // env kill values force disabled.
    for (const v of ["off", "0", "false", "disabled"]) {
      const s = resolveCanaryServingState(persisted, { [KILL]: v });
      expect(s.enabled).toBe(false);
      expect(s.killReason).toContain(KILL);
    }
    // TRACEBASE_DISABLED is a global kill.
    expect(resolveCanaryServingState(persisted, { TRACEBASE_DISABLED: "1" }).enabled).toBe(false);
    // env can NEVER enable: a disabled persisted config stays off no matter the env.
    const off = disableApplicabilityCanary(basePath)!;
    expect(resolveCanaryServingState(off, { [KILL]: "on" }).enabled).toBe(false);
    expect(resolveCanaryServingState(off, { [KILL]: "on:0.5" }).enabled).toBe(false);
    expect(resolveCanaryServingState(null, { [KILL]: "true" }).enabled).toBe(false);
  });

  it("enable returns null when the project is not initialized", () => {
    const fresh = realpathSync(((): string => { const p = join(tmpdir(), `tb-canary-noinit-${randomUUID()}`); mkdirSync(p, { recursive: true }); return p; })());
    try {
      expect(enableApplicabilityCanary(fresh, { policyAck: CANARY_POLICY_VERSION })).toBeNull();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
