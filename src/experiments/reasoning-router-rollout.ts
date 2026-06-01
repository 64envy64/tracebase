/**
 * Reasoning Memory Router V2 — rollout resolver.
 *
 * ONE env-driven switch decides how the Router V2 evidence/family decision is
 * exposed at runtime. Mirrors the cascade-rollout convention (a small pure
 * resolver, read at BlockServer construction):
 *
 *   TRACEBASE_REASONING_ROUTER = off | shadow | on
 *
 *   off    (DEFAULT) → serve V1 only. Byte-for-byte the legacy behaviour; the
 *                      V2 decision is never computed.
 *   shadow           → serve V1 only (injected context is UNCHANGED), but
 *                      compute the V2-family decision side-by-side on the SAME
 *                      candidate slate and persist a privacy-safe comparison
 *                      event. Zero effect on what the agent sees.
 *   on               → serve the V2-family decision, fail-open to V1 on any
 *                      error.
 *
 * The mode maps onto the two orthogonal BlockServer primitives:
 *   servingMode    — which decision DRIVES injection ("v1" | "v2-family").
 *   shadowEvaluate — which V2 decision to additionally compute for comparison
 *                    WITHOUT affecting injection (set only in shadow mode).
 *
 * Default MUST remain `off`. An unset / unrecognized env value resolves to
 * `off` with a diagnostic — a typo never silently enables V2.
 */
import type { ServingMode } from "../core/block-serving.js";
import type { ServingModeV2 } from "../core/serving-decision-v2.js";

export type ReasoningRouterMode = "off" | "shadow" | "on";

export const REASONING_ROUTER_ENV = "TRACEBASE_REASONING_ROUTER";

export interface RouterModeResolution {
  mode: ReasoningRouterMode;
  /** Human-readable notes (e.g. an ignored bad value). Empty when default. */
  diagnostics: string[];
}

/** Resolve the rollout mode from the environment. Default `off`; never throws. */
export function resolveReasoningRouterMode(env: NodeJS.ProcessEnv = process.env): RouterModeResolution {
  const raw = env[REASONING_ROUTER_ENV];
  if (raw === undefined || raw === "") return { mode: "off", diagnostics: [] };
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "shadow" || v === "on") {
    return { mode: v, diagnostics: v === "off" ? [] : [`${REASONING_ROUTER_ENV}=${v}`] };
  }
  return { mode: "off", diagnostics: [`${REASONING_ROUTER_ENV}="${raw}" ignored (expected off|shadow|on); using off`] };
}

/** BlockServer option fragment for a rollout mode. */
export interface RouterServingOptions {
  servingMode: ServingMode;
  shadowEvaluate?: ServingModeV2;
}

/** Map a rollout mode onto the BlockServer serving primitives. */
export function routerServingOptionsForMode(mode: ReasoningRouterMode): RouterServingOptions {
  switch (mode) {
    case "on":
      return { servingMode: "v2-family" };
    case "shadow":
      return { servingMode: "v1", shadowEvaluate: "v2-family" };
    case "off":
    default:
      return { servingMode: "v1" };
  }
}

/**
 * Convenience: resolve the env and return the BlockServer option fragment to
 * spread into `new BlockServer(store, { ...routerServingOptions(), ... })`.
 * This is the ONE call each runtime construction site makes — CLI inject-context,
 * SDK runtime, TracebaseRuntimeProvider, and the MCP server — so all paths share
 * a single rollout contract and the same default-off behaviour.
 */
export function routerServingOptions(env: NodeJS.ProcessEnv = process.env): RouterServingOptions {
  return routerServingOptionsForMode(resolveReasoningRouterMode(env).mode);
}
