import type { Metadata } from "next";
import { AgentsView } from "@/components/engineering-brain/AgentsView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";

export const metadata: Metadata = {
  title: "Agents — TraceBase",
  description: "Connected agents and their run rollups.",
};

export default async function AgentsPage() {
  const { brain } = await getAuthenticatedEngineeringBrainBootstrap();
  return (
    <AgentsView
      agents={brain.agents}
      agentRuns={brain.agentRuns}
      memoryEvents={brain.memoryEvents}
    />
  );
}
