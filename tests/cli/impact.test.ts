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
  enableCascade,
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
  cascade?: boolean;
  fallbackReason?: "timeout" | "error" | "null" | "empty" | "validation";
}): void {
  // Use the path-constructor so BlockStore owns + closes the
  // underlying handle. Multiple short-lived connections without
  // WAL otherwise silently lose writes when run back-to-back.
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  store.appendEvent({
    ts: opts.ts ?? Date.now(),
    queryId: opts.queryId,
    event: "retrieval",
    candidates: [],
    shadow: opts.shadow,
    ...(opts.controlReason ? { controlReason: opts.controlReason } : {}),
    ...(opts.cascade
      ? {
          cascadePolicyId: "linear+rerank+mmr.v1",
          rerankerName: "minilm",
          mmrLambda: 0.7,
          rerankerFellBack: opts.fallbackReason !== undefined,
          ...(opts.fallbackReason ? { rerankerFallbackReason: opts.fallbackReason } : {}),
        }
      : {}),
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
  // Use the path-constructor so BlockStore owns + closes the
  // underlying handle. Multiple short-lived connections without
  // WAL otherwise silently lose writes when run back-to-back.
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  store.appendEvent({
    ts: opts.ts ?? Date.now(),
    queryId: opts.queryId,
    event: "outcome",
    resolved: opts.resolved,
    ...(opts.control !== undefined ? { control: opts.control } : {}),
  });
  store.close();
}

function seedInjection(opts: {
  queryId: string;
  blockId?: string;
  score?: number;
  ts?: number;
}): void {
  // Use the path-constructor so BlockStore owns + closes the
  // underlying handle. Multiple short-lived connections without
  // WAL otherwise silently lose writes when run back-to-back.
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  store.appendEvent({
    ts: opts.ts ?? Date.now(),
    queryId: opts.queryId,
    event: "injection",
    blockId: opts.blockId ?? "block-stub",
    score: opts.score ?? 0.8,
  });
  store.close();
}

function seedAgentUsed(opts: {
  queryId: string;
  blockId?: string;
  ts?: number;
}): void {
  const cfg = loadConfig(projectDir);
  const store = new BlockStore(cfg.storagePath);
  store.appendEvent({
    ts: opts.ts ?? Date.now(),
    queryId: opts.queryId,
    event: "agent_used",
    blockId: opts.blockId ?? "block-stub",
    matchSignal: "explicit",
    matchScore: 1,
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
    db.close();
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
    expect(renderImpactLine(r)).not.toMatch(/cascade:/);
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
    db.close();
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    expect(line).toMatch(/Not enough data yet/);
  });

  it("0.6.1 — no-holdout (experiment NOT enabled): head + 'verified: disabled' + init-rerun hint", () => {
    initConfig(projectDir);
    // No enableHoldoutExperiment() call → holdout config absent.
    seedRetrieval({ queryId: "a", shadow: false, injectedTokens: 500 });
    seedRetrieval({ queryId: "b", shadow: false, injectedTokens: 429 });
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    expect(line).toMatch(/runs assisted/);
    expect(line).toMatch(/injected 929 tokens|injected 0\.9k tokens/);
    // 0.6.1 — verified is a separate tagged segment; copy uses
    // "verified: disabled" (not "savings unavailable").
    expect(line).toMatch(/verified: disabled/);
    expect(line).toMatch(/tracebase-ai init --holdout-rate/);
    expect(line).not.toMatch(/Causal arm not configured/);
    expect(line).not.toMatch(/savings unavailable/);
  });

  it("0.6.0 — experiment ENABLED but no holdout outcomes yet → 'collecting causal data'", () => {
    initConfig(projectDir);
    enableHoldoutExperiment(projectDir, { rate: 0.1 });
    // Assisted: retrieval + injection + outcome(control=false).
    // No holdout outcomes recorded yet.
    seedRetrieval({ queryId: "a", shadow: false, injectedTokens: 500 });
    seedInjection({ queryId: "a" });
    seedOutcome({ queryId: "a", resolved: true, control: false });
    seedRetrieval({ queryId: "b", shadow: false, injectedTokens: 429 });
    seedInjection({ queryId: "b" });
    seedOutcome({ queryId: "b", resolved: true, control: false });
    const r = runImpact({ path: projectDir });
    expect(r.experiment).toEqual({
      enabled: true,
      rate: 0.1,
      assistedN: 2,
      holdoutN: 0,
      minCohortSize: expect.any(Number),
    });
    const line = renderImpactLine(r);
    expect(line).toMatch(/runs assisted/);
    expect(line).toMatch(/injected/);
    // 0.6.1 — copy is "verified: collecting" (tagged segment).
    expect(line).toMatch(/verified: collecting/);
    expect(line).toMatch(/assisted=2/);
    expect(line).toMatch(/holdout=0/);
    expect(line).toMatch(/need ≥ 30 per arm/);
    expect(line).not.toMatch(/savings unavailable/);
    expect(line).not.toMatch(/tracebase-ai init --holdout-rate/);
  });

  it("0.6.0 — experiment enabled + below-cohort: 'collecting' replaces 'Not enough causal data yet'", () => {
    initConfig(projectDir);
    enableHoldoutExperiment(projectDir, { rate: 0.1 });
    // Holdout arm: shadow retrieval + outcome(control=true).
    seedRetrieval({
      queryId: "h",
      shadow: true,
      controlReason: "holdout",
      injectedTokens: 0,
    });
    seedOutcome({ queryId: "h", resolved: false, control: true });
    // Assisted arm: retrieval + injection + outcome(control=false).
    seedRetrieval({ queryId: "a", shadow: false, injectedTokens: 1200 });
    seedInjection({ queryId: "a" });
    seedOutcome({ queryId: "a", resolved: true, control: false });
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    // 0.6.1 — copy is "verified: collecting — ..." (tagged segment).
    expect(line).toMatch(/verified: collecting — assisted=1, holdout=1/);
    expect(line).not.toMatch(/Not enough causal data yet/);
  });

  it("0.6.0 — experiment ENABLED + below-cohort: 'collecting causal data' (renamed from 'Not enough')", () => {
    // Pre-0.6.0 this rendered "Not enough causal data yet"; with
    // experiment enabled the copy now reads "collecting causal
    // data" so users see growing-not-broken state.
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
    seedInjection({ queryId: "a-1" });
    seedOutcome({ queryId: "a-1", resolved: true, control: false });
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    expect(line).toMatch(/runs? assisted/);
    expect(line).toMatch(/injected/);
    expect(line).toMatch(/verified: collecting/);
    expect(line).toMatch(/assisted=\d+/);
    expect(line).toMatch(/holdout=\d+/);
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
          // 0.6.1 — heuristic fields on the mocked metrics so the
          // estimated segment renders alongside the verified one.
          heuristicTokensSaved: { value: 39 * 1000, sampleSize: 39, formula: "helpfulRuns × 1000 tokens (heuristic)" },
          heuristicLatencySavedMs: { value: 39 * 5_000, sampleSize: 39, formula: "helpfulRuns × 5000 ms (heuristic)" },
        },
        causal,
        integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
        netTokenImpact: opts.netTokenImpact,
        totalInjectedTokensEstimate: opts.injectedTokens,
      },
    };
  }

  it("renders estimated + verified saved + net + latency when cohort is ready", () => {
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
    expect(line).toMatch(/injected 14\.0k tokens/);
    // 0.6.1 — both segments rendered. Estimated is heuristic
    // (39 helpful × 1000 = 39k); verified is the causal lift.
    expect(line).toMatch(/39\.0k estimated saved \(n=39 helpful\)/);
    expect(line).toMatch(/net est .+ after context cost/);
    expect(line).toMatch(/38\.0k verified saved over 7d/);
    expect(line).toMatch(/\+12pp vs holdout/);
    expect(line).toMatch(/net verified \+24\.0k after context cost/);
    expect(line).toMatch(/verified latency saved 1\.2s/);
    // §5 — never say "saved" alone. The positive assertions
    // above already prove every "saved" token in this line is
    // tagged as "estimated saved" / "verified saved" /
    // "(estimated|verified) latency saved".
    // No dollars without pricing config.
    expect(line).not.toMatch(/\$/);
  });

  it("0.6.1 — pricing config renders dollars on BOTH estimated and verified; without it, no dollars", () => {
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
    // Verified: 1M tokens at blended rate (3+15)/2 = $9/1M → $9 verified.
    expect(withPricing).toMatch(/\$9\.00 verified/);
    expect(withPricing).toMatch(/net verified ≈ \+\$4\.50/);
    // Estimated: 39k tokens (39 helpful × 1000) → ~$0.35 estimated.
    expect(withPricing).toMatch(/\$\d+\.\d+ estimated/);
  });

  it("0.6.1 — verified latency omitted when causal.latencyLift.value is null", () => {
    const line = renderImpactLine(
      readyMetrics({
        tokensLift: 5_000,
        netTokenImpact: 1_000,
        latencyLiftMs: null,
        injectedTokens: 4_000,
        resolvedLift: 0.05,
      }),
    );
    expect(line).not.toMatch(/verified latency saved/);
    // Estimated latency line still appears (heuristic always populates).
    expect(line).toMatch(/estimated latency saved/);
  });
});

