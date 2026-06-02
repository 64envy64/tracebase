/**
 * Phase D.4.1 / D.4.2 — canary preflight receipt + receipt-gated enable.
 *
 * The receipt binds activation to a machine-checkable state; any drift (shadow
 * off, pre-reg edited, version bump, kill engaged, expired) refuses the enable.
 *
 * D.4.2 closes a TOCTOU hole: the v1 digest omitted attribution/privacy and
 * `enable` never required `live.ok`, so a READY receipt could survive a NEW
 * cross-run or privacy regression and still authorize activation. v2 binds EVERY
 * dynamic check + the failure diagnostics into the digest AND requires live.ok.
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent } from "../../src/types.js";
import {
  buildPreflightReceipt,
  verifyReceiptForEnable,
  preregHashOf,
  computeReadinessDigest,
  CANARY_RECEIPT_VERSION,
  RECEIPT_TTL_MS,
  type PreflightInput,
  type CanaryPreflightReceipt,
} from "../../src/experiments/canary-preflight.js";
import { CANARY_TRANSPORT_PARITY } from "../../src/experiments/canary-transport-attestation.js";

const NOW = 1_780_000_000_000;
const PREREG = "FROZEN pre-registration v1 — apply-only canary, max 5% …";
const base = (o: Partial<PreflightInput> = {}): PreflightInput => ({
  preregText: PREREG,
  events: [],
  canaryConfig: null, // off
  shadowEnabled: true,
  killEngaged: false,
  globalDisabled: false,
  policyVersion: "deterministic-applicability.v1",
  currentPolicyVersion: "deterministic-applicability.v1",
  applicabilityFeatureVersion: 1,
  currentApplicabilityFeatureVersion: 1,
  nowMs: NOW,
  ...o,
});

// A cross-run dirtier: a comparison under runId A with its outcome under runId B.
const crossRunEvents = (): AnalyticsEvent[] => [
  { event: "reasoning.applicability_comparison", ts: 0, queryId: "x", runId: "A", queryHash: "q", corpusSize: 1, candidateCount: 1, v4Action: "inject", v4TopBlockId: "b", applicabilityProvider: "p", applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "none", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1 } as AnalyticsEvent,
  { event: "outcome", ts: 1, queryId: "x", runId: "B", resolved: true, control: false } as AnalyticsEvent,
];
// A privacy dirtier: an injection event whose blockId carries an absolute path.
const secretEvents = (): AnalyticsEvent[] => [
  { event: "injection", ts: 0, queryId: "x", blockId: "/Users/secret/leak.ts", score: 1, calibratedProb: 1 } as AnalyticsEvent,
];

describe("buildPreflightReceipt (v2)", () => {
  it("is READY when every prerequisite holds; stamps version + attestation", () => {
    const r = buildPreflightReceipt(base());
    expect(r.ok).toBe(true);
    expect(r.receiptVersion).toBe(CANARY_RECEIPT_VERSION);
    expect(r.transportParityVersion).toBe(CANARY_TRANSPORT_PARITY.version);
    expect(r.checks).toEqual({ shadowEnabled: true, canaryOff: true, versionsCurrent: true, attributionClean: true, privacyClean: true, killSwitchClear: true, transportParity: true });
    expect(r.preregHash).toBe(preregHashOf(PREREG));
    expect(r.diagnostics).toEqual({ crossRun: 0, ambiguous: 0, trials: 0, privacyPattern: null });
  });

  it("FAILS shadow-off, kill-engaged, canary-already-on, stale-version", () => {
    expect(buildPreflightReceipt(base({ shadowEnabled: false })).ok).toBe(false);
    expect(buildPreflightReceipt(base({ killEngaged: true })).ok).toBe(false);
    expect(buildPreflightReceipt(base({ globalDisabled: true })).ok).toBe(false);
    expect(buildPreflightReceipt(base({ canaryConfig: { enabled: true, rate: 0.05, salt: "s", policyVersion: "p", createdAt: "t", updatedAt: "t" } })).ok).toBe(false);
    expect(buildPreflightReceipt(base({ applicabilityFeatureVersion: 0, currentApplicabilityFeatureVersion: 1 })).ok).toBe(false);
  });

  it("FAILS on dirty attribution (cross-run) and records the bounded diagnostic", () => {
    const r = buildPreflightReceipt(base({ events: crossRunEvents() }));
    expect(r.checks.attributionClean).toBe(false);
    expect(r.diagnostics.crossRun).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
  });

  it("FAILS privacy via the SHARED leakage scanner and records the pattern NAME (content-free)", () => {
    const r = buildPreflightReceipt(base({ events: secretEvents() }));
    expect(r.checks.privacyClean).toBe(false);
    expect(r.diagnostics.privacyPattern).toBe("abs-path-posix"); // a stable enum label, never the path text
    expect(JSON.stringify(r)).not.toContain("/Users/secret/leak.ts"); // receipt stays content-free
  });

  it("the digest BINDS attribution + privacy (the D.4.2 fix): a dirty live state ⇒ different digest", () => {
    const clean = buildPreflightReceipt(base());
    const dirtyAttr = buildPreflightReceipt(base({ events: crossRunEvents() }));
    const dirtyPriv = buildPreflightReceipt(base({ events: secretEvents() }));
    expect(dirtyAttr.prereqDigest).not.toBe(clean.prereqDigest);
    expect(dirtyPriv.prereqDigest).not.toBe(clean.prereqDigest);
  });

  it("trials VOLUME does not move the digest (benign shadow activity ≠ drift)", () => {
    // A clean abstain+apply comparison (same run) is a counterfactual trial: trials
    // goes up, crossRun/ambiguous stay 0 → the digest is unchanged.
    const benign: AnalyticsEvent[] = [
      { event: "reasoning.applicability_comparison", ts: 0, queryId: "y", runId: "R", queryHash: "q", corpusSize: 1, candidateCount: 1, v4Action: "abstain", v4TopBlockId: "b", applicabilityTopBlockId: "b", applicabilityProvider: "p", applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "reranker_only_apply", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1 } as AnalyticsEvent,
    ];
    const a = buildPreflightReceipt(base());
    const b = buildPreflightReceipt(base({ events: benign }));
    expect(b.diagnostics.trials).toBeGreaterThanOrEqual(a.diagnostics.trials);
    expect(b.prereqDigest).toBe(a.prereqDigest); // volume excluded from the binding
  });
});

describe("verifyReceiptForEnable (v2 — requires stored.ok AND live.ok AND digest AND freshness)", () => {
  const fresh = buildPreflightReceipt(base());
  const liveOk = buildPreflightReceipt(base()); // same inputs ⇒ identical digest + ok

  it("authorizes a fresh, matching receipt against a clean live re-audit", () => {
    expect(verifyReceiptForEnable(fresh, { live: liveOk, nowMs: NOW + 1000 }).ok).toBe(true);
  });

  it("refuses: missing / malformed / wrong-version / failed-checks", () => {
    expect(verifyReceiptForEnable(null, { live: liveOk, nowMs: NOW })).toMatchObject({ ok: false, reason: "no_receipt" });
    expect(verifyReceiptForEnable({ receiptVersion: CANARY_RECEIPT_VERSION }, { live: liveOk, nowMs: NOW })).toMatchObject({ ok: false, reason: "malformed_receipt" });
    expect(verifyReceiptForEnable({ ...fresh, receiptVersion: 99 }, { live: liveOk, nowMs: NOW })).toMatchObject({ ok: false, reason: "wrong_receipt_version" });
    const failed = buildPreflightReceipt(base({ shadowEnabled: false }));
    expect(verifyReceiptForEnable(failed, { live: liveOk, nowMs: NOW })).toMatchObject({ ok: false, reason: "checks_failed" });
  });

  it("refuses an EXPIRED receipt", () => {
    expect(verifyReceiptForEnable(fresh, { live: liveOk, nowMs: NOW + RECEIPT_TTL_MS + 1 })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses when a STATIC prerequisite changed since issuance (pre-reg edited)", () => {
    const live = buildPreflightReceipt(base({ preregText: PREREG + " (edited)" }));
    expect(verifyReceiptForEnable(fresh, { live, nowMs: NOW })).toMatchObject({ ok: false, reason: "prerequisites_changed" });
  });

  // ── Adversarial TOCTOU: the exact bug the D.4.2 audit flagged ──
  it("TOCTOU: a cross-run appearing AFTER a READY receipt refuses the enable (v1 would have authorized)", () => {
    const stored = buildPreflightReceipt(base()); // READY, ok=true, clean ledger
    const live = buildPreflightReceipt(base({ events: crossRunEvents() })); // ledger went dirty since
    expect(stored.ok).toBe(true);
    expect(live.ok).toBe(false);
    const v = verifyReceiptForEnable(stored, { live, nowMs: NOW + 1000 });
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ reason: "prerequisites_changed" }); // digest now binds attribution
  });

  it("TOCTOU: a secret appearing AFTER a READY receipt refuses the enable", () => {
    const stored = buildPreflightReceipt(base());
    const live = buildPreflightReceipt(base({ events: secretEvents() }));
    expect(stored.ok).toBe(true);
    expect(live.ok).toBe(false);
    expect(verifyReceiptForEnable(stored, { live, nowMs: NOW + 1000 })).toMatchObject({ ok: false, reason: "prerequisites_changed" });
  });

  it("defense-in-depth: an explicit live.ok=false refuses even if a digest somehow matches", () => {
    // Synthetic — the digest binding makes this unreachable through honest builds
    // (a false check changes the digest), but the explicit live.ok gate guards a
    // future digest that stops binding some check. Forge equal digests + live.ok=false.
    const digest = computeReadinessDigest({
      preregHash: "h", policyVersion: "p", applicabilityFeatureVersion: 1, transportParityVersion: CANARY_TRANSPORT_PARITY.version,
      checks: { shadowEnabled: true, canaryOff: true, versionsCurrent: true, attributionClean: true, privacyClean: true, killSwitchClear: true, transportParity: true },
      diagnostics: { crossRun: 0, ambiguous: 0, privacyPattern: null },
    });
    const stored = { ...fresh, ok: true, prereqDigest: digest } as CanaryPreflightReceipt;
    const live = { ...fresh, ok: false, prereqDigest: digest } as CanaryPreflightReceipt;
    expect(verifyReceiptForEnable(stored, { live, nowMs: NOW + 1000 })).toMatchObject({ ok: false, reason: "not_ready" });
  });
});
