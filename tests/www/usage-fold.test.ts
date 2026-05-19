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
  filterSamplesByScope,
  foldImpactWindow,
  parseUsageMetrics,
  toDailyBuckets,
  validateSamples,
  type ValidatedSample,
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

  it("folds calibration reliability diagnostics across buckets", () => {
    const calibration = (
      overrides: Partial<NonNullable<UsageMetrics["calibration"]>>,
    ): NonNullable<UsageMetrics["calibration"]> => ({
      brierScore: null,
      auc: null,
      scoredInjections: 0,
      refitCount: 0,
      lastRefitAt: null,
      candidatesSeen: 0,
      candidatesShown: 0,
      candidatesFiltered: 0,
      candidateFilterRate: null,
      driftInjectionCount: 0,
      driftPatternsInjected: 0,
      ...overrides,
    });
    const buckets = [
      {
        date: "2026-04-20",
        metrics: {
          ...bucket({ eligibleRuns: 4 }),
          calibration: calibration({
            brierScore: 0.1,
            auc: 0.7,
            scoredInjections: 2,
            refitCount: 1,
            lastRefitAt: 10,
            candidatesSeen: 4,
            candidatesShown: 2,
            candidatesFiltered: 2,
            candidateFilterRate: 0.5,
            driftInjectionCount: 1,
            driftPatternsInjected: 2,
          }),
        },
      },
      {
        date: "2026-04-21",
        metrics: {
          ...bucket({ eligibleRuns: 6 }),
          calibration: calibration({
            brierScore: 0.2,
            scoredInjections: 3,
            candidatesSeen: 6,
            candidatesShown: 3,
            candidatesFiltered: 3,
            candidateFilterRate: 0.5,
          }),
        },
      },
    ];
    const window = foldImpactWindow({
      afterTs: "2026-04-20T00:00:00.000Z",
      beforeTs: "2026-04-22T00:00:00.000Z",
      buckets,
    });
    expect(window.totals.calibration?.brierScore).toBeCloseTo(0.16);
    expect(window.totals.calibration?.auc).toBeCloseTo(0.7);
    expect(window.totals.calibration?.scoredInjections).toBe(5);
    expect(window.totals.calibration?.refitCount).toBe(1);
    expect(window.totals.calibration?.lastRefitAt).toBe(10);
    expect(window.totals.calibration?.candidateFilterRate).toBeCloseTo(0.5);
    expect(window.totals.calibration?.driftInjectionCount).toBe(1);
    expect(window.totals.calibration?.driftPatternsInjected).toBe(2);
  });
});

