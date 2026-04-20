import { auth } from "@clerk/nextjs/server";
import { DashboardShell } from "@/components/layout/DashboardShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await auth.protect();

  return <DashboardShell>{children}</DashboardShell>;
}
