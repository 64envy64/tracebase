import type { Metadata } from "next";
import { RunsView, type RunRow } from "@/components/dashboard/RunsView";
import { getAuthenticatedEngineeringBrainBootstrap } from "@/lib/control-plane/engineering-brain-server";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";
import { isDemoMode } from "@/lib/demo/demo-mode";
import type { AgentHost } from "@/lib/control-plane/types";

export const metadata: Metadata = {
  title: "Runs — TraceBase",
  description: "One row per task an agent worked on — with the patterns it pulled in and the tokens it saved.",
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

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const demo = isDemoMode({ searchParams: sp });

  if (demo) {
    const fixture = getDataInfraFixture();
    const rows: RunRow[] = fixture.runs.map((r) => ({
      id: r.id,
      framework: r.framework,
      agentDisplayName: r.agentDisplayName,
      user: r.user,
      startedAt: r.startedIso,
      endedAt: r.endedIso,
      status: r.status,
      taskTitle: r.taskTitle,
      taskRepo: r.taskRepo,
      profile: r.profile,
      patternsUsed: r.patternsUsed,
      toolCalls: r.toolCalls,
      tokensSaved: r.tokensSaved,
    }));
    return <RunsView runs={rows} demo />;
  }

  const { brain } = await getAuthenticatedEngineeringBrainBootstrap();
  const agentLookup = new Map(brain.agents.map((a) => [a.id, a]));
  const rows: RunRow[] = brain.agentRuns.map((r) => {
    const agent = r.agentId ? agentLookup.get(r.agentId) : undefined;
    const framework = agent
      ? adaptHostToFramework(agent.host)
      : "other";
    return {
      id: r.id,
      framework,
      agentDisplayName: agent?.displayName ?? "(unknown agent)",
      user: agent?.ownerLabel ?? "—",
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      status: r.status,
      taskTitle: r.taskTitle ?? "(no title)",
      taskRepo: "—",
      profile: "coding",
      patternsUsed: r.recalledPatternsCount,
      toolCalls: r.toolCallsCount,
      tokensSaved: r.tokensSavedEstimated,
    };
  });
  return <RunsView runs={rows} demo={false} />;
}
