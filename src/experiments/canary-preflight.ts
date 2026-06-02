/**
 * Applicability-canary preflight + activation receipt (Phase D.4.1, hardened D.4.2).
 *
 * Enabling a serving canary must not be a single mutating command. `preflight`
 * runs a machine-checkable readiness audit and emits a LOCAL, bounded RECEIPT
 * (timestamp + prerequisite hashes + check results — never content or secrets).
 * `canary enable` then refuses unless a FRESH, still-valid receipt exists AND the
 * LIVE state re-audits clean AND the operator re-acknowledges policy + pre-reg.
 *
 * ── D.4.2 TOCTOU fix ──────────────────────────────────────────────────────────
 * The v1 digest bound only the STATIC prerequisites (prereg/policy/version/shadow/
 * kill/canary-off) and `enable` checked only `digest match + freshness + stored.ok`.
 * That let a READY receipt survive a NEW cross-run or privacy regression that
 * appeared *after* issuance — the digest was identical and `live.ok` was never
 * consulted, so activation was authorized over a now-dirty ledger. v2 closes both
 * holes: the digest binds EVERY dynamic check and the failure-relevant bounded
 * diagnostics (attribution, privacy, versions, kill, shadow, canary-off, transport
 * attestation), and `verifyReceiptForEnable` requires `stored.ok` AND a matching
 * digest AND freshness AND `live.ok`. Any drift since issuance refuses.
 *
 * Pure + deterministic: the clock and all environment state are injected, so the
 * receipt is reproducible and the verifier has no hidden inputs.
 */
import { createHash } from "node:crypto";
import type { AnalyticsEvent } from "../types.js";
import type { ApplicabilityCanaryConfig } from "../types.js";
import { joinApplicabilityTrials } from "../analytics/applicability-ledger.js";
import { detectLeakageExtended } from "../core/guard.js";
import { CANARY_TRANSPORT_PARITY, isTransportParityAttested } from "./canary-transport-attestation.js";

/** v2: the digest now binds all dynamic checks + bounded diagnostics (D.4.2). */
export const CANARY_RECEIPT_VERSION = 2 as const;
/** A receipt older than this is expired and cannot authorize an enable. */
export const RECEIPT_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const CANARY_RECEIPT_FILE = "canary-preflight-receipt.json";

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export interface CanaryPreflightChecks {
  /** TRACEBASE_REASONING_APPLICABILITY=shadow (the canary needs a reranker verdict). */
  shadowEnabled: boolean;
  /** The canary is currently OFF (you preflight BEFORE enabling). */
  canaryOff: boolean;
  /** Policy + applicability feature versions are the current ones. */
  versionsCurrent: boolean;
  /** Recent ledger attribution is clean: zero cross-run / ambiguous joins. */
  attributionClean: boolean;
  /** No recent local event carries a leak (paths / secrets / env-lines). */
  privacyClean: boolean;
  /** No env / global kill switch is engaged. */
  killSwitchClear: boolean;
  /** The rail is wired through MCP/hook/SDK — BUILD-TIME attestation, not a probe. */
  transportParity: boolean;
}

/** Bounded, content-free diagnostics surfaced to the operator + (most) bound into the digest. */
export interface CanaryReceiptDiagnostics {
  /** Comparison events whose outcome/injection lived under a DIFFERENT runId. */
  crossRun: number;
  /** queryIds with more than one same-run outcome — cannot attribute. */
  ambiguous: number;
  /** Total joined trials. VOLUME — surfaced but deliberately NOT bound into the digest. */
  trials: number;
  /** Matched leakage-pattern NAME (a stable enum label) or null. Content-free. */
  privacyPattern: string | null;
}

