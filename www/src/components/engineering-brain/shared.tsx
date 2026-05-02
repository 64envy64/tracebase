/**
 * Visual primitives shared across Engineering Brain views.
 *
 * These are the small atoms — page header, surface card, status pill,
 * empty state, relative time. The dashboard styling matches the
 * existing /dashboard/* surfaces (var(--bg)/var(--surface)/var(--border)
 * tokens) so the Engineering Brain doesn't visually drift from the
 * rest of the app.
 */
import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header
      className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between"
      style={{ borderColor: "var(--border)" }}
    >
      <div>
        <p
          className="text-[10px] font-mono uppercase tracking-[0.22em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {eyebrow}
        </p>
        <h1 className="mt-2 text-[1.5rem] font-light tracking-[-0.02em] md:text-[1.7rem]">
          {title}
        </h1>
        {description ? (
          <p
            className="mt-3 max-w-[44rem] text-[13px] font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function SurfaceCard({
  children,
  title,
  meta,
}: {
  children: ReactNode;
  title?: string;
  meta?: ReactNode;
}) {
  return (
    <article
      className="rounded-sm border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      {title || meta ? (
        <header
          className="flex items-baseline justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--border)" }}
        >
          <p className="text-[13px] font-light tracking-tight">{title}</p>
          {meta ? (
            <span
              className="rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
              style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
            >
              {meta}
            </span>
          ) : null}
        </header>
      ) : null}
      {children}
    </article>
  );
}

export function StatusPill({
  status,
  tone,
}: {
  status: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const colorByTone: Record<string, { bg: string; text: string; border: string }> = {
    neutral: { bg: "transparent", text: "var(--text-secondary)", border: "var(--border)" },
    good: { bg: "rgba(53, 193, 134, 0.08)", text: "#7adfae", border: "rgba(122, 223, 174, 0.3)" },
    warn: { bg: "rgba(241, 175, 73, 0.08)", text: "#f7c97a", border: "rgba(247, 201, 122, 0.3)" },
    bad: { bg: "rgba(232, 88, 88, 0.08)", text: "#f5a3a3", border: "rgba(245, 163, 163, 0.3)" },
  };
  const c = colorByTone[tone ?? "neutral"];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.18em]"
      style={{ background: c.bg, color: c.text, borderColor: c.border }}
    >
      {status}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-start gap-3 px-6 py-10 text-[13px] font-light"
      style={{ color: "var(--text-secondary)" }}
    >
      <p className="text-[14px]" style={{ color: "var(--text)" }}>
        {title}
      </p>
      {description ? <p className="max-w-[42rem]">{description}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

export function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return "—";
  if (diffMs < 0) return "just now";
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

export function MetricTile({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: string;
}) {
  return (
    <article
      className="rounded-sm border px-4 py-4"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <p
        className="text-[10px] font-mono uppercase tracking-[0.22em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {label}
      </p>
      <p className="mt-2 text-[1.4rem] font-light tracking-[-0.02em]" style={{ color: "var(--text)" }}>
        {value}
      </p>
      {note ? (
        <p className="mt-1 text-[11px] font-light" style={{ color: "var(--text-tertiary)" }}>
          {note}
        </p>
      ) : null}
    </article>
  );
}
