import type { Metadata } from "next";
import { TeamView, type TeamMemberRow } from "@/components/dashboard/TeamView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";
import { isDemoMode } from "@/lib/demo/demo-mode";
import type { AgentHost } from "@/lib/control-plane/types";

export const metadata: Metadata = {
  title: "Team — TraceBase",
  description: "People in this workspace and the agents tied to each.",
};

function adaptHostToFramework(
  host: AgentHost,
): "claude-code" | "cursor" | "codex" | "openai" | "anthropic" | "other" {
  if (host === "claude-code") return "claude-code";
  if (host === "cursor") return "cursor";
  if (host === "codex") return "codex";
  if (host === "openai") return "openai";
  if (host === "anthropic") return "anthropic";
  return "other";
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const demo = isDemoMode({ searchParams: sp });

  if (demo) {
    const fixture = getDataInfraFixture();
    const members: TeamMemberRow[] = fixture.team.map((t) => ({
      name: t.name,
      role: t.role,
      agents: fixture.agents
        .filter((a) => a.user === t.name)
        .map((a) => ({
          displayName: a.displayName,
          framework: a.framework,
          status: a.status,
          lastSeenAt: a.lastSeenIso,
          totalRuns: a.totalRuns,
        })),
    }));
    return <TeamView members={members} currentName={null} demo />;
  }

  const { brain, owner } = await getAuthenticatedEngineeringBrainBootstrap();
  const byOwner = new Map<string, TeamMemberRow>();
  for (const a of brain.agents) {
    const label = a.ownerLabel ?? "(unassigned)";
    const existing = byOwner.get(label);
    const agentRow = {
      displayName: a.displayName,
      framework: adaptHostToFramework(a.host),
      status: a.status === "active" ? ("active" as const) : ("idle" as const),
      lastSeenAt: a.updatedAt,
      totalRuns: brain.agentRuns.filter((r) => r.agentId === a.id).length,
    };
    if (existing) {
      existing.agents.push(agentRow);
    } else {
      byOwner.set(label, {
        name: label,
        role: label === owner.label ? "Workspace owner" : "Engineer",
        agents: [agentRow],
      });
    }
  }
  return <TeamView members={Array.from(byOwner.values())} currentName={owner.label} demo={false} />;
}
