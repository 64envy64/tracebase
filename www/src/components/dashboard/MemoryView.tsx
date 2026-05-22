"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "@/components/dashboard/primitives/PageHeader";
import { ActionPill } from "@/components/dashboard/primitives/Buttons";
import { EmptyState } from "@/components/dashboard/charts/EmptyState";
import {
  IconActivity,
  IconPattern,
  IconRocket,
} from "@/components/dashboard/primitives/Icons";

export type FindingType = "bug" | "note" | "pattern";

export interface FindingRow {
  id: string;
  codebase: string;
  filePath: string;
  type: FindingType;
  body: string;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * Memory view — codebase findings.
 *
 * Each finding is a small fact your agents have learned about a
 * specific file or module: a buggy code path to avoid, a convention
 * the team enforces, a pattern that should be followed when touching
 * a particular area. Findings differ from `/dashboard/patterns` in
 * that they're tied to a file path; patterns are reasoning rules that
 * apply more broadly.
 *
 * Two filters drive the list:
 *   • codebase — pick one repo, or "all" to see everything.
 *   • type     — bug / note / pattern. The type chip is the only
 *                differentiator on the card body, so it's intended
 *                to read at a glance.
 */
const TYPE_LABEL: Record<FindingType, string> = {
  bug: "Bug",
  note: "Note",
  pattern: "Pattern",
};

const TYPE_TONE: Record<FindingType, { bg: string; color: string; border: string }> = {
  bug: {
    bg: "rgba(232, 88, 88, 0.08)",
    color: "#f4a8a8",
    border: "rgba(245, 163, 163, 0.32)",
  },
  pattern: {
    bg: "rgba(255, 122, 92, 0.08)",
    color: "var(--accent)",
    border: "rgba(255, 122, 92, 0.28)",
  },
  note: {
    bg: "rgba(232, 217, 184, 0.06)",
    color: "var(--text-secondary)",
    border: "var(--border)",
  },
};

export function MemoryView({
  findings,
  codebases,
  demo = false,
}: {
  findings: FindingRow[];
  codebases: Array<{ name: string; description: string }>;
  demo?: boolean;
}) {
  const [codebaseFilter, setCodebaseFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<FindingType | "all">("all");
  const href = (path: string) => (demo ? `${path}?demo=1` : path);

  const countsByCodebase = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of findings) {
      map.set(f.codebase, (map.get(f.codebase) ?? 0) + 1);
    }
    return map;
  }, [findings]);

  const countsByType = useMemo(() => {
    const out: Record<FindingType, number> = { bug: 0, note: 0, pattern: 0 };
    for (const f of findings) out[f.type] += 1;
    return out;
  }, [findings]);

  const visible = useMemo(() => {
    return findings
      .filter((f) => (codebaseFilter === "all" ? true : f.codebase === codebaseFilter))
      .filter((f) => (typeFilter === "all" ? true : f.type === typeFilter));
  }, [findings, codebaseFilter, typeFilter]);

  const totalCodebases = codebases.length;

  return (
    <section className="space-y-7" aria-label="Memory">
      <PageHeader
        title="Findings store"
        subtitle={
          findings.length === 0
            ? "Nothing stored yet"
            : `${totalCodebases} codebase${totalCodebases === 1 ? "" : "s"} · ${findings.length} stored finding${findings.length === 1 ? "" : "s"}`
        }
        actions={
          <>
            <ActionPill href={href("/dashboard/patterns")} icon={<IconPattern />}>
              Patterns
            </ActionPill>
            <ActionPill href={href("/dashboard/runs")} icon={<IconActivity />}>
              Runs
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
          label="Codebase"
          options={[
            { key: "all", label: "All", count: findings.length },
            ...codebases.map((c) => ({
              key: c.name,
              label: c.name,
              count: countsByCodebase.get(c.name) ?? 0,
            })),
          ]}
          value={codebaseFilter}
          onChange={(v) => setCodebaseFilter(v)}
        />
        <FilterRow
          label="Type"
          options={[
            { key: "all", label: "All", count: findings.length },
            { key: "bug", label: "Bug", count: countsByType.bug },
            { key: "note", label: "Note", count: countsByType.note },
            { key: "pattern", label: "Pattern", count: countsByType.pattern },
          ]}
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as FindingType | "all")}
        />
      </div>

      {findings.length === 0 ? (
        <EmptyState
          title="No findings yet"
          body="Findings are written when an agent learns something specific about a file or module — a buggy code path, a convention to follow, a workaround for a tricky case. Once your team runs a few sessions with TraceBase attached, this list fills in."
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
          No findings match the current filters.
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {visible.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FindingCard({ finding }: { finding: FindingRow }) {
  const tone = TYPE_TONE[finding.type];
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
          {TYPE_LABEL[finding.type]}
        </span>
        <span
          className="font-mono text-[11px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {finding.codebase}
        </span>
        <span style={{ color: "var(--text-tertiary)" }} aria-hidden>
          ·
        </span>
        <span
          className="font-mono text-[11px]"
          style={{ color: "var(--text)" }}
        >
          {finding.filePath}
        </span>
        <span
          className="ml-auto font-mono text-[10px]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {finding.id}
        </span>
      </div>
      <p
        className="text-[13px] font-light leading-relaxed"
        style={{ color: "var(--text)" }}
      >
        {finding.body}
      </p>
      {finding.lastUsedAt ? (
        <p
          className="font-mono text-[10px]"
          style={{ color: "var(--text-tertiary)" }}
        >
          last cited {formatRelative(finding.lastUsedAt)}
        </p>
      ) : null}
    </li>
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
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
