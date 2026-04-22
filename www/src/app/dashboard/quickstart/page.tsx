import type { Metadata } from "next";
import { QuickstartView } from "@/components/dashboard/QuickstartView";

export const metadata: Metadata = {
  title: "Quickstart — TraceBase",
  description: "One-command install for Claude Code, Cursor, and Codex.",
};

export default function DashboardQuickstartPage() {
  return <QuickstartView />;
}
