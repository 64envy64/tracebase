import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { ClerkBoundary } from "@/components/auth/ClerkBoundary";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { isDemoModeFromEnv } from "@/lib/demo/demo-mode";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const demoMode = isDemoModeFromEnv() || requestHeaders.get("x-tracebase-demo") === "1";

  if (!demoMode) {
    await auth.protect({ unauthenticatedUrl: "/login" });
  }

  const shell = <DashboardShell demoMode={demoMode}>{children}</DashboardShell>;

  return demoMode ? shell : <ClerkBoundary>{shell}</ClerkBoundary>;
}
