"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill } from "@/components/dashboard/primitives/Buttons";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import {
  IconBook,
  IconPattern,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

export type RunFramework =
  | "claude-code"
  | "cursor"
  | "codex"
  | "openai"
  | "anthropic"
  | "other";
export type RunStatus = "running" | "resolved" | "failed" | "abandoned";

export interface RunRow {
  id: string;
  framework: RunFramework;
  agentDisplayName: string;
  user: string;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  taskTitle: string;
  taskRepo: string;
  profile: string;
  patternsUsed: number;
  toolCalls: number;
  tokensSaved: number;
}

/**
 * Runs view — one row per task an agent worked on. The numbers
 * shown are *outcomes* — patterns the agent pulled in, tool calls it
 * made, tokens it saved compared to a no-memory baseline — never the
 * conversation itself. TraceBase does not store agent transcripts.
 *
 * Three filter dimensions, each rendered as a chip row:
 *   • Framework  — claude-code | cursor | codex | other
 *   • Outcome    — success | abandoned | in_progress (resolved is
 *                  the explicit "success" label so the chip reads
 *                  cleanly when the user is scanning the list)
 *   • Profile    — coding | pr_review (rendered only when more than
 *                  one profile exists in the visible runs)
 */

const FRAMEWORK_LABEL: Record<RunFramework, string> = {
  "claude-code": "claude code",
  cursor: "cursor",
  codex: "codex",
  openai: "openai",
  anthropic: "anthropic",
  other: "other",
};

const STATUS_TONE: Record<RunStatus, { bg: string; color: string; border: string; label: string }> = {
  running: {
    bg: "rgba(125, 211, 252, 0.08)",
    color: "#9bd1f5",
    border: "rgba(155, 209, 245, 0.32)",
    label: "in progress",
  },
  resolved: {
    bg: "rgba(255, 122, 92, 0.08)",
    color: "var(--accent)",
    border: "rgba(255, 122, 92, 0.28)",
    label: "success",
  },
  failed: {
    bg: "rgba(232, 88, 88, 0.08)",
    color: "#f4a8a8",
    border: "rgba(245, 163, 163, 0.32)",
    label: "failed",
  },
  abandoned: {
    bg: "rgba(232, 217, 184, 0.05)",
    color: "var(--text-secondary)",
    border: "var(--border)",
    label: "abandoned",
  },
};

