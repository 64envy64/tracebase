import type { Metadata } from "next";
import { OverviewView } from "@/components/dashboard/OverviewView";
import { getAuthenticatedDashboardBootstrap } from "@/lib/control-plane/server";

export const metadata: Metadata = {
  title: "Overview — TraceBase",
  description: "Workspace overview, wiring counts, and architecture loop.",
};

export default async function DashboardOverviewPage() {
  const bootstrap = await getAuthenticatedDashboardBootstrap();
  return <OverviewView bootstrap={bootstrap} />;
}