export interface CanaryPreflightReceipt {
  receiptVersion: typeof CANARY_RECEIPT_VERSION;
  issuedAtMs: number;
  policyVersion: string;
  applicabilityFeatureVersion: number;
  /** sha256(16) of the frozen pre-registration document text. */
  preregHash: string;
  /** Build-time transport-parity attestation version (honest provenance). */
  transportParityVersion: number;
  checks: CanaryPreflightChecks;
  /** Every check passed → the receipt CAN authorize an enable (still needs freshness + acks + live.ok). */
  ok: boolean;
  /** Binds the receipt to EVERY dynamic check + failure diagnostic it certified. */
  prereqDigest: string;
  diagnostics: CanaryReceiptDiagnostics;
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

/**
 * The readiness digest binds a receipt to the FULL dynamic state it certified —
 * every check plus the failure-relevant bounded diagnostics. Re-derived live at
 * enable time; any drift (a new cross-run, a leak, shadow off, a version bump, the
 * kill switch, the canary already on) changes the digest and refuses activation.
 * `trials` (pure volume) is intentionally excluded so benign shadow activity in the
 * 30-min window doesn't invalidate a healthy receipt — only failure signals do.
 */
export function computeReadinessDigest(r: {
  preregHash: string;
  policyVersion: string;
  applicabilityFeatureVersion: number;
  transportParityVersion: number;
  checks: CanaryPreflightChecks;
  diagnostics: Pick<CanaryReceiptDiagnostics, "crossRun" | "ambiguous" | "privacyPattern">;
}): string {
  const c = r.checks;
  return sha16(
    [
      "v2",
      r.preregHash,
      r.policyVersion,
      String(r.applicabilityFeatureVersion),
      String(r.transportParityVersion),
      // every dynamic check boolean
      String(c.shadowEnabled),
      String(c.canaryOff),
      String(c.versionsCurrent),
      String(c.attributionClean),
      String(c.privacyClean),
      String(c.killSwitchClear),
      String(c.transportParity),
      // failure-relevant bounded diagnostics (NOT trials volume)
      String(r.diagnostics.crossRun),
      String(r.diagnostics.ambiguous),
      r.diagnostics.privacyPattern ?? "none",
    ].join("|"),
  );
}

/** Build the preflight receipt from injected state. Pure + deterministic. */
export function buildPreflightReceipt(input: PreflightInput): CanaryPreflightReceipt {
  const preregHash = sha16(input.preregText);
  const { diagnostics: jd, trials } = joinApplicabilityTrials(input.events, { featureVersion: input.applicabilityFeatureVersion });
  const attributionClean = jd.crossRun === 0 && jd.ambiguous === 0;

  // Privacy audit — reuse the SHARED leakage scanner (abs-paths + API keys + env
  // lines), not a bespoke path regex. Scan only the canary-relevant local events;
  // record the matched pattern NAME (a stable enum, content-free), never any text.
  const serialized = JSON.stringify(
    input.events.filter((e) => e.event.startsWith("reasoning.applicability") || e.event === "injection"),
  );
  const privacyPattern = detectLeakageExtended(serialized);
  const privacyClean = privacyPattern === null;

  const killSwitchClear = !input.killEngaged && !input.globalDisabled;
  const versionsCurrent =
    input.policyVersion === input.currentPolicyVersion &&
    input.applicabilityFeatureVersion === input.currentApplicabilityFeatureVersion;
  const canaryOff = !input.canaryConfig?.enabled;
  const transportParityVersion = CANARY_TRANSPORT_PARITY.version;

  const checks: CanaryPreflightChecks = {
    shadowEnabled: input.shadowEnabled,
    canaryOff,
    versionsCurrent,
    attributionClean,
    privacyClean,
    killSwitchClear,
    transportParity: isTransportParityAttested(transportParityVersion), // build-time attestation
  };
  const ok = Object.values(checks).every(Boolean);
  const diagnostics: CanaryReceiptDiagnostics = { crossRun: jd.crossRun, ambiguous: jd.ambiguous, trials: trials.length, privacyPattern };
  const prereqDigest = computeReadinessDigest({
    preregHash,
    policyVersion: input.policyVersion,
    applicabilityFeatureVersion: input.applicabilityFeatureVersion,
    transportParityVersion,
    checks,
    diagnostics,
  });

  return {
    receiptVersion: CANARY_RECEIPT_VERSION,
    issuedAtMs: input.nowMs,
    policyVersion: input.policyVersion,
    applicabilityFeatureVersion: input.applicabilityFeatureVersion,
    preregHash,
    transportParityVersion,
    checks,
    ok,
    prereqDigest,
    diagnostics,
  };
}

export type ReceiptRefusal =
  | "no_receipt"
  | "malformed_receipt"
  | "wrong_receipt_version"
  | "checks_failed"
  | "expired"
  | "prerequisites_changed"
  | "not_ready";

/**
 * Verify a STORED receipt authorizes an enable RIGHT NOW, against a freshly-built
 * LIVE receipt. Refuses on a missing / malformed / wrong-version / not-READY-at-
 * issuance / expired receipt, when the live readiness digest no longer matches
 * (anything bound changed since issuance), OR when the live state is not currently
 * READY (`live.ok === false`). The last two together are the D.4.2 TOCTOU fix:
 * `stored.ok AND digest-match AND freshness AND live.ok` — all required.
 */
export function verifyReceiptForEnable(
  stored: unknown,
  current: { live: CanaryPreflightReceipt; nowMs: number },
): { ok: true; receipt: CanaryPreflightReceipt } | { ok: false; reason: ReceiptRefusal } {
  if (!stored || typeof stored !== "object") return { ok: false, reason: "no_receipt" };
  const r = stored as Partial<CanaryPreflightReceipt>;
  if (r.receiptVersion !== CANARY_RECEIPT_VERSION) return { ok: false, reason: "wrong_receipt_version" };
  if (typeof r.issuedAtMs !== "number" || typeof r.prereqDigest !== "string" || typeof r.ok !== "boolean") return { ok: false, reason: "malformed_receipt" };
  if (!r.ok) return { ok: false, reason: "checks_failed" }; // the receipt wasn't READY when issued
  if (current.nowMs - r.issuedAtMs > RECEIPT_TTL_MS || current.nowMs < r.issuedAtMs) return { ok: false, reason: "expired" };
  if (r.prereqDigest !== current.live.prereqDigest) return { ok: false, reason: "prerequisites_changed" }; // anything bound drifted
  if (!current.live.ok) return { ok: false, reason: "not_ready" }; // belt-and-suspenders: live state regressed
  return { ok: true, receipt: r as CanaryPreflightReceipt };
}

/** Hash the frozen pre-registration text — the operator acks THIS exact value. */
export function preregHashOf(preregText: string): string {
  return sha16(preregText);
}
