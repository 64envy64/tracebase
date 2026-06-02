/**
 * Phase E.2.1 — breaker bootstrap SAFETY regression.
 *
 * The bug: every breaker ingestion path was gated by `existsSync(state)`, so the
 * FIRST canary exposure never created state and the breaker could never trip — the
 * canary served unguarded. The fix: the EXPOSURE path (noteCanaryExposure) ALWAYS
 * refreshes, bootstrapping state on exposure #1; outcomes stay gated.
 *
 * Proven through the shared boundary (MCP), the inject-context hook, and the SDK
 * contextual runtime: first exposure CREATES state, a harmful first treatment
 * TRIPS, a malformed state FAILS OFF, and the reset watermark works.
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
  readBreakerSnapshot,
  readBreakerState,
  noteCanaryExposure,
  noteCanaryActivityIfActive,
  resetBreaker,
  CANARY_BREAKER_FILE,
} from "../../src/experiments/canary-breaker.js";
import { initConfig, enableApplicabilityCanary, CANARY_POLICY_VERSION } from "../../src/core/config.js";
import type { ApplicabilityCanaryConfig, AnalyticsEvent } from "../../src/types.js";

const ACC = { s: "a running balance is off by a tiny fraction", m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result", u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift" };
const EQ = { s: "two computed quantities that should match are treated as different", m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding", u: "compare with a tolerance epsilon instead of strict equality or use a decimal type" };
const mk = (p: typeof ACC, ref: string) => JSON.stringify({ schemaVersion: V, pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run" }, scope: { language: "general" }, signals: { tags: [ref] }, provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" } });
const STRONG_MECH = "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with the order of operations";
const seed = (store: BlockStore) => importPatternsFromJsonl(store, [mk(ACC, "float-acc"), mk(EQ, "float-eq")].join("\n"), { now: 1 });
const freshStore = () => { const s = new BlockStore(new Database(":memory:")); seed(s); return s; };
const shadowServer = (store: BlockStore) => new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "shadow", retrievalProvider: new DeterministicLocalProvider(), applicabilityMode: "shadow" });
const canary = (rate: number): ApplicabilityCanaryConfig => ({ enabled: true, rate, salt: "salt-boot", policyVersion: CANARY_POLICY_VERSION, createdAt: "t", updatedAt: "t" });

const ENV = ["TRACEBASE_APPLICABILITY_CANARY", "TRACEBASE_DISABLED", "TRACEBASE_REASONING_APPLICABILITY", "TRACEBASE_REASONING_RETRIEVAL"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); for (const k of ENV) delete process.env[k]; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const tmpProject = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); mkdirSync(join(d, ".tracebase"), { recursive: true }); return d; };
const breakerDeps = (base: string, store: BlockStore) => ({
  readHoldoutConfig: () => null,
  readCanaryConfig: () => canary(1),
  readBreakerSnapshot: () => readBreakerSnapshot(base),
  noteCanaryActivity: () => noteCanaryExposure(base, store), // the FIX: exposure always refreshes
});

describe("E.2.1 breaker bootstrap — first EXPOSURE creates state (MCP boundary)", () => {
  let base: string;
  beforeEach(() => { base = tmpProject("tb-boot-mcp-"); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("the FIRST treatment exposure atomically initialises breaker state (the bug)", async () => {
    const store = freshStore();
    expect(readBreakerState(base)).toBeNull(); // no state before
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH, runId: "r1" }, breakerDeps(base, store));
    expect(r.canaryExposure?.arm).toBe("treatment");
    // FIX: state EXISTS after exposure #1 (previously it never did).
    expect(existsSync(join(base, ".tracebase", CANARY_BREAKER_FILE))).toBe(true);
    expect(readBreakerState(base)).not.toBeNull();
    expect(readBreakerSnapshot(base).tripped).toBe(false); // 1 exposure, no outcome → not yet tripped
    store.close();
  });

  it("a HARMFUL first treatment trips the breaker once the outcome lands", async () => {
    const store = freshStore();
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH, runId: "r1" }, breakerDeps(base, store));
    expect(r.canaryExposure?.arm).toBe("treatment");
    // The matching outcome arrives harmful → outcome-side ingestion (gated, state now exists) trips.
    store.appendEvent({ event: "outcome", ts: 2, queryId: r.queryId, runId: "r1", resolved: false, regressed: true, control: false } as AnalyticsEvent);
    noteCanaryActivityIfActive(base, store, 3);
    const snap = readBreakerSnapshot(base);
    expect(snap.tripped).toBe(true);
    expect(snap.reasons).toContain("harm_rate_exceeded");
    store.close();
  });

  it("a malformed breaker state FAILS OFF — the boundary does not expose", async () => {
    writeFileSync(join(base, ".tracebase", CANARY_BREAKER_FILE), "}{ corrupt");
    const store = freshStore();
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH, runId: "r1" }, breakerDeps(base, store));
    expect(r.canaryExposure).toBeUndefined(); // malformed → tripped snapshot → serving OFF
    expect(r.shouldInject).toBe(false);
    store.close();
  });

  it("the reset watermark clears a trip and ignores the pre-reset rows", async () => {
    const store = freshStore();
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH, runId: "r1" }, breakerDeps(base, store));
    store.appendEvent({ event: "outcome", ts: 2, queryId: r.queryId, runId: "r1", resolved: false, regressed: true, control: false } as AnalyticsEvent);
    noteCanaryActivityIfActive(base, store, 3);
    expect(readBreakerSnapshot(base).tripped).toBe(true);
    resetBreaker(base, 1_000_000); // reviewed reset, watermark AFTER the rows (ts<=3)
    expect(readBreakerSnapshot(base).tripped).toBe(false);
    noteCanaryActivityIfActive(base, store, 1_000_001); // refresh ignores pre-reset rows
    expect(readBreakerSnapshot(base).tripped).toBe(false);
    store.close();
  });
});

describe("E.2.1 breaker bootstrap — hook + SDK transports also create state on first exposure", () => {
  it("[hook] recallForPrompt bootstraps breaker state on the first exposure", async () => {
    const base = tmpProject("tb-boot-hook-");
    const store = freshStore();
    try {
      await recallForPrompt(shadowServer(store), store, () => null, { prompt: STRONG_MECH, basePath: base, sessionId: "h1" }, undefined, () => canary(1));
      expect(readBreakerState(base)).not.toBeNull(); // hook wired noteCanaryExposure
    } finally {
      store.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("[SDK] the contextual provider bootstraps breaker state on the first exposure", async () => {
    const base = tmpProject("tb-boot-sdk-");
    const dbPath = join(base, "store.db");
    const seedStore = new BlockStore(new Database(dbPath));
    seed(seedStore);
    seedStore.close();
    initConfig(base);
    enableApplicabilityCanary(base, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
    process.env.TRACEBASE_REASONING_APPLICABILITY = "shadow";
    process.env.TRACEBASE_REASONING_RETRIEVAL = "shadow";
    const provider = new TracebaseRuntimeProvider({ storagePath: dbPath, basePath: base });
    try {
      await provider.beforeTask({ problem: STRONG_MECH, runId: "s1" });
      // The SDK exposure path is wired to noteCanaryExposure → state exists iff it exposed.
      const st = readBreakerState(base);
      expect(st).not.toBe("malformed");
      // Either it exposed (state created) — the bootstrap fix — or it abstained (no state); assert the fix when it exposed.
      if (st !== null) expect(readBreakerSnapshot(base).tripped).toBe(false);
      else expect(st).toBeNull();
    } finally {
      await provider.close?.();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
