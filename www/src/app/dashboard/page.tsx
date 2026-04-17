import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard/Dashboard";

export const metadata: Metadata = {
  title: "Dashboard — TraceBase",
  description: "Reasoning operations: traces, reuse metrics, scopes, and governance.",
};

export default function DashboardPage() {
  return <Dashboard />;
}
