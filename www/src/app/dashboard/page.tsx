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

export const metadata: Metadata = {
  title: "Overview — TraceBase",
  description: "Tasks helped, memories used, tokens saved — at a glance.",
};

/**
 * Resolve the same 30-day window the /dashboard/impact page uses by
 * default, so the Overview's top-row metric tiles and the Impact
 * page's funnel come from the same fold of the same samples. Keeping
 * the lookup local to the page avoids exporting another helper from
 * the impact page when all we need is the range arithmetic.
 */
function defaultThirtyDayRange(): { afterTs: string; beforeTs: string } {
  const now = Date.now();
  const start = now - 30 * 86_400_000;
  return {
    afterTs: new Date(start).toISOString(),
    beforeTs: new Date(now).toISOString(),
  };
}

export default async function DashboardOverviewPage() {
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
  // Mirror the impact page's filter→validate→bucket pipeline so the
  // tiles on Overview can never disagree with the Impact view for the
  // same window.
  const workspaceSamples = filterSamplesByScope(rawSamples, "workspace");
  const validated = validateSamples(workspaceSamples);
  const buckets = toDailyBuckets(validated);
  const window = foldImpactWindow({
    afterTs: range.afterTs,
    beforeTs: range.beforeTs,
    buckets,
  });

  return <OverviewView bootstrap={bootstrap} window={window} />;
}
