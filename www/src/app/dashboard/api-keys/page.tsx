import type { Metadata } from "next";
import { ApiKeysView } from "@/components/dashboard/ApiKeysView";
import { getAuthenticatedDashboardBootstrap } from "@/lib/control-plane/server";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";
import { isDemoMode } from "@/lib/demo/demo-mode";

export const metadata: Metadata = {
  title: "API keys — TraceBase",
  description: "Create and list workspace API keys for CI and browserless installs.",
};

export default async function DashboardApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const demo = isDemoMode({ searchParams: sp });

  if (demo) {
    const fixture = getDataInfraFixture();
    // Re-use timestamps already baked into the fixture so the API-keys
    // page renders against the same anchor as Overview / Runs / etc.
    // and doesn't drift after long server uptime.
    const nikaInstall =
      fixture.installations.find((i) => i.user === "Nika") ?? fixture.installations[0];
    const amirInstall =
      fixture.installations.find((i) => i.user === "Amir") ?? fixture.installations[1];
    const tomasInstall =
      fixture.installations.find((i) => i.user === "Tomas") ?? fixture.installations[2];
    const mayaInstall =
      fixture.installations.find((i) => i.user === "Maya") ?? fixture.installations[3];
    const demoData = {
      apiBaseUrl: "https://api.tracebase.ai",
      workspace: {
        id: "demo-workspace-data-infra",
        scope: "personal" as const,
        slug: "data-infra-pilot",
        displayName: fixture.workspaceDisplayName,
        createdAt: nikaInstall.linkedIso,
        updatedAt: nikaInstall.updatedIso,
      },
      apiKeys: [
        {
          id: "demo-key-ledger-prod",
          workspaceId: "demo-workspace-data-infra",
          label: "ledger-pipeline prod hook",
          prefix: "tb_live",
          last4: "9c4f",
          createdAt: nikaInstall.linkedIso,
          lastUsedAt: nikaInstall.updatedIso,
        },
        {
          id: "demo-key-cdc-nightly",
          workspaceId: "demo-workspace-data-infra",
          label: "cdc-sync nightly replay CI",
          prefix: "tb_live",
          last4: "1a8e",
          createdAt: mayaInstall.linkedIso,
          lastUsedAt: mayaInstall.updatedIso,
        },
        {
          id: "demo-key-warehouse-release",
          workspaceId: "demo-workspace-data-infra",
          label: "warehouse release checks",
          prefix: "tb_live",
          last4: "44d7",
          createdAt: amirInstall.linkedIso,
          lastUsedAt: amirInstall.updatedIso,
        },
        {
          id: "demo-key-backfill-runner",
          workspaceId: "demo-workspace-data-infra",
          label: "backfill-runner headless ops",
          prefix: "tb_live",
          last4: "f63b",
          createdAt: tomasInstall.linkedIso,
          lastUsedAt: tomasInstall.updatedIso,
        },
      ],
      installations: [],
    };
    return <ApiKeysView initialData={demoData} demo />;
  }

  const bootstrap = await getAuthenticatedDashboardBootstrap();
  return <ApiKeysView initialData={bootstrap} demo={false} />;
}
