/**
 * Dashboard-side merge of workspace-scoped UsageMetrics samples.
 *
 * Phase 1E reads rolled-up daily samples from `listUsageSamples` and
 * renders a project-level (workspace-scoped) Impact view. This module
 * is the one place that knows how to fold N samples into one; the UI
 * never re-invents the math.
 *
 * Invariants kept intact from the CLI-side `computeUsageMetrics`:
 *   - `observed` sums are additive across buckets.
 *   - `estimated` values are weight-averaged by sample size, with the
 *     summed sample size reported back. Null estimates remain null —
 *     a single bucket without a shadow arm cannot resurrect an
 *     estimate the others lack.
 *   - `integrity` counters accumulate.
 *
 * Anything with `scope !== "workspace"` is filtered out before the
 * fold. Per-agent rollups (Phase 2) will be rendered on a separate
 * surface; this module does not mix granularities.
 */
import type { UsageMetrics } from "@/lib/usage/types";
import type { ControlPlaneUsageSample } from "./types";

export type DailyBucket = {
  /** ISO date string (UTC midnight) — used as X axis label. */
  date: string;
  metrics: UsageMetrics;
};

export type ImpactWindow = {
  afterTs: string;
  beforeTs: string;
  totals: UsageMetrics;
  buckets: DailyBucket[];
};

export function extractWorkspaceSamples(
  samples: readonly ControlPlaneUsageSample[],
): DailyBucket[] {
  const out: DailyBucket[] = [];
  for (const sample of samples) {
    const parsed = parseUsageMetrics(sample.metrics);
    if (!parsed) continue;
    if (parsed.scope !== "workspace") continue;
    out.push({
      date: sample.windowStart.slice(0, 10), // YYYY-MM-DD
      metrics: parsed,
    });
  }
  // Ascending by window_start so timeseries renders left-to-right.
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export function foldImpactWindow(input: {
  afterTs: string;
  beforeTs: string;
  buckets: DailyBucket[];
}): ImpactWindow {
  const { afterTs, beforeTs, buckets } = input;
  if (buckets.length === 0) {
    return {
      afterTs,
      beforeTs,
      totals: emptyMetrics(afterTs, beforeTs),
      buckets: [],
    };
  }

  let eligibleRuns = 0;
  let recalledRuns = 0;
  let injectedRuns = 0;
  let usedRuns = 0;
  let helpfulRuns = 0;

  let tokensSavedSum = 0;
  let tokensSavedWeight = 0;
  let tokensSavedHadAny = false;
  let tokensSavedN = 0;

  let latencySumMs = 0;
  let latencyWeight = 0;
  let latencyHadAny = false;
  let latencyN = 0;

  let shadowControlMismatches = 0;
  let outcomesWithoutRetrieval = 0;

  for (const bucket of buckets) {
    const o = bucket.metrics.observed;
    eligibleRuns += o.eligibleRuns;
    recalledRuns += o.recalledRuns;
    injectedRuns += o.injectedRuns;
    usedRuns += o.usedRuns;
    helpfulRuns += o.helpfulRuns;

    const t = bucket.metrics.estimated.tokensSaved;
    if (t.value !== null && t.sampleSize > 0) {
      tokensSavedHadAny = true;
      tokensSavedSum += t.value;
      tokensSavedWeight += t.sampleSize;
      tokensSavedN += t.sampleSize;
    }

    const l = bucket.metrics.estimated.latencySavedMs;
    if (l.value !== null && l.sampleSize > 0) {
      latencyHadAny = true;
      latencySumMs += l.value;
      latencyWeight += l.sampleSize;
      latencyN += l.sampleSize;
    }

    shadowControlMismatches += bucket.metrics.integrity.shadowControlMismatches;
    outcomesWithoutRetrieval += bucket.metrics.integrity.outcomesWithoutRetrieval;
  }

  const resolvedRateWithMemory =
    injectedRuns > 0 ? helpfulRuns / injectedRuns : null;

  const totals: UsageMetrics = {
    scope: "workspace",
    window: {
      afterTs: Date.parse(afterTs),
      beforeTs: Date.parse(beforeTs),
    },
    observed: {
      eligibleRuns,
      recalledRuns,
      injectedRuns,
      usedRuns,
      helpfulRuns,
      resolvedRateWithMemory,
    },
    estimated: {
      tokensSaved: {
        value: tokensSavedHadAny ? tokensSavedSum : null,
        sampleSize: tokensSavedN,
        formula:
          "(Σ mean(shadow.tokens) − mean(treatment.tokens)) × injectedRuns, per bucket",
      },
      latencySavedMs: {
        value: latencyHadAny ? latencySumMs : null,
        sampleSize: latencyN,
        formula:
          "(Σ mean(shadow.durationMs) − mean(treatment.durationMs)) × injectedRuns, per bucket",
      },
    },
    integrity: {
      shadowControlMismatches,
      outcomesWithoutRetrieval,
    },
  };
  // The weight-averaged arithmetic lives on the Impact page when we
  // want per-run estimates; the summed `value` above is the total
  // savings across the window, which is the number the UI renders.
  // Kept weight/sampleSize around so estimates page can show a
  // per-run figure later if needed.
  void tokensSavedWeight;
  void latencyWeight;

  return { afterTs, beforeTs, totals, buckets };
}

function emptyMetrics(afterTs: string, beforeTs: string): UsageMetrics {
  return {
    scope: "workspace",
    window: {
      afterTs: Date.parse(afterTs),
      beforeTs: Date.parse(beforeTs),
    },
    observed: {
      eligibleRuns: 0,
      recalledRuns: 0,
      injectedRuns: 0,
      usedRuns: 0,
      helpfulRuns: 0,
      resolvedRateWithMemory: null,
    },
    estimated: {
      tokensSaved: {
        value: null,
        sampleSize: 0,
        formula: "needs at least one bucket with a shadow arm",
      },
      latencySavedMs: {
        value: null,
        sampleSize: 0,
        formula: "needs at least one bucket with a shadow arm",
      },
    },
    integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
  };
}

function parseUsageMetrics(raw: Record<string, unknown>): UsageMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const scope = raw.scope;
  const observed = raw.observed as Record<string, unknown> | undefined;
  const estimated = raw.estimated as Record<string, unknown> | undefined;
  const integrity = raw.integrity as Record<string, unknown> | undefined;
  const window = raw.window as Record<string, unknown> | undefined;
  if (scope !== "workspace" && scope !== "agent") return null;
  if (!observed || !estimated || !integrity || !window) return null;
  const obs = pickObserved(observed);
  const est = pickEstimated(estimated);
  const itg = pickIntegrity(integrity);
  if (!obs || !est || !itg) return null;
  return {
    scope,
    window: {
      ...(typeof window.afterTs === "number" ? { afterTs: window.afterTs } : {}),
      ...(typeof window.beforeTs === "number" ? { beforeTs: window.beforeTs } : {}),
    },
    observed: obs,
    estimated: est,
    integrity: itg,
  };
}

