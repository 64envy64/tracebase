"use client";

import { Panel } from "@/components/dashboard/Panel";
import { ToolbarTag } from "@/components/dashboard/ToolbarTag";
import { InteractiveFunnelChart } from "@/components/dashboard/charts/InteractiveFunnelChart";
import { InteractiveLineChart } from "@/components/dashboard/charts/InteractiveLineChart";
import { formatActiveContext } from "@/components/dashboard/selectors/formatContext";
import { useDashboardState } from "@/components/dashboard/state/DashboardStateContext";
import type {
  ActivityRow,
  ControlRow,
  DashboardMetric,
  MetricTone,
  ScopeRow,
  TraceRow,
} from "@/components/dashboard/dashboardData";
import { dashboardData } from "@/components/dashboard/dashboardData";
import { buildAreaPath, buildLinePath, buildPoints } from "@/components/dashboard/lib/chartMath";
import type { PrimaryInsightId, TimeRangeId, TraceScopeId } from "@/components/dashboard/state/types";

const METRIC_TONES: Record<
  MetricTone,
  { line: string; fill: string; badge: string; text: string }
> = {
  accent: {
    line: "var(--accent)",
    fill: "var(--accent-soft)",
    badge: "rgba(177, 255, 109, 0.12)",
    text: "#d4ffad",
  },
  signal: {
    line: "var(--signal)",
    fill: "var(--signal-soft)",
    badge: "rgba(125, 211, 252, 0.12)",
    text: "#bae6fd",
  },
  success: {
    line: "var(--success)",
    fill: "var(--success-soft)",
    badge: "rgba(109, 231, 183, 0.12)",
    text: "#bbf7d0",
  },
  warning: {
    line: "var(--warning)",
    fill: "var(--warning-soft)",
    badge: "rgba(242, 197, 114, 0.12)",
    text: "#f8deb1",
  },
};

const STATUS_STYLES: Record<
  TraceRow["status"],
  { label: string; color: string; background: string }
> = {
  promoted: {
    label: "promoted",
    color: "#d4ffad",
    background: "rgba(177, 255, 109, 0.12)",
  },
  watching: {
    label: "watching",
    color: "#bae6fd",
    background: "rgba(125, 211, 252, 0.12)",
  },
  draft: {
    label: "draft",
    color: "#f8deb1",
    background: "rgba(242, 197, 114, 0.12)",
  },
};

const TIME_OPTIONS: { id: TimeRangeId; label: string }[] = [
  { id: "7d", label: "LAST 7D" },
  { id: "30d", label: "LAST 30D" },
  { id: "90d", label: "LAST 90D" },
  { id: "all", label: "ALL TIME" },
];

const INSIGHT_OPTIONS: { id: PrimaryInsightId; label: string }[] = [
  { id: "all", label: "ALL TRACES" },
  { id: "scopes", label: "BY SCOPE" },
  { id: "promoted", label: "PROMOTED" },
  { id: "review", label: "NEEDS REVIEW" },
];

const TRACE_OPTIONS: { id: TraceScopeId; label: string }[] = [
  { id: "all", label: "ALL" },
  { id: "org", label: "ORG" },
  { id: "project", label: "PROJECT" },
  { id: "personal", label: "PERSONAL" },
];

