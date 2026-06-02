/**
 * Phase D.4.2 — the `$0` breaker + receipt-TOCTOU SIMULATION matrix.
 *
 * Dependency-free (no model, network, or paid agent) end-to-end proof that the
 * circuit breaker + hardened receipt behave correctly across every axis the audit
 * named. Each `it` is one row; the vitest output reads as the matrix:
 *
 *   receipt TOCTOU     cross-run / secret appearing AFTER a READY receipt refuses
 *   breaker rules      harm / latency / attribution / privacy trip from the ledger
 *   hot-path gate      a tripped breaker forces serving OFF at the shared boundary
 *   transport parity   the gate engages identically through MCP / hook / SDK
 *   restart            the latch survives a "process restart" (disk only)
 *   malformed          a corrupt breaker state FAILS OFF
 *   privacy            the breaker state is dropped WHOLE by the cloud allowlist
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import { recallForPrompt } from "../../src/runtime/recall.js";
import { TracebaseRuntimeProvider } from "../../src/sdk/contextual-runtime-provider.js";
import {
  refreshBreaker,
  readBreakerSnapshot,
  readBreakerState,
  CANARY_BREAKER_FILE,
} from "../../src/experiments/canary-breaker.js";
import { buildPreflightReceipt, verifyReceiptForEnable, type PreflightInput } from "../../src/experiments/canary-preflight.js";
import { initConfig, enableApplicabilityCanary, CANARY_POLICY_VERSION } from "../../src/core/config.js";
import { sanitizeForCloud } from "../../src/cli/cloud-allowlist.js";
import { detectLeakageExtended } from "../../src/core/guard.js";
import type { ApplicabilityCanaryConfig, AnalyticsEvent } from "../../src/types.js";

const TS = 1_780_000_000_000;
const ACC = { s: "a running balance is off by a tiny fraction", m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result", u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift" };
const EQ = { s: "two computed quantities that should match are treated as different", m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding", u: "compare with a tolerance epsilon instead of strict equality or use a decimal type" };
const mk = (p: typeof ACC, ref: string) => JSON.stringify({ schemaVersion: V, pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run" }, scope: { language: "general" }, signals: { tags: [ref] }, provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" } });
const STRONG_MECH = "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with the order of operations";
const seedCorpus = (store: BlockStore) => importPatternsFromJsonl(store, [mk(ACC, "float-acc"), mk(EQ, "float-eq")].join("\n"), { now: 1 }).results[0]!.blockId!;
const shadowServer = (store: BlockStore) => new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "shadow", retrievalProvider: new DeterministicLocalProvider(), applicabilityMode: "shadow" });
const canary = (rate: number): ApplicabilityCanaryConfig => ({ enabled: true, rate, salt: "salt-sim", policyVersion: CANARY_POLICY_VERSION, createdAt: "t", updatedAt: "t" });
const exposures = (store: BlockStore) => store.readEvents({}).filter((e) => e.event === "reasoning.applicability_canary_exposure");

// A harmful treatment trial — enough to trip §7.2 (harm rate 100% > 5%).
function harmfulTrial(q: string): AnalyticsEvent[] {
  return [
    { event: "reasoning.applicability_comparison", ts: TS, queryId: q, runId: "r", queryHash: "h", corpusSize: 1, candidateCount: 1, v4Action: "abstain", v4TopBlockId: "b", applicabilityTopBlockId: "b", applicabilityProvider: CANARY_POLICY_VERSION, applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "reranker_only_apply", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 5 } as AnalyticsEvent,
    { event: "reasoning.applicability_canary_exposure", ts: TS, queryId: q, runId: "r", queryHash: "h", unitHash: "u", arm: "treatment", propensity: 0.05, policyVersion: CANARY_POLICY_VERSION, applicabilityFeatureVersion: 1, blockId: "b", eligibilityReason: "v4_abstain_reranker_applicable", outcomeCompatible: true } as AnalyticsEvent,
    { event: "injection", ts: TS, queryId: q, runId: "r", blockId: "b", score: 1, calibratedProb: 1 } as AnalyticsEvent,
    { event: "outcome", ts: TS, queryId: q, runId: "r", resolved: false, regressed: true, control: false } as AnalyticsEvent,
  ];
}
/** Trip the breaker for `basePath` from a throwaway ledger with a harmful trial. */
function tripBreakerAt(basePath: string): void {
  const s = new BlockStore(new Database(":memory:"));
  harmfulTrial("q").forEach((e) => s.appendEvent(e));
  refreshBreaker(basePath, s, TS + 1000);
  s.close();
}
function tmpProject(prefix: string): string {
  const p = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(p, ".tracebase"), { recursive: true });
  return p;
}

