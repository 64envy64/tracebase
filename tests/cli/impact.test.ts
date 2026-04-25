/**
 * `tracebase impact` — one-line, honest summary of measurable
 * impact (PLAN-0.5.7 §C).
 *
 * Three readiness states pinned here:
 *   - `no-store`     — no memory.db / not initialized
 *   - `no-runs`      — initialized, but the window has zero
 *                      eligible runs
 *   - `below-cohort` — observed counts present, but cohort is
 *                      under threshold → no token numbers
 *   - `ready`        — every per-token number resolved
 *
 * Critical invariant: NO fabricated savings on small samples.
 * `below-cohort` MUST surface the gap honestly, never round
 * a 2-sample lift to a confident number.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  initConfig,
  loadConfig,
  enableHoldoutExperiment,
} from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { runImpact, renderImpactLine } from "../../src/cli/commands/impact.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-impact-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function seedRetrieval(opts: {
  queryId: string;
  shadow: boolean;
  controlReason?: "shadow" | "holdout";
  injectedTokens?: number;
  ts?: number;
}): void {
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);
  store.appendEvent({
    ts: opts.ts ?? Date.now(),
    queryId: opts.queryId,
    event: "retrieval",
    candidates: [],
    shadow: opts.shadow,
    ...(opts.controlReason ? { controlReason: opts.controlReason } : {}),
    ...(opts.injectedTokens !== undefined
      ? { injectedTokensEstimate: opts.injectedTokens }
      : {}),
  });
  store.close();
}

describe("runImpact — readiness gates", () => {
  it("no-store on uninitialized project", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "tb-impact-noinit-"));
    try {
      const r = runImpact({ path: elsewhere });
      expect(r.readiness).toBe("no-store");
      expect(r.error).toMatch(/not initialized/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("no-store when memory.db is absent (initialized, no agent activity)", () => {
    initConfig(projectDir);
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("no-store");
    expect(r.error).toBeUndefined();
  });

  it("no-runs when memory.db exists but no eligible runs in the window", () => {
    initConfig(projectDir);
    // Touch the schema without seeding events.
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    new BlockStore(db).close();
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("no-runs");
  });

  it("below-cohort when retrievals exist but holdout is too small", () => {
    initConfig(projectDir);
    // Two assisted retrievals, no holdout — far below 30/arm threshold.
    seedRetrieval({ queryId: "q-1", shadow: false, injectedTokens: 1200 });
    seedRetrieval({ queryId: "q-2", shadow: false, injectedTokens: 1200 });
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("below-cohort");
    expect(r.metrics?.netTokenImpact ?? null).toBeNull();
    expect(r.metrics?.totalInjectedTokensEstimate).toBe(2400);
  });
});

describe("runImpact — netTokenImpact arithmetic", () => {
  it("totalInjectedTokensEstimate sums across retrieval events", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "a", shadow: false, injectedTokens: 800 });
    seedRetrieval({ queryId: "b", shadow: false, injectedTokens: 1200 });
    seedRetrieval({ queryId: "c", shadow: true, injectedTokens: 0 });
    const r = runImpact({ path: projectDir });
    expect(r.metrics?.totalInjectedTokensEstimate).toBe(2000);
  });

  it("netTokenImpact stays null when tokensLift.value is null (cohort gate fired)", () => {
    initConfig(projectDir);
    // One holdout retrieval — ensures `causal` block exists
    // (`holdout.n > 0`), but neither arm reaches min cohort, so
    // `tokensLift.value` is null and netTokenImpact follows.
    enableHoldoutExperiment(projectDir, { rate: 0.5 });
    seedRetrieval({
      queryId: "h-1",
      shadow: true,
      controlReason: "holdout",
      injectedTokens: 0,
    });
    seedRetrieval({ queryId: "a-1", shadow: false, injectedTokens: 1200 });
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("below-cohort");
    expect(r.metrics?.netTokenImpact).toBeNull();
    // BUT totalInjectedTokensEstimate is still computed and surfaced.
    expect(r.metrics?.totalInjectedTokensEstimate).toBe(1200);
  });
});

describe("renderImpactLine — honest copy", () => {
  it("renders 'no store yet' on no-store", () => {
    const line = renderImpactLine({
      readiness: "no-store",
      windowAfterTs: 0,
      windowBeforeTs: Date.now(),
      metrics: null,
    });
    expect(line).toMatch(/no store yet/);
  });

  it("renders 'Not enough data yet' on no-runs", () => {
    const line = renderImpactLine({
      readiness: "no-runs",
      windowAfterTs: 0,
      windowBeforeTs: Date.now(),
      metrics: {
        scope: "workspace",
        window: { afterTs: 0, beforeTs: 0 },
        observed: {
          eligibleRuns: 0,
          recalledRuns: 0,
          injectedRuns: 0,
          usedRuns: 0,
          helpfulRuns: 0,
          resolvedRateWithMemory: null,
        },
        estimated: {
          tokensSaved: { value: 0, sampleSize: 0, formula: "noop" },
          latencySavedMs: { value: 0, sampleSize: 0, formula: "noop" },
        },
        integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
        netTokenImpact: null,
        totalInjectedTokensEstimate: 0,
      },
    });
    expect(line).toMatch(/Not enough data yet/);
  });

  it("renders observed counts + 'Not enough causal data' on below-cohort", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q-1", shadow: false, injectedTokens: 1200 });
    seedRetrieval({ queryId: "q-2", shadow: false, injectedTokens: 1200 });
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    // Must mention the actual observed count, AND must NOT
    // confidently state a token-saved number.
    expect(line).toMatch(/runs assisted/);
    expect(line).not.toMatch(/saved over \d+d/);
  });
});