function workspaceHeading(workspace: string) {
  return workspace
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function filterPatterns(rows: readonly TraceRow[], scope: TraceScopeId): TraceRow[] {
  if (scope === "all") return [...rows];
  return rows.filter((r) => r.scope === scope);
}

function traceScopeFromScopeLabel(label: string): TraceScopeId {
  const key = label.toLowerCase();
  if (key === "personal") return "personal";
  if (key === "project") return "project";
  if (key === "org") return "org";
  return "all";
}

function isScopeRowActive(scopeLabel: string, traceScope: TraceScopeId): boolean {
  const key = scopeLabel.toLowerCase();
  if (key === "global") {
    return traceScope === "all";
  }
  return traceScope === traceScopeFromScopeLabel(scopeLabel);
}

function staggerStyle(i: number) {
  return { animationDelay: `${i * 42}ms` } as const;
}

export function DashboardView() {
  const { toolbar, metrics, chart, scopes, controls, funnel, patterns, activity } =
    dashboardData;
  const { state, setTimeRange, setPrimaryInsight, setTraceScope, setSelectedPattern, setFunnelStage, setFocusedMetric } =
    useDashboardState();

  const title = workspaceHeading(toolbar.workspace);
  const contextLine = formatActiveContext(state);
  const visiblePatterns = filterPatterns(patterns, state.traceScope);

  return (
    <article className="space-y-5 pb-4" aria-label="Workspace dashboard">
      <header
        className="dash-enter flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-start lg:justify-between"
        style={{ ...staggerStyle(0), borderColor: "var(--border)" }}
      >
        <div>
          <h1 className="text-lg font-light tracking-tight">{title}</h1>
          <p
            className="mt-1.5 text-xs font-light leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            <span>{toolbar.organization}</span>
            <span className="mx-1.5" style={{ color: "var(--text-tertiary)" }}>
              ·
            </span>
            <span>{toolbar.environment}</span>
            <span className="mx-1.5" style={{ color: "var(--text-tertiary)" }}>
              ·
            </span>
            <span>{toolbar.lastUpdated}</span>
          </p>
          <p className="mt-2 text-[11px] font-light leading-snug" style={{ color: "var(--text-tertiary)" }}>
            {contextLine}
          </p>
        </div>
      </header>

      <div className="dash-enter flex flex-col gap-2" style={staggerStyle(1)}>
        <p className="text-[10px] font-mono uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
          Window
        </p>
        <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Time range">
          {TIME_OPTIONS.map((opt) => (
            <ToolbarTag
              key={opt.id}
              active={state.timeRange === opt.id}
              onClick={() => setTimeRange(opt.id)}
              ariaLabel={`Period ${opt.label}`}
            >
              {opt.label}
            </ToolbarTag>
          ))}
        </div>
      </div>

      <div className="dash-enter flex flex-col gap-2" style={staggerStyle(2)}>
        <p className="text-[10px] font-mono uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
          View
        </p>
        <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Trace view">
          {INSIGHT_OPTIONS.map((opt) => (
            <ToolbarTag
              key={opt.id}
              active={state.primaryInsight === opt.id}
              onClick={() => setPrimaryInsight(opt.id)}
              ariaLabel={opt.label}
            >
              {opt.label}
            </ToolbarTag>
          ))}
        </div>
      </div>

      <section aria-labelledby="dashboard-kpi-heading" className="dash-enter space-y-2" style={staggerStyle(3)}>
        <h2 id="dashboard-kpi-heading" className="sr-only">
          Key metrics
        </h2>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {metrics.map((metric, index) => (
            <MetricCard
              key={metric.label}
              metric={metric}
              selected={state.focusedMetricIndex === index}
              onSelect={() => setFocusedMetric(state.focusedMetricIndex === index ? null : index)}
            />
          ))}
        </div>
      </section>

      <section className="dash-enter space-y-3" aria-label="Efficiency and namespaces" style={staggerStyle(4)}>
        <div className="overflow-hidden rounded-sm border" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
          <div
            className="flex flex-col gap-2.5 border-b px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            <p className="text-[10px] font-mono uppercase tracking-[0.18em]" style={{ color: "var(--text-tertiary)" }}>
              Trace coverage
            </p>
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              {TRACE_OPTIONS.map((opt) => (
                <ToolbarTag
                  key={opt.id}
                  active={state.traceScope === opt.id}
                  onClick={() => setTraceScope(opt.id)}
                  ariaLabel={`Scope ${opt.label}`}
                >
                  {opt.label}
                </ToolbarTag>
              ))}
              <span className="pl-1 text-[10px] font-mono uppercase tracking-[0.2em]" style={{ color: "var(--text-tertiary)" }}>
                {toolbar.lastUpdated}
              </span>
            </div>
          </div>

          <div className="p-4 sm:p-5">
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,1fr)] lg:gap-5">
              <Panel
                eyebrow="Efficiency"
                title="Cold start vs assisted runs"
                description="Token index by week — scrub the chart to compare series."
              >
                <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
                  <div className="min-w-0 flex-1 basis-0">
                    <InteractiveLineChart labels={chart.labels} series={chart.series} />
                  </div>
                  <aside className="grid w-full min-w-[220px] shrink-0 grid-cols-1 gap-3 sm:grid-cols-3 lg:flex lg:w-[min(100%,300px)] lg:flex-col lg:gap-3">
                    <DataCallout
                      value="-31%"
                      label="Median token spend vs cold start"
                      note="Repeated task families, rolling window."
                    />
                    <DataCallout
                      value="2.4×"
                      label="Faster first useful answer"
                      note="Recall matched before first completion."
                    />
                    <DataCallout
                      value="17m"
                      label="Time saved / person / week"
                      note="Latency + reuse model for this org."
                    />
                  </aside>
                </div>
              </Panel>

              <Panel
                eyebrow="Namespaces"
                title="Coverage by memory layer"
                description="Click a row to mirror scope filters above."
              >
                <div className="space-y-4">
                  <div className="space-y-2.5">
                    {scopes.map((scope) => (
                      <ScopeBar
                        key={scope.label}
                        row={scope}
                        active={isScopeRowActive(scope.label, state.traceScope)}
                        onSelect={() => setTraceScope(traceScopeFromScopeLabel(scope.label))}
                      />
                    ))}
                  </div>

                  <div className="grid gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
                    {controls.map((control) => (
                      <ControlRowView key={control.label} row={control} />
                    ))}
                  </div>
                </div>
              </Panel>
            </div>
          </div>
        </div>
      </section>

      <section
        className="dash-enter grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.9fr)] lg:gap-5"
        aria-label="Patterns and activity"
        style={staggerStyle(5)}
      >
        <Panel
          id="patterns"
          eyebrow="Patterns"
          title="Highest reuse"
          description="Select a row — selection is UI state until wired to the API."
        >
          <PatternTable
            rows={visiblePatterns}
            selectedKey={state.selectedPatternKey}
            onSelectRow={(key) => setSelectedPattern(state.selectedPatternKey === key ? null : key)}
          />
        </Panel>

        <div className="grid gap-3">
          <Panel eyebrow="Pipeline" title="Store → recall → helpful" description="Tap a stage to focus the bar.">
            <InteractiveFunnelChart
              rows={funnel}
              selectedIndex={state.funnelStage}
              onSelect={setFunnelStage}
            />
          </Panel>

          <Panel eyebrow="Activity" title="Audit log" description="Recent governance events.">
            <ActivityFeed rows={activity} />
          </Panel>
        </div>
      </section>
    </article>
  );
}