describe("parseUsageMetrics calibration field", () => {
  const VALID_CALIBRATION = {
    brierScore: 0.12,
    auc: 0.74,
    scoredInjections: 10,
    refitCount: 1,
    lastRefitAt: 123,
    candidatesSeen: 20,
    candidatesShown: 8,
    candidatesFiltered: 12,
    candidateFilterRate: 0.6,
    driftInjectionCount: 2,
    driftPatternsInjected: 3,
  };

  it("preserves a valid calibration block", () => {
    const parsed = parseUsageMetrics({
      ...(bucket({ eligibleRuns: 1 }) as unknown as Record<string, unknown>),
      calibration: VALID_CALIBRATION,
    });
    expect(parsed?.calibration).toEqual(VALID_CALIBRATION);
  });

  it("rejects malformed calibration blocks", () => {
    const parsed = parseUsageMetrics({
      ...(bucket({ eligibleRuns: 1 }) as unknown as Record<string, unknown>),
      calibration: { ...VALID_CALIBRATION, brierScore: "low" },
    });
    expect(parsed).toBeNull();
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

/**
 * Construct a schema-valid sample for an installation. The metrics
 * payload passes `parseUsageMetrics` unchanged so `validateSamples`
 * accepts it in tests that exercise the full pipeline.
 */
function sampleFor(
  installationId: string,
  dateIso = "2026-04-20T00:00:00.000Z",
): ControlPlaneUsageSample {
  return {
    id: `s-${installationId}-${dateIso}`,
    workspaceId: "ws-1",
    installationId,
    windowStart: dateIso,
    windowEnd: dateIso,
    metrics: bucket({}) as unknown as Record<string, unknown>,
    receivedAt: dateIso,
  };
}

/** Validated-sample convenience for contributor-count tests. */
function validatedFor(
  installationId: string,
  dateIso = "2026-04-20T00:00:00.000Z",
): ValidatedSample {
  const source = sampleFor(installationId, dateIso);
  const metrics = parseUsageMetrics(source.metrics);
  if (!metrics) throw new Error("test fixture produced an invalid metrics payload");
  return { source, metrics };
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
    const samples = [validatedFor("inst-a"), validatedFor("inst-b")];
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
    const samples = [
      validatedFor("inst-a"),
      validatedFor("inst-a", "2026-04-21T00:00:00.000Z"),
      validatedFor("inst-b"),
    ];
    const result = countContributorsInWindow(samples, installations);
    expect(result).toEqual({ projects: 1, installations: 2 });
  });

  it("includes unresolved installation ids in the installation count without fabricating a project membership", () => {
    const installations = [inst("inst-a", "proj-A")];
    // An orphaned installationId (e.g. install was removed) still
    // counts toward contributors — refusing to forget the sample is
    // honest — but we will not invent a project for it.
    const samples = [validatedFor("inst-a"), validatedFor("inst-gone")];
    const result = countContributorsInWindow(samples, installations);
    expect(result).toEqual({ projects: 1, installations: 2 });
  });
});

describe("filterSamplesByScope guardrail", () => {
  it("keeps the scope tag authoritative — scope=agent rows do not leak into a workspace-scope fold", () => {
    // Phase 2 introduces scope="agent" samples alongside the
    // workspace-scope ones. The Impact route must key off the
    // filtered set; a downstream consumer that forgets to filter
    // must not silently include the agent rows in workspace totals.
    const workspaceSample: ControlPlaneUsageSample = {
      id: "s1",
      workspaceId: "ws-1",
      installationId: "inst-a",
      windowStart: "2026-04-20T00:00:00.000Z",
      windowEnd: "2026-04-21T00:00:00.000Z",
      metrics: bucket({ eligibleRuns: 3 }) as unknown as Record<string, unknown>,
      receivedAt: "2026-04-20T00:00:00.000Z",
    };
    const agentSample: ControlPlaneUsageSample = {
      id: "s2",
      workspaceId: "ws-1",
      installationId: "inst-b",
      windowStart: "2026-04-20T00:00:00.000Z",
      windowEnd: "2026-04-21T00:00:00.000Z",
      metrics: {
        ...bucket({ eligibleRuns: 99 }),
        scope: "agent",
      } as unknown as Record<string, unknown>,
      receivedAt: "2026-04-20T00:00:00.000Z",
    };
    const all = [workspaceSample, agentSample];

    const workspaceOnly = filterSamplesByScope(all, "workspace");
    expect(workspaceOnly).toHaveLength(1);
    expect(workspaceOnly[0]?.id).toBe("s1");

    // Both page consumers must feed from the same filtered and
    // validated set. Buckets should only see the workspace sample;
    // contributor count must reflect a single contributing
    // installation — not two.
    const validated = validateSamples(workspaceOnly);
    const buckets = toDailyBuckets(validated);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.metrics.observed.eligibleRuns).toBe(3);

    const installations = [inst("inst-a", "proj-A"), inst("inst-b", "proj-B")];
    const contributors = countContributorsInWindow(validated, installations);
    expect(contributors).toEqual({ projects: 1, installations: 1 });
  });

  it("extractWorkspaceSamples stays equivalent to filter + validate + bucket for back-compat", () => {
    const samples: ControlPlaneUsageSample[] = [
      {
        id: "s1",
        workspaceId: "ws",
        installationId: "inst-a",
        windowStart: "2026-04-20T00:00:00.000Z",
        windowEnd: "2026-04-21T00:00:00.000Z",
        metrics: bucket({ eligibleRuns: 2 }) as unknown as Record<string, unknown>,
        receivedAt: "2026-04-20T00:00:00.000Z",
      },
    ];
    const legacy = extractWorkspaceSamples(samples);
    const split = toDailyBuckets(
      validateSamples(filterSamplesByScope(samples, "workspace")),
    );
    expect(legacy).toEqual(split);
  });
});

