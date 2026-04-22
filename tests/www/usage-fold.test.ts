/**
 * Regression tests for the dashboard-side sample fold.
 *
 * The Impact page is a thin renderer on top of `extractWorkspaceSamples`
 * + `foldImpactWindow`. Locking those two functions down makes UI
 * refactors safe: as long as the fold returns the same shape, the
 * dashboard cannot silently drift away from the CLI-side numbers.
 */
import { describe, it, expect } from "vitest";
// The dashboard side keeps its own UsageMetrics mirror because Cloud
// Build only uploads `www/`. This test imports the mirror used at
// runtime so we lock the exact shape the dashboard ships against,
// separately from the CLI shape covered in tests/core/usage-metrics.
import type { UsageMetrics } from "../../www/src/lib/usage/types.ts";
import {
  countContributorsInWindow,
  extractWorkspaceSamples,
  foldImpactWindow,
} from "../../www/src/lib/control-plane/usage.ts";
import type {
  ControlPlaneInstallation,
  ControlPlaneUsageSample,
} from "../../www/src/lib/control-plane/types.ts";

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

// Drift guard: the www mirror must stay assignable both ways to the
// canonical CLI type. If either side grows a field the other hasn't,
// TypeScript fails this file at compile time and the PR can't land.
import type { UsageMetrics as CliUsageMetrics } from "../../src/analytics/usage-metrics.js";

describe("www UsageMetrics mirror stays structurally compatible with the CLI surface", () => {
  it("is bidirectionally assignable to src/analytics/usage-metrics.UsageMetrics", () => {
    type _DashboardFitsCli = UsageMetrics extends CliUsageMetrics ? true : false;
    type _CliFitsDashboard = CliUsageMetrics extends UsageMetrics ? true : false;
    const fwd: _DashboardFitsCli = true;
    const back: _CliFitsDashboard = true;
    expect(fwd).toBe(true);
    expect(back).toBe(true);
  });
});

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

function inst(id: string, localWorkspaceId: string): ControlPlaneInstallation {
  return {
    id,
    workspaceId: "ws-1",
    localWorkspaceId,
    projectName: `proj-${localWorkspaceId}`,
    agent: "claude-code",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

function sampleFor(
  installationId: string,
  dateIso = "2026-04-20T00:00:00.000Z",
): ControlPlaneUsageSample {
  return {
    id: `s-${installationId}`,
    workspaceId: "ws-1",
    installationId,
    windowStart: dateIso,
    windowEnd: dateIso,
    metrics: {} as Record<string, unknown>,
    receivedAt: dateIso,
  };
}

describe("countContributorsInWindow", () => {
  it("returns zeros when the window has no samples, regardless of workspace inventory", () => {
    // Regression: Phase 1E.2 used listInstallations(workspace) for
    // the project/installation counts on Impact. That over-counted
    // an idle workspace — a user with 3 wired installations saw
    // "3 projects · 3 installations" even when nothing pushed a
    // sample in the selected window.
    const installations = [
      inst("inst-a", "proj-A"),
      inst("inst-b", "proj-B"),
      inst("inst-c", "proj-C"),
    ];
    const result = countContributorsInWindow([], installations);
    expect(result).toEqual({ projects: 0, installations: 0 });
  });

  it("counts only installations that actually contributed samples in the window", () => {
    const installations = [
      inst("inst-a", "proj-A"),
      inst("inst-b", "proj-B"),
      inst("inst-c", "proj-C"),
    ];
    const samples = [sampleFor("inst-a"), sampleFor("inst-b")];
    const result = countContributorsInWindow(samples, installations);
    expect(result).toEqual({ projects: 2, installations: 2 });
  });

  it("deduplicates samples from the same installation, and multiple installations on one project count as one project", () => {
    // Same project, two adapters (e.g. Claude Code + Cursor) both
    // pushed samples → 1 project, 2 installations.
    const installations = [
      inst("inst-a", "proj-A"),
      inst("inst-b", "proj-A"),
    ];
    const samples = [sampleFor("inst-a"), sampleFor("inst-a"), sampleFor("inst-b")];
    const result = countContributorsInWindow(samples, installations);
    expect(result).toEqual({ projects: 1, installations: 2 });
  });

  it("includes unresolved installation ids in the installation count without fabricating a project membership", () => {
    const installations = [inst("inst-a", "proj-A")];
    // An orphaned installationId (e.g. install was removed) still
    // counts toward contributors — refusing to forget the sample is
    // honest — but we will not invent a project for it.
    const samples = [sampleFor("inst-a"), sampleFor("inst-gone")];
    const result = countContributorsInWindow(samples, installations);
    expect(result).toEqual({ projects: 1, installations: 2 });
  });
});
