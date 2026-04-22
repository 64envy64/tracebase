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
} from "@/lib/control-plane/usage";

export const metadata: Metadata = {
  title: "Impact — TraceBase",
  description:
    "Workspace-level reasoning-reuse metrics, rolled up from the contributors in the selected window. Per-project and per-adapter breakdowns land in Phase 2.",
};

export default async function DashboardImpactPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) throw new Error("Authentication required");

  const params = await searchParams;
  const windowKey = parseWindowKey(params.window);
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

  // Filter + validate once, two consumers. `validated` is the
  // authoritative source for both the fold (→ totals rendered on the
  // page) and the contributor count (→ "N projects · M installs" in
  // the header). Any sample that fails `parseUsageMetrics` is
  // dropped from both at once — a row rejected by the parser cannot
  // be counted as a contributor while sitting out of the totals.
  //
  // When Phase 2 starts emitting scope="agent" samples, the filter
  // below is the only place that needs to change — the numbers and
  // the counts cannot drift apart because they both key off the
  // same filtered-and-validated set.
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
    />
  );
}
