/**
 * Applicability-canary preflight + activation receipt (Phase D.4.1).
 *
 * Enabling a serving canary must not be a single mutating command. `preflight`
 * runs a machine-checkable readiness audit and emits a LOCAL, bounded RECEIPT
 * (timestamp + prerequisite hashes + check results — never content or secrets).
 * `canary enable` then refuses unless a FRESH, still-valid receipt exists AND the
 * operator re-acknowledges the policy + the frozen pre-registration hash. If any
 * prerequisite changed since the receipt was issued — shadow turned off, the
 * pre-reg edited, a version bumped, the kill switch engaged, the canary already
 * on — the bound `prereqDigest` no longer matches and activation is refused.
 *
 * Pure + deterministic: the clock and all environment state are injected, so the
 * receipt is reproducible and the verifier has no hidden inputs.
 */
import { createHash } from "node:crypto";
import type { AnalyticsEvent } from "../types.js";
import type { ApplicabilityCanaryConfig } from "../types.js";
import { joinApplicabilityTrials } from "../analytics/applicability-ledger.js";

export const CANARY_RECEIPT_VERSION = 1 as const;
/** A receipt older than this is expired and cannot authorize an enable. */
export const RECEIPT_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const CANARY_RECEIPT_FILE = "canary-preflight-receipt.json";

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Absolute-path / drive markers a privacy-safe local event must never contain. */
const PATH_MARKERS = [/(^|[\s("'`])\/(Users|home|tmp|private|var|etc|root|opt|usr)\//, /[A-Za-z]:[\\/]/];

export interface CanaryPreflightChecks {
  /** TRACEBASE_REASONING_APPLICABILITY=shadow (the canary needs a reranker verdict). */
  shadowEnabled: boolean;
  /** The canary is currently OFF (you preflight BEFORE enabling). */
  canaryOff: boolean;
  /** Policy + applicability feature versions are the current ones. */
  versionsCurrent: boolean;
  /** Recent ledger attribution is clean: zero cross-run / ambiguous joins. */
  attributionClean: boolean;
  /** No recent local event carries an absolute path / obvious raw text. */
  privacyClean: boolean;
  /** No env / global kill switch is engaged. */
  killSwitchClear: boolean;
  /** The canary rail is wired through MCP, hook AND SDK (a build-time invariant). */
  transportParity: boolean;
}

export interface CanaryPreflightReceipt {
  receiptVersion: typeof CANARY_RECEIPT_VERSION;
  issuedAtMs: number;
  policyVersion: string;
  applicabilityFeatureVersion: number;
  /** sha256(16) of the frozen pre-registration document text. */
  preregHash: string;
  checks: CanaryPreflightChecks;
  /** Every check passed → the receipt CAN authorize an enable (still needs freshness + acks). */
  ok: boolean;
  /** Binds the receipt to the prerequisites it certified. Recomputed at enable time. */
  prereqDigest: string;
  /** Counts surfaced for the operator; bounded numbers only. */
  attribution: { crossRun: number; ambiguous: number; trials: number };
}

export interface PreflightInput {
  preregText: string;
  events: readonly AnalyticsEvent[];
  canaryConfig: ApplicabilityCanaryConfig | null;
  shadowEnabled: boolean;
  killEngaged: boolean;
  globalDisabled: boolean;
  policyVersion: string;
  currentPolicyVersion: string;
  applicabilityFeatureVersion: number;
  currentApplicabilityFeatureVersion: number;
  nowMs: number;
}

/** The prerequisite digest binds a receipt to the state it certified. */
export function computePrereqDigest(p: {
  preregHash: string;
  policyVersion: string;
  applicabilityFeatureVersion: number;
  shadowEnabled: boolean;
  killSwitchClear: boolean;
  canaryOff: boolean;
}): string {
  return sha16([p.preregHash, p.policyVersion, String(p.applicabilityFeatureVersion), String(p.shadowEnabled), String(p.killSwitchClear), String(p.canaryOff)].join("|"));
}

/** Build the preflight receipt from injected state. Pure + deterministic. */
export function buildPreflightReceipt(input: PreflightInput): CanaryPreflightReceipt {
  const preregHash = sha16(input.preregText);
  const { diagnostics, trials } = joinApplicabilityTrials(input.events, { featureVersion: input.applicabilityFeatureVersion });
  const attributionClean = diagnostics.crossRun === 0 && diagnostics.ambiguous === 0;

  const serialized = JSON.stringify(
    input.events.filter((e) => e.event.startsWith("reasoning.applicability") || e.event === "injection"),
  );
  const privacyClean = !PATH_MARKERS.some((re) => re.test(serialized));

  const killSwitchClear = !input.killEngaged && !input.globalDisabled;
  const versionsCurrent = input.policyVersion === input.currentPolicyVersion && input.applicabilityFeatureVersion === input.currentApplicabilityFeatureVersion;
  const canaryOff = !input.canaryConfig?.enabled;

  const checks: CanaryPreflightChecks = {
    shadowEnabled: input.shadowEnabled,
    canaryOff,
    versionsCurrent,
    attributionClean,
    privacyClean,
    killSwitchClear,
    transportParity: true, // MCP/hook/SDK funnel through one boundary (D.4.1) — build-time invariant.
  };
  const ok = Object.values(checks).every(Boolean);
  const prereqDigest = computePrereqDigest({ preregHash, policyVersion: input.policyVersion, applicabilityFeatureVersion: input.applicabilityFeatureVersion, shadowEnabled: input.shadowEnabled, killSwitchClear, canaryOff });

  return {
    receiptVersion: CANARY_RECEIPT_VERSION,
    issuedAtMs: input.nowMs,
    policyVersion: input.policyVersion,
    applicabilityFeatureVersion: input.applicabilityFeatureVersion,
    preregHash,
    checks,
    ok,
    prereqDigest,
    attribution: { crossRun: diagnostics.crossRun, ambiguous: diagnostics.ambiguous, trials: trials.length },
  };
}

export type ReceiptRefusal =
  | "no_receipt"
  | "malformed_receipt"
  | "checks_failed"
  | "expired"
  | "prerequisites_changed"
  | "wrong_receipt_version";

/**
 * Verify a stored receipt authorizes an enable RIGHT NOW. Refuses on a missing /
 * malformed / failed / expired receipt, or when the live prerequisites no longer
 * match the digest the receipt was bound to (anything changed since issuance).
 */
export function verifyReceiptForEnable(
  receipt: unknown,
  current: { prereqDigest: string; nowMs: number },
): { ok: true; receipt: CanaryPreflightReceipt } | { ok: false; reason: ReceiptRefusal } {
  if (!receipt || typeof receipt !== "object") return { ok: false, reason: "no_receipt" };
  const r = receipt as Partial<CanaryPreflightReceipt>;
  if (r.receiptVersion !== CANARY_RECEIPT_VERSION) return { ok: false, reason: "wrong_receipt_version" };
  if (typeof r.issuedAtMs !== "number" || typeof r.prereqDigest !== "string" || typeof r.ok !== "boolean") return { ok: false, reason: "malformed_receipt" };
  if (!r.ok) return { ok: false, reason: "checks_failed" };
  if (current.nowMs - r.issuedAtMs > RECEIPT_TTL_MS || current.nowMs < r.issuedAtMs) return { ok: false, reason: "expired" };
  if (r.prereqDigest !== current.prereqDigest) return { ok: false, reason: "prerequisites_changed" };
  return { ok: true, receipt: r as CanaryPreflightReceipt };
}

/** Hash the frozen pre-registration text — the operator acks THIS exact value. */
export function preregHashOf(preregText: string): string {
  return sha16(preregText);
}
