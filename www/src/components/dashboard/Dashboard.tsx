"use client";

import { DashboardView } from "@/components/dashboard/DashboardView";
import { DashboardStateProvider } from "@/components/dashboard/state/DashboardStateContext";

export function Dashboard() {
  return (
    <DashboardStateProvider>
      <DashboardView />
    </DashboardStateProvider>
  );
}