const ENV_KEYS = ["TRACEBASE_APPLICABILITY_CANARY", "TRACEBASE_DISABLED", "TRACEBASE_REASONING_APPLICABILITY", "TRACEBASE_REASONING_RETRIEVAL"] as const;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => { savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

describe("phase-d.4.2 breaker + receipt $0 simulation matrix", () => {
  // ── receipt TOCTOU ──
  it("[receipt:toctou-crossrun] a cross-run appearing AFTER a READY receipt refuses the enable", () => {
    const pf = (events: AnalyticsEvent[]): PreflightInput => ({ preregText: "prereg", events, canaryConfig: null, shadowEnabled: true, killEngaged: false, globalDisabled: false, policyVersion: CANARY_POLICY_VERSION, currentPolicyVersion: CANARY_POLICY_VERSION, applicabilityFeatureVersion: 1, currentApplicabilityFeatureVersion: 1, nowMs: TS });
    const stored = buildPreflightReceipt(pf([]));
    const live = buildPreflightReceipt(pf([
      { event: "reasoning.applicability_comparison", ts: 0, queryId: "x", runId: "A", queryHash: "q", corpusSize: 1, candidateCount: 1, v4Action: "inject", v4TopBlockId: "b", applicabilityProvider: "p", applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "none", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 1 } as AnalyticsEvent,
      { event: "outcome", ts: 1, queryId: "x", runId: "B", resolved: true, control: false } as AnalyticsEvent,
    ]));
    expect(stored.ok).toBe(true);
    expect(live.ok).toBe(false);
    expect(verifyReceiptForEnable(stored, { live, nowMs: TS + 1000 })).toMatchObject({ ok: false });
  });

  it("[receipt:toctou-secret] a secret appearing AFTER a READY receipt refuses the enable", () => {
    const pf = (events: AnalyticsEvent[]): PreflightInput => ({ preregText: "prereg", events, canaryConfig: null, shadowEnabled: true, killEngaged: false, globalDisabled: false, policyVersion: CANARY_POLICY_VERSION, currentPolicyVersion: CANARY_POLICY_VERSION, applicabilityFeatureVersion: 1, currentApplicabilityFeatureVersion: 1, nowMs: TS });
    const stored = buildPreflightReceipt(pf([]));
    const live = buildPreflightReceipt(pf([{ event: "injection", ts: 0, queryId: "x", blockId: "/Users/secret/leak.ts", score: 1, calibratedProb: 1 } as AnalyticsEvent]));
    expect(verifyReceiptForEnable(stored, { live, nowMs: TS + 1000 })).toMatchObject({ ok: false });
  });

  // ── breaker rules from the ledger ──
  it("[breaker:rule-harm] a harmful treatment outcome trips the breaker (§7.2)", () => {
    const base = tmpProject("tb-sim-harm-");
    tripBreakerAt(base);
    expect(readBreakerSnapshot(base)).toMatchObject({ tripped: true });
    expect(readBreakerSnapshot(base).reasons).toContain("harm_rate_exceeded");
    rmSync(base, { recursive: true, force: true });
  });

  it("[breaker:rule-latency] rail p95 > 50ms trips (§7.4)", () => {
    const base = tmpProject("tb-sim-lat-");
    const s = new BlockStore(new Database(":memory:"));
    for (let i = 0; i < 20; i++) s.appendEvent({ event: "reasoning.applicability_comparison", ts: TS, queryId: `q${i}`, runId: "r", queryHash: "h", corpusSize: 1, candidateCount: 1, v4Action: "abstain", v4TopBlockId: "b", applicabilityTopBlockId: "b", applicabilityProvider: CANARY_POLICY_VERSION, applicabilityFeatureVersion: 1, applicabilityVerdict: "applicable", changedDecision: "reranker_only_apply", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 90 } as AnalyticsEvent);
    refreshBreaker(base, s, TS + 1000);
    s.close();
    expect(readBreakerSnapshot(base).reasons).toContain("latency_regression");
    rmSync(base, { recursive: true, force: true });
  });

  // ── hot-path gate at the shared boundary (the MCP transport path) ──
  it("[breaker:gate-MCP] a tripped breaker forces serving OFF at the boundary (and clear ⇒ exposes)", async () => {
    const base = tmpProject("tb-sim-gate-");
    // Control: clear breaker → eligible treatment exposes.
    const s1 = new BlockStore(new Database(":memory:"));
    const accId = seedCorpus(s1);
    const clear = await runReasoningPatternsRecall(shadowServer(s1), { problem: STRONG_MECH, runId: "c" }, { readHoldoutConfig: () => null, readCanaryConfig: () => canary(1), readBreakerSnapshot: () => readBreakerSnapshot(base) });
    expect(clear.canaryExposure?.arm).toBe("treatment");
    expect(clear.blocks.find((h) => h.passesGate)?.block.id).toBe(accId);
    s1.close();
    // Trip the breaker, then the SAME eligible query no longer exposes.
    tripBreakerAt(base);
    const s2 = new BlockStore(new Database(":memory:"));
    seedCorpus(s2);
    const tripped = await runReasoningPatternsRecall(shadowServer(s2), { problem: STRONG_MECH, runId: "t" }, { readHoldoutConfig: () => null, readCanaryConfig: () => canary(1), readBreakerSnapshot: () => readBreakerSnapshot(base) });
    expect(tripped.canaryExposure).toBeUndefined();
    expect(tripped.shouldInject).toBe(false);
    expect(exposures(s2).length).toBe(0);
    s2.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("[breaker:gate-hook] recallForPrompt reads the breaker from basePath → tripped ⇒ no exposure", async () => {
    const base = tmpProject("tb-sim-hook-");
    tripBreakerAt(base);
    const store = new BlockStore(new Database(":memory:"));
    seedCorpus(store);
    await recallForPrompt(shadowServer(store), store, () => null, { prompt: STRONG_MECH, basePath: base, sessionId: "h" }, undefined, () => canary(1));
    expect(exposures(store).length).toBe(0); // breaker gate held
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("[breaker:gate-SDK] the contextual provider honours the tripped breaker", async () => {
    const base = tmpProject("tb-sim-sdk-");
    const dbPath = join(base, "store.db");
    const seedStore = new BlockStore(new Database(dbPath));
    seedCorpus(seedStore);
    seedStore.close();
    initConfig(base);
    enableApplicabilityCanary(base, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    tripBreakerAt(base);
    process.env.TRACEBASE_REASONING_APPLICABILITY = "shadow";
    process.env.TRACEBASE_REASONING_RETRIEVAL = "shadow";
    const provider = new TracebaseRuntimeProvider({ storagePath: dbPath, basePath: base });
    try {
      await provider.beforeTask({ problem: STRONG_MECH, runId: "s" });
      const ro = new BlockStore(new Database(dbPath, { readonly: true }));
      expect(exposures(ro).length).toBe(0); // tripped breaker ⇒ no exposure on the SDK transport
      ro.close();
    } finally {
      await provider.close?.();
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ── restart / malformed / privacy ──
  it("[breaker:restart] the latch survives a process restart (disk only)", () => {
    const base = tmpProject("tb-sim-restart-");
    tripBreakerAt(base);
    // A fresh read (new "process") sees the latched state.
    expect(readBreakerSnapshot(base).tripped).toBe(true);
    const st = readBreakerState(base);
    expect(st !== "malformed" && st?.tripped).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it("[breaker:malformed] a corrupt breaker state FAILS OFF (snapshot tripped)", async () => {
    const base = tmpProject("tb-sim-mal-");
    writeFileSync(join(base, ".tracebase", CANARY_BREAKER_FILE), "}{ corrupt");
    expect(readBreakerSnapshot(base)).toEqual({ tripped: true, reasons: ["malformed_state"] });
    // And the boundary refuses to serve over it.
    const store = new BlockStore(new Database(":memory:"));
    seedCorpus(store);
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH }, { readHoldoutConfig: () => null, readCanaryConfig: () => canary(1), readBreakerSnapshot: () => readBreakerSnapshot(base) });
    expect(r.canaryExposure).toBeUndefined();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("[cloud-strip] the persisted breaker state is content-free and dropped WHOLE by the cloud allowlist", () => {
    const base = tmpProject("tb-sim-cloud-");
    tripBreakerAt(base);
    const state = readBreakerState(base);
    expect(state).not.toBe("malformed");
    expect(state).not.toBeNull();
    const blob = JSON.stringify(state);
    expect(detectLeakageExtended(blob)).toBeNull(); // no path/secret/env-line in the state
    expect(Object.keys(sanitizeForCloud(state as object)).length).toBe(0); // no allowlisted key survives
    rmSync(base, { recursive: true, force: true });
  });
});
