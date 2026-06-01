/**
 * Phase D.4.1 — canary preflight receipt + receipt-gated enable. The receipt
 * binds activation to a machine-checkable state; any drift (shadow off, pre-reg
 * edited, version bump, kill engaged, expired) refuses the enable.
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent } from "../../src/types.js";
import {
  buildPreflightReceipt,
  verifyReceiptForEnable,
  preregHashOf,
  RECEIPT_TTL_MS,
  type PreflightInput,
} from "../../src/experiments/canary-preflight.js";

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

describe("buildPreflightReceipt", () => {
  it("is READY when every prerequisite holds", () => {
    const r = buildPreflightReceipt(base());
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual({ shadowEnabled: true, canaryOff: true, versionsCurrent: true, attributionClean: true, privacyClean: true, killSwitchClear: true, transportParity: true });
    expect(r.preregHash).toBe(preregHashOf(PREREG));
  });

  it("FAILS shadow-off, kill-engaged, canary-already-on, stale-version", () => {
    expect(buildPreflightReceipt(base({ shadowEnabled: false })).ok).toBe(false);
    expect(buildPreflightReceipt(base({ killEngaged: true })).ok).toBe(false);
    expect(buildPreflightReceipt(base({ globalDisabled: true })).ok).toBe(false);
    expect(buildPreflightReceipt(base({ canaryConfig: { enabled: true, rate: 0.05, salt: "s", policyVersion: "p", createdAt: "t", updatedAt: "t" } })).ok).toBe(false);
    expect(buildPreflightReceipt(base({ applicabilityFeatureVersion: 0, currentApplicabilityFeatureVersion: 1 })).ok).toBe(false);
  });

  it("FAILS on dirty attribution (cross-run) in the ledger", () => {
    const events: AnalyticsEvent[] = [
      { event: "reasoning.applicability_comparison", ts: 0, queryId: "x", runId: "A", queryHash: "q", corpusSize: 1, candidateCount: 1, v4Action: "inject", v4TopBlockId: "b", applicabilityProvider: "p", applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "none", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1 } as AnalyticsEvent,
      { event: "outcome", ts: 1, queryId: "x", runId: "B", resolved: true, control: false } as AnalyticsEvent,
    ];
    const r = buildPreflightReceipt(base({ events }));
    expect(r.checks.attributionClean).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("FAILS privacy if a local event carries an absolute path", () => {
    const events: AnalyticsEvent[] = [
      { event: "injection", ts: 0, queryId: "x", blockId: "/Users/secret/leak.ts", score: 1, calibratedProb: 1 } as AnalyticsEvent,
    ];
    expect(buildPreflightReceipt(base({ events })).checks.privacyClean).toBe(false);
  });
});

describe("verifyReceiptForEnable", () => {
  const fresh = buildPreflightReceipt(base());
  it("authorizes a fresh, matching receipt", () => {
    const v = verifyReceiptForEnable(fresh, { prereqDigest: fresh.prereqDigest, nowMs: NOW + 1000 });
    expect(v.ok).toBe(true);
  });
  it("refuses: missing / malformed / failed-checks / wrong-version", () => {
    expect(verifyReceiptForEnable(null, { prereqDigest: fresh.prereqDigest, nowMs: NOW })).toMatchObject({ ok: false, reason: "no_receipt" });
    expect(verifyReceiptForEnable({ receiptVersion: 1 }, { prereqDigest: "x", nowMs: NOW })).toMatchObject({ ok: false, reason: "malformed_receipt" });
    expect(verifyReceiptForEnable({ ...fresh, receiptVersion: 99 }, { prereqDigest: fresh.prereqDigest, nowMs: NOW })).toMatchObject({ ok: false, reason: "wrong_receipt_version" });
    const failed = buildPreflightReceipt(base({ shadowEnabled: false }));
    expect(verifyReceiptForEnable(failed, { prereqDigest: failed.prereqDigest, nowMs: NOW })).toMatchObject({ ok: false, reason: "checks_failed" });
  });
  it("refuses an EXPIRED receipt", () => {
    expect(verifyReceiptForEnable(fresh, { prereqDigest: fresh.prereqDigest, nowMs: NOW + RECEIPT_TTL_MS + 1 })).toMatchObject({ ok: false, reason: "expired" });
  });
  it("refuses when a PREREQUISITE changed since issuance (digest mismatch)", () => {
    // e.g. the pre-reg was edited, or shadow turned off → live digest differs.
    const liveDigest = buildPreflightReceipt(base({ preregText: PREREG + " (edited)" })).prereqDigest;
    expect(verifyReceiptForEnable(fresh, { prereqDigest: liveDigest, nowMs: NOW })).toMatchObject({ ok: false, reason: "prerequisites_changed" });
  });
});
