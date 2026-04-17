/**
 * Dashboard UI state — keep stable field names when wiring to API / React Query.
 */
export type TimeRangeId = "7d" | "30d" | "90d" | "all";

export type PrimaryInsightId = "all" | "scopes" | "promoted" | "review";

export type TraceScopeId = "all" | "org" | "project" | "personal";

export interface DashboardUiState {
  timeRange: TimeRangeId;
  primaryInsight: PrimaryInsightId;
  traceScope: TraceScopeId;
  selectedPatternKey: string | null;
  funnelStage: number | null;
  focusedMetricIndex: number | null;
}

export type DashboardUiAction =
  | { type: "setTimeRange"; timeRange: TimeRangeId }
  | { type: "setPrimaryInsight"; primaryInsight: PrimaryInsightId }
  | { type: "setTraceScope"; traceScope: TraceScopeId }
  | { type: "setSelectedPattern"; patternKey: string | null }
  | { type: "setFunnelStage"; stage: number | null }
  | { type: "setFocusedMetric"; index: number | null };
