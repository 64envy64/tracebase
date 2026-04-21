"use client";

import type { ReactNode } from "react";
import { Panel } from "@/components/dashboard/Panel";
import { ToolbarTag } from "@/components/dashboard/ToolbarTag";
import { InteractiveLineChart } from "@/components/dashboard/charts/InteractiveLineChart";
import type {
  AuditNote,
  AuditTrailRow,
  AttributionStage,
  DashboardMetric,
  MetricTone,
  PatternRow,
} from "@/components/dashboard/dashboardData";
import { dashboardData } from "@/components/dashboard/dashboardData";
import { buildAreaPath, buildLinePath, buildPoints } from "@/components/dashboard/lib/chartMath";
import type { DashboardBootstrap } from "@/lib/control-plane/types";

const METRIC_TONES: Record<
  MetricTone,
  { line: string; fill: string; badge: string; text: string }
> = {
  accent: {
    line: "var(--accent)",
    fill: "var(--accent-soft)",
    badge: "rgba(49, 208, 178, 0.14)",
    text: "#7ff1dc",
  },
  signal: {
    line: "var(--signal)",
    fill: "var(--signal-soft)",
    badge: "rgba(125, 211, 252, 0.14)",
    text: "#bae6fd",
  },
  success: {
    line: "var(--success)",
    fill: "var(--success-soft)",
    badge: "rgba(109, 231, 183, 0.14)",
    text: "#bbf7d0",
  },
  warning: {
    line: "var(--warning)",
    fill: "var(--warning-soft)",
    badge: "rgba(242, 197, 114, 0.14)",
    text: "#f8deb1",
  },
};

const PATTERN_STATUS_STYLES: Record<
  PatternRow["status"],
  { label: string; background: string; color: string }
> = {
  promoted: {
    label: "promoted",
    background: "rgba(49, 208, 178, 0.14)",
    color: "#7ff1dc",
  },
  watching: {
    label: "watching",
    background: "rgba(125, 211, 252, 0.14)",
    color: "#bae6fd",
  },
  draft: {
    label: "draft",
    background: "rgba(242, 197, 114, 0.14)",
    color: "#f8deb1",
  },
};

const AUDIT_STATUS_STYLES: Record<
  AuditTrailRow["status"],
  { label: string; background: string; color: string }
> = {
  verified: {
    label: "verified",
    background: "rgba(49, 208, 178, 0.14)",
    color: "#7ff1dc",
  },
  watching: {
    label: "watching",
    background: "rgba(125, 211, 252, 0.14)",
    color: "#bae6fd",
  },
  flagged: {
    label: "review",
    background: "rgba(242, 197, 114, 0.14)",
    color: "#f8deb1",
  },
};