export function RunsView({ runs, demo = false }: { runs: RunRow[]; demo?: boolean }) {
  const [frameworkFilter, setFrameworkFilter] = useState<RunFramework | "all">("all");
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "resolved" | "running" | "failed" | "abandoned">("all");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const href = (path: string) => (demo ? `${path}?demo=1` : path);

  const profiles = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs) set.add(r.profile);
    return Array.from(set);
  }, [runs]);

  const visible = useMemo(() => {
    return runs
      .filter((r) => (frameworkFilter === "all" ? true : r.framework === frameworkFilter))
      .filter((r) => (outcomeFilter === "all" ? true : r.status === outcomeFilter))
      .filter((r) => (profileFilter === "all" ? true : r.profile === profileFilter));
  }, [runs, frameworkFilter, outcomeFilter, profileFilter]);

  const totals = useMemo(() => {
    const tokens = visible.reduce((s, r) => s + r.tokensSaved, 0);
    const resolved = visible.filter((r) => r.status === "resolved").length;
    return { tokens, resolved };
  }, [visible]);

  const frameworkCounts = useMemo(() => {
    const counts: Record<RunFramework | "all", number> = {
      all: runs.length,
      "claude-code": 0,
      cursor: 0,
      codex: 0,
      openai: 0,
      anthropic: 0,
      other: 0,
    };
    for (const r of runs) counts[r.framework] += 1;
    return counts;
  }, [runs]);

  const outcomeCounts = useMemo(() => {
    const out = { all: runs.length, resolved: 0, running: 0, failed: 0, abandoned: 0 };
    for (const r of runs) {
      if (r.status === "resolved") out.resolved += 1;
      else if (r.status === "running") out.running += 1;
      else if (r.status === "failed") out.failed += 1;
      else if (r.status === "abandoned") out.abandoned += 1;
    }
    return out;
  }, [runs]);

  return (
    <section className="space-y-7" aria-label="Runs">
      <PageHeader
        title="Runs"
        subtitle={
          runs.length === 0
            ? "Nothing recorded yet"
            : `Last 7 days · ${runs.length} run${runs.length === 1 ? "" : "s"}`
        }
        actions={
          <>
            <ActionPill href={href("/dashboard/patterns")} icon={<IconPattern />}>
              Patterns
            </ActionPill>
            <ActionPill href={href("/dashboard/memory")} icon={<IconBook />}>
              Memory
            </ActionPill>
            <ActionPill href={href("/dashboard")} icon={<IconRocket />}>
              Overview
            </ActionPill>
          </>
        }
      />

      <div
        className="rounded-lg border px-4 py-4"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <FilterRow
          label="Framework"
          options={[
            { key: "all", label: "All", count: frameworkCounts.all },
            { key: "claude-code", label: "Claude Code", count: frameworkCounts["claude-code"] },
            { key: "cursor", label: "Cursor", count: frameworkCounts.cursor },
            { key: "codex", label: "Codex", count: frameworkCounts.codex },
            { key: "anthropic", label: "Anthropic", count: frameworkCounts.anthropic },
            { key: "openai", label: "OpenAI", count: frameworkCounts.openai },
            ...(frameworkCounts.other > 0
              ? [{ key: "other", label: "Other", count: frameworkCounts.other }]
              : []),
          ]}
          value={frameworkFilter}
          onChange={(v) => setFrameworkFilter(v as RunFramework | "all")}
        />
        <FilterRow
          label="Outcome"
          options={[
            { key: "all", label: "All", count: outcomeCounts.all },
            { key: "resolved", label: "Success", count: outcomeCounts.resolved },
            { key: "running", label: "In progress", count: outcomeCounts.running },
            { key: "failed", label: "Failed", count: outcomeCounts.failed },
            { key: "abandoned", label: "Abandoned", count: outcomeCounts.abandoned },
          ]}
          value={outcomeFilter}
          onChange={(v) => setOutcomeFilter(v as "all" | RunStatus)}
        />
        {profiles.length > 1 ? (
          <FilterRow
            label="Profile"
            options={[
              { key: "all", label: "All" },
              ...profiles.map((p) => ({ key: p, label: p })),
            ]}
            value={profileFilter}
            onChange={(v) => setProfileFilter(v)}
          />
        ) : null}
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 text-[12px]"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <span style={{ color: "var(--text-tertiary)" }}>
          <span className="font-mono tabular-nums" style={{ color: "var(--text)" }}>
            {visible.length}
          </span>{" "}
          / {runs.length} shown
        </span>
        <span style={{ color: "var(--text-tertiary)" }} aria-hidden>
          ·
        </span>
        <span style={{ color: "var(--text-tertiary)" }}>
          <span className="font-mono tabular-nums" style={{ color: "var(--accent)" }}>
            {totals.resolved}
          </span>{" "}
          successful
        </span>
        <span style={{ color: "var(--text-tertiary)" }} aria-hidden>
          ·
        </span>
        <span style={{ color: "var(--text-tertiary)" }}>
          <span className="font-mono tabular-nums" style={{ color: "var(--accent)" }}>
            {totals.tokens.toLocaleString()}
          </span>{" "}
          tokens saved
        </span>
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title="No runs recorded yet"
          body="Once an agent starts a session with TraceBase attached, every task it works on appears here — with the patterns it pulled in, the tools it called, and the tokens it saved vs a no-memory baseline."
          artSrc="/octopus.svg"
          artAlt="TraceBase octopus"
        />
      ) : visible.length === 0 ? (
        <div
          className="rounded-lg border px-4 py-6 text-center text-[12px] font-light"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface)",
            color: "var(--text-tertiary)",
          }}
        >
          No runs match the current filters.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((r) => (
            <RunRowItem key={r.id} run={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRowItem({ run }: { run: RunRow }) {
  const tone = STATUS_TONE[run.status];
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border px-4 py-3.5"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em]"
          style={{ background: tone.bg, color: tone.color, borderColor: tone.border }}
        >
          {tone.label}
        </span>
        <span
          className="inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em]"
          style={{
            borderColor: "var(--border)",
            color: "var(--text-tertiary)",
          }}
        >
          {FRAMEWORK_LABEL[run.framework]}
        </span>
        <p className="min-w-0 truncate text-[13px] font-normal" style={{ color: "var(--text)" }}>
          {run.taskTitle}
        </p>
        <span
          className="ml-auto font-mono text-[10px]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {run.id}
        </span>
      </div>
      <p
        className="font-mono text-[11px]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {run.user} · {run.agentDisplayName} · {run.taskRepo} · profile {run.profile} · started{" "}
        {formatRelative(run.startedAt)}
        {run.endedAt ? ` · ended ${formatRelative(run.endedAt)}` : ""}
      </p>
      <div className="flex flex-wrap gap-2 text-[11px] font-mono">
        <Stat label="patterns" value={run.patternsUsed} />
        <Stat label="tool calls" value={run.toolCalls} />
        <Stat
          label="tokens saved"
          value={run.tokensSaved === 0 ? "—" : run.tokensSaved.toLocaleString()}
          highlight={run.tokensSaved > 0}
        />
      </div>
    </li>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 uppercase tracking-[0.14em]"
      style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
    >
      <span className="text-[10px]">{label}</span>
      <strong
        className="font-mono text-[11px] normal-case tracking-normal"
        style={{ color: highlight ? "var(--accent)" : "var(--text)" }}
      >
        {value}
      </strong>
    </span>
  );
}

function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ key: string; label: string; count?: number }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <span
        className="min-w-[72px] text-[10px] font-mono uppercase tracking-[0.22em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {label}
      </span>
      {options.map((option) => {
        const active = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            className="inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-[11px] font-light transition-[background-color,color]"
            style={{
              background: active ? "var(--text)" : "transparent",
              color: active ? "var(--bg)" : "var(--text-secondary)",
              borderColor: active ? "var(--text)" : "var(--border)",
            }}
            aria-pressed={active}
          >
            <span>{option.label}</span>
            {option.count !== undefined ? (
              <span
                className="font-mono text-[10px]"
                style={{ color: active ? "var(--bg)" : "var(--text-tertiary)" }}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
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
