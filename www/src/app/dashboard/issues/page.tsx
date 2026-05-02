import type { Metadata } from "next";
import { IssuesView } from "@/components/engineering-brain/IssuesView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";

export const metadata: Metadata = {
  title: "Issues — TraceBase",
  description: "Ingested GitHub issues, PRs, and CI failures with citable Issue Briefs.",
};

export default async function IssuesPage() {
  const { brain } = await getAuthenticatedEngineeringBrainBootstrap();
  return (
    <IssuesView
      integrations={brain.integrations}
      items={brain.githubItems}
      memoryStatuses={brain.memoryStatuses}
    />
  );
}
