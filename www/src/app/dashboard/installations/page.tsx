import type { Metadata } from "next";
import { InstallationsView, type InstallationRow } from "@/components/dashboard/InstallationsView";
import { getAuthenticatedDashboardBootstrap } from "@/lib/control-plane/server";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";
import { isDemoMode } from "@/lib/demo/demo-mode";

export const metadata: Metadata = {
  title: "Installations — TraceBase",
  description: "Wiring inventory — one row per (project × adapter) linked to this workspace.",
};

export default async function DashboardInstallationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const demo = isDemoMode({ searchParams: sp });

  if (demo) {
    const fixture = getDataInfraFixture();
    const rows: InstallationRow[] = fixture.installations.map((i) => ({
      id: i.id,
      projectName: i.projectName,
      adapter: i.framework,
      cliVersion: i.cliVersion,
      owner: i.user,
      createdAt: i.linkedIso,
      updatedAt: i.updatedIso,
    }));
    return <InstallationsView installations={rows} demo />;
  }

  const bootstrap = await getAuthenticatedDashboardBootstrap();
  const rows: InstallationRow[] = bootstrap.installations.map((i) => ({
    id: i.id,
    projectName: i.projectName,
    adapter: i.agent,
    cliVersion: i.cliVersion ?? "—",
    owner: "—",
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  }));
  return <InstallationsView installations={rows} demo={false} />;
}
