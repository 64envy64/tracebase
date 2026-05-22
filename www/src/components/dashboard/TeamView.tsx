import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill } from "@/components/dashboard/primitives/Buttons";
import { CardHeaderRow, SectionCard } from "@/components/dashboard/primitives/SectionCard";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import {
  IconActivity,
  IconAgent,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

type TeamAgentFramework =
  | "claude-code"
  | "cursor"
  | "codex"
  | "openai"
  | "anthropic"
  | "other";

export interface TeamMemberRow {
  name: string;
  role: string;
  agents: Array<{
    displayName: string;
    framework: TeamAgentFramework;
    status: "active" | "idle";
    lastSeenAt: string;
    totalRuns: number;
  }>;
}

const FRAMEWORK_LABEL: Record<TeamAgentFramework, string> = {
  "claude-code": "claude code",
  cursor: "cursor",
  codex: "codex",
  openai: "openai",
  anthropic: "anthropic",
  other: "other",
};

/**
 * Team view — one card per person, with the agents they own listed
 * underneath. The "current user" highlight pins the viewer to the top
 * of the list and tags their card so they can spot it at a glance.
 *
 * Deliberately simple: no per-row actions, no RBAC. TraceBase's auth
 * model right now is single-workspace-per-user, so this page is more
 * about visibility than control.
 */
export function TeamView({
  members,
  currentName,
  demo = false,
}: {
  members: TeamMemberRow[];
  currentName: string | null;
  demo?: boolean;
}) {
  const href = (path: string) => (demo ? `${path}?demo=1` : path);

  const sorted = [...members].sort((a, b) => {
    if (a.name === currentName) return -1;
    if (b.name === currentName) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <section className="space-y-7" aria-label="Team">
      <PageHeader
        title="Team"
        subtitle={
          members.length === 0
            ? "Nobody onboarded yet"
            : `${members.length} ${members.length === 1 ? "person" : "people"} · ${members.reduce((s, m) => s + m.agents.length, 0)} agents`
        }
        actions={
          <>
            <ActionPill href={href("/dashboard/runs")} icon={<IconActivity />}>
              Runs
            </ActionPill>
            <ActionPill href={href("/dashboard")} icon={<IconRocket />}>
              Overview
            </ActionPill>
          </>
        }
      />

      {members.length === 0 ? (
        <EmptyState
          title="No teammates yet"
          body="Once a teammate runs `npx tracebase-ai init` in any project, they appear here with the agents they own. TraceBase doesn't yet have an explicit invite flow — anyone who installs against this workspace lands in this list automatically."
          artSrc="/octopus.svg"
          artAlt="TraceBase octopus"
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {sorted.map((m) => (
            <MemberCard key={m.name} member={m} isCurrent={m.name === currentName} />
          ))}
        </div>
      )}
    </section>
  );
}

function MemberCard({
  member,
  isCurrent,
}: {
  member: TeamMemberRow;
  isCurrent: boolean;
}) {
  const totalRuns = member.agents.reduce((s, a) => s + a.totalRuns, 0);
  return (
    <SectionCard
      inset={false}
      header={
        <CardHeaderRow
          icon={<MemberAvatar name={member.name} highlight={isCurrent} />}
          actor={
            <span style={{ color: "var(--text)" }}>
              {member.name}
              {isCurrent ? (
                <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: "var(--accent)" }}>
                  you
                </span>
              ) : null}
            </span>
          }
          meta={<>· {member.role}</>}
          actions={
            <span
              className="rounded-md border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
              style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
            >
              {totalRuns} runs
            </span>
          }
        />
      }
      body={
        <ul className="flex flex-col gap-2">
          {member.agents.map((a) => (
            <li
              key={a.displayName}
              className="flex flex-wrap items-center gap-2 rounded-sm border px-3 py-2"
              style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.015)" }}
            >
              <IconAgent />
              <span className="font-mono text-[12px]" style={{ color: "var(--text)" }}>
                {a.displayName}
              </span>
              <span
                className="inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em]"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text-tertiary)",
                }}
              >
                {FRAMEWORK_LABEL[a.framework]}
              </span>
              <span
                className="inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em]"
                style={{
                  background:
                    a.status === "active"
                      ? "rgba(255, 122, 92, 0.08)"
                      : "rgba(232, 217, 184, 0.04)",
                  color: a.status === "active" ? "var(--accent)" : "var(--text-tertiary)",
                  borderColor:
                    a.status === "active"
                      ? "rgba(255, 122, 92, 0.28)"
                      : "var(--border)",
                }}
              >
                {a.status}
              </span>
              <span
                className="ml-auto font-mono text-[10px]"
                style={{ color: "var(--text-tertiary)" }}
              >
                {a.totalRuns} runs · seen {formatRelative(a.lastSeenAt)}
              </span>
            </li>
          ))}
        </ul>
      }
    />
  );
}

function MemberAvatar({ name, highlight }: { name: string; highlight: boolean }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials =
    parts.length === 0
      ? "?"
      : parts.length === 1
        ? parts[0].slice(0, 2).toUpperCase()
        : `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return (
    <span
      className="inline-flex h-7 w-7 items-center justify-center rounded-full font-mono text-[10px]"
      style={{
        background: highlight ? "rgba(255, 122, 92, 0.12)" : "rgba(255, 255, 255, 0.04)",
        color: highlight ? "var(--accent)" : "var(--text)",
        border: `1px solid ${highlight ? "rgba(255, 122, 92, 0.32)" : "var(--border)"}`,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
