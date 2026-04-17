import type { DashboardUiState } from "@/components/dashboard/state/types";

const TIME: Record<DashboardUiState["timeRange"], string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

const INSIGHT: Record<DashboardUiState["primaryInsight"], string> = {
  all: "All traces",
  scopes: "By scope",
  promoted: "Promoted only",
  review: "Needs review",
};

const SCOPE: Record<DashboardUiState["traceScope"], string> = {
  all: "All layers",
  org: "Org layer",
  project: "Project layer",
  personal: "Personal layer",
};

/** Human-readable summary of current filters — swap for API-driven copy later. */
export function formatActiveContext(state: DashboardUiState): string {
  return [TIME[state.timeRange], INSIGHT[state.primaryInsight], SCOPE[state.traceScope]].join(" · ");
}
