/**
 * Phase D.4.2 — the latched, crash-safe canary circuit breaker.
 *
 * Covers: ledger-driven trips (harm / latency), monotonic latch, restart
 * persistence, malformed-state fail-OFF, the reset watermark, the cheap hot-path
 * snapshot, the canary-active ingestion gate, and the resolveCanaryServingState
 * breaker gate (env still wins).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../src/core/block-store.js";
import type { AnalyticsEvent } from "../../src/types.js";
import {
  refreshBreaker,
  resetBreaker,
  readBreakerSnapshot,
  readBreakerState,
  noteCanaryActivityIfActive,
  CANARY_BREAKER_FILE,
} from "../../src/experiments/canary-breaker.js";
import { resolveCanaryServingState, CANARY_POLICY_VERSION } from "../../src/core/config.js";
import type { ApplicabilityCanaryConfig } from "../../src/types.js";

const TS = 1_780_000_000_000;
const FV = 1; // APPLICABILITY_FEATURE_VERSION

// A full canary TREATMENT trial: comparison + exposure + injection + agent_used + outcome.
function treatmentTrial(q: string, r: string, o: { regressed?: boolean; resolved?: boolean; latencyMs?: number }): AnalyticsEvent[] {
  const latencyMs = o.latencyMs ?? 5;
  return [
    { event: "reasoning.applicability_comparison", ts: TS, queryId: q, runId: r, queryHash: "h", corpusSize: 1, candidateCount: 1, v4Action: "abstain", v4TopBlockId: "b", applicabilityTopBlockId: "b", applicabilityProvider: CANARY_POLICY_VERSION, applicabilityFeatureVersion: FV, applicabilityVerdict: "applicable", changedDecision: "reranker_only_apply", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs } as AnalyticsEvent,
    { event: "reasoning.applicability_canary_exposure", ts: TS, queryId: q, runId: r, queryHash: "h", unitHash: "u", arm: "treatment", propensity: 0.05, policyVersion: CANARY_POLICY_VERSION, applicabilityFeatureVersion: FV, blockId: "b", eligibilityReason: "v4_abstain_reranker_applicable", outcomeCompatible: true } as AnalyticsEvent,
    { event: "injection", ts: TS, queryId: q, runId: r, blockId: "b", score: 1, calibratedProb: 1 } as AnalyticsEvent,
    { event: "agent_used", ts: TS, queryId: q, runId: r, blockId: "b", matchSignal: "explicit", matchScore: 1, evidenceStrength: "explicit", evidenceKind: "record_reasoning_outcome" } as AnalyticsEvent,
    { event: "outcome", ts: TS, queryId: q, runId: r, resolved: o.resolved ?? false, control: false, ...(o.regressed ? { regressed: true } : {}) } as AnalyticsEvent,
  ];
}
// A bare slow comparison (no outcome) → an incomplete trial that only contributes latency.
function slowComparison(q: string, latencyMs: number): AnalyticsEvent {
  return { event: "reasoning.applicability_comparison", ts: TS, queryId: q, runId: "r", queryHash: "h", corpusSize: 1, candidateCount: 1, v4Action: "abstain", v4TopBlockId: "b", applicabilityTopBlockId: "b", applicabilityProvider: CANARY_POLICY_VERSION, applicabilityFeatureVersion: FV, applicabilityVerdict: "applicable", changedDecision: "reranker_only_apply", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs } as AnalyticsEvent;
}

describe("canary circuit breaker", () => {
  let basePath: string;
  let store: BlockStore;
  beforeEach(() => {
    basePath = mkdtempSync(join(tmpdir(), "tb-breaker-"));
    mkdirSync(join(basePath, ".tracebase"), { recursive: true });
    store = new BlockStore(new Database(":memory:"));
  });
  afterEach(() => {
    store.close();
    rmSync(basePath, { recursive: true, force: true });
  });
  const seed = (events: AnalyticsEvent[]) => events.forEach((e) => store.appendEvent(e));

  it("absent state → snapshot reports NOT tripped (config gate decides)", () => {
    expect(readBreakerSnapshot(basePath)).toEqual({ tripped: false, reasons: [] });
    expect(readBreakerState(basePath)).toBeNull();
  });

  it("trips on harm (§7.2) derived from the ledger, and latches", () => {
    seed(treatmentTrial("q1", "r1", { regressed: true })); // 1/1 harmful = 100% > 5%
    const s = refreshBreaker(basePath, store, TS + 1000);
    expect(s.tripped).toBe(true);
    expect(s.reasons).toContain("harm_rate_exceeded");
    expect(s.trippedAtMs).toBe(TS + 1000);
    // Snapshot reads the latched state.
    expect(readBreakerSnapshot(basePath).tripped).toBe(true);
  });

  it("trips on rail latency p95 > 50ms (§7.4) with no outcomes", () => {
    for (let i = 0; i < 20; i++) seed([slowComparison(`q${i}`, 80)]);
    const s = refreshBreaker(basePath, store, TS + 1000);
    expect(s.reasons).toContain("latency_regression");
    expect(s.tripped).toBe(true);
  });

  it("LATCHES monotonically: a clean refresh after a trip stays tripped", () => {
    seed(treatmentTrial("q1", "r1", { regressed: true }));
    expect(refreshBreaker(basePath, store, TS + 1000).tripped).toBe(true);
    // New clean store (as if the dirty rows aged out) — latch must hold.
    store.close();
    store = new BlockStore(new Database(":memory:"));
    seed(treatmentTrial("q2", "r2", { resolved: true })); // healthy
    const s = refreshBreaker(basePath, store, TS + 2000);
    expect(s.tripped).toBe(true); // still latched
    expect(s.reasons).toContain("harm_rate_exceeded"); // first-trip cause preserved
  });

  it("survives a restart: the latched state is read fresh from disk", () => {
    seed(treatmentTrial("q1", "r1", { regressed: true }));
    refreshBreaker(basePath, store, TS + 1000);
    // Simulate a process restart — only the file persists.
    expect(readBreakerSnapshot(basePath)).toMatchObject({ tripped: true });
    const reloaded = readBreakerState(basePath);
    expect(reloaded).not.toBeNull();
    expect(reloaded !== "malformed" && reloaded?.tripped).toBe(true);
  });

  it("malformed state FAILS OFF (snapshot tripped) — never serve over a corrupt breaker", () => {
    writeFileSync(join(basePath, ".tracebase", CANARY_BREAKER_FILE), "{ this is not valid json ");
    expect(readBreakerSnapshot(basePath)).toEqual({ tripped: true, reasons: ["malformed_state"] });
    expect(readBreakerState(basePath)).toBe("malformed");
  });

  it("atomic write leaves no .tmp turd and a valid JSON state", () => {
    seed(treatmentTrial("q1", "r1", { regressed: true }));
    refreshBreaker(basePath, store, TS + 1000);
    expect(existsSync(join(basePath, ".tracebase", `${CANARY_BREAKER_FILE}.tmp`))).toBe(false);
    expect(readBreakerState(basePath)).not.toBe("malformed");
  });

  it("reset stamps a watermark so a refresh ignores the pre-reset rows that tripped it", () => {
    seed(treatmentTrial("q1", "r1", { regressed: true }));
    refreshBreaker(basePath, store, TS + 1000);
    expect(readBreakerSnapshot(basePath).tripped).toBe(true);
    // Reviewed reset at a time AFTER the dirty rows' ts.
    const reset = resetBreaker(basePath, TS + 5000);
    expect(reset.tripped).toBe(false);
    expect(reset.resetAtMs).toBe(TS + 5000);
    // A refresh now ignores the pre-reset (TS) rows → stays clean.
    const after = refreshBreaker(basePath, store, TS + 6000);
    expect(after.tripped).toBe(false);
  });

  it("noteCanaryActivityIfActive is a no-op when the breaker file is absent (canary off)", () => {
    seed(treatmentTrial("q1", "r1", { regressed: true })); // dirty rows present...
    noteCanaryActivityIfActive(basePath, store, TS + 1000); // ...but no breaker file yet
    expect(existsSync(join(basePath, ".tracebase", CANARY_BREAKER_FILE))).toBe(false); // still absent → no churn
    // Once a state exists (canary exposed at least once), it DOES refresh.
    refreshBreaker(basePath, store, TS + 1000);
    expect(readBreakerSnapshot(basePath).tripped).toBe(true);
  });
});

describe("resolveCanaryServingState — breaker is a third OFF gate; env still wins", () => {
  const cfg: ApplicabilityCanaryConfig = { enabled: true, rate: 0.05, salt: "s", policyVersion: CANARY_POLICY_VERSION, createdAt: "t", updatedAt: "t" };
  it("a tripped breaker forces OFF with a breaker killReason", () => {
    const s = resolveCanaryServingState(cfg, {}, { tripped: true, reasons: ["harm_rate_exceeded"] });
    expect(s.enabled).toBe(false);
    expect(s.killReason).toBe("breaker_tripped:harm_rate_exceeded");
  });
  it("an untripped breaker leaves an enabled config enabled", () => {
    expect(resolveCanaryServingState(cfg, {}, { tripped: false, reasons: [] }).enabled).toBe(true);
  });
  it("env/global kill WINS over the breaker (its killReason is reported)", () => {
    expect(resolveCanaryServingState(cfg, { TRACEBASE_DISABLED: "1" }, { tripped: true }).killReason).toBe("TRACEBASE_DISABLED=1");
    expect(resolveCanaryServingState(cfg, { TRACEBASE_APPLICABILITY_CANARY: "off" }, { tripped: true }).killReason).toContain("TRACEBASE_APPLICABILITY_CANARY");
  });
});
