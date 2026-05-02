"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  EmptyState,
  PageHeader,
  StatusPill,
  SurfaceCard,
  formatRelativeTime,
} from "@/components/engineering-brain/shared";
import type {
  MemoryEventRecord,
  MemoryStatusRecord,
  MemoryStatusValue,
  RollbackEventRecord,
} from "@/lib/control-plane/types";

interface Props {
  statuses: MemoryStatusRecord[];
  events: MemoryEventRecord[];
  rollbacks: RollbackEventRecord[];
}

const STATUS_GROUPS: MemoryStatusValue[] = [
  "active",
  "candidate",
  "superseded",
  "retired",
  "deleted",
];

const STATUS_LABEL: Record<MemoryStatusValue, string> = {
  active: "In use",
  candidate: "Under review",
  superseded: "Replaced by a newer one",
  retired: "Set aside",
  deleted: "Removed",
};

const STATUS_TONE: Record<MemoryStatusValue, "good" | "neutral" | "warn" | "bad"> = {
  active: "good",
  candidate: "neutral",
  superseded: "neutral",
  retired: "warn",
  deleted: "bad",
};

export function MemoryView({ statuses, events, rollbacks }: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map: Record<MemoryStatusValue, MemoryStatusRecord[]> = {
      active: [],
      candidate: [],
      retired: [],
      superseded: [],
      deleted: [],
    };
    for (const s of statuses) map[s.status].push(s);
    return map;
  }, [statuses]);

  const eventsByMemory = useMemo(() => {
    const m = new Map<string, MemoryEventRecord[]>();
    for (const ev of events) {
      const list = m.get(ev.memoryId) ?? [];
      list.push(ev);
      m.set(ev.memoryId, list);
    }
    return m;
  }, [events]);

  async function action(memoryId: string, kind: "retire" | "delete" | "supersede" | "rollback") {
    setBusyId(`${memoryId}:${kind}`);
    setError(null);
    try {
      const reason =
        kind === "rollback"
          ? "manual rollback from dashboard"
          : `${kind} from dashboard`;
      const res = await fetch("/api/engineering-brain/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: kind, memoryId, reason }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `failed to ${kind} memory`);
        return;
      }
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-6" aria-label="Memory">
      <PageHeader
        eyebrow="Lessons learned"
        title="What your agents remember"
        description={
          <>
            Short, reusable notes saved after agents solved something. Group
            them by status, see who created them, and act on them: keep,
            retire, replace, or remove. Removed lessons leave behind only
            audit metadata — never the lesson body — and rolled-back lessons
            return to their previous state. (This is about lessons, not
            code: we don&apos;t roll back commits from here.)
          </>
        }
      />

      {STATUS_GROUPS.map((status) => (
        <SurfaceCard
          key={status}
          title={`${STATUS_LABEL[status]} · ${grouped[status].length}`}
          meta={`status=${status}`}
        >
          {grouped[status].length === 0 ? (
            <EmptyState
              title={`Nothing ${STATUS_LABEL[status].toLowerCase()} yet`}
              description={
                status === "deleted"
                  ? "Removed lessons stay listed here as audit-only entries — body intentionally blank."
                  : undefined
              }
            />
          ) : (
            <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
              {grouped[status].map((memory) => {
                const memEvents = eventsByMemory.get(memory.memoryId) ?? [];
                const lastEvent = memEvents.sort((a, b) =>
                  b.createdAt.localeCompare(a.createdAt),
                )[0];
                return (
                  <li key={memory.memoryId} className="flex flex-col gap-2 px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={memory.status} tone={STATUS_TONE[memory.status]} />
                      <p className="text-[13px] font-light" style={{ color: "var(--text)" }}>
                        {memory.trigSituation ?? "(no trigger snapshot)"}
                      </p>
                      <span
                        className="text-[10px] font-mono"
                        style={{ color: "var(--text-tertiary)" }}
                      >
                        {memory.memoryId}
                      </span>
                    </div>
                    {memory.bodyPreview ? (
                      <p
                        className="text-[12px] font-light"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {memory.bodyPreview}
                      </p>
                    ) : null}
                    <p
                      className="text-[11px] font-mono"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      provenance: {memory.provenanceKind ?? "—"} · last touched{" "}
                      {formatRelativeTime(memory.updatedAt)}
                      {lastEvent ? ` · last action ${lastEvent.action}` : ""}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <ActionButton
                        label="Set aside"
                        disabled={status === "retired" || busyId !== null}
                        busy={busyId === `${memory.memoryId}:retire`}
                        onClick={() => action(memory.memoryId, "retire")}
                      />
                      <ActionButton
                        label="Mark as replaced"
                        disabled={status === "superseded" || busyId !== null}
                        busy={busyId === `${memory.memoryId}:supersede`}
                        onClick={() => action(memory.memoryId, "supersede")}
                      />
                      <ActionButton
                        label="Remove"
                        disabled={status === "deleted" || busyId !== null}
                        busy={busyId === `${memory.memoryId}:delete`}
                        danger
                        onClick={() => action(memory.memoryId, "delete")}
                      />
                      <ActionButton
                        label="Undo last change"
                        disabled={busyId !== null}
                        busy={busyId === `${memory.memoryId}:rollback`}
                        onClick={() => action(memory.memoryId, "rollback")}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SurfaceCard>
      ))}

      <SurfaceCard
        title={`Rollback history · ${rollbacks.length}`}
        meta={`memories restored: ${rollbacks.filter((r) => r.targetKind === "memory").length}`}
      >
        {rollbacks.length === 0 ? (
          <EmptyState title="No rollback events yet" />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
            {rollbacks.map((rb) => (
              <li key={rb.id} className="flex flex-col gap-1 px-5 py-3">
                <p className="text-[13px] font-light" style={{ color: "var(--text)" }}>
                  Rolled back <span className="font-mono">{rb.targetKind}</span> to{" "}
                  <span className="font-mono">{rb.rollbackToId ?? "previous"}</span>
                </p>
                <p
                  className="text-[11px] font-mono"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  by {rb.actorId ?? "(unknown)"} · {formatRelativeTime(rb.createdAt)} · {rb.reason}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SurfaceCard>

      <SurfaceCard title={`Event timeline · ${events.length}`}>
        {events.length === 0 ? (
          <EmptyState title="No memory events yet" />
        ) : (
          <ul
            className="max-h-[420px] overflow-auto divide-y"
            style={{ borderColor: "var(--border)" }}
          >
            {events.slice(0, 200).map((ev) => (
              <li key={ev.id} className="flex flex-col gap-0.5 px-5 py-2">
                <div className="flex items-center gap-2">
                  <StatusPill
                    status={ev.action}
                    tone={
                      ev.action === "deleted"
                        ? "bad"
                        : ev.action === "rollback"
                          ? "warn"
                          : ev.action === "created" || ev.action === "used"
                            ? "good"
                            : "neutral"
                    }
                  />
                  <span
                    className="text-[12px] font-mono"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {ev.memoryId}
                  </span>
                </div>
                <p
                  className="text-[11px] font-light"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  {ev.actorKind}
                  {ev.actorId ? ` · ${ev.actorId}` : ""} · {formatRelativeTime(ev.createdAt)}
                  {ev.reason ? ` · ${ev.reason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SurfaceCard>

      {error ? (
        <p className="text-[12px] font-light" style={{ color: "#f5a3a3" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ActionButton({
  label,
  busy,
  disabled,
  onClick,
  danger,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className="rounded-sm border px-3 py-1 text-[11px] font-light disabled:opacity-50"
      style={{
        background: "var(--surface)",
        color: danger ? "#f5a3a3" : "var(--text)",
        borderColor: danger ? "rgba(245, 163, 163, 0.3)" : "var(--border)",
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}
