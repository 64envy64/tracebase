/**
 * ServingEvidenceV3 rollout resolver — default off; shadow; `on` refused.
 */
import { describe, it, expect } from "vitest";
import {
  resolveReasoningEvidenceMode,
  reasoningEvidenceOptions,
  REASONING_EVIDENCE_ENV,
} from "../../src/experiments/reasoning-evidence-rollout.js";

describe("reasoning-evidence rollout resolver", () => {
  it("defaults to off (unset/empty), no diagnostic", () => {
    expect(resolveReasoningEvidenceMode({}).mode).toBe("off");
    expect(resolveReasoningEvidenceMode({ [REASONING_EVIDENCE_ENV]: "" }).mode).toBe("off");
    expect(resolveReasoningEvidenceMode({}).diagnostics).toEqual([]);
  });

  it("accepts off | shadow (case-insensitive)", () => {
    expect(resolveReasoningEvidenceMode({ [REASONING_EVIDENCE_ENV]: "shadow" }).mode).toBe("shadow");
    expect(resolveReasoningEvidenceMode({ [REASONING_EVIDENCE_ENV]: " SHADOW " }).mode).toBe("shadow");
  });

  it("REFUSES on (V3 is shadow-only) → off + diagnostic", () => {
    const r = resolveReasoningEvidenceMode({ [REASONING_EVIDENCE_ENV]: "on" });
    expect(r.mode).toBe("off");
    expect(r.diagnostics.some((d) => d.includes("not permitted"))).toBe(true);
  });

  it("ignores an unrecognized value → off + diagnostic", () => {
    const r = resolveReasoningEvidenceMode({ [REASONING_EVIDENCE_ENV]: "v3" });
    expect(r.mode).toBe("off");
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it("reasoningEvidenceOptions reads env (default off)", () => {
    expect(reasoningEvidenceOptions({})).toEqual({ evidenceMode: "off" });
    expect(reasoningEvidenceOptions({ [REASONING_EVIDENCE_ENV]: "shadow" })).toEqual({ evidenceMode: "shadow" });
    expect(reasoningEvidenceOptions({ [REASONING_EVIDENCE_ENV]: "on" })).toEqual({ evidenceMode: "off" });
  });
});