function pickObserved(raw: Record<string, unknown>): UsageMetrics["observed"] | null {
  const keys: Array<keyof UsageMetrics["observed"]> = [
    "eligibleRuns",
    "recalledRuns",
    "injectedRuns",
    "usedRuns",
    "helpfulRuns",
  ];
  const out: Partial<UsageMetrics["observed"]> = {};
  for (const k of keys) {
    const v = raw[k];
    if (typeof v !== "number") return null;
    out[k] = v;
  }
  const r = raw.resolvedRateWithMemory;
  out.resolvedRateWithMemory = r === null || typeof r === "number" ? r : null;
  return out as UsageMetrics["observed"];
}

function pickEstimated(raw: Record<string, unknown>): UsageMetrics["estimated"] | null {
  const a = raw.tokensSaved as Record<string, unknown> | undefined;
  const b = raw.latencySavedMs as Record<string, unknown> | undefined;
  if (!a || !b) return null;
  const pick = (x: Record<string, unknown>): UsageMetrics["estimated"]["tokensSaved"] | null => {
    const value = x.value;
    const sampleSize = x.sampleSize;
    const formula = x.formula;
    if (
      !(value === null || typeof value === "number") ||
      typeof sampleSize !== "number" ||
      typeof formula !== "string"
    ) {
      return null;
    }
    return { value, sampleSize, formula };
  };
  const tokens = pick(a);
  const latency = pick(b);
  if (!tokens || !latency) return null;
  return { tokensSaved: tokens, latencySavedMs: latency };
}

function pickIntegrity(raw: Record<string, unknown>): UsageMetrics["integrity"] | null {
  const s = raw.shadowControlMismatches;
  const o = raw.outcomesWithoutRetrieval;
  if (typeof s !== "number" || typeof o !== "number") return null;
  return { shadowControlMismatches: s, outcomesWithoutRetrieval: o };
}