describe("validateSamples — schema drift guard", () => {
  it("drops rows whose metrics fail the UsageMetrics schema", () => {
    const good: ControlPlaneUsageSample = {
      id: "good",
      workspaceId: "ws",
      installationId: "inst-a",
      windowStart: "2026-04-20T00:00:00.000Z",
      windowEnd: "2026-04-21T00:00:00.000Z",
      metrics: bucket({ eligibleRuns: 4 }) as unknown as Record<string, unknown>,
      receivedAt: "2026-04-20T00:00:00.000Z",
    };
    const bad: ControlPlaneUsageSample = {
      id: "bad",
      workspaceId: "ws",
      installationId: "inst-b",
      windowStart: "2026-04-20T00:00:00.000Z",
      windowEnd: "2026-04-21T00:00:00.000Z",
      // Missing observed/estimated/integrity — parser must reject.
      metrics: { scope: "workspace", window: {} } as Record<string, unknown>,
      receivedAt: "2026-04-20T00:00:00.000Z",
    };
    const validated = validateSamples([good, bad]);
    expect(validated).toHaveLength(1);
    expect(validated[0]?.source.id).toBe("good");
  });

  it("is the single truth for both fold and contributor count — an invalid row cannot appear in one without the other", () => {
    // This is the P2 the reviewer flagged: contributor counts used
    // to key off scope-filtered raw samples while buckets keyed off
    // parse-filtered rows. Now both consume `validated`, so an
    // invalid metrics payload drops from both at once.
    const good: ControlPlaneUsageSample = {
      id: "good",
      workspaceId: "ws",
      installationId: "inst-a",
      windowStart: "2026-04-20T00:00:00.000Z",
      windowEnd: "2026-04-21T00:00:00.000Z",
      metrics: bucket({ eligibleRuns: 2 }) as unknown as Record<string, unknown>,
      receivedAt: "2026-04-20T00:00:00.000Z",
    };
    const badScopeWorkspaceButInvalidPayload: ControlPlaneUsageSample = {
      id: "bad",
      workspaceId: "ws",
      installationId: "inst-b",
      windowStart: "2026-04-20T00:00:00.000Z",
      windowEnd: "2026-04-21T00:00:00.000Z",
      // scope is workspace (so filterSamplesByScope keeps it), but
      // the rest of the shape is broken.
      metrics: { scope: "workspace", garbage: true } as Record<string, unknown>,
      receivedAt: "2026-04-20T00:00:00.000Z",
    };
    const all = [good, badScopeWorkspaceButInvalidPayload];
    const filtered = filterSamplesByScope(all, "workspace");
    expect(filtered).toHaveLength(2);

    const validated = validateSamples(filtered);
    expect(validated).toHaveLength(1);
    expect(validated[0]?.source.id).toBe("good");

    const buckets = toDailyBuckets(validated);
    const contributors = countContributorsInWindow(validated, [
      inst("inst-a", "proj-A"),
      inst("inst-b", "proj-B"),
    ]);
    // Both sides agree: one contributing installation, one bucket.
    // The invalid row is not counted as a contributor even though
    // it had a matching workspace scope and a resolvable project.
    expect(buckets).toHaveLength(1);
    expect(contributors).toEqual({ projects: 1, installations: 1 });
  });
});

