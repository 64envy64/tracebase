import {
  EmptyState,
  MetricTile,
  PageHeader,
  StatusPill,
  SurfaceCard,
  formatRelativeTime,
} from "@/components/engineering-brain/shared";
import type {
  AgentRecord,
  AgentRunRecord,
  MemoryEventRecord,
} from "@/lib/control-plane/types";

interface Props {
  agents: AgentRecord[];
  agentRuns: AgentRunRecord[];
  memoryEvents: MemoryEventRecord[];
}

interface AgentRollup {
  agent: AgentRecord;
  totalRuns: number;
  resolvedRuns: number;
  blockedCalls: number;
  tokensSaved: number;
  memoriesUsed: number;
  memoriesCreated: number;
  lastActiveAt?: string;
}

export function AgentsView({ agents, agentRuns, memoryEvents }: Props) {
  const rollups = computeRollups(agents, agentRuns, memoryEvents);
  return (
    <section className="space-y-6" aria-label="Agents">
      <PageHeader
        eyebrow="Agents"
        title="Who&apos;s helping you"
        description={
          <>
            Every connected AI assistant — Claude Code, Codex, Cursor, or
            anything wired through the generic adapter. The numbers below are
            counts and estimates only; we never store the conversations
            themselves.
          </>
        }
      />

      <section className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Agents"
          value={agents.length}
          note={agents[0] ? `latest: ${agents[0].displayName}` : "none yet"}
        />
        <MetricTile
          label="Tasks worked on"
          value={agentRuns.length}
          note={`${rollups.reduce((s, r) => s + r.resolvedRuns, 0)} solved`}
        />
        <MetricTile
          label="Loops avoided"
          value={rollups.reduce((s, r) => s + r.blockedCalls, 0)}
          note="times the brain stopped a stuck agent"
        />
        <MetricTile
          label="Tokens saved (est.)"
          value={rollups.reduce((s, r) => s + r.tokensSaved, 0).toLocaleString()}
          note="thanks to reused lessons"
        />
      </section>

      <SurfaceCard title={`Agents · ${agents.length}`} meta={`runs ${agentRuns.length}`}>
        {agents.length === 0 ? (
          <EmptyState
            title="No agents have checked in yet"
            description="Agents register themselves the first time they help with a task. Once one does, it appears here with its activity rolled up."
          />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
            {rollups.map((row) => (
              <li
                key={row.agent.id}
                className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-[13px]" style={{ color: "var(--text)" }}>
                      {row.agent.displayName}
                    </p>
                    <StatusPill
                      status={row.agent.host}
                      tone="neutral"
                    />
                    <StatusPill
                      status={row.agent.status}
                      tone={row.agent.status === "active" ? "good" : "neutral"}
                    />
                  </div>
                  <p className="text-[11px] font-light" style={{ color: "var(--text-tertiary)" }}>
                    owner: {row.agent.ownerLabel ?? "(unassigned)"} · last active {formatRelativeTime(row.lastActiveAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] font-mono">
                  <Stat label="tasks" value={row.totalRuns} />
                  <Stat label="solved" value={row.resolvedRuns} />
                  <Stat label="reroutes" value={row.blockedCalls} />
                  <Stat label="tokens saved" value={row.tokensSaved.toLocaleString()} />
                  <Stat label="lessons used" value={row.memoriesUsed} />
                  <Stat label="lessons saved" value={row.memoriesCreated} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SurfaceCard>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span
      className="rounded-sm border px-2 py-1 uppercase tracking-[0.14em]"
      style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
    >
      {label}: <strong className="font-mono" style={{ color: "var(--text)" }}>{value}</strong>
    </span>
  );
}

function computeRollups(
  agents: AgentRecord[],
  runs: AgentRunRecord[],
  events: MemoryEventRecord[],
): AgentRollup[] {
  const runByAgent = new Map<string, AgentRunRecord[]>();
  for (const run of runs) {
    if (!run.agentId) continue;
    const list = runByAgent.get(run.agentId) ?? [];
    list.push(run);
    runByAgent.set(run.agentId, list);
  }
  // memoryEvents.actorKind="agent" with actorId mapping to displayName.
  // We don't have a direct foreign key to agents.id, but the actor_id
  // is conventionally the agent display name (set by the SDK).
  const memUsedByAgent = new Map<string, number>();
  const memCreatedByAgent = new Map<string, number>();
  for (const ev of events) {
    if (ev.actorKind !== "agent" || !ev.actorId) continue;
    if (ev.action === "used") {
      memUsedByAgent.set(ev.actorId, (memUsedByAgent.get(ev.actorId) ?? 0) + 1);
    } else if (ev.action === "created") {
      memCreatedByAgent.set(ev.actorId, (memCreatedByAgent.get(ev.actorId) ?? 0) + 1);
    }
  }
  return agents.map((agent) => {
    const list = runByAgent.get(agent.id) ?? [];
    const tokensSaved = list.reduce((s, r) => s + r.tokensSavedEstimated, 0);
    const blockedCalls = list.reduce((s, r) => s + r.blockedCallsCount, 0);
    const resolved = list.filter((r) => r.status === "resolved").length;
    const lastActiveAt = list
      .map((r) => r.endedAt ?? r.startedAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop();
    return {
      agent,
      totalRuns: list.length,
      resolvedRuns: resolved,
      blockedCalls,
      tokensSaved,
      memoriesUsed: memUsedByAgent.get(agent.displayName) ?? 0,
      memoriesCreated: memCreatedByAgent.get(agent.displayName) ?? 0,
      ...(lastActiveAt ? { lastActiveAt } : {}),
    };
  });
}
