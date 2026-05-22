import type { Metadata } from "next";
import { auth, currentUser } from "@clerk/nextjs/server";
import { OverviewView } from "@/components/dashboard/OverviewView";
import { getAuthenticatedDashboardBootstrap } from "@/lib/control-plane/server";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import {
  filterSamplesByScope,
  foldImpactWindow,
  toDailyBuckets,
  validateSamples,
} from "@/lib/control-plane/usage";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";
import { isDemoMode } from "@/lib/demo/demo-mode";

export const metadata: Metadata = {
  title: "Overview — TraceBase",
  description: "Tasks helped, memories used, tokens saved — at a glance.",
};

function defaultThirtyDayRange(): { afterTs: string; beforeTs: string } {
  const now = Date.now();
  const start = now - 30 * 86_400_000;
  return {
    afterTs: new Date(start).toISOString(),
    beforeTs: new Date(now).toISOString(),
  };
}

export default async function DashboardOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const demo = isDemoMode({ searchParams: sp });

  if (demo) {
    const fixture = getDataInfraFixture();
    return <OverviewView demo fixture={fixture} />;
  }

  const { userId } = await auth();
  if (!userId) throw new Error("Authentication required");

  const [bootstrap, user, store] = await Promise.all([
    getAuthenticatedDashboardBootstrap(),
    currentUser(),
    getControlPlaneStore(),
  ]);

  const workspace = await store.ensurePersonalWorkspaceForUser({
    clerkUserId: userId,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
  });

  const range = defaultThirtyDayRange();
  const rawSamples = await store.listUsageSamples({
    workspaceId: workspace.id,
    afterTs: range.afterTs,
    beforeTs: range.beforeTs,
  });
  const workspaceSamples = filterSamplesByScope(rawSamples, "workspace");
  const validated = validateSamples(workspaceSamples);
  const buckets = toDailyBuckets(validated);
  const window = foldImpactWindow({
    afterTs: range.afterTs,
    beforeTs: range.beforeTs,
    buckets,
  });

  return <OverviewView demo={false} bootstrap={bootstrap} window={window} />;
}