function MetricCard({
  metric,
  selected,
  onSelect,
}: {
  metric: DashboardMetric;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = METRIC_TONES[metric.tone];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="rounded-sm border p-3 text-left transition-[border-color,background-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
      style={{
        borderColor: selected ? "rgba(177,255,109,0.28)" : "var(--border)",
        background: selected ? "rgba(177,255,109,0.04)" : "var(--surface)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className="text-[10px] font-mono uppercase tracking-[0.18em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            {metric.label}
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <span className="text-2xl font-extralight tracking-tight tabular-nums">{metric.value}</span>
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em]"
              style={{ color: tone.text, background: tone.badge }}
            >
              {metric.delta}
            </span>
          </div>
        </div>
        <Sparkline values={metric.trend} tone={metric.tone} />
      </div>
      <p className="mt-2 text-[11px] font-light leading-snug" style={{ color: "var(--text-secondary)" }}>
        {metric.note}
      </p>
    </button>
  );
}

function DataCallout({
  value,
  label,
  note,
}: {
  value: string;
  label: string;
  note: string;
}) {
  return (
    <div
      className="min-h-0 min-w-0 rounded-sm border p-3 sm:p-4"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xl font-extralight tabular-nums">{value}</span>
        <span className="text-[10px] font-mono uppercase tracking-[0.14em]" style={{ color: "var(--text-tertiary)" }}>
          snapshot
        </span>
      </div>
      <p className="mt-1 text-xs font-light">{label}</p>
      <p className="mt-1 text-[11px] font-light leading-snug" style={{ color: "var(--text-secondary)" }}>
        {note}
      </p>
    </div>
  );
}

function ScopeBar({
  row,
  active,
  onSelect,
}: {
  row: ScopeRow;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full space-y-1.5 rounded-sm border border-transparent px-1 py-1 text-left transition-[background-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
      style={{ background: active ? "rgba(255,255,255,0.03)" : "transparent" }}
      aria-pressed={active}
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <div className="min-w-0">
          <p className="font-light">{row.label}</p>
          <p className="text-xs font-light" style={{ color: "var(--text-secondary)" }}>
            {row.traces}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-light tabular-nums">{row.coverage}%</p>
          <p className="text-xs font-light" style={{ color: "var(--text-secondary)" }}>
            helpful {row.helpfulRate}
          </p>
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${row.coverage}%`,
            background: active ? "var(--signal)" : "var(--accent)",
          }}
        />
      </div>
    </button>
  );
}

function ControlRowView({ row }: { row: ControlRow }) {
  return (
    <div className="rounded-sm border px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-light">{row.label}</p>
          <p className="mt-0.5 text-[11px] font-light leading-snug" style={{ color: "var(--text-secondary)" }}>
            {row.note}
          </p>
        </div>
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em]"
          style={{
            color: "#d4ffad",
            background: "rgba(177, 255, 109, 0.08)",
          }}
        >
          {row.value}
        </span>
      </div>
    </div>
  );
}

function PatternTable({
  rows,
  selectedKey,
  onSelectRow,
}: {
  rows: readonly TraceRow[];
  selectedKey: string | null;
  onSelectRow: (pattern: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[640px] w-full border-collapse text-sm" style={{ borderColor: "var(--border)" }}>
        <thead>
          <tr className="border-b text-left" style={{ borderColor: "var(--border)" }}>
            {["pattern", "scope", "reuse", "quality", "last used", "status"].map((col) => (
              <th
                key={col}
                scope="col"
                className="px-3 py-2 text-[10px] font-mono font-normal uppercase tracking-[0.16em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = STATUS_STYLES[row.status];
            const selected = selectedKey === row.pattern;

            return (
              <tr
                key={row.pattern}
                className="border-b transition-[background-color]"
                style={{
                  borderColor: "var(--border)",
                  background: selected ? "rgba(177,255,109,0.04)" : "transparent",
                }}
              >
                <td className="min-w-0 px-3 py-2 align-top">
                  <button
                    type="button"
                    onClick={() => onSelectRow(row.pattern)}
                    className="w-full text-left font-light transition-[color] hover:[color:var(--accent)]"
                  >
                    {row.pattern}
                  </button>
                  <div className="mt-0.5 text-[11px] font-light" style={{ color: "var(--text-secondary)" }}>
                    reasoning trace
                  </div>
                </td>
                <td className="px-3 py-2 align-top" style={{ color: "var(--text-secondary)" }}>
                  {row.scope}
                </td>
                <td className="px-3 py-2 align-top tabular-nums" style={{ color: "var(--text-secondary)" }}>
                  {row.reuse}
                </td>
                <td className="px-3 py-2 align-top tabular-nums">{row.quality}</td>
                <td className="px-3 py-2 align-top" style={{ color: "var(--text-secondary)" }}>
                  {row.lastApplied}
                </td>
                <td className="px-3 py-2 align-top">
                  <span
                    className="inline-flex rounded-sm px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em]"
                    style={{ color: status.color, background: status.background }}
                  >
                    {status.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActivityFeed({ rows }: { rows: readonly ActivityRow[] }) {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={`${row.title}-${row.time}`}
          className="rounded-sm border px-3 py-2.5 transition-[border-color] hover:[border-color:rgba(237,236,236,0.12)]"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-light">{row.title}</p>
              <p className="mt-1 text-[11px] font-light leading-snug" style={{ color: "var(--text-secondary)" }}>
                {row.description}
              </p>
            </div>
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em]"
              style={{
                color: "var(--text-tertiary)",
                background: "rgba(255,255,255,0.04)",
              }}
            >
              {row.scope}
            </span>
          </div>
          <p className="mt-2 text-[10px] font-mono uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>
            {row.time}
          </p>
        </div>
      ))}
    </div>
  );
}

function Sparkline({
  values,
  tone,
}: {
  values: readonly number[];
  tone: MetricTone;
}) {
  const width = 96;
  const height = 36;
  const points = buildPoints(values, width, height, 4);
  const colors = METRIC_TONES[tone];

  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} className="h-9 w-24 shrink-0">
      <path d={buildAreaPath(points, height, 4)} fill={colors.fill} />
      <path
        d={buildLinePath(points)}
        fill="none"
        stroke={colors.line}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
