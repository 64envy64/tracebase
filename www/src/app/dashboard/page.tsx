import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { DashboardInstallPanel } from "@/components/dashboard/DashboardInstallPanel";
import { getAuthenticatedDashboardBootstrap } from "@/lib/control-plane/server";

export const metadata: Metadata = {
  title: "Dashboard — TraceBase",
  description: "Reasoning operations: traces, reuse metrics, scopes, and governance.",
};

export default async function DashboardPage() {
  const bootstrap = await getAuthenticatedDashboardBootstrap();

  return (
    <div className="space-y-5">
      <DashboardInstallPanel initialData={bootstrap} />
      <Dashboard bootstrap={bootstrap} />
    </div>
  );
}
