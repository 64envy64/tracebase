import type { Metadata } from "next";
import { InstallationsView } from "@/components/dashboard/InstallationsView";
import { getAuthenticatedDashboardBootstrap } from "@/lib/control-plane/server";

export const metadata: Metadata = {
  title: "Installations — TraceBase",
  description:
    "Wiring inventory — each row is one (project × adapter) pair linked to this workspace.",
};

export default async function DashboardInstallationsPage() {
  const bootstrap = await getAuthenticatedDashboardBootstrap();
  return <InstallationsView installations={bootstrap.installations} />;
}
