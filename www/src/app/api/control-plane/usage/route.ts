/**
 * GET /api/control-plane/usage
 *
 * Dashboard-side read of rolled-up UsageMetrics samples for the
 * authenticated user's personal workspace. Never recomputes metrics
 * server-side — it just returns whatever the CLI pushed, so the
 * dashboard is a thin visibility layer on top of the append-only
 * event log.
 *
 * Optional querystring params:
 *   after, before — ISO timestamps bounding the returned samples.
 */
import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getControlPlaneStore } from "@/lib/control-plane/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const user = await currentUser();
  const store = await getControlPlaneStore();
  const workspace = await store.ensurePersonalWorkspaceForUser({
    clerkUserId: userId,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
  });

  const url = new URL(req.url);
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");

  const samples = await store.listUsageSamples({
    workspaceId: workspace.id,
    ...(after ? { afterTs: after } : {}),
    ...(before ? { beforeTs: before } : {}),
  });
  const installations = await store.listInstallations(workspace.id);

  return NextResponse.json({
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      displayName: workspace.displayName,
      scope: workspace.scope,
    },
    installations,
    samples,
  });
}
