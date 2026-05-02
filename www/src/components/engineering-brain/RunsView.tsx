"use client";

import { useMemo, useState } from "react";
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
  AgentRunSourceKind,
  AgentRunStatus,
  GithubItemRecord,
  MemoryEventRecord,
} from "@/lib/control-plane/types";

interface Props {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  githubItems: GithubItemRecord[];
  memoryEvents: MemoryEventRecord[];
}

const STATUS_FILTERS: Array<{ key: AgentRunStatus | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "running", label: "In progress" },
  { key: "resolved", label: "Solved" },
  { key: "failed", label: "Failed" },
  { key: "abandoned", label: "Given up" },
];

const SOURCE_FILTERS: Array<{ key: AgentRunSourceKind | "all"; label: string }> = [
  { key: "all", label: "Any source" },
  { key: "manual", label: "Manual ask" },
  { key: "github_issue", label: "From an issue" },
  { key: "pull_request", label: "From a PR" },
  { key: "ci_failure", label: "From CI failure" },
];

export function RunsView({ agents, runs, githubItems, memoryEvents }: Props) {
  const [statusFilter, setStatusFilter] = useState<AgentRunStatus | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<AgentRunSourceKind | "all">("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");

  const visible = useMemo(() => {
    return runs
      .filter((r) => (statusFilter === "all" ? true : r.status === statusFilter))
      .filter((r) => (sourceFilter === "all" ? true : r.taskSourceKind === sourceFilter))
      .filter((r) => (agentFilter === "all" ? true : r.agentId === agentFilter));
  }, [runs, statusFilter, sourceFilter, agentFilter]);

  const agentName = useMemo(() => {
    const m = new Map<string, AgentRecord>();
    for (const a of agents) m.set(a.id, a);
    return (id: string | undefined) => (id ? m.get(id)?.displayName ?? "(unknown)" : "(no agent)");
  }, [agents]);

  const githubLabel = useMemo(() => {
    const m = new Map<string, GithubItemRecord>();
    for (const i of githubItems) m.set(i.id, i);
    return (id: string | undefined) => {
      if (!id) return null;
      const found = m.get(id);
      if (!found) return null;
      return found.number !== undefined ? `#${found.number} ${found.title ?? ""}` : found.title ?? null;
    };
  }, [githubItems]);

  const eventsByRun = useMemo(() => {
    const m = new Map<string, MemoryEventRecord[]>();
    for (const ev of memoryEvents) {
      if (!ev.sourceRunId) continue;
      const list = m.get(ev.sourceRunId) ?? [];
      list.push(ev);
      m.set(ev.sourceRunId, list);
    }
    return m;
  }, [memoryEvents]);

  return (
    <section className="space-y-6" aria-label="Runs">
      <PageHeader
        eyebrow="Runs"
        title="Agent activity"
        description={
          <>
            One row per task an agent worked on. You see what context it
            pulled in, which files were in scope, whether the brain stepped
            in to stop a loop, and what was learned afterward — but never
            the conversation itself.
          </>
        }
      />

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setStatusFilter(option.key)}
            className="rounded-sm border px-3 py-1.5 text-[11px] font-light"
            style={{
              background: statusFilter === option.key ? "var(--surface)" : "transparent",
              color: statusFilter === option.key ? "var(--text)" : "var(--text-secondary)",
              borderColor: "var(--border)",
            }}
          >
            {option.label}
          </button>
        ))}
        <span className="self-center text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
          ·
        </span>
        {SOURCE_FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setSourceFilter(option.key)}
            className="rounded-sm border px-3 py-1.5 text-[11px] font-light"
            style={{
              background: sourceFilter === option.key ? "var(--surface)" : "transparent",
              color: sourceFilter === option.key ? "var(--text)" : "var(--text-secondary)",
              borderColor: "var(--border)",
            }}
          >
            {option.label}
          </button>
        ))}
        <select
          value={agentFilter}
          onChange={(event) => setAgentFilter(event.target.value)}
          className="rounded-sm border px-2 py-1.5 text-[11px] font-light"
          style={{
            background: "var(--surface)",
            color: "var(--text)",
            borderColor: "var(--border)",
          }}
        >
          <option value="all">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
      </div>

      <SurfaceCard title={`Runs · ${visible.length}`} meta={`agents ${agents.length}`}>
        {visible.length === 0 ? (
          <EmptyState title="No runs match these filters" />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
            {visible.map((run) => {
              const sourceLabel =
                run.taskSourceKind === "manual"
                  ? "manual ask"
                  : run.taskSourceKind === "github_issue"
                    ? "from an issue"
                    : run.taskSourceKind === "pull_request"
                      ? "from a pull request"
                      : "from a CI failure";
              const sourceItemLabel = githubLabel(run.taskSourceId);
              const events = eventsByRun.get(run.id) ?? [];
              const memoriesCreated = events.filter((e) => e.action === "created").length;
              const memoriesUsed = events.filter((e) => e.action === "used").length;
              return (
                <li key={run.id} className="flex flex-col gap-2 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill
                      status={run.status}
                      tone={
                        run.status === "resolved"
                          ? "good"
                          : run.status === "failed"
                            ? "bad"
                            : run.status === "abandoned"
                              ? "warn"
                              : "neutral"
                      }
                    />
                    <p className="text-[13px] font-light" style={{ color: "var(--text)" }}>
                      {run.taskTitle ?? "(no title)"}
                    </p>
                    <span
                      className="text-[11px] font-mono"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      · {agentName(run.agentId)}
                    </span>
                  </div>
                  <p
                    className="text-[11px] font-mono"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {sourceLabel}
                    {sourceItemLabel ? ` (${sourceItemLabel})` : ""} · started {formatRelativeTime(run.startedAt)}
                    {run.endedAt ? ` · ended ${formatRelativeTime(run.endedAt)}` : ""}
                  </p>
                  <div className="flex flex-wrap gap-2 text-[11px] font-mono">
                    <Stat label="lessons pulled in" value={run.recalledPatternsCount} />
                    <Stat label="files in scope" value={run.recalledFilesCount} />
                    <Stat label="actions taken" value={run.toolCallsCount} />
                    <Stat label="loops avoided" value={run.blockedCallsCount} />
                    <Stat label="context added" value={run.tokensInjected.toLocaleString()} />
                    <Stat label="tokens saved" value={run.tokensSavedEstimated.toLocaleString()} />
                    <Stat label="lessons cited" value={memoriesUsed} />
                    <Stat label="lessons saved" value={memoriesCreated} />
                  </div>
                </li>
              );
            })}
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
