/**
 * Router V2 rollout resolver — default-off + mode mapping.
 */
import { describe, it, expect } from "vitest";
import {
  resolveReasoningRouterMode,
  routerServingOptions,
  routerServingOptionsForMode,
  REASONING_ROUTER_ENV,
} from "../../src/experiments/reasoning-router-rollout.js";

describe("reasoning-router rollout resolver", () => {
  it("defaults to off when the env is unset or empty", () => {
    expect(resolveReasoningRouterMode({}).mode).toBe("off");
    expect(resolveReasoningRouterMode({ [REASONING_ROUTER_ENV]: "" }).mode).toBe("off");
    expect(resolveReasoningRouterMode({}).diagnostics).toEqual([]);
  });

  it("parses off | shadow | on (case-insensitive, trimmed)", () => {
    expect(resolveReasoningRouterMode({ [REASONING_ROUTER_ENV]: "off" }).mode).toBe("off");
    expect(resolveReasoningRouterMode({ [REASONING_ROUTER_ENV]: "shadow" }).mode).toBe("shadow");
    expect(resolveReasoningRouterMode({ [REASONING_ROUTER_ENV]: "  ON " }).mode).toBe("on");
  });

  it("ignores an unrecognized value — falls back to off with a diagnostic", () => {
    const r = resolveReasoningRouterMode({ [REASONING_ROUTER_ENV]: "v2-family" });
    expect(r.mode).toBe("off");
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it("maps each mode onto the BlockServer serving primitives", () => {
    expect(routerServingOptionsForMode("off")).toEqual({ servingMode: "v1" });
    expect(routerServingOptionsForMode("shadow")).toEqual({ servingMode: "v1", shadowEvaluate: "v2-family" });
    expect(routerServingOptionsForMode("on")).toEqual({ servingMode: "v2-family" });
  });

  it("routerServingOptions reads the env (default off → V1 only, no shadow)", () => {
    expect(routerServingOptions({})).toEqual({ servingMode: "v1" });
    expect(routerServingOptions({ [REASONING_ROUTER_ENV]: "shadow" })).toEqual({
      servingMode: "v1",
      shadowEvaluate: "v2-family",
    });
    expect(routerServingOptions({ [REASONING_ROUTER_ENV]: "on" })).toEqual({ servingMode: "v2-family" });
  });
});
