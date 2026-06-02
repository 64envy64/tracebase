/**
 * Phase D.4.1 — the `$0` applicability-canary SMOKE MATRIX.
 *
 * One consolidated, dependency-free (no model, no network, no paid agent) record
 * that the canary rail is safe across EVERY axis the pre-registration cares about.
 * Each `it` is one matrix row; the vitest output reads as the matrix itself:
 *
 *   transport      MCP · inject-context hook · SDK contextual runtime
 *   disabled       byte-identical on all three transports
 *   arms           eligible treatment injects · eligible control abstains
 *   precedence     a holdout-cohort unit is never exposed
 *   kill switches  env disable + TRACEBASE_DISABLED force byte-identical
 *   rate cap       enable rejects > 5% (never clamps); a persisted > 5% collapses off
 *   receipt gate   missing / expired receipt refuses the enable
 *   privacy        an exposure event is dropped WHOLE by the cloud allowlist
 *
 * The three transports are driven through their REAL entrypoints
 * (`runReasoningPatternsRecall`, `recallForPrompt`, `TracebaseRuntimeProvider`) so
 * this also proves they funnel through the one shared boundary (D.4.1) rather than
 * re-deriving eligibility.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
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
  initConfig,
  enableApplicabilityCanary,
  readApplicabilityCanaryConfig,
  resolveCanaryServingState,
  CANARY_POLICY_VERSION,
  MAX_CANARY_RATE,
} from "../../src/core/config.js";
import { buildPreflightReceipt, verifyReceiptForEnable, RECEIPT_TTL_MS, type PreflightInput } from "../../src/experiments/canary-preflight.js";
import { sanitizeForCloud } from "../../src/cli/cloud-allowlist.js";
import { writeFileSync, readFileSync } from "node:fs";
import type { ApplicabilityCanaryConfig, HoldoutConfig, AnalyticsEvent } from "../../src/types.js";

// --- shared corpus: a strong mechanism-only prose query → V4 abstains, the D.2
//     reranker rules `applicable` (the exact residual the canary makes observable).
const ACC = { s: "a running balance is off by a tiny fraction", m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result", u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift" };
const EQ = { s: "two computed quantities that should match are treated as different", m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding", u: "compare with a tolerance epsilon instead of strict equality or use a decimal type" };
const mk = (p: typeof ACC, ref: string) => JSON.stringify({ schemaVersion: V, pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run" }, scope: { language: "general" }, signals: { tags: [ref] }, provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" } });
const STRONG_MECH = "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with the order of operations";

function seed(store: BlockStore): string {
  return importPatternsFromJsonl(store, [mk(ACC, "float-acc"), mk(EQ, "float-eq")].join("\n"), { now: 1 }).results[0]!.blockId!;
}
function freshStore(): { store: BlockStore; accId: string } {
  const store = new BlockStore(new Database(":memory:"));
  return { store, accId: seed(store) };
}
const shadowServer = (store: BlockStore) => new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "shadow", retrievalProvider: new DeterministicLocalProvider(), applicabilityMode: "shadow" });
const canary = (rate: number): ApplicabilityCanaryConfig => ({ enabled: true, rate, salt: "salt-smoke", policyVersion: CANARY_POLICY_VERSION, createdAt: "t", updatedAt: "t" });
const heldOut: HoldoutConfig = { enabled: true, rate: 1, salt: "h-smoke", createdAt: "t", updatedAt: "t" };
const exposures = (store: BlockStore) => store.readEvents({}).filter((e) => e.event === "reasoning.applicability_canary_exposure");
const injections = (store: BlockStore) => store.readEvents({}).filter((e) => e.event === "injection");

// Env knobs touched by the kill-switch + SDK rows — snapshot + restore so rows are hermetic.
const ENV_KEYS = ["TRACEBASE_APPLICABILITY_CANARY", "TRACEBASE_DISABLED", "TRACEBASE_REASONING_APPLICABILITY", "TRACEBASE_REASONING_RETRIEVAL"] as const;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => { savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

describe("phase-d.4.1 canary $0 smoke matrix", () => {
  // ---- transport coverage: every entrypoint funnels through the one boundary ----
  it("[transport:MCP] enabled + eligible + treatment injects the reranker block + emits exposure", async () => {
    const { store, accId } = freshStore();
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH, runId: "mcp" }, { readHoldoutConfig: () => null, readCanaryConfig: () => canary(1), admitCanaryTreatment: () => true });
    expect(r.canaryExposure?.arm).toBe("treatment");
    expect(r.shouldInject).toBe(true);
    expect(r.blocks.find((h) => h.passesGate)?.block.id).toBe(accId);
    expect(exposures(store).length).toBe(1);
    expect(injections(store).filter((e) => (e as { blockId: string }).blockId === accId).length).toBe(1);
    store.close();
  });

  it("[transport:hook] recallForPrompt threads the identical loader → run-scoped exposure", async () => {
    const { store } = freshStore();
    const basePath = mkdtempSync(join(tmpdir(), "tb-smoke-hook-"));
    try {
      await recallForPrompt(shadowServer(store), store, () => null, { prompt: STRONG_MECH, basePath, sessionId: "hookRun" }, undefined, () => canary(1));
      const exp = exposures(store) as Array<{ runId?: string; arm: string }>;
      expect(exp.length).toBe(1);
      expect(exp[0]!.arm).toBe("treatment");
      expect(exp[0]!.runId).toBe("hookRun"); // sessionId → runId, identical attribution to MCP
    } finally {
      store.close();
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  it("[transport:SDK] the contextual provider reads the project canary config → engages the same rail", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tb-smoke-sdk-"));
    const dbPath = join(tmp, "store.db");
    const seedStore = new BlockStore(new Database(dbPath));
    seed(seedStore);
    seedStore.close();
    initConfig(tmp);
    enableApplicabilityCanary(tmp, { policyAck: CANARY_POLICY_VERSION, rate: MAX_CANARY_RATE }); // 5% — the cap, via the real config path
    process.env.TRACEBASE_REASONING_APPLICABILITY = "shadow";
    process.env.TRACEBASE_REASONING_RETRIEVAL = "shadow";
    const provider = new TracebaseRuntimeProvider({ storagePath: dbPath, basePath: tmp });
    try {
      await provider.beforeTask({ problem: STRONG_MECH, runId: "sdkRun" });
      const ro = new BlockStore(new Database(dbPath, { readonly: true }));
      const exp = exposures(ro) as Array<{ arm: string; runId?: string }>;
      expect(exp.length).toBe(1); // the SDK transport engaged the canary (eligible)…
      expect(["treatment", "control"]).toContain(exp[0]!.arm); // …arm follows deterministic assignment at the 5% cap
      expect(exp[0]!.runId).toBe("sdkRun");
      ro.close();
    } finally {
      await provider.close?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- disabled is byte-identical on all three transports ----
  it("[disabled-parity:MCP] canary off → no exposure, baseline abstain preserved", async () => {
    const { store } = freshStore();
    const off = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH }, { readHoldoutConfig: () => null, readCanaryConfig: () => ({ ...canary(1), enabled: false }) });
    const absent = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH }, { readHoldoutConfig: () => null });
    expect(off.canaryExposure).toBeUndefined();
    expect(off.shouldInject).toBe(false);
    expect(absent.canaryExposure).toBeUndefined();
    expect(exposures(store).length).toBe(0);
    store.close();
  });

  it("[disabled-parity:hook] no canary loader → no exposure (byte-identical)", async () => {
    const { store } = freshStore();
    const basePath = mkdtempSync(join(tmpdir(), "tb-smoke-hookoff-"));
    try {
      await recallForPrompt(shadowServer(store), store, () => null, { prompt: STRONG_MECH, basePath, sessionId: "hookOff" }); // no canaryLoader
      expect(exposures(store).length).toBe(0);
    } finally {
      store.close();
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  it("[disabled-parity:SDK] no canary config persisted → no exposure (byte-identical)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tb-smoke-sdkoff-"));
    const dbPath = join(tmp, "store.db");
    const seedStore = new BlockStore(new Database(dbPath));
    seed(seedStore);
    seedStore.close();
    initConfig(tmp); // initialised but canary NEVER enabled
    process.env.TRACEBASE_REASONING_APPLICABILITY = "shadow";
    process.env.TRACEBASE_REASONING_RETRIEVAL = "shadow";
    const provider = new TracebaseRuntimeProvider({ storagePath: dbPath, basePath: tmp });
    try {
      await provider.beforeTask({ problem: STRONG_MECH, runId: "sdkOff" });
      const ro = new BlockStore(new Database(dbPath, { readonly: true }));
      expect(exposures(ro).length).toBe(0);
      ro.close();
    } finally {
      await provider.close?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- eligible arms ----
  it("[arm:control] a tiny rate keeps the baseline abstain but logs a (non-injecting) control exposure", async () => {
    const { store } = freshStore();
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH }, { readHoldoutConfig: () => null, readCanaryConfig: () => canary(0.0000001) });
    expect(r.canaryExposure?.arm).toBe("control");
    expect(r.shouldInject).toBe(false);
    expect(injections(store).length).toBe(0);
    expect(exposures(store).length).toBe(1);
    store.close();
  });

  // ---- precedence: a control / holdout arm wins over the canary ----
  // The global holdout only ever captures queries that WOULD have injected
  // (`wouldInjectAbsentShadow`); the canary only acts where V4 ABSTAINS — disjoint
  // populations, so a *real* holdout can never co-occur with canary eligibility.
  // The code still guards `served.controlReason === "holdout" || served.shadow`
  // defensively; the demonstrable trigger of that guard is a control/shadow arm,
  // which the canary must never override into an injection.
  it("[precedence:control] a control/shadow-arm unit is NEVER exposed, even with the canary enabled at rate 1", async () => {
    const { store } = freshStore();
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH, runId: "held", shadow: true }, { readHoldoutConfig: () => heldOut, readCanaryConfig: () => canary(1) });
    expect(r.canaryExposure).toBeUndefined();
    expect(r.shouldInject).toBe(false);
    expect(exposures(store).length).toBe(0);
    store.close();
  });

  // ---- kill switches (env may only ever DISABLE) ----
  it("[kill:env] TRACEBASE_APPLICABILITY_CANARY=off forces byte-identical (overrides an enabled config)", async () => {
    const { store } = freshStore();
    process.env.TRACEBASE_APPLICABILITY_CANARY = "off";
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH }, { readHoldoutConfig: () => null, readCanaryConfig: () => canary(1) });
    expect(r.canaryExposure).toBeUndefined();
    expect(exposures(store).length).toBe(0);
    store.close();
  });

  it("[kill:global] TRACEBASE_DISABLED=1 forces byte-identical (global kill)", async () => {
    const { store } = freshStore();
    process.env.TRACEBASE_DISABLED = "1";
    const r = await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH }, { readHoldoutConfig: () => null, readCanaryConfig: () => canary(1) });
    expect(r.canaryExposure).toBeUndefined();
    expect(exposures(store).length).toBe(0);
    store.close();
  });

  // ---- rate cap: rejected, never clamped; a persisted over-cap rate collapses to off ----
  it("[cap] enable REJECTS a rate above 5% (never clamps); exactly 5% is allowed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tb-smoke-cap-"));
    try {
      initConfig(tmp);
      expect(MAX_CANARY_RATE).toBe(0.05);
      expect(() => enableApplicabilityCanary(tmp, { policyAck: CANARY_POLICY_VERSION, rate: 0.06 })).toThrow(/0\.05|cap/);
      expect(() => enableApplicabilityCanary(tmp, { policyAck: CANARY_POLICY_VERSION, rate: 0.5 })).toThrow();
      expect(enableApplicabilityCanary(tmp, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 })!.rate).toBe(0.05);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("[fail-off:malformed] a persisted rate above the cap collapses the config to OFF", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tb-smoke-failoff-"));
    try {
      initConfig(tmp);
      enableApplicabilityCanary(tmp, { policyAck: CANARY_POLICY_VERSION, rate: 0.05 });
      const file = join(tmp, ".tracebase", "config.json");
      const raw = JSON.parse(readFileSync(file, "utf8")) as { experiment: { applicabilityCanary: { rate: number } } };
      raw.experiment.applicabilityCanary.rate = 0.9; // tamper / future-version drift
      writeFileSync(file, JSON.stringify(raw));
      expect(readApplicabilityCanaryConfig(tmp)).toBeNull();
      expect(resolveCanaryServingState(readApplicabilityCanaryConfig(tmp), {}).enabled).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- receipt gate: a missing or expired preflight receipt refuses the enable ----
  it("[receipt:missing/stale] enable is refused with no receipt and with an expired one", () => {
    const pf: PreflightInput = { preregText: "frozen prereg v1", events: [], canaryConfig: null, shadowEnabled: true, killEngaged: false, globalDisabled: false, policyVersion: CANARY_POLICY_VERSION, currentPolicyVersion: CANARY_POLICY_VERSION, applicabilityFeatureVersion: 1, currentApplicabilityFeatureVersion: 1, nowMs: 1_780_000_000_000 };
    const receipt = buildPreflightReceipt(pf);
    const live = buildPreflightReceipt(pf); // clean live re-audit (same inputs)
    expect(receipt.ok).toBe(true);
    expect(verifyReceiptForEnable(null, { live, nowMs: pf.nowMs })).toMatchObject({ ok: false, reason: "no_receipt" });
    expect(verifyReceiptForEnable(receipt, { live, nowMs: pf.nowMs + RECEIPT_TTL_MS + 1 })).toMatchObject({ ok: false, reason: "expired" });
    // sanity: a fresh, matching receipt authorises against a clean live re-audit.
    expect(verifyReceiptForEnable(receipt, { live, nowMs: pf.nowMs + 1000 }).ok).toBe(true);
  });

  // ---- privacy: an exposure event never survives the cloud allowlist ----
  it("[cloud-strip] a real canary exposure event is dropped WHOLE by sanitizeForCloud", async () => {
    const { store } = freshStore();
    await runReasoningPatternsRecall(shadowServer(store), { problem: STRONG_MECH, runId: "cloud" }, { readHoldoutConfig: () => null, readCanaryConfig: () => canary(1) });
    const event = exposures(store)[0] as AnalyticsEvent & { blockId?: string; unitHash?: string; queryHash?: string };
    expect(event).toBeTruthy();
    const sanitized = sanitizeForCloud(event);
    expect(Object.keys(sanitized as object).length).toBe(0); // no allowlisted key → dropped whole
    const blob = JSON.stringify(sanitized);
    for (const leaky of [event.blockId, event.unitHash, event.queryHash]) {
      if (leaky) expect(blob).not.toContain(leaky);
    }
    store.close();
  });
});