describe("parseUsageMetrics — schema gate for ingest + dashboard read", () => {
  const VALID = bucket({ eligibleRuns: 1 });

  it("accepts a well-formed payload", () => {
    const parsed = parseUsageMetrics(VALID as unknown as Record<string, unknown>);
    expect(parsed).not.toBeNull();
    expect(parsed?.scope).toBe("workspace");
  });

  it("rejects null / non-object / missing branches", () => {
    expect(parseUsageMetrics(null)).toBeNull();
    expect(parseUsageMetrics(undefined)).toBeNull();
    expect(parseUsageMetrics("not-an-object")).toBeNull();
    expect(parseUsageMetrics({})).toBeNull();
    expect(
      parseUsageMetrics({ scope: "workspace", observed: {} } as Record<string, unknown>),
    ).toBeNull();
  });

  it("rejects unknown scope values", () => {
    const payload = {
      ...VALID,
      scope: "everyone",
    } as unknown as Record<string, unknown>;
    expect(parseUsageMetrics(payload)).toBeNull();
  });

  it("rejects non-numeric observed fields", () => {
    const payload = {
      ...VALID,
      observed: { ...VALID.observed, eligibleRuns: "many" },
    } as unknown as Record<string, unknown>;
    expect(parseUsageMetrics(payload)).toBeNull();
  });
});

describe("parseUsageMetrics — Phase 3.3 causal field", () => {
  const VALID_CAUSAL = {
    assisted: { n: 100, resolved: 70, resolvedRate: 0.7 },
    holdout:  { n: 100, resolved: 55, resolvedRate: 0.55 },
    resolvedLift: 0.15,
    tokensLift: { value: 400, sampleSize: 100, formula: "f1" },
    latencyLift: { value: 1200, sampleSize: 100, formula: "f2" },
    minCohortSize: 30,
  };

  function withCausal(causal: unknown): Record<string, unknown> {
    return {
      ...(bucket({ eligibleRuns: 1 }) as unknown as Record<string, unknown>),
      causal,
    };
  }

  it("preserves a valid causal block end-to-end on the dashboard read path", () => {
    // Regression: before 3.3.1 the parser silently dropped `causal`.
    // A valid Phase 3.3 payload would round-trip through the
    // dashboard with its causal data gone, breaking the whole
    // point of the assisted-vs-holdout comparison.
    const parsed = parseUsageMetrics(withCausal(VALID_CAUSAL));
    expect(parsed).not.toBeNull();
    expect(parsed?.causal).toEqual(VALID_CAUSAL);
  });

  it("accepts a payload without `causal` (Phase 1 / 2 clients stay valid)", () => {
    // Back-compat guarantee: the old client doesn't know about
    // causal. Its payload must parse cleanly and produce a
    // UsageMetrics with `causal` undefined.
    const parsed = parseUsageMetrics(bucket({ eligibleRuns: 1 }) as unknown as Record<string, unknown>);
    expect(parsed).not.toBeNull();
    expect(parsed?.causal).toBeUndefined();
  });

  it("rejects a payload whose causal.assisted is missing required fields", () => {
    const broken = {
      ...VALID_CAUSAL,
      assisted: { n: 100 /* no resolved, no resolvedRate */ },
    };
    expect(parseUsageMetrics(withCausal(broken))).toBeNull();
  });

  it("rejects a payload whose causal.holdout has a non-numeric resolvedRate (not null)", () => {
    const broken = {
      ...VALID_CAUSAL,
      holdout: { n: 100, resolved: 55, resolvedRate: "high" },
    };
    expect(parseUsageMetrics(withCausal(broken))).toBeNull();
  });

  it("rejects a payload whose causal.tokensLift is malformed", () => {
    // tokensLift must be a UsageEstimate: { value, sampleSize,
    // formula }. Providing a plain number here is the most common
    // drift shape; parser must reject it.
    const broken = {
      ...VALID_CAUSAL,
      tokensLift: 400,
    };
    expect(parseUsageMetrics(withCausal(broken))).toBeNull();
  });

  it("rejects a payload whose causal.tokensLift.sampleSize is missing", () => {
    const broken = {
      ...VALID_CAUSAL,
      tokensLift: { value: 400, formula: "f" },
    };
    expect(parseUsageMetrics(withCausal(broken))).toBeNull();
  });

  it("rejects a payload whose causal.resolvedLift is a string", () => {
    const broken = { ...VALID_CAUSAL, resolvedLift: "0.15" };
    expect(parseUsageMetrics(withCausal(broken))).toBeNull();
  });

  it("accepts a valid causal block with null lift fields (below-cohort state)", () => {
    const smallCohort = {
      assisted: { n: 3, resolved: 3, resolvedRate: 1 },
      holdout:  { n: 2, resolved: 1, resolvedRate: 0.5 },
      resolvedLift: null,
      tokensLift:  { value: null, sampleSize: 2, formula: "pending" },
      latencyLift: { value: null, sampleSize: 2, formula: "pending" },
      minCohortSize: 30,
    };
    const parsed = parseUsageMetrics(withCausal(smallCohort));
    expect(parsed?.causal).toEqual(smallCohort);
  });

  it("rejects a payload where causal itself is not an object", () => {
    expect(parseUsageMetrics(withCausal("yes"))).toBeNull();
    expect(parseUsageMetrics(withCausal(null))).toBeNull();
  });

  it("rejects a malformed causal block even when observed/estimated are well-formed", () => {
    // Drift shape the reviewer explicitly named: a caller submits
    // good observed data wrapped around garbage causal data. The
    // ingest gate must reject the whole payload so the server
    // never stores something the dashboard would choke on later.
    const obviouslyGood = bucket({ eligibleRuns: 50, injectedRuns: 40, helpfulRuns: 25 });
    const garbage: Record<string, unknown> = {
      ...(obviouslyGood as unknown as Record<string, unknown>),
      causal: { this: "is", not: "a", cohort: true },
    };
    expect(parseUsageMetrics(garbage)).toBeNull();
  });
});

