import type { Metadata } from "next";
import { MemoryView, type FindingRow } from "@/components/dashboard/MemoryView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";
import { isDemoMode } from "@/lib/demo/demo-mode";

export const metadata: Metadata = {
  title: "Memory — TraceBase",
  description: "Codebase findings — facts your agents have learned about specific files and modules.",
};

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const demo = isDemoMode({ searchParams: sp });

  if (demo) {
    const fixture = getDataInfraFixture();
    const findings: FindingRow[] = fixture.findings.map((f) => ({
      id: f.id,
      codebase: f.codebase,
      filePath: f.filePath,
      type: f.type,
      body: f.body,
      createdAt: f.createdIso,
      lastUsedAt: f.lastUsedIso,
    }));
    return (
      <MemoryView
        findings={findings}
        codebases={fixture.codebases.map((c) => ({
          name: c.name,
          description: c.description,
        }))}
        demo
      />
    );
  }

  const { brain } = await getAuthenticatedEngineeringBrainBootstrap();
  // Real data path: adapt MemoryStatusRecord into the finding-like
  // shape the view expects. Provenance hints map to finding types so
  // the UI reads consistently regardless of source: a memory distilled
  // from a successful agent run is a "pattern"; a manually-curated
  // memory pointed at a specific file is a "note"; superseded /
  // retired statuses surface as "bug" (the prior guidance was wrong
  // about something) so the type chip carries signal beyond a generic
  // catch-all.
  const findings: FindingRow[] = brain.memoryStatuses.map((m) => ({
    id: m.memoryId,
    codebase: "workspace",
    filePath: m.trigSituation ?? "—",
    type:
      m.status === "superseded" || m.status === "retired"
        ? "bug"
        : m.provenanceKind === "agent_run"
          ? "pattern"
          : "note",
    body: m.bodyPreview ?? "(no body preview)",
    createdAt: m.createdAt,
    lastUsedAt: m.updatedAt,
  }));
  return (
    <MemoryView
      findings={findings}
      codebases={[
        { name: "workspace", description: "Memories scoped to this workspace." },
      ]}
      demo={false}
    />
  );
}
