/**
 * Server-side helpers for Engineering Brain dashboard pages.
 *
 * Pages call `getAuthenticatedEngineeringBrainBootstrap()` to get the
 * full graph for the current Clerk user's personal workspace in one
 * round-trip. Action POSTs use `requireAuthenticatedWorkspace()` as a
 * shared auth gate.
 *
 * No tokens are ever returned in any of these payloads — see the
 * Phase-2 ingest pipeline; tokens are env-only.
 */
import "server-only";
import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import type { User } from "@clerk/nextjs/server";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import { getEngineeringBrainStore } from "@/lib/control-plane/engineering-brain";
import { ensureWorkspaceSeeded } from "@/lib/control-plane/seed-workspace";
import type {
  ControlPlaneWorkspace,
  EngineeringBrainBootstrap,
} from "@/lib/control-plane/types";

/**
 * Page-level auth gate. Used by server components rendered under
 * /dashboard/*, where Clerk's middleware already redirects unauth
 * traffic to /login — by the time a page calls this we are
 * guaranteed a session, and a missing session here is an internal
 * invariant violation that throws.
 *
 * For API routes the caller may not have a session; route handlers
 * should call `requireAuthenticatedWorkspaceForApi` instead, which
 * returns a 401 NextResponse on miss.
 */
export async function requireAuthenticatedWorkspace(): Promise<ControlPlaneWorkspace> {
  const { userId } = await auth();
  if (!userId) {
    throw new Error("Authentication required");
  }
  const user = await currentUser();
  const store = await getControlPlaneStore();
  return store.ensurePersonalWorkspaceForUser({
    clerkUserId: userId,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
  });
}

/**
 * API-route auth gate. Returns the workspace on success, or a
 * NextResponse(401) on miss. Routes must early-return when the
 * helper returns a NextResponse.
 *
 * This is the contract enforced by the Engineering Brain API
 * routes — without it an unauth caller would get a 500 with an
 * error stack instead of the well-formed 401 the dashboard
 * (and external CLI tooling) expects.
 */
export async function requireAuthenticatedWorkspaceForApi(): Promise<
  | { ok: true; workspace: ControlPlaneWorkspace }
  | { ok: false; response: NextResponse }
> {
  const { userId } = await auth();
  if (!userId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "authentication required" },
        { status: 401 },
      ),
    };
  }
  const user = await currentUser();
  const store = await getControlPlaneStore();
  const workspace = await store.ensurePersonalWorkspaceForUser({
    clerkUserId: userId,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    name: user?.fullName ?? user?.firstName ?? null,
  });
  return { ok: true, workspace };
}

/**
 * Resolve the user's preferred display name for owner-label tagging.
 * Capitalises an email-local-part fallback so a workspace owned by
 * `alikhan1212152@gmail.com` shows up as "Alikhan", not the full
 * email. Never returns an empty string.
 */
function resolveOwnerDisplayName(user: User | null, fallback: string): string {
  if (user?.fullName) return user.fullName;
  if (user?.firstName) return user.firstName;
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  if (email) {
    const local = email.split("@")[0];
    // Strip trailing digits and capitalise: "alikhan1212152" → "Alikhan".
    const cleaned = local.replace(/\d+$/g, "").replace(/[._-]+/g, " ").trim();
    if (cleaned.length > 0) {
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
  }
  return fallback;
}

export async function getAuthenticatedEngineeringBrainBootstrap(): Promise<{
  workspace: ControlPlaneWorkspace;
  brain: EngineeringBrainBootstrap;
  hasEnvToken: boolean;
  owner: { label: string };
}> {
  const workspace = await requireAuthenticatedWorkspace();
  const user = await currentUser();
  const ownerLabel = resolveOwnerDisplayName(user, "You");

  const store = await getEngineeringBrainStore();

  // First-touch seed: empty workspaces get a realistic, owner-labelled
  // graph so the dashboard reads as a working environment from minute
  // one. Idempotent — once any rows exist (real or seeded), this is a
  // no-op forever.
  await ensureWorkspaceSeeded({
    workspaceId: workspace.id,
    ownerLabel,
    store,
  });

  const [
    integrations,
    githubItems,
    agents,
    agentRuns,
    memoryStatuses,
    memoryEvents,
    rollbackEvents,
  ] = await Promise.all([
    store.listIntegrations(workspace.id),
    store.listGithubItems(workspace.id, { limit: 250 }),
    store.listAgents(workspace.id),
    store.listAgentRuns(workspace.id, { limit: 200 }),
    store.listMemoryStatuses(workspace.id),
    store.listMemoryEvents(workspace.id, { limit: 200 }),
    store.listRollbackEvents(workspace.id),
  ]);
  const brain: EngineeringBrainBootstrap = {
    integrations,
    githubItems,
    agents,
    agentRuns,
    memoryStatuses,
    memoryEvents,
    rollbackEvents,
  };
  return {
    workspace,
    brain,
    hasEnvToken: Boolean(
      process.env.TRACEBASE_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
    ),
    owner: { label: ownerLabel },
  };
}
