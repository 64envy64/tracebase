/**
 * Phase D.4.1 — the ONE shared canary boundary. runReasoningPatternsRecall (the
 * single orchestration point every transport — MCP, inject-context hook, SDK
 * contextual runtime — funnels through) applies the canary identically on BOTH
 * retrieval modes, is byte-identical when off, and emits run-scoped exposures the
 * D.3 ledger joins WITHOUT cross-run leakage.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import { joinApplicabilityTrials } from "../../src/analytics/applicability-ledger.js";
import { CANARY_POLICY_VERSION } from "../../src/core/config.js";
import type { ApplicabilityCanaryConfig } from "../../src/types.js";

const ACC = { s: "a running balance is off by a tiny fraction", m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result", u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift" };
const EQ = { s: "two computed quantities that should match are treated as different", m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding", u: "compare with a tolerance epsilon instead of strict equality or use a decimal type" };
const mk = (p: typeof ACC, ref: string) => JSON.stringify({ schemaVersion: V, pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run" }, scope: { language: "general" }, signals: { tags: [ref] }, provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" } });
function freshStore(): { store: BlockStore; accId: string } {
  const store = new BlockStore(new Database(":memory:"));
  const sum = importPatternsFromJsonl(store, [mk(ACC, "float-acc"), mk(EQ, "float-eq")].join("\n"), { now: 1 });
  return { store, accId: sum.results[0]!.blockId! };
}
const STRONG_MECH = "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with the order of operations";
const enabled: ApplicabilityCanaryConfig = { enabled: true, rate: 1, salt: "salt-p", policyVersion: CANARY_POLICY_VERSION, createdAt: "t", updatedAt: "t" };
const server = (store: BlockStore, retrievalMode: "shadow" | "on") => new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode, retrievalProvider: new DeterministicLocalProvider(), applicabilityMode: "shadow" });
const exposures = (store: BlockStore) => store.readEvents({}).filter((e) => e.event === "reasoning.applicability_canary_exposure");

describe("phase-d.4.1 canary shared-boundary parity", () => {
  it("the unified boundary applies the canary on BOTH retrieval modes (shadow + on)", async () => {
    for (const mode of ["shadow", "on"] as const) {
      const { store, accId } = freshStore();
      const r = await runReasoningPatternsRecall(server(store, mode), { problem: STRONG_MECH, runId: `run-${mode}` }, { readHoldoutConfig: () => null, readCanaryConfig: () => enabled, admitCanaryTreatment: () => true });
      expect(r.canaryExposure?.arm, mode).toBe("treatment");
      expect(r.canaryExposure?.blockId, mode).toBe(accId);
      expect(exposures(store).length, mode).toBe(1);
      store.close();
    }
  });

  it("DISABLED is byte-identical on both retrieval modes (no exposure, no canaryExposure)", async () => {
    for (const mode of ["shadow", "on"] as const) {
      const { store } = freshStore();
      const withLoaderDisabled = await runReasoningPatternsRecall(server(store, mode), { problem: STRONG_MECH }, { readHoldoutConfig: () => null, readCanaryConfig: () => ({ ...enabled, enabled: false }) });
      const noLoader = await runReasoningPatternsRecall(server(store, mode), { problem: STRONG_MECH }, { readHoldoutConfig: () => null });
      expect(withLoaderDisabled.canaryExposure, mode).toBeUndefined();
      expect(noLoader.canaryExposure, mode).toBeUndefined();
      expect(exposures(store).length, mode).toBe(0);
      store.close();
    }
  });

  it("emits run-scoped exposures the ledger joins WITHOUT cross-run leakage", async () => {
    const { store, accId } = freshStore();
    const srv = server(store, "shadow");
    await runReasoningPatternsRecall(srv, { problem: STRONG_MECH, runId: "runA" }, { readHoldoutConfig: () => null, readCanaryConfig: () => enabled, admitCanaryTreatment: () => true });
    await runReasoningPatternsRecall(srv, { problem: STRONG_MECH, runId: "runB" }, { readHoldoutConfig: () => null, readCanaryConfig: () => enabled, admitCanaryTreatment: () => true });

    const exps = exposures(store) as Array<{ runId?: string; arm: string; blockId?: string }>;
    expect(exps.length).toBe(2);
    expect(new Set(exps.map((e) => e.runId))).toEqual(new Set(["runA", "runB"]));

    // The ledger joins each run's exposure + injection to ITS OWN trial only.
    const { trials, diagnostics } = joinApplicabilityTrials(store.readEvents({}));
    expect(diagnostics.crossRun).toBe(0);
    const a = trials.find((t) => t.runId === "runA")!;
    const b = trials.find((t) => t.runId === "runB")!;
    expect(a.canary?.arm).toBe("treatment");
    expect(b.canary?.arm).toBe("treatment");
    expect(a.baselineExposed).toBe(true); // each run's own canary injection
    expect(b.baselineExposed).toBe(true);
    expect(a.candidateBlockId).toBe(accId);
    store.close();
  });
});
