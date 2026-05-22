import type { Metadata } from "next";
import { auth, currentUser } from "@clerk/nextjs/server";
import {
  ImpactView,
  parseWindowKey,
  windowKeyToRange,
} from "@/components/dashboard/ImpactView";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import {
  countContributorsInWindow,
  filterSamplesByScope,
  foldImpactWindow,
  toDailyBuckets,
  validateSamples,
  type ImpactWindow,
} from "@/lib/control-plane/usage";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";
import { isDemoMode } from "@/lib/demo/demo-mode";
import type { UsageMetrics } from "@/lib/usage/types";

export const metadata: Metadata = {
  title: "Impact - TraceBase",
  description:
    "Workspace-level reasoning-reuse metrics, rolled up from the contributors in the selected window.",
};

function buildDemoWindow(): { window: ImpactWindow; projects: number; installations: number } {
  const fixture = getDataInfraFixture();
  const { impact } = fixture;

  const dayMs = 86_400_000;
  const beforeTs = new Date().toISOString();
  const afterTs = new Date(Date.parse(beforeTs) - 7 * dayMs).toISOString();

  const eligibleRuns = impact.runs7d;
  const recalledRuns = Math.round(eligibleRuns * 0.92);
  const injectedRuns = eligibleRuns;
  const usedRuns = Math.round(eligibleRuns * 0.81);
  const helpfulRuns = impact.helpfulRuns7d;

  const impactByDate = new Map(impact.dailyImpact.map((d) => [d.date, d]));
  const buckets = impact.dailyRuns.map((d) => {
    const bucketInjected = d.runs;
    const bucketImpact = impactByDate.get(d.date);
    return {
      date: d.date,
      metrics: {
        scope: "workspace" as const,
        window: {
          afterTs: Date.parse(d.date),
          beforeTs: Date.parse(d.date) + dayMs,
        },
        observed: {
          eligibleRuns: bucketInjected,
          recalledRuns: Math.round(bucketInjected * 0.92),
          injectedRuns: bucketInjected,
          usedRuns: Math.round(bucketInjected * 0.81),
          helpfulRuns: d.helpful,
          resolvedRateWithMemory: bucketInjected > 0 ? d.helpful / bucketInjected : null,
        },
        estimated: {
          tokensSaved: {
            value: Math.round((impact.tokensSaved7d / impact.runs7d) * bucketInjected),
            sampleSize: bucketInjected,
            formula: "(mean(held-out tokens) - mean(assisted tokens)) x injected runs",
          },
          latencySavedMs: {
            value: (bucketImpact?.minutesSaved ?? bucketInjected * 1.5) * 60_000,
            sampleSize: bucketInjected,
            formula: "(mean(held-out API time) - mean(assisted API time)) x injected runs",
          },
        },
        integrity: {
          shadowControlMismatches: 0,
          outcomesWithoutRetrieval: 0,
        },
      } as UsageMetrics,
    };
  });

  const totals: UsageMetrics = {
    scope: "workspace",
    window: {
      afterTs: Date.parse(afterTs),
      beforeTs: Date.parse(beforeTs),
    },
    observed: {
      eligibleRuns,
      recalledRuns,
      injectedRuns,
      usedRuns,
      helpfulRuns,
      resolvedRateWithMemory: injectedRuns > 0 ? helpfulRuns / injectedRuns : null,
    },
    estimated: {
      tokensSaved: {
        value: impact.tokensSaved7d,
        sampleSize: injectedRuns,
        formula: "(mean(held-out tokens) - mean(assisted tokens)) x injected runs",
      },
      latencySavedMs: {
        value: impact.apiTimeSaved7dMin * 60_000,
        sampleSize: injectedRuns,
        formula: "(mean(held-out API time) - mean(assisted API time)) x injected runs",
      },
    },
    causal: {
      assisted: {
        n: 64,
        resolved: 56,
        resolvedRate: 56 / 64,
      },
      holdout: {
        n: 64,
        resolved: 43,
        resolvedRate: 43 / 64,
      },
      resolvedLift: 56 / 64 - 43 / 64,
      tokensLift: {
        value: 1_780,
        sampleSize: 64,
        formula: "mean(held-out tokens) - mean(assisted tokens)",
      },
      latencyLift: {
        value: 26_000,
        sampleSize: 64,
        formula: "mean(held-out API time) - mean(assisted API time)",
      },
      minCohortSize: 30,
    },
    calibration: {
      brierScore: 0.118,
      auc: 0.81,
      scoredInjections: 151,
      refitCount: 3,
      lastRefitAt: Date.now() - 18 * 3_600_000,
      candidatesSeen: 412,
      candidatesShown: 151,
      candidatesFiltered: 261,
      candidateFilterRate: 261 / 412,
      driftInjectionCount: 7,
      driftPatternsInjected: 9,
    },
    integrity: {
      shadowControlMismatches: 0,
      outcomesWithoutRetrieval: 0,
    },
  };

  return {
    window: { afterTs, beforeTs, totals, buckets },
    projects: fixture.codebases.length,
    installations: fixture.installations.length,
  };
}

export default async function DashboardImpactPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; demo?: string }>;
}) {
  const params = await searchParams;
  const windowKey = parseWindowKey(params.window);
  const demo = isDemoMode({ searchParams: params });

  if (demo) {
    const { window, projects, installations } = buildDemoWindow();
    return (
      <ImpactView
        window={window}
        windowKey={windowKey}
        projectsCount={projects}
        installationsCount={installations}
        demo
      />
    );
  }

  const { userId } = await auth();
  if (!userId) throw new Error("Authentication required");

  const range = windowKeyToRange(windowKey);

  const user = await currentUser();
  const store = await getControlPlaneStore();
  const workspace = await store.ensurePersonalWorkspaceForUser({
    clerkUserId: userId,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
  });

  const [rawSamples, installations] = await Promise.all([
    store.listUsageSamples({
      workspaceId: workspace.id,
      afterTs: range.afterTs,
      beforeTs: range.beforeTs,
    }),
    store.listInstallations(workspace.id),
  ]);

  const workspaceSamples = filterSamplesByScope(rawSamples, "workspace");
  const validated = validateSamples(workspaceSamples);
  const buckets = toDailyBuckets(validated);
  const window = foldImpactWindow({
    afterTs: range.afterTs,
    beforeTs: range.beforeTs,
    buckets,
  });

  const contributors = countContributorsInWindow(validated, installations);

  return (
    <ImpactView
      window={window}
      windowKey={windowKey}
      projectsCount={contributors.projects}
      installationsCount={contributors.installations}
      demo={false}
    />
  );
}
