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
  extractWorkspaceSamples,
  foldImpactWindow,
} from "@/lib/control-plane/usage";

export const metadata: Metadata = {
  title: "Impact — TraceBase",
  description:
    "Workspace-level reasoning-reuse metrics, rolled up across every linked project and adapter. Per-project and per-adapter breakdowns land in Phase 2.",
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

  const buckets = extractWorkspaceSamples(rawSamples);
  const window = foldImpactWindow({
    afterTs: range.afterTs,
    beforeTs: range.beforeTs,
    buckets,
  });

  // Counts must describe *contributors to this window*, not every
  // installation the workspace has ever wired. An idle installation
  // that pushed nothing in the selected window is not part of the
  // numbers rendered below.
  const contributors = countContributorsInWindow(rawSamples, installations);

  return (
    <ImpactView
      window={window}
      windowKey={windowKey}
      projectsCount={contributors.projects}
      installationsCount={contributors.installations}
    />
  );
}