// ---------------------------------------------------------------------------
// 0.7.0-rc.7 — estimated mechanism savings block
// ---------------------------------------------------------------------------

describe("runImpact — mechanism savings (0.7.0-rc.7)", () => {
  function seedContextFold(opts: {
    queryId: string;
    tokensBefore: number;
    tokensAfter: number;
    ts?: number;
  }): void {
    const cfg = loadConfig(projectDir);
    const store = new BlockStore(cfg.storagePath);
    store.appendEvent({
      ts: opts.ts ?? Date.now(),
      queryId: opts.queryId,
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "0-7",
      tokensBefore: opts.tokensBefore,
      tokensAfter: opts.tokensAfter,
      summarizer: "heuristic",
    });
    store.close();
  }

  function seedFileMemory(opts: {
    queryId: string;
    bytesAvoided: number;
    tokensInjected: number;
    ts?: number;
  }): void {
    const cfg = loadConfig(projectDir);
    const store = new BlockStore(cfg.storagePath);
    store.appendEvent({
      ts: opts.ts ?? Date.now(),
      queryId: opts.queryId,
      event: "file_memory.recalled",
      fileIds: ["src/a.ts"],
      tokensInjected: opts.tokensInjected,
      bytesAvoided: opts.bytesAvoided,
    });
    store.close();
  }

  function seedToolSuppressed(opts: {
    queryId: string;
    toolName: string;
    ts?: number;
  }): void {
    const cfg = loadConfig(projectDir);
    const store = new BlockStore(cfg.storagePath);
    store.appendEvent({
      ts: opts.ts ?? Date.now(),
      queryId: opts.queryId,
      event: "tool_supervision.suppressed",
      argKey: "k",
      toolName: opts.toolName,
      // 0.7.0-rc.7 hardening — only blocked suppressions count
      // toward mechanism savings. The impact test seeds these as
      // strict-mode blocks to assert the renderer integration.
      blocked: true,
    });
    store.close();
  }

  function seedCacheHit(opts: {
    queryId: string;
    surface: "anthropic" | "openai";
    tokensSaved: number;
    ts?: number;
  }): void {
    const cfg = loadConfig(projectDir);
    const store = new BlockStore(cfg.storagePath);
    store.appendEvent({
      ts: opts.ts ?? Date.now(),
      queryId: opts.queryId,
      event: "cache.prompt_hit",
      surface: opts.surface,
      tokensSaved: opts.tokensSaved,
    });
    store.close();
  }

  it("populates report.mechanisms when any component is non-zero", () => {
    initConfig(projectDir);
    seedContextFold({ queryId: "f1", tokensBefore: 1000, tokensAfter: 200 });
    seedCacheHit({ queryId: "c1", surface: "anthropic", tokensSaved: 1500 });
    const r = runImpact({ path: projectDir });
    expect(r.mechanisms).not.toBeNull();
    expect(r.mechanisms?.contextCompressionSaved).toBe(800);
    expect(r.mechanisms?.promptCacheSaved).toBe(1500);
    expect(r.mechanisms?.total).toBe(800 + 1500);
  });

  it("report.mechanisms is null when no mechanism events landed", () => {
    initConfig(projectDir);
    // Just a retrieval — no fold / file-memory / tool-supervision / cache hit.
    seedRetrieval({ queryId: "q1", shadow: false, injectedTokens: 100 });
    const r = runImpact({ path: projectDir });
    expect(r.mechanisms).toBeNull();
  });

  it("renderImpactLine appends an 'estimated mechanisms' line when mechanisms present", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q1", shadow: false, injectedTokens: 100 });
    seedContextFold({ queryId: "f1", tokensBefore: 5000, tokensAfter: 1000 });
    seedFileMemory({ queryId: "fm1", bytesAvoided: 12_000, tokensInjected: 200 });
    seedToolSuppressed({ queryId: "t1", toolName: "Read" });
    seedCacheHit({ queryId: "c1", surface: "openai", tokensSaved: 600 });
    const r = runImpact({ path: projectDir });
    const line = renderImpactLine(r);
    // Line is multi-line: primary on line 1, mechanisms on line 2.
    expect(line).toMatch(/estimated mechanisms:/);
    // Each non-zero component must surface with its source label.
    expect(line).toMatch(/context fold ≈ /);
    expect(line).toMatch(/file memory ≈ /);
    expect(line).toMatch(/tool supervision ≈ /);
    expect(line).toMatch(/prompt cache ≈ /);
    // Total uses "total estimated saved" — never "saved" alone.
    expect(line).toMatch(/total estimated saved/);
    // STRICT VOCAB CONTRACT: the mechanism block must NEVER claim
    // verified savings or use the bare word "verified saved".
    const mechSection = line.split("estimated mechanisms:")[1] ?? "";
    expect(mechSection).not.toMatch(/verified/i);
  });

  it("does NOT render mechanism line when total is zero (clamped or no events)", () => {
    initConfig(projectDir);
    seedRetrieval({ queryId: "q1", shadow: false, injectedTokens: 100 });
    // Pathological fold where summary is longer than original — clamps to 0.
    seedContextFold({ queryId: "f1", tokensBefore: 100, tokensAfter: 200 });
    const r = runImpact({ path: projectDir });
    expect(r.mechanisms).toBeNull();
    const line = renderImpactLine(r);
    expect(line).not.toMatch(/estimated mechanisms:/);
  });

  it("mechanism block surfaces even on no-runs windows (mechanisms can fire outside causal-eligible runs)", () => {
    initConfig(projectDir);
    // No retrievals/outcomes — but a tool-supervision suppression
    // happened. The user's mechanism savings are real even when
    // no causal run landed, so the line should still appear.
    seedToolSuppressed({ queryId: "t1", toolName: "Read" });
    seedToolSuppressed({ queryId: "t2", toolName: "Read" });
    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("no-runs");
    expect(r.mechanisms).not.toBeNull();
    const line = renderImpactLine(r);
    expect(line).toMatch(/Not enough data yet/);
    expect(line).toMatch(/estimated mechanisms:/);
    expect(line).toMatch(/tool supervision ≈ /);
  });
});

