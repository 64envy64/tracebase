/**
 * Phase D.4 — applicability canary exposure decision (apply-only). The safety
 * matrix: eligible ONLY when V4 abstains AND reranker `applicable`; holdout +
 * disabled always win; uncertain/inapplicable/fallback/stale/missing never
 * expose; deterministic, stable assignment.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateApplicabilityCanaryExposure,
  canaryUnitHash,
  type CanaryExposureInput,
  type CanaryShadowSummary,
} from "../../src/experiments/applicability-canary.js";

const cfg = { salt: "salt-1", rate: 1, policyVersion: "deterministic-applicability.v1", enabled: true };
const eligibleShadow: CanaryShadowSummary = { v4Action: "abstain", verdict: "applicable", topBlockId: "blk-1", fallback: "none" };
const base = (o: Partial<CanaryExposureInput> = {}): CanaryExposureInput => ({
  servingEnabled: true,
  config: cfg,
  fingerprint: "fp-xyz",
  holdout: false,
  shadow: eligibleShadow,
  applicabilityFeatureVersion: 1,
  currentFeatureVersion: 1,
  ...o,
});

describe("evaluateApplicabilityCanaryExposure", () => {
  it("EXPOSES treatment when V4 abstains AND reranker is applicable (rate 1)", () => {
    const d = evaluateApplicabilityCanaryExposure(base());
    expect(d.exposed).toBe(true);
    if (d.exposed) {
      expect(d.arm).toBe("treatment");
      expect(d.blockId).toBe("blk-1");
      expect(d.outcomeCompatible).toBe(true);
      expect(d.eligibilityReason).toBe("v4_abstain_reranker_applicable");
      expect(d.unitHash).toBe(canaryUnitHash(cfg.salt, "fp-xyz"));
    }
  });

  it("assigns control at a tiny rate; the block is recorded but outcome is the baseline", () => {
    const d = evaluateApplicabilityCanaryExposure(base({ config: { ...cfg, rate: 0.0001 } }));
    expect(d.exposed).toBe(true);
    if (d.exposed) {
      expect(d.arm).toBe("control");
      expect(d.blockId).toBe("blk-1"); // the candidate is recorded
      expect(d.outcomeCompatible).toBe(false); // control: no per-block injected outcome
    }
  });

  it("is deterministic + stable: same fingerprint → same arm", () => {
    const c = { ...cfg, rate: 0.5 };
    const a1 = evaluateApplicabilityCanaryExposure(base({ config: c, fingerprint: "stable-fp" }));
    const a2 = evaluateApplicabilityCanaryExposure(base({ config: c, fingerprint: "stable-fp" }));
    expect(a1).toEqual(a2);
  });

  it.each([
    ["disabled (serving off)", base({ servingEnabled: false }), "disabled"],
    ["disabled (config off)", base({ config: { ...cfg, enabled: false } }), "disabled"],
    ["disabled (no config)", base({ config: null }), "disabled"],
    ["global holdout wins", base({ holdout: true }), "holdout"],
    ["no shadow verdict", base({ shadow: undefined }), "no_shadow"],
    ["reranker fallback (timeout)", base({ shadow: { ...eligibleShadow, fallback: "timeout" } }), "reranker_fallback"],
    ["V4 injected (not abstain)", base({ shadow: { ...eligibleShadow, v4Action: "inject" } }), "v4_injected"],
    ["verdict uncertain", base({ shadow: { ...eligibleShadow, verdict: "uncertain" } }), "not_applicable"],
    ["verdict inapplicable", base({ shadow: { ...eligibleShadow, verdict: "inapplicable" } }), "not_applicable"],
    ["verdict none", base({ shadow: { ...eligibleShadow, verdict: "none" } }), "not_applicable"],
    ["missing block id", base({ shadow: { v4Action: "abstain", verdict: "applicable", fallback: "none" } }), "no_block"],
    ["stale feature version", base({ applicabilityFeatureVersion: 0, currentFeatureVersion: 1 }), "stale_feature_version"],
  ])("does NOT expose: %s", (_name, input, reason) => {
    const d = evaluateApplicabilityCanaryExposure(input);
    expect(d.exposed).toBe(false);
    if (!d.exposed) expect(d.reason).toBe(reason);
  });

  it("unitHash is opaque (never the raw fingerprint)", () => {
    const h = canaryUnitHash("salt", "sensitive-fingerprint");
    expect(h).toMatch(/^u_[0-9a-f]{8}$/);
    expect(h).not.toContain("sensitive");
  });
});
