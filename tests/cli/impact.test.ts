/**
 * `tracebase impact` — honest, always-on summary of measurable
 * impact (PLAN-0.5.7 §C, completed in 0.5.9).
 *
 * Five readiness states:
 *   - `no-store`     — no memory.db / not initialized
 *   - `no-runs`      — initialized, but window has zero eligible runs
 *   - `no-holdout`   — runs exist, but holdout never enabled
 *                      (causal block absent). Must surface the
 *                      enable-holdout next step.
 *   - `below-cohort` — holdout exists but per-arm n < threshold.
 *                      Must show observed counts honestly.
 *   - `ready`        — every per-token number resolved.
 *
 * Critical invariants:
 *   1. NEVER fabricate savings on small samples.
 *   2. Always show the input-side cost (totalInjectedTokensEstimate)
 *      so the user sees what TraceBase is spending even when no
 *      savings are available.
 *   3. Dollars are NEVER inferred from a model name. Only render
 *      USD when both `--price-input-per-1m` and
 *      `--price-output-per-1m` resolve (or both `pricing.*` config
 *      fields).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function seedOutcome(opts: {
  queryId: string;
  resolved: boolean;
  control?: boolean;
  ts?: number;
}): void {
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);
  store.appendEvent({
    ts: opts.ts ?? Date.now(),
    queryId: opts.queryId,
    event: "outcome",
    resolved: opts.resolved,
    ...(opts.control !== undefined ? { control: opts.control } : {}),
  });
  store.close();
}

function setPricingConfig(input: number, output: number): void {
  const file = join(projectDir, ".tracebase", "config.json");
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  raw.pricing = { inputPer1mTokens: input, outputPer1mTokens: output };
  writeFileSync(file, JSON.stringify(raw, null, 2));
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

  it("no-store when memory.db is absent", () => {
    initConfig(projectDir);
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("no-store");
    expect(r.error).toBeUndefined();
  });

  it("no-runs when memory.db exists but no eligible runs in window", () => {
    initConfig(projectDir);
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    new BlockStore(db).close();
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("no-runs");
  });

  it("0.5.9 — no-holdout when retrievals exist but holdout is NOT enabled", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q-1", shadow: false, injectedTokens: 1200 });
    seedRetrieval({ queryId: "q-2", shadow: false, injectedTokens: 1200 });
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("no-holdout");
    expect(r.metrics?.causal).toBeUndefined();
    expect(r.metrics?.totalInjectedTokensEstimate).toBe(2400);
  });

  it("0.5.9 — below-cohort when holdout exists but arms are tiny", () => {
    initConfig(projectDir);
    enableHoldoutExperiment(projectDir, { rate: 0.5 });
    // Holdout retrieval + outcome → populates causal.holdout.n.
    seedRetrieval({
      queryId: "h-1",
      shadow: true,
      controlReason: "holdout",
      injectedTokens: 0,
    });
    seedOutcome({ queryId: "h-1", resolved: false, control: true });
    // Assisted retrieval + outcome → populates causal.assisted.n.
    seedRetrieval({ queryId: "a-1", shadow: false, injectedTokens: 1200 });
    seedOutcome({ queryId: "a-1", resolved: true, control: false });
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("below-cohort");
    expect(r.metrics?.causal).toBeDefined();
    expect(r.metrics?.causal?.tokensLift?.value).toBeNull();
    expect(r.metrics?.netTokenImpact).toBeNull();
    expect(r.metrics?.totalInjectedTokensEstimate).toBe(1200);
  });
});

describe("runImpact — pricing resolution", () => {
  it("returns pricing=null when neither flags nor config provide both prices", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q", shadow: false, injectedTokens: 100 });
    const r = runImpact({ path: projectDir });
    expect(r.pricing).toBeNull();
  });

  it("returns pricing=null when only ONE flag is set (both required)", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q", shadow: false, injectedTokens: 100 });
    const r = runImpact({
      path: projectDir,
      priceInputPer1m: "3",
      // priceOutputPer1m intentionally omitted
    });
    expect(r.pricing).toBeNull();
  });

  it("CLI flags resolve when both are set", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q", shadow: false, injectedTokens: 100 });
    const r = runImpact({
      path: projectDir,
      priceInputPer1m: "3",
      priceOutputPer1m: "15",
    });
    expect(r.pricing).toEqual({ inputPer1mTokens: 3, outputPer1mTokens: 15 });
  });

  it("config.pricing populates when CLI flags absent", () => {
    initConfig(projectDir);
    setPricingConfig(2.5, 12);
    seedRetrieval({ queryId: "q", shadow: false, injectedTokens: 100 });
    const r = runImpact({ path: projectDir });
    expect(r.pricing).toEqual({ inputPer1mTokens: 2.5, outputPer1mTokens: 12 });
  });

  it("CLI flags win over config.pricing", () => {
    initConfig(projectDir);
    setPricingConfig(2.5, 12);
    seedRetrieval({ queryId: "q", shadow: false, injectedTokens: 100 });
    const r = runImpact({
      path: projectDir,
      priceInputPer1m: "5",
      priceOutputPer1m: "20",
    });
    expect(r.pricing).toEqual({ inputPer1mTokens: 5, outputPer1mTokens: 20 });
  });

  it("rejects non-numeric / zero / negative prices", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q", shadow: false, injectedTokens: 100 });
    const r = runImpact({
      path: projectDir,
      priceInputPer1m: "not-a-number",
      priceOutputPer1m: "0",
    });
    expect(r.pricing).toBeNull();
  });
});

describe("renderImpactLine — head/tail composition", () => {
  it("no-store → 'no store yet'", () => {
    const line = renderImpactLine({
      readiness: "no-store",
      windowAfterTs: 0,
      windowBeforeTs: Date.now(),
      metrics: null,
      pricing: null,
    });
    expect(line).toMatch(/no store yet/);
  });

  it("no-runs → 'Not enough data yet — no eligible runs'", () => {
    initConfig(projectDir);
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    new BlockStore(db).close();
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    expect(line).toMatch(/Not enough data yet/);
  });

  it("0.5.9 — no-holdout: head + 'savings unavailable: enable holdout' (actionable copy)", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "a", shadow: false, injectedTokens: 500 });
    seedRetrieval({ queryId: "b", shadow: false, injectedTokens: 429 });
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    // Always-on head: assisted runs / resolved rate / injected tokens.
    expect(line).toMatch(/runs assisted/);
    expect(line).toMatch(/injected 929 tokens|injected 0\.9k tokens/); // 929 → "929"
    // Actionable next-step pointer.
    expect(line).toMatch(/savings unavailable/);
    expect(line).toMatch(/tracebase experiment enable --rate/);
    // Must NOT pretend the cohort is "configured" — the 0.5.7
    // copy was wrong on this exact case.
    expect(line).not.toMatch(/Causal arm not configured/);
  });

  it("0.5.9 — below-cohort: head + 'Not enough causal data yet — assisted=N, holdout=M'", () => {
    initConfig(projectDir);
    enableHoldoutExperiment(projectDir, { rate: 0.5 });
    seedRetrieval({
      queryId: "h-1",
      shadow: true,
      controlReason: "holdout",
      injectedTokens: 0,
    });
    seedOutcome({ queryId: "h-1", resolved: false, control: true });
    seedRetrieval({ queryId: "a-1", shadow: false, injectedTokens: 1200 });
    seedOutcome({ queryId: "a-1", resolved: true, control: false });
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    expect(line).toMatch(/runs assisted/);
    expect(line).toMatch(/injected/);
    expect(line).toMatch(/Not enough causal data yet/);
    expect(line).toMatch(/assisted=\d+/);
    expect(line).toMatch(/holdout=\d+/);
    // No fabricated savings on small cohorts.
    expect(line).not.toMatch(/saved over \d+d/);
  });

  it("0.5.9 — head always shows injected tokens even when 0 savings are available", () => {
    initConfig(projectDir);
    // Two assisted retrievals, total 929 tokens — matches the
    // exact format the user spec called out.
    seedRetrieval({ queryId: "q-1", shadow: false, injectedTokens: 500 });
    seedRetrieval({ queryId: "q-2", shadow: false, injectedTokens: 429 });
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    expect(line).toMatch(/injected (929|0\.9k) tokens/);
  });
});

describe("renderImpactLine — ready state (mocked metrics)", () => {
  // The "ready" path requires ≥30 outcomes per arm, which is
  // expensive to seed end-to-end. We fabricate a metrics
  // payload and feed it through `renderImpactLine` to pin the
  // visible copy.
  function readyMetrics(opts: {
    tokensLift: number;
    netTokenImpact: number | null;
    latencyLiftMs: number | null;
    injectedTokens: number;
    resolvedLift: number | null;
  }) {
    const causal = {
      assisted: { n: 47, resolved: 39, resolvedRate: 0.83 },
      holdout: { n: 35, resolved: 25, resolvedRate: 0.71 },
      resolvedLift: opts.resolvedLift,
      tokensLift: { value: opts.tokensLift, sampleSize: 47, formula: "..." },
      latencyLift: { value: opts.latencyLiftMs, sampleSize: 47, formula: "..." },
      minCohortSize: 30,
    } as const;
    return {
      readiness: "ready" as const,
      windowAfterTs: Date.now() - 7 * 86_400_000,
      windowBeforeTs: Date.now(),
      pricing: null,
      metrics: {
        scope: "workspace" as const,
        window: { afterTs: 0, beforeTs: 0 },
        observed: {
          eligibleRuns: 50,
          recalledRuns: 47,
          injectedRuns: 47,
          usedRuns: 45,
          helpfulRuns: 39,
          resolvedRateWithMemory: 0.83,
        },
        estimated: {
          tokensSaved: { value: opts.tokensLift, sampleSize: 47, formula: "..." },
          latencySavedMs: { value: opts.latencyLiftMs ?? 0, sampleSize: 47, formula: "..." },
        },
        causal,
        integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
        netTokenImpact: opts.netTokenImpact,
        totalInjectedTokensEstimate: opts.injectedTokens,
      },
    };
  }

  it("renders tokens saved + net + latency when cohort is ready", () => {
    const line = renderImpactLine(
      readyMetrics({
        tokensLift: 38_000,
        netTokenImpact: 24_000,
        latencyLiftMs: 1_200,
        injectedTokens: 14_000,
        resolvedLift: 0.12,
      }),
    );
    expect(line).toMatch(/runs assisted/);
    expect(line).toMatch(/83% resolved/);
    expect(line).toMatch(/\+12pp vs holdout/);
    expect(line).toMatch(/injected 14\.0k tokens/);
    expect(line).toMatch(/38\.0k tokens saved over 7d/);
    expect(line).toMatch(/net \+24\.0k after injection/);
    expect(line).toMatch(/latency saved 1\.2s/);
    // No dollars without pricing config.
    expect(line).not.toMatch(/\$/);
  });

  it("0.5.9 — pricing config renders dollars; without it, dollars are absent", () => {
    const noPricing = renderImpactLine(
      readyMetrics({
        tokensLift: 1_000_000,
        netTokenImpact: 500_000,
        latencyLiftMs: null,
        injectedTokens: 100_000,
        resolvedLift: 0.1,
      }),
    );
    expect(noPricing).not.toMatch(/\$/);

    const withPricing = renderImpactLine({
      ...readyMetrics({
        tokensLift: 1_000_000,
        netTokenImpact: 500_000,
        latencyLiftMs: null,
        injectedTokens: 100_000,
        resolvedLift: 0.1,
      }),
      pricing: { inputPer1mTokens: 3, outputPer1mTokens: 15 },
    });
    // 1M tokens at blended rate (3+15)/2 = $9 per 1M → $9 saved.
    expect(withPricing).toMatch(/\$9\.00 saved/);
    // 500k net at the same rate → $4.50 net.
    expect(withPricing).toMatch(/net ≈ \+\$4\.50/);
  });

  it("0.5.9 — latency saved omitted when latencyLift.value is null", () => {
    const line = renderImpactLine(
      readyMetrics({
        tokensLift: 5_000,
        netTokenImpact: 1_000,
        latencyLiftMs: null,
        injectedTokens: 4_000,
        resolvedLift: 0.05,
      }),
    );
    expect(line).not.toMatch(/latency saved/);
  });
});
