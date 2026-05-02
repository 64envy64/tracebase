import type { Metadata } from "next";
import { GraphPage } from "@/components/engineering-brain/EngineeringGraph";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";

export const metadata: Metadata = {
  title: "Graph — TraceBase",
  description: "Engineering Brain graph: GitHub × agents × memory.",
};

export default async function GraphRoutePage() {
  const { brain } = await getAuthenticatedEngineeringBrainBootstrap();
  return (
    <GraphPage
      agents={brain.agents}
      runs={brain.agentRuns}
      githubItems={brain.githubItems}
      memoryStatuses={brain.memoryStatuses}
      memoryEvents={brain.memoryEvents}
    />
  );
}
