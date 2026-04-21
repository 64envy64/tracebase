import { auth, currentUser } from "@clerk/nextjs/server";
import { getControlPlaneApiBaseUrl, getControlPlaneStore } from "@/lib/control-plane/store";
import type { DashboardBootstrap } from "@/lib/control-plane/types";

export async function getAuthenticatedDashboardBootstrap(): Promise<DashboardBootstrap> {
  const { userId } = await auth();
  if (!userId) {
    throw new Error("Authentication required");
  }

  const user = await currentUser();
  const store = await getControlPlaneStore();
  const workspace = await store.ensurePersonalWorkspaceForUser({
    clerkUserId: userId,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
  });
  const [apiKeys, installations] = await Promise.all([
    store.listApiKeys(workspace.id),
    store.listInstallations(workspace.id),
  ]);

  return {
    apiBaseUrl: getControlPlaneApiBaseUrl(),
    workspace,
    apiKeys,
    installations,
  };
}
