import {
  EmptyState,
  PageHeader,
  StatusPill,
  SurfaceCard,
  formatRelativeTime,
} from "@/components/engineering-brain/shared";
import type {
  AgentRecord,
  AgentRunRecord,
} from "@/lib/control-plane/types";

interface Props {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  /** Current authenticated user's display name. Used to pin them to
   * the top of the People view even if they happen to share an
   * ownerLabel with other rows. */
  currentOwnerLabel: string;
}

const UNASSIGNED_LABEL = "(unassigned)";

export function TeamView({ agents, runs, currentOwnerLabel }: Props) {
  const grouped = groupByOwner(agents, currentOwnerLabel);

  return (
    <section className="space-y-6" aria-label="Team">
      <PageHeader
        eyebrow="Team"
        title="People and their agents"
        description={
          <>
            Group agents by the person they&apos;re working for. You appear
            at the top with the agents tied to your owner label. Agents
            reporting other names get their own card below.
          </>
        }
      />

      {grouped.length === 0 ? (
        <SurfaceCard title="No agents yet">
          <EmptyState
            title="No one to group yet"
            description="Once an agent reports a task with an owner label, it will show up here grouped under that person."
          />
        </SurfaceCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {grouped.map((group) => (
          <SurfaceCard
            key={group.label}
            title={
              group.isCurrentUser ? `${group.label} (you)` : group.label
            }
            meta={`${group.agents.length} agent${group.agents.length === 1 ? "" : "s"}`}
          >
            <div className="flex items-center gap-3 border-b px-5 py-3" style={{ borderColor: "var(--border)" }}>
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-light"
                style={{
                  background: group.isCurrentUser
                    ? "rgba(53, 193, 134, 0.18)"
                    : "var(--surface)",
                  color: group.isCurrentUser ? "#7adfae" : "var(--text-secondary)",
                  border: `1px solid ${group.isCurrentUser ? "rgba(122, 223, 174, 0.4)" : "var(--border)"}`,
                }}
              >
                {personInitials(group.label)}
              </div>
              <div className="flex flex-col gap-0.5">
                <p className="text-[13px] font-light" style={{ color: "var(--text)" }}>
                  {group.label}
                </p>
                <p className="text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
                  {group.agents.length} agent{group.agents.length === 1 ? "" : "s"} ·{" "}
                  {totalRuns(group.agents, runs)} runs total
                </p>
              </div>
            </div>
            <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
              {group.agents.map((agent) => {
                const agentRuns = runs.filter((r) => r.agentId === agent.id);
                const lastActive = agentRuns
                  .map((r) => r.endedAt ?? r.startedAt)
                  .sort()
                  .pop();
                return (
                  <li
                    key={agent.id}
                    className="flex flex-col gap-1 px-5 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <p className="font-mono text-[12px]" style={{ color: "var(--text)" }}>
                        {agent.displayName}
                      </p>
                      <StatusPill status={agent.host} />
                      <StatusPill
                        status={agent.status}
                        tone={agent.status === "active" ? "good" : "neutral"}
                      />
                    </div>
                    <p
                      className="text-[11px] font-light"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      {agentRuns.length} runs · last active {formatRelativeTime(lastActive)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </SurfaceCard>
        ))}
      </div>
    </section>
  );
}

function totalRuns(agents: AgentRecord[], runs: AgentRunRecord[]): number {
  const ids = new Set(agents.map((a) => a.id));
  return runs.filter((r) => r.agentId && ids.has(r.agentId)).length;
}

function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

interface OwnerGroup {
  label: string;
  agents: AgentRecord[];
  isCurrentUser: boolean;
}

function groupByOwner(
  agents: AgentRecord[],
  currentOwnerLabel: string,
): OwnerGroup[] {
  const buckets = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    const key = agent.ownerLabel ?? UNASSIGNED_LABEL;
    const list = buckets.get(key) ?? [];
    list.push(agent);
    buckets.set(key, list);
  }
  return Array.from(buckets.entries())
    .map(
      ([label, list]): OwnerGroup => ({
        label,
        agents: list,
        isCurrentUser: label === currentOwnerLabel,
      }),
    )
    .sort((a, b) => {
      if (a.isCurrentUser) return -1;
      if (b.isCurrentUser) return 1;
      if (a.label === UNASSIGNED_LABEL) return 1;
      if (b.label === UNASSIGNED_LABEL) return -1;
      return a.label.localeCompare(b.label);
    });
}