function staggerStyle(i: number) {
  return { animationDelay: `${i * 42}ms` } as const;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";

  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function scopeLabel(scope: DashboardBootstrap["workspace"]["scope"] | undefined) {
  switch (scope) {
    case "org":
      return "organization workspace";
    default:
      return "personal workspace";
  }
}

export function DashboardView({ bootstrap }: { bootstrap?: DashboardBootstrap }) {
  const { toolbar, metrics, chart, impactSnapshots, attributionStages, auditNotes, patterns, auditRows } =
    dashboardData;
  const latestInstall = bootstrap?.installations[0];

  const title = bootstrap?.workspace.displayName ?? toolbar.workspace;
  const subtitle = bootstrap
    ? {
        organization: scopeLabel(bootstrap.workspace.scope),
        environment: "Production",
        lastUpdated: latestInstall
          ? `linked ${formatRelativeTime(latestInstall.updatedAt)}`
          : "no installs linked yet",
      }
    : toolbar;

  return (
    <article className="space-y-5 pb-4" aria-label="Workspace dashboard">
      <header
        id="overview"
        className="dash-enter flex flex-col gap-4 border-b pb-4 lg:flex-row lg:items-end lg:justify-between"
        style={{ ...staggerStyle(0), borderColor: "var(--border)" }}
      >
        <div>
          <p
            className="text-[10px] font-mono uppercase tracking-[0.18em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            Dashboard
          </p>
          <h1 className="mt-2 text-[1.8rem] font-light tracking-[-0.03em]">{title}</h1>
          <p
            className="mt-2 max-w-3xl text-sm font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            Hosted control plane for install, reuse analytics, and trace auditability. The view stays
            focused on the metrics a buyer and an operator actually need.
          </p>
          <p
            className="mt-3 text-[11px] font-light uppercase tracking-[0.18em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            {subtitle.organization}
            <span className="mx-2">·</span>
            {subtitle.environment}
            <span className="mx-2">·</span>
            {subtitle.lastUpdated}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <ToolbarTag active>{`scope ${bootstrap?.workspace.scope ?? "personal"}`}</ToolbarTag>
          <ToolbarTag>{`installs ${bootstrap?.installations.length ?? 0}`}</ToolbarTag>
          <ToolbarTag>{`api keys ${bootstrap?.apiKeys.length ?? 0}`}</ToolbarTag>
          {bootstrap?.workspace.slug ? <ToolbarTag>{bootstrap.workspace.slug}</ToolbarTag> : null}
        </div>
      </header>

      <section
        className="dash-enter grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Key metrics"
        style={staggerStyle(1)}
      >
        {metrics.map((metric) => (
          <MetricCard key={metric.label} metric={metric} />
        ))}
      </section>

      <section
        className="dash-enter grid gap-4 xl:grid-cols-[minmax(0,1.16fr)_minmax(320px,0.84fr)]"
        style={staggerStyle(2)}
      >
        <Panel
          id="efficiency"
          eyebrow="Impact"
          title="Cold start vs assisted runs"
          description="Median tokens per repeated workflow. This is the buyer-facing cost story: once recall starts early, the agent burns fewer tokens and avoids re-exploring the same dead ends."
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.24fr)_minmax(260px,0.76fr)]">
            <div className="min-w-0">
              <InteractiveLineChart labels={chart.labels} series={chart.series} />
            </div>

            <div className="grid gap-2.5">
              {impactSnapshots.map((snapshot) => (
                <div
                  key={snapshot.label}
                  className="rounded-sm border p-3.5"
                  style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.015)" }}
                >
                  <p
                    className="text-[10px] font-mono uppercase tracking-[0.18em]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {snapshot.label}
                  </p>
                  <p className="mt-3 text-[1.45rem] font-light tracking-[-0.03em]">{snapshot.value}</p>
                  <p
                    className="mt-2 text-[12px] font-light leading-relaxed"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {snapshot.note}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel
          id="audit"
          eyebrow="Auditability"
          title="Every assist stays query-to-outcome attributable"
          description="This is the trust surface behind the product. Retrieval, prompt injection, and outcome logging are kept in one chain so enterprises can inspect what was used and demote bad reasoning automatically."
        >
          <div className="grid gap-5">
            <AttributionFlow rows={attributionStages} />
            <div className="grid gap-2.5">
              {auditNotes.map((note) => (
                <AuditNoteCard key={note.label} note={note} />
              ))}
            </div>
          </div>
        </Panel>
      </section>

      <section
        className="dash-enter grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]"
        style={staggerStyle(3)}
      >
        <Panel
          id="trail"
          eyebrow="Audit Trail"
          title="Recent attributed runs"
          description="Operators should be able to inspect the last useful recalls without digging through raw logs. This is the thin product layer on top of the event substrate."
        >
          <AuditTrailTable rows={auditRows} />
        </Panel>

        <Panel
          id="patterns"
          eyebrow="Reusable Memory"
          title="Top promoted patterns"
          description="The blocks currently earning their keep. Show reuse, helpfulness, and token lift together so quality and efficiency are evaluated on the same surface."
        >
          <PatternTable rows={patterns} />
        </Panel>
      </section>
    </article>
  );
}

function MetricCard({ metric }: { metric: DashboardMetric }) {
  const colors = METRIC_TONES[metric.tone];

  return (
    <article
      className="rounded-sm border p-4"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <p
        className="text-[10px] font-mono uppercase tracking-[0.18em]"
        style={{ color: "var(--text-tertiary)" }}
      >
        {metric.label}
      </p>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[1.7rem] font-light tracking-[-0.04em]">{metric.value}</p>
        <span
          className="rounded-sm px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
          style={{ background: colors.badge, color: colors.text }}
        >
          {metric.delta}
        </span>
      </div>

      <p
        className="mt-3 min-h-[2.75rem] text-[12px] font-light leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        {metric.note}
      </p>

      <div className="mt-4">
        <Sparkline values={metric.trend} line={colors.line} fill={colors.fill} />
      </div>
    </article>
  );
}

function Sparkline({
  values,
  line,
  fill,
}: {
  values: readonly number[];
  line: string;
  fill: string;
}) {
  const width = 176;
  const height = 54;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = buildPoints(values, width, height, pad, min, max);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-12 w-full"
      role="img"
      aria-label="Metric trend"
    >
      <path d={buildAreaPath(points, height, pad)} fill={fill} />
      <path
        d={buildLinePath(points)}
        fill="none"
        stroke={line}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AttributionFlow({ rows }: { rows: readonly AttributionStage[] }) {
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.label} className="space-y-2">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <p className="text-sm font-light">{row.label}</p>
              <p
                className="mt-1 text-[12px] font-light leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                {row.note}
              </p>
            </div>
            <span className="shrink-0 text-sm font-light tabular-nums">{row.value}</span>
          </div>

          <div
            className="h-2 overflow-hidden rounded-full"
            style={{ background: "rgba(255,255,255,0.06)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${row.width}%`,
                background: "var(--accent)",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditNoteCard({ note }: { note: AuditNote }) {
  return (
    <div
      className="rounded-sm border p-3.5"
      style={{ borderColor: "var(--border)", background: "rgba(255,255,255,0.015)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <p
          className="text-[10px] font-mono uppercase tracking-[0.18em]"
          style={{ color: "var(--text-tertiary)" }}
        >
          {note.label}
        </p>
        <span
          className="rounded-sm border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
          style={{ borderColor: "var(--border)", color: "var(--text)" }}
        >
          {note.value}
        </span>
      </div>
      <p
        className="mt-3 text-[12px] font-light leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        {note.note}
      </p>
    </div>
  );
}

function PatternTable({ rows }: { rows: readonly PatternRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <TableHead>Pattern</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Reuse</TableHead>
            <TableHead>Helpful</TableHead>
            <TableHead>Lift</TableHead>
            <TableHead>Status</TableHead>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = PATTERN_STATUS_STYLES[row.status];
            return (
              <tr key={row.pattern}>
                <TableCell>
                  <div className="min-w-[240px]">
                    <p className="text-sm font-light">{row.pattern}</p>
                    <p
                      className="mt-1 text-[11px] font-light leading-relaxed"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      last applied {row.lastApplied}
                    </p>
                  </div>
                </TableCell>
                <TableCell>{row.scope}</TableCell>
                <TableCell>{row.reuse}</TableCell>
                <TableCell>{row.helpfulRate}</TableCell>
                <TableCell>{row.lift}</TableCell>
                <TableCell>
                  <span
                    className="inline-flex rounded-sm px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
                    style={{ background: status.background, color: status.color }}
                  >
                    {status.label}
                  </span>
                </TableCell>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuditTrailTable({ rows }: { rows: readonly AuditTrailRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <TableHead>Task</TableHead>
            <TableHead>Pattern</TableHead>
            <TableHead>Query ID</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Status</TableHead>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = AUDIT_STATUS_STYLES[row.status];
            return (
              <tr key={row.traceId}>
                <TableCell>
                  <div className="min-w-[220px]">
                    <p className="text-sm font-light">{row.task}</p>
                    <p
                      className="mt-1 text-[11px] font-light leading-relaxed"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      {row.time}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-[12px] font-light" style={{ color: "var(--text-secondary)" }}>
                    {row.pattern}
                  </span>
                </TableCell>
                <TableCell>{row.traceId}</TableCell>
                <TableCell>{row.outcome}</TableCell>
                <TableCell>{row.tokensSaved}</TableCell>
                <TableCell>
                  <span
                    className="inline-flex rounded-sm px-2 py-1 text-[10px] font-mono uppercase tracking-[0.16em]"
                    style={{ background: status.background, color: status.color }}
                  >
                    {status.label}
                  </span>
                </TableCell>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TableHead({ children }: { children: ReactNode }) {
  return (
    <th
      className="border-b px-0 py-2 pr-4 text-left text-[10px] font-mono uppercase tracking-[0.18em]"
      style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
      scope="col"
    >
      {children}
    </th>
  );
}

function TableCell({ children }: { children: ReactNode }) {
  return (
    <td
      className="border-b px-0 py-3 pr-4 align-top text-sm font-light"
      style={{ borderColor: "rgba(237, 236, 236, 0.06)", color: "var(--text)" }}
    >
      {children}
    </td>
  );
}
