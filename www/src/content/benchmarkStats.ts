/**
 * Цифры для лендинга — только то, что явно зафиксировано в whitepaper/page.tsx (TraceBase Technical Report v1.0).
 * При обновлении отчёта меняйте и этот файл, и страницу whitepaper.
 */
export const SWE_BENCH_SNAPSHOT = {
  benchmark: "SWE-bench Verified",
  harness: "mini-swe-agent v2.2.8 · Docker",
  model: "Claude Sonnet 4.6",
  attempted: 20,
  completed: 16,
  accuracyBaselinePct: 62,
  accuracyInjectionPct: 75,
  /** Абсолютный прирост в п.п., без округлений маркетинга. */
  accuracyGainPp: 13,
  newFixes: 2,
  regressions: 0,
  highConfidenceN: 10,
  stepReductionAvgPct: 17,
  stepReductionPeakPct: 45,
  costReductionAvgPct: 34,
  costReductionPeakPct: 49,
  bestTaskId: "astropy-14309",
  bestTaskStepsBefore: 31,
  bestTaskStepsAfter: 13,
  bestTaskStepReductionPct: 58,
  bestTaskCostReductionPct: 64,
  retrievalSignalCount: 6,
  patternFields: 3,
} as const;
