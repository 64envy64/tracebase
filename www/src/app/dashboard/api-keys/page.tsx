import type { Metadata } from "next";
import { ApiKeysView } from "@/components/dashboard/ApiKeysView";
import { getAuthenticatedDashboardBootstrap } from "@/lib/control-plane/server";

export const metadata: Metadata = {
  title: "API keys — TraceBase",
  description: "Create and list workspace API keys for CI and browserless installs.",
};

export default async function DashboardApiKeysPage() {
  const bootstrap = await getAuthenticatedDashboardBootstrap();
  return <ApiKeysView initialData={bootstrap} />;
}
