import type { Metadata } from "next";
import { QuickstartView } from "@/components/dashboard/QuickstartView";
import { isDemoMode } from "@/lib/demo/demo-mode";

export const metadata: Metadata = {
  title: "Quickstart — TraceBase",
  description: "One-command install for Claude Code, Cursor, and Codex.",
};

export default async function DashboardQuickstartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const demo = isDemoMode({ searchParams: sp });
  return <QuickstartView demo={demo} />;
}
