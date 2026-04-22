import type { Metadata } from "next";
import { auth, currentUser } from "@clerk/nextjs/server";
import {
  ImpactView,
  parseWindowKey,
  windowKeyToRange,
} from "@/components/dashboard/ImpactView";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import {
  extractWorkspaceSamples,
  foldImpactWindow,
} from "@/lib/control-plane/usage";

export const metadata: Metadata = {
  title: "Impact — TraceBase",
  description:
    "Project-level reasoning-reuse metrics across every adapter in the workspace. Rolled-up observations with explicit estimate labels; no per-adapter attribution until Phase 2.",
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

  return (
    <ImpactView
      window={window}
      windowKey={windowKey}
      installationsCount={installations.length}
    />
  );
}
