import type { ReactNode } from "react";
import { DashboardMobileBar } from "@/components/layout/DashboardMobileBar";
import { DashboardSidebar } from "@/components/layout/DashboardSidebar";

export function DashboardShell({
  children,
  demoMode = false,
}: {
  children: ReactNode;
  demoMode?: boolean;
}) {
  return (
    <div className="flex min-h-screen" style={{ background: "var(--bg)" }}>
      <DashboardSidebar demoMode={demoMode} />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <DashboardMobileBar demoMode={demoMode} />
        <main className="flex-1 overflow-x-hidden overflow-y-auto px-4 pb-10 pt-5 md:px-8 md:pb-12 md:pt-6 lg:px-10">
          <div className="mx-auto w-full max-w-[min(1240px,100%)]">{children}</div>
        </main>
      </div>
    </div>
  );
}
