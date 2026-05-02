import type { Metadata } from "next";
import { RunsView } from "@/components/engineering-brain/RunsView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";

export const metadata: Metadata = {
  title: "Runs — TraceBase",
  description: "Agent run timeline with citation-grade summaries.",
};

export default async function RunsPage() {
  const { brain } = await getAuthenticatedEngineeringBrainBootstrap();
  return (
    <RunsView
      agents={brain.agents}
      runs={brain.agentRuns}
      githubItems={brain.githubItems}
      memoryEvents={brain.memoryEvents}
    />
  );
}
