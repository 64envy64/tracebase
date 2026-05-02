import type { Metadata } from "next";
import { MemoryView } from "@/components/engineering-brain/MemoryView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";

export const metadata: Metadata = {
  title: "Memory — TraceBase",
  description: "Memory governance, audit trail, and rollback.",
};

export default async function MemoryPage() {
  const { brain } = await getAuthenticatedEngineeringBrainBootstrap();
  return (
    <MemoryView
      statuses={brain.memoryStatuses}
      events={brain.memoryEvents}
      rollbacks={brain.rollbackEvents}
    />
  );
}
