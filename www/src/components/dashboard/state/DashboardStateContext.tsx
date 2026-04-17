"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type { DashboardUiAction, DashboardUiState, PrimaryInsightId, TimeRangeId, TraceScopeId } from "./types";

const initialState: DashboardUiState = {
  timeRange: "30d",
  primaryInsight: "all",
  traceScope: "all",
  selectedPatternKey: null,
  funnelStage: null,
  focusedMetricIndex: null,
};

function reducer(state: DashboardUiState, action: DashboardUiAction): DashboardUiState {
  switch (action.type) {
    case "setTimeRange":
      return { ...state, timeRange: action.timeRange };
    case "setPrimaryInsight":
      return { ...state, primaryInsight: action.primaryInsight };
    case "setTraceScope":
      return { ...state, traceScope: action.traceScope };
    case "setSelectedPattern":
      return { ...state, selectedPatternKey: action.patternKey };
    case "setFunnelStage":
      return { ...state, funnelStage: action.stage };
    case "setFocusedMetric":
      return { ...state, focusedMetricIndex: action.index };
  }
}

export interface DashboardStateApi {
  state: DashboardUiState;
  setTimeRange: (timeRange: TimeRangeId) => void;
  setPrimaryInsight: (primaryInsight: PrimaryInsightId) => void;
  setTraceScope: (traceScope: TraceScopeId) => void;
  setSelectedPattern: (patternKey: string | null) => void;
  setFunnelStage: (stage: number | null) => void;
  setFocusedMetric: (index: number | null) => void;
}

const DashboardStateContext = createContext<DashboardStateApi | null>(null);

export function DashboardStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setTimeRange = useCallback((timeRange: TimeRangeId) => {
    dispatch({ type: "setTimeRange", timeRange });
  }, []);

  const setPrimaryInsight = useCallback((primaryInsight: PrimaryInsightId) => {
    dispatch({ type: "setPrimaryInsight", primaryInsight });
  }, []);

  const setTraceScope = useCallback((traceScope: TraceScopeId) => {
    dispatch({ type: "setTraceScope", traceScope });
  }, []);

  const setSelectedPattern = useCallback((patternKey: string | null) => {
    dispatch({ type: "setSelectedPattern", patternKey });
  }, []);

  const setFunnelStage = useCallback((stage: number | null) => {
    dispatch({ type: "setFunnelStage", stage });
  }, []);

  const setFocusedMetric = useCallback((index: number | null) => {
    dispatch({ type: "setFocusedMetric", index });
  }, []);

  const value = useMemo(
    () => ({
      state,
      setTimeRange,
      setPrimaryInsight,
      setTraceScope,
      setSelectedPattern,
      setFunnelStage,
      setFocusedMetric,
    }),
    [
      state,
      setTimeRange,
      setPrimaryInsight,
      setTraceScope,
      setSelectedPattern,
      setFunnelStage,
      setFocusedMetric,
    ],
  );

  return <DashboardStateContext.Provider value={value}>{children}</DashboardStateContext.Provider>;
}

export function useDashboardState(): DashboardStateApi {
  const ctx = useContext(DashboardStateContext);
  if (!ctx) {
    throw new Error("useDashboardState must be used within DashboardStateProvider");
  }
  return ctx;
}