describe("runImpact — cascade visibility (B1.5)", () => {
  it("embeds the cascade-vs-sync rollout comparison in the main impact surface", () => {
    initConfig(projectDir);
    enableCascade(projectDir, {
      rate: 1,
      kind: "minilm",
      saltFactory: () => "cascade-test-salt",
    });

    seedRetrieval({ queryId: "c-1", shadow: false, injectedTokens: 100, cascade: true });
    seedInjection({ queryId: "c-1" });
    seedAgentUsed({ queryId: "c-1" });
    seedOutcome({ queryId: "c-1", resolved: true, control: false });

    seedRetrieval({ queryId: "s-1", shadow: false, injectedTokens: 100 });
    seedInjection({ queryId: "s-1" });
    seedAgentUsed({ queryId: "s-1" });
    seedOutcome({ queryId: "s-1", resolved: false, control: false });

    const r = runImpact({ path: projectDir });
    expect(r.cascade?.configured).toBe(true);
    expect(r.cascade?.enabled).toBe(true);
    expect(r.cascade?.kind).toBe("minilm");
    expect(r.cascade?.comparison?.lift).toBe(1);

    const line = renderImpactLine(r);
    expect(line).toMatch(/cascade:/);
    expect(line).toMatch(/kind=minilm/);
    expect(line).toMatch(/lift \+100\.00pp/);
  });

  it("surfaces configured cascade state even before rollout events land", () => {
    initConfig(projectDir);
    enableCascade(projectDir, {
      rate: 0.05,
      kind: "noop",
      saltFactory: () => "cascade-test-salt",
    });
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    new BlockStore(db).close();
    db.close();

    const r = runImpact({ path: projectDir });
    expect(r.readiness).toBe("no-runs");
    expect(r.cascade?.configured).toBe(true);
    const line = renderImpactLine(r);
    expect(line).toMatch(/cascade:/);
    expect(line).toMatch(/collecting rollout events/);
  });
});
