/**
 * Regression tests for the dashboard-side sample fold.
 *
 * The Impact page is a thin renderer on top of `extractWorkspaceSamples`
 * + `foldImpactWindow`. Locking those two functions down makes UI
 * refactors safe: as long as the fold returns the same shape, the
 * dashboard cannot silently drift away from the CLI-side numbers.
 */
import { describe, it, expect } from "vitest";
import type { UsageMetrics } from "../../src/analytics/usage-metrics.js";
import {
  extractWorkspaceSamples,
  foldImpactWindow,
} from "../../www/src/lib/control-plane/usage.ts";
import type { ControlPlaneUsageSample } from "../../www/src/lib/control-plane/types.ts";

function bucket(overrides: Partial<UsageMetrics["observed"]> & {
  tokensSaved?: number | null;
  tokensSaved_n?: number;
  latencySaved?: number | null;
  latencySaved_n?: number;
}): UsageMetrics {
  const observed = {
    eligibleRuns: 0,
    recalledRuns: 0,
    injectedRuns: 0,
    usedRuns: 0,
    helpfulRuns: 0,
    resolvedRateWithMemory: null,
    ...overrides,
  };
  return {
    scope: "workspace",
    window: {},
    observed: {
      ...observed,
      resolvedRateWithMemory:
        observed.injectedRuns > 0 ? observed.helpfulRuns / observed.injectedRuns : null,
    },
    estimated: {
      tokensSaved: {
        value: overrides.tokensSaved ?? null,
        sampleSize: overrides.tokensSaved_n ?? 0,
        formula: "mean(shadow.tokens) − mean(treatment.tokens) × injectedRuns",
      },
      latencySavedMs: {
        value: overrides.latencySaved ?? null,
        sampleSize: overrides.latencySaved_n ?? 0,
        formula: "mean(shadow.durationMs) − mean(treatment.durationMs) × injectedRuns",
      },
    },
    integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
  };
}

function sample(dateIso: string, metrics: UsageMetrics): ControlPlaneUsageSample {
  return {
    id: `sample-${dateIso}`,
    workspaceId: "ws-1",
    installationId: "inst-1",
    windowStart: dateIso,
    windowEnd: dateIso.replace("T00", "T23"),
    metrics: metrics as unknown as Record<string, unknown>,
    receivedAt: dateIso,
  };
}

describe("extractWorkspaceSamples", () => {
  it("drops non-workspace samples and sorts ascending by date", () => {
    const raw: ControlPlaneUsageSample[] = [
      sample("2026-04-22T00:00:00.000Z", bucket({ eligibleRuns: 1 })),
      sample("2026-04-20T00:00:00.000Z", bucket({ eligibleRuns: 3 })),
      // scope=agent — Phase 2 shape — must be excluded from Phase 1 fold.
      sample("2026-04-21T00:00:00.000Z", {
        ...bucket({ eligibleRuns: 99 }),
        scope: "agent",
      }),
    ];
    const buckets = extractWorkspaceSamples(raw);
    expect(buckets.map((b) => b.date)).toEqual(["2026-04-20", "2026-04-22"]);
    expect(buckets[0]?.metrics.observed.eligibleRuns).toBe(3);
    expect(buckets[1]?.metrics.observed.eligibleRuns).toBe(1);
  });
});

describe("foldImpactWindow", () => {
  it("returns an empty totals block and 0 buckets when the window has no samples", () => {
    const window = foldImpactWindow({
      afterTs: "2026-04-01T00:00:00.000Z",
      beforeTs: "2026-04-30T23:59:59.000Z",
      buckets: [],
    });
    expect(window.buckets).toEqual([]);
    expect(window.totals.observed.eligibleRuns).toBe(0);
    expect(window.totals.observed.resolvedRateWithMemory).toBeNull();
    expect(window.totals.estimated.tokensSaved.value).toBeNull();
    expect(window.totals.estimated.latencySavedMs.value).toBeNull();
    expect(window.totals.scope).toBe("workspace");
  });

  it("sums observed counts across daily buckets and derives resolvedRateWithMemory", () => {
    const buckets = [
      { date: "2026-04-20", metrics: bucket({ eligibleRuns: 10, recalledRuns: 8, injectedRuns: 6, usedRuns: 4, helpfulRuns: 3 }) },
      { date: "2026-04-21", metrics: bucket({ eligibleRuns: 5, recalledRuns: 5, injectedRuns: 4, usedRuns: 3, helpfulRuns: 1 }) },
    ];
    const window = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets,
    });
    expect(window.totals.observed.eligibleRuns).toBe(15);
    expect(window.totals.observed.recalledRuns).toBe(13);
    expect(window.totals.observed.injectedRuns).toBe(10);
    expect(window.totals.observed.usedRuns).toBe(7);
    expect(window.totals.observed.helpfulRuns).toBe(4);
    // resolvedRateWithMemory = helpful(4) / injected(10) = 0.4.
    expect(window.totals.observed.resolvedRateWithMemory).toBeCloseTo(0.4);
  });

  it("accumulates estimates over buckets with non-null shadow arms", () => {
    const buckets = [
      { date: "2026-04-20", metrics: bucket({ eligibleRuns: 4, injectedRuns: 2, tokensSaved: 200, tokensSaved_n: 1, latencySaved: 500, latencySaved_n: 1 }) },
      { date: "2026-04-21", metrics: bucket({ eligibleRuns: 3, injectedRuns: 2, tokensSaved: 400, tokensSaved_n: 2, latencySaved: 800, latencySaved_n: 2 }) },
    ];
    const window = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets,
    });
    expect(window.totals.estimated.tokensSaved.value).toBe(600);
    expect(window.totals.estimated.tokensSaved.sampleSize).toBe(3);
    expect(window.totals.estimated.latencySavedMs.value).toBe(1300);
    expect(window.totals.estimated.latencySavedMs.sampleSize).toBe(3);
  });

  it("keeps estimates null when every bucket's shadow arm was empty", () => {
    const buckets = [
      { date: "2026-04-20", metrics: bucket({ eligibleRuns: 4, injectedRuns: 2 }) },
      { date: "2026-04-21", metrics: bucket({ eligibleRuns: 3, injectedRuns: 2 }) },
    ];
    const window = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets,
    });
    expect(window.totals.estimated.tokensSaved.value).toBeNull();
    expect(window.totals.estimated.latencySavedMs.value).toBeNull();
    expect(window.totals.observed.eligibleRuns).toBe(7);
  });
});
