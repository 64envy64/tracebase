import type { Metadata } from "next";
import { TeamView } from "@/components/engineering-brain/TeamView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";

export const metadata: Metadata = {
  title: "Team — TraceBase",
  description: "Owner-label hierarchy of agents (no auth/RBAC yet).",
};

export default async function TeamPage() {
  const { brain, owner } = await getAuthenticatedEngineeringBrainBootstrap();
  return (
    <TeamView
      agents={brain.agents}
      runs={brain.agentRuns}
      currentOwnerLabel={owner.label}
    />
  );
}
