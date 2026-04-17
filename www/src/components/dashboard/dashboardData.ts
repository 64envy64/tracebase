export type MetricTone = "accent" | "signal" | "success" | "warning";

export interface DashboardMetric {
  label: string;
  value: string;
  delta: string;
  note: string;
  trend: readonly number[];
  tone: MetricTone;
}

export interface DashboardSeries {
  label: string;
  values: readonly number[];
  tone: "baseline" | "optimized";
}

export interface ScopeRow {
  label: string;
  traces: string;
  coverage: number;
  helpfulRate: string;
}

export interface FunnelRow {
  label: string;
  value: string;
  width: number;
  note: string;
}

export interface TraceRow {
  pattern: string;
  scope: string;
  reuse: string;
  quality: string;
  lastApplied: string;
  status: "promoted" | "watching" | "draft";
}

export interface ActivityRow {
  title: string;
  description: string;
  time: string;
  scope: string;
}

export interface ControlRow {
  label: string;
  value: string;
  note: string;
}

export const dashboardData = {
  toolbar: {
    organization: "tracebase organization",
    workspace: "production workspace",
    environment: "Production",
    lastUpdated: "Updated 5m ago",
  },
  metrics: [
    {
      label: "Org recall rate",
      value: "38%",
      delta: "+9.4pp",
      note: "eligible runs matched a prior trace before first completion",
      trend: [18, 21, 24, 26, 29, 31, 35, 38],
      tone: "accent",
    },
    {
      label: "Avg token delta",
      value: "-31%",
      delta: "-7.2pp",
      note: "median reduction versus cold-start baseline across repeated tasks",
      trend: [10, 12, 15, 18, 22, 25, 29, 31],
      tone: "signal",
    },
    {
      label: "Helpful reuse",
      value: "81%",
      delta: "+11%",
      note: "injected traces later confirmed as helpful by feedback or outcome match",
      trend: [55, 59, 63, 66, 71, 75, 78, 81],
      tone: "success",
    },
    {
      label: "Needs review",
      value: "46",
      delta: "-12",
      note: "draft traces below org quality threshold or missing a promoted owner",
      trend: [74, 72, 70, 68, 62, 57, 51, 46],
      tone: "warning",
    },
  ] satisfies DashboardMetric[],
  chart: {
    labels: ["wk 01", "wk 02", "wk 03", "wk 04", "wk 05", "wk 06", "wk 07"],
    series: [
      {
        label: "cold start",
        values: [86, 83, 81, 79, 76, 73, 71],
        tone: "baseline",
      },
      {
        label: "with reasoning layer",
        values: [86, 74, 67, 60, 54, 49, 45],
        tone: "optimized",
      },
    ] satisfies DashboardSeries[],
  },
  scopes: [
    {
      label: "Personal",
      traces: "1.8k traces",
      coverage: 24,
      helpfulRate: "74%",
    },
    {
      label: "Project",
      traces: "4.2k traces",
      coverage: 59,
      helpfulRate: "79%",
    },
    {
      label: "Org",
      traces: "12.6k traces",
      coverage: 86,
      helpfulRate: "84%",
    },
    {
      label: "Global",
      traces: "62k traces",
      coverage: 41,
      helpfulRate: "68%",
    },
  ] satisfies ScopeRow[],
  controls: [
    {
      label: "Promotion rules",
      value: "auto + reviewer",
      note: "High-confidence traces auto-promote after two confirmed successful reuses.",
    },
    {
      label: "Retention",
      value: "90d active",
      note: "Low-signal drafts age into archive unless reactivated by a fresh match.",
    },
    {
      label: "Namespaces",
      value: "repo / team / org",
      note: "Teams can pin private schemas and block noisy global matches per workspace.",
    },
  ] satisfies ControlRow[],
  funnel: [
    {
      label: "captured runs",
      value: "12.4k",
      width: 100,
      note: "all successful task completions",
    },
    {
      label: "recalled candidates",
      value: "5.1k",
      width: 71,
      note: "returned above the min-score threshold",
    },
    {
      label: "injected traces",
      value: "3.4k",
      width: 53,
      note: "actually surfaced into the model context",
    },
    {
      label: "confirmed helpful",
      value: "2.8k",
      width: 44,
      note: "feedback or outcome overlap marked the trace useful",
    },
  ] satisfies FunnelRow[],
  patterns: [
    {
      pattern: "swebench.astropy-path-normalization",
      scope: "org",
      reuse: "184x",
      quality: "0.93",
      lastApplied: "12m ago",
      status: "promoted",
    },
    {
      pattern: "support.triage-water-damage-routing",
      scope: "project",
      reuse: "109x",
      quality: "0.88",
      lastApplied: "27m ago",
      status: "promoted",
    },
    {
      pattern: "claims.policy-overlap-secondary-cause",
      scope: "org",
      reuse: "86x",
      quality: "0.82",
      lastApplied: "1h ago",
      status: "watching",
    },
    {
      pattern: "docs.oauth-token-refresh-expiry",
      scope: "personal",
      reuse: "39x",
      quality: "0.79",
      lastApplied: "2h ago",
      status: "draft",
    },
    {
      pattern: "global.react-undefined-first-render",
      scope: "global",
      reuse: "244x",
      quality: "0.91",
      lastApplied: "5m ago",
      status: "promoted",
    },
  ] satisfies TraceRow[],
  activity: [
    {
      title: "Promoted a new org pattern",
      description: "TypeScript fixture traces reached the reuse threshold and moved into the org scope.",
      time: "8m ago",
      scope: "org",
    },
    {
      title: "Scoped out a noisy global match",
      description: "The onboarding repo now blocks generic React hydration patterns from overriding local conventions.",
      time: "41m ago",
      scope: "project",
    },
    {
      title: "Backfilled missing owners",
      description: "42 draft traces were assigned to the platform team for review and promotion.",
      time: "2h ago",
      scope: "ops",
    },
  ] satisfies ActivityRow[],
};
