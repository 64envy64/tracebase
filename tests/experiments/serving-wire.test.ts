import { describe, it, expect } from "vitest";
import { buildHoldoutInput } from "../../src/experiments/serving.js";
import type { HoldoutConfig } from "../../src/types.js";

const ENABLED: HoldoutConfig = {
  enabled: true,
  rate: 0.1,
  salt: "salt-x",
  createdAt: "2026-04-22T00:00:00.000Z",
  updatedAt: "2026-04-22T00:00:00.000Z",
};

describe("buildHoldoutInput", () => {
  it("returns undefined when the config is null / undefined (default-off serving)", () => {
    expect(buildHoldoutInput(null, "fp")).toBeUndefined();
    expect(buildHoldoutInput(undefined, "fp")).toBeUndefined();
  });

  it("returns undefined when holdout is disabled, even with a positive rate on disk", () => {
    const disabled: HoldoutConfig = { ...ENABLED, enabled: false };
    expect(buildHoldoutInput(disabled, "fp")).toBeUndefined();
  });

  it("returns undefined when rate is <= 0 / non-finite", () => {
    expect(buildHoldoutInput({ ...ENABLED, rate: 0 }, "fp")).toBeUndefined();
    expect(buildHoldoutInput({ ...ENABLED, rate: -0.5 }, "fp")).toBeUndefined();
    expect(buildHoldoutInput({ ...ENABLED, rate: Number.NaN }, "fp")).toBeUndefined();
  });

  it("returns undefined when fingerprint is missing or empty", () => {
    expect(buildHoldoutInput(ENABLED, undefined)).toBeUndefined();
    expect(buildHoldoutInput(ENABLED, "")).toBeUndefined();
  });

  it("returns an ExperimentInput-shaped object when every precondition is met", () => {
    const input = buildHoldoutInput(ENABLED, "fp:abc");
    expect(input).toEqual({
      rate: 0.1,
      salt: "salt-x",
      fingerprint: "fp:abc",
    });
  });

  it("never leaks the persisted createdAt / updatedAt into the serving input", () => {
    const input = buildHoldoutInput(ENABLED, "fp:abc");
    // Input shape is deliberately narrow — only rate / salt /
    // fingerprint. The persisted timestamps are config-only.
    expect(input).not.toHaveProperty("createdAt");
    expect(input).not.toHaveProperty("updatedAt");
    expect(input).not.toHaveProperty("enabled");
  });
});
