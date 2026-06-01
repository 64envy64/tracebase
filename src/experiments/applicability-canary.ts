/**
 * Applicability canary experiment contract (Router V2, Phase D.3).
 *
 * A DORMANT, default-OFF contract for a FUTURE explicit opt-in canary that would
 * serve the reranker's verdict to a bounded, deterministically-assigned slice of
 * traffic. Phase D.3 ships ONLY the contract + assignment math + a kill switch —
 * it is NOT wired into any serving path and changes nothing. Activation requires
 * a separate, explicitly-reviewed opt-in (Phase E+), gated on organic shadow
 * evidence from the ledger.
 *
 * GUARANTEES
 *   • Deterministic assignment from a stable salt + unit key (same unit → same
 *     arm), so propensity is exactly known and replay is reproducible.
 *   • Bounded rate ∈ [0,1], clamped.
 *   • Kill switch: `enabled=false` (the default) forces EVERY unit to control with
 *     propensity 0 — there is no path to treatment while disabled.
 *   • Logged propensity + policyVersion for off-policy correction later.
 *
 * Pure + deterministic. No DB, no clock, no randomness.
 */

export const APPLICABILITY_CANARY_ENV = "TRACEBASE_APPLICABILITY_CANARY";

export interface CanaryConfig {
  /** Master kill switch. DEFAULT false — disabled forces all-control. */
  enabled: boolean;
  /** Stable salt; changing it reshuffles assignment (use a fixed value per experiment). */
  salt: string;
  /** Treatment fraction ∈ [0,1] (clamped). Ignored while disabled. */
  rate: number;
  /** The policy version this canary would serve (logged for off-policy correction). */
  policyVersion: string;
}

export const DISABLED_CANARY: CanaryConfig = { enabled: false, salt: "applicability-canary-v1", rate: 0, policyVersion: "none" };

export interface CanaryAssignment {
  arm: "treatment" | "control";
  /** P(treatment) for this unit under the config — 0 while disabled (no path to treatment). */
  propensity: number;
  policyVersion: string;
  /** True iff the kill switch is engaged (config disabled). */
  killed: boolean;
}

/** Deterministic FNV-1a hash of `salt|unit` → a stable fraction in [0,1). */
function hashUnit(salt: string, unit: string): number {
  const s = `${salt}|${unit}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Assign a unit (e.g. a problem fingerprint) to treatment/control. While disabled
 * (the default), ALWAYS control with propensity 0 — the kill switch is absolute.
 */
export function assignCanary(unit: string, config: CanaryConfig = DISABLED_CANARY): CanaryAssignment {
  if (!config.enabled) {
    return { arm: "control", propensity: 0, policyVersion: config.policyVersion, killed: true };
  }
  const rate = clamp01(config.rate);
  const h = hashUnit(config.salt, unit);
  return {
    arm: h < rate ? "treatment" : "control",
    propensity: rate,
    policyVersion: config.policyVersion,
    killed: false,
  };
}

/**
 * Resolve the canary config from the environment. DEFAULT is DISABLED. The env
 * var is intentionally NOT read by any serving path in D.3 — this exists so a
 * future opt-in can flip it after review, never implicitly. Any value other than
 * an explicit `on:<rate>` leaves the canary disabled.
 */
export function resolveCanaryConfig(env: NodeJS.ProcessEnv = process.env): { config: CanaryConfig; diagnostics: string[] } {
  const raw = env[APPLICABILITY_CANARY_ENV];
  if (raw === undefined || raw === "" || raw.trim().toLowerCase() === "off") {
    return { config: DISABLED_CANARY, diagnostics: [] };
  }
  // Accept ONLY `on:<rate>` (e.g. `on:0.05`); anything else stays disabled.
  const m = /^on:(\d*\.?\d+)$/.exec(raw.trim().toLowerCase());
  if (!m) {
    return { config: DISABLED_CANARY, diagnostics: [`${APPLICABILITY_CANARY_ENV}="${raw}" not understood; canary stays DISABLED`] };
  }
  const rate = clamp01(Number.parseFloat(m[1]!));
  return {
    config: { enabled: true, salt: DISABLED_CANARY.salt, rate, policyVersion: "deterministic-applicability.v1" },
    diagnostics: [
      `${APPLICABILITY_CANARY_ENV}=on:${rate} parsed — but D.3 does NOT wire the canary to serving; this is dormant config only`,
    ],
  };
}