describe("validateSamples — causal field round-trip", () => {
  it("preserves the causal block on the ValidatedSample.metrics once the parser accepts it", () => {
    const metricsWithCausal = {
      ...(bucket({ eligibleRuns: 1 })),
      causal: {
        assisted: { n: 40, resolved: 28, resolvedRate: 0.7 },
        holdout:  { n: 40, resolved: 20, resolvedRate: 0.5 },
        resolvedLift: 0.2,
        tokensLift:  { value: 800, sampleSize: 40, formula: "f1" },
        latencyLift: { value: 2400, sampleSize: 40, formula: "f2" },
        minCohortSize: 30,
      },
    };
    const sample: ControlPlaneUsageSample = {
      id: "s-causal",
      workspaceId: "ws-1",
      installationId: "inst-a",
      windowStart: "2026-04-20T00:00:00.000Z",
      windowEnd: "2026-04-21T00:00:00.000Z",
      metrics: metricsWithCausal as unknown as Record<string, unknown>,
      receivedAt: "2026-04-20T00:00:00.000Z",
    };
    const validated = validateSamples([sample]);
    expect(validated).toHaveLength(1);
    expect(validated[0]?.metrics.causal?.assisted.n).toBe(40);
    expect(validated[0]?.metrics.causal?.resolvedLift).toBeCloseTo(0.2);
  });

  it("drops the whole sample (not just the causal) when causal fails validation", () => {
    const sample: ControlPlaneUsageSample = {
      id: "s-broken",
      workspaceId: "ws-1",
      installationId: "inst-a",
      windowStart: "2026-04-20T00:00:00.000Z",
      windowEnd: "2026-04-21T00:00:00.000Z",
      metrics: {
        ...(bucket({ eligibleRuns: 1 })),
        causal: { assisted: "no" },
      } as unknown as Record<string, unknown>,
      receivedAt: "2026-04-20T00:00:00.000Z",
    };
    const validated = validateSamples([sample]);
    expect(validated).toHaveLength(0);
  });
});
