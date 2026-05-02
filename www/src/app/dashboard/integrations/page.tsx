import type { Metadata } from "next";
import { IntegrationsView } from "@/components/engineering-brain/IntegrationsView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";

export const metadata: Metadata = {
  title: "Integrations — TraceBase",
  description: "Link a GitHub repo so agents work from cited engineering context.",
};

export default async function IntegrationsPage() {
  const { brain, hasEnvToken } = await getAuthenticatedEngineeringBrainBootstrap();
  return (
    <IntegrationsView
      integrations={brain.integrations}
      hasEnvToken={hasEnvToken}
    />
  );
}
