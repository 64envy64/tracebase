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

export interface ImpactSnapshot {
  label: string;
  value: string;
  note: string;
}

export interface AttributionStage {
  label: string;
  value: string;
  width: number;
  note: string;
}

export interface AuditNote {
  label: string;
  value: string;
  note: string;
}

export interface PatternRow {
  pattern: string;
  scope: string;
  reuse: string;
  helpfulRate: string;
  lift: string;
  lastApplied: string;
  status: "promoted" | "watching" | "draft";
}

export interface AuditTrailRow {
  task: string;
  pattern: string;
  traceId: string;
  outcome: string;
  tokensSaved: string;
  time: string;
  status: "verified" | "watching" | "flagged";
}

export const dashboardData = {
  toolbar: {
    organization: "tracebase workspace",
    workspace: "production workspace",
    environment: "Production",
    lastUpdated: "Updated 5m ago",
  },
  metrics: [
    {
      label: "Recall rate",
      value: "38%",
      delta: "+9.4pp",
      note: "eligible runs matched a prior reasoning block before first completion",
      trend: [18, 21, 24, 26, 29, 31, 35, 38],
      tone: "accent",
    },
    {
      label: "Helpful reuse",
      value: "81%",
      delta: "+11%",
      note: "injected traces later confirmed useful by explicit usage or outcome overlap",
      trend: [55, 59, 63, 66, 71, 75, 78, 81],
      tone: "success",
    },
    {
      label: "Avg token delta",
      value: "-31%",
      delta: "-7.2pp",
      note: "median reduction versus cold-start baseline on repeated task families",
      trend: [10, 12, 15, 18, 22, 25, 29, 31],
      tone: "signal",
    },
    {
      label: "Trace attribution",
      value: "94%",
      delta: "+6pp",
      note: "recalled runs with query → injection → outcome linkage preserved end to end",
      trend: [71, 74, 77, 81, 84, 88, 91, 94],
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
        label: "with tracebase",
        values: [86, 74, 67, 60, 54, 49, 45],
        tone: "optimized",
      },
    ] satisfies DashboardSeries[],
  },
  impactSnapshots: [
    {
      label: "Patterns injected",
      value: "3.4k",
      note: "strong-match runs where a prior block actually entered prompt context",
    },
    {
      label: "Est. tokens saved",
      value: "18.7M",
      note: "aggregate model spend avoided over the current 30-day window",
    },
    {
      label: "Est. cost saved",
      value: "$3.2k",
      note: "based on the current model mix and observed delta versus cold runs",
    },
  ] satisfies ImpactSnapshot[],
  attributionStages: [
    {
      label: "Captured",
      value: "12.4k",
      width: 100,
      note: "successful runs written into the memory substrate",
    },
    {
      label: "Recalled",
      value: "5.1k",
      width: 72,
      note: "runs that found an above-threshold candidate before generation",
    },
    {
      label: "Injected",
      value: "3.4k",
      width: 56,
      note: "only prompt-rendered traces; payload and analytics stay one-to-one",
    },
    {
      label: "Verified helpful",
      value: "2.8k",
      width: 46,
      note: "closed-loop runs where the assist was actually used and helped",
    },
  ] satisfies AttributionStage[],
  auditNotes: [
    {
      label: "Query IDs",
      value: "100%",
      note: "every recall request gets a stable handle that follows the run through outcome recording",
    },
    {
      label: "Payload parity",
      value: "strict",
      note: "if a block or fact is rendered into the prompt, the matching injection event exists, and vice versa",
    },
    {
      label: "Self-correction",
      value: "on",
      note: "disproved blocks demote out of serving automatically instead of poisoning future runs",
    },
  ] satisfies AuditNote[],
  patterns: [
    {
      pattern: "swebench.astropy-path-normalization",
      scope: "org",
      reuse: "184x",
      helpfulRate: "92%",
      lift: "-42%",
      lastApplied: "12m ago",
      status: "promoted",
    },
    {
      pattern: "support.triage-water-damage-routing",
      scope: "project",
      reuse: "109x",
      helpfulRate: "88%",
      lift: "-34%",
      lastApplied: "27m ago",
      status: "promoted",
    },
    {
      pattern: "claims.policy-overlap-secondary-cause",
      scope: "org",
      reuse: "86x",
      helpfulRate: "81%",
      lift: "-29%",
      lastApplied: "1h ago",
      status: "watching",
    },
    {
      pattern: "docs.oauth-token-refresh-expiry",
      scope: "personal",
      reuse: "39x",
      helpfulRate: "73%",
      lift: "-18%",
      lastApplied: "2h ago",
      status: "draft",
    },
  ] satisfies PatternRow[],
  auditRows: [
    {
      task: "Astropy path normalization failure",
      pattern: "swebench.astropy-path-normalization",
      traceId: "q_01JY1T3K",
      outcome: "resolved with assist",
      tokensSaved: "-44%",
      time: "8m ago",
      status: "verified",
    },
    {
      task: "Water damage support triage",
      pattern: "support.triage-water-damage-routing",
      traceId: "q_01JY1PXA",
      outcome: "resolved after recall",
      tokensSaved: "-31%",
      time: "21m ago",
      status: "verified",
    },
    {
      task: "Claims secondary-cause routing",
      pattern: "claims.policy-overlap-secondary-cause",
      traceId: "q_01JY1MD8",
      outcome: "watching for confirmation",
      tokensSaved: "-17%",
      time: "47m ago",
      status: "watching",
    },
    {
      task: "OAuth token refresh expiry bug",
      pattern: "docs.oauth-token-refresh-expiry",
      traceId: "q_01JY1H2N",
      outcome: "flagged for review",
      tokensSaved: "+3%",
      time: "2h ago",
      status: "flagged",
    },
  ] satisfies AuditTrailRow[],
} as const;
