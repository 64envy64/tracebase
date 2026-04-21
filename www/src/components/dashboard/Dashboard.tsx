import { DashboardView } from "@/components/dashboard/DashboardView";
import type { DashboardBootstrap } from "@/lib/control-plane/types";

export function Dashboard({ bootstrap }: { bootstrap?: DashboardBootstrap }) {
  return <DashboardView bootstrap={bootstrap} />;
}
