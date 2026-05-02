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
  GithubItemRecord,
  IntegrationRecord,
  MemoryStatusRecord,
} from "@/lib/control-plane/types";
import type { IssueBrief } from "@/lib/control-plane/issue-brief";

interface Props {
  integrations: IntegrationRecord[];
  items: GithubItemRecord[];
  memoryStatuses: MemoryStatusRecord[];
}

type KindFilter = "all" | GithubItemRecord["kind"];

const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "issue", label: "Issues" },
  { key: "pull_request", label: "Pull requests" },
  { key: "check_run", label: "CI checks" },
  { key: "review_comment", label: "Reviews" },
  { key: "commit", label: "Commits" },
];

export function IssuesView({ integrations, items, memoryStatuses }: Props) {
  const [filter, setFilter] = useState<KindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const [brief, setBrief] = useState<IssueBrief | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  const visible = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((i) => i.kind === filter);
  }, [items, filter]);

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  async function generateBrief() {
    if (!selectedId) return;
    setBriefBusy(true);
    setBriefError(null);
    setBrief(null);
    try {
      const res = await fetch(
        `/api/engineering-brain/issue-brief?itemId=${encodeURIComponent(selectedId)}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBriefError(data?.error ?? "failed to generate brief");
        return;
      }
      setBrief(data.brief as IssueBrief);
    } finally {
      setBriefBusy(false);
    }
  }

  return (
    <section className="space-y-6" aria-label="Issues">
      <PageHeader
        eyebrow="Work coming in"
        title="Issues, PRs, and CI failures"
        description={
          <>
            Everything pulled in from your connected repos. Click{" "}
            <strong className="font-mono">Generate background notes</strong>{" "}
            on any item to see the cited context an agent would have — files
            in scope, related work, prior lessons. It&apos;s read-only
            background; agents never receive commands from here.
          </>
        }
      />

      {integrations.length === 0 ? (
        <SurfaceCard title="No repositories connected">
          <EmptyState
            title="Connect a GitHub repo first"
            description="This page lists work pulled in from your linked repos. Add one on the Integrations page to get started."
          />
        </SurfaceCard>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {KIND_FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setFilter(option.key)}
            className="rounded-sm border px-3 py-1.5 text-[11px] font-light"
            style={{
              background: filter === option.key ? "var(--surface)" : "transparent",
              color: filter === option.key ? "var(--text)" : "var(--text-secondary)",
              borderColor: "var(--border)",
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <SurfaceCard
          title={`Items · ${visible.length}`}
          meta={`${memoryStatuses.length} prior lessons`}
        >
          {visible.length === 0 ? (
            <EmptyState title="No items match this filter" />
          ) : (
            <ul
              className="max-h-[640px] overflow-auto divide-y"
              style={{ borderColor: "var(--border)" }}
            >
              {visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(item.id);
                      setBrief(null);
                    }}
                    className="flex w-full flex-col gap-1 px-5 py-3 text-left"
                    style={{
                      background: selectedId === item.id ? "var(--bg)" : "transparent",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <StatusPill
                        status={item.kind.replace("_", " ")}
                        tone={item.kind === "check_run" && item.state === "failure" ? "bad" : "neutral"}
                      />
                      <p
                        className="truncate text-[13px] font-light"
                        style={{ color: "var(--text)" }}
                      >
                        {item.number !== undefined ? `#${item.number} ` : ""}
                        {item.title ?? "(no title)"}
                      </p>
                    </div>
                    <p
                      className="text-[11px] font-mono"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      {item.repoFullName} · {formatRelativeTime(item.updatedAtRemote ?? item.ingestedAt)}
                      {item.state ? ` · ${item.state}` : ""}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SurfaceCard>

        <SurfaceCard
          title={selected ? `Background notes: ${selected.kind.replace("_", " ")}` : "Background notes"}
          meta={brief ? `~${brief.approxTokens} tokens` : "not generated"}
        >
          <div className="flex flex-col gap-4 px-5 py-4">
            {selected ? (
              <>
                <div className="flex flex-col gap-1">
                  <p className="text-[14px] font-light" style={{ color: "var(--text)" }}>
                    {selected.number !== undefined ? `#${selected.number} ` : ""}
                    {selected.title ?? "(no title)"}
                  </p>
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] font-mono"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {selected.url}
                  </a>
                </div>
                <button
                  type="button"
                  onClick={generateBrief}
                  disabled={briefBusy}
                  className="self-start rounded-sm border px-3 py-1.5 text-[12px] font-light disabled:opacity-50"
                  style={{
                    background: "var(--surface)",
                    color: "var(--text)",
                    borderColor: "var(--border)",
                  }}
                >
                  {briefBusy ? "generating…" : "Generate background notes"}
                </button>
                {briefError ? (
                  <p className="text-[12px] font-light" style={{ color: "#f5a3a3" }}>
                    {briefError}
                  </p>
                ) : null}
                {brief ? <BriefRender brief={brief} /> : null}
              </>
            ) : (
              <EmptyState title="Select an item on the left" />
            )}
          </div>
        </SurfaceCard>
      </div>
    </section>
  );
}

function BriefRender({ brief }: { brief: IssueBrief }) {
  return (
    <div className="flex flex-col gap-4 border-t pt-4" style={{ borderColor: "var(--border)" }}>
      <p
        className="text-[10px] font-mono uppercase tracking-[0.18em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        Failure class · {brief.failureClass}
      </p>
      {brief.sections.map((section) => (
        <div key={section.heading} className="flex flex-col gap-2">
          <p className="text-[13px] font-light" style={{ color: "var(--text)" }}>
            {section.heading}
          </p>
          <div
            className="flex flex-col gap-1.5 text-[12px] font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            {section.body.map((line, idx) => (
              <p key={idx}>{line}</p>
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-col gap-1.5 border-t pt-3" style={{ borderColor: "var(--border)" }}>
        <p
          className="text-[10px] font-mono uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          Citations · {brief.citations.length}
        </p>
        <ul className="flex flex-col gap-1">
          {brief.citations.map((c) => (
            <li
              key={`${c.kind}:${c.id}`}
              className="text-[12px] font-mono"
              style={{ color: "var(--text-secondary)" }}
            >
              {c.kind}:{c.id} — {c.label}
              {c.url ? (
                <>
                  {" — "}
                  <a
                    href={c.url}
                    className="underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    open
                  </a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {brief.truncated ? (
        <p className="text-[11px] font-light" style={{ color: "var(--text-tertiary)" }}>
          Brief was truncated to fit the token budget.
        </p>
      ) : null}
    </div>
  );
}
