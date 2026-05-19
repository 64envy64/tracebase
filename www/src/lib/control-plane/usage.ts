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
// Runtime import uses a relative path so Vitest (which runs from
// the root package and doesn't see the Next.js `@/` alias) can
// resolve the constant alongside TypeScript's compile-time
// resolution via tsconfig paths.
import { DEFAULT_MIN_CAUSAL_COHORT } from "../usage/types";
import type {
  UsageCalibration,
  UsageCausal,
  UsageCohort,
  UsageEstimate,
  UsageMetrics,
  UsageScope,
} from "@/lib/usage/types";
import type { ControlPlaneInstallation, ControlPlaneUsageSample } from "./types";

/**
 * A sample whose `metrics` JSONB payload successfully parsed against
 * the `UsageMetrics` schema. Every downstream consumer on the
 * dashboard side — fold, contributor count, drill-down — must key
 * off this type so they cannot drift: a row rejected by the parser
 * here is rejected everywhere, or accepted everywhere.
 *
 * The `source` field preserves the original row for installationId /
 * windowStart lookups; `metrics` is the typed parse.
 */
export interface ValidatedSample {
  source: ControlPlaneUsageSample;
  metrics: UsageMetrics;
}

/**
 * Parse each sample's JSONB `metrics` against the UsageMetrics
 * schema, dropping rows that fail validation. Pure — the only
 * authoritative source of "did this row pass schema" on the
 * dashboard side. Consumers must consume `ValidatedSample[]`, not
 * raw `ControlPlaneUsageSample[]`, so invalid payloads cannot cause
 * contributor counts and fold totals to disagree.
 */
export function validateSamples(
  samples: readonly ControlPlaneUsageSample[],
): ValidatedSample[] {
  const out: ValidatedSample[] = [];
  for (const sample of samples) {
    const parsed = parseUsageMetrics(sample.metrics);
    if (!parsed) continue;
    out.push({ source: sample, metrics: parsed });
  }
  return out;
}

/**
 * Count of projects and installations that actually pushed valid
 * samples into the selected window. Different from the workspace's
 * total installation list — an installation that sits idle in the
 * window does not count as a contributor to the numbers rendered on
 * the Impact page.
 *
 * Takes `ValidatedSample[]` so invalid-payload rows cannot be
 * counted as contributors even though their metrics are dropped
 * from the fold. See `ValidatedSample` for the contract.
 *
 * Samples whose `installationId` is not in the provided lookup get
 * counted toward the installation total but not the project total;
 * this keeps the installation count lossless while refusing to
 * fabricate a project association for an unresolved row.
 */
export function countContributorsInWindow(
  samples: readonly ValidatedSample[],
  installations: readonly ControlPlaneInstallation[],
): { projects: number; installations: number } {
  const contributorIds = new Set<string>();
  for (const s of samples) contributorIds.add(s.source.installationId);

  const byId = new Map<string, ControlPlaneInstallation>();
  for (const i of installations) byId.set(i.id, i);

  const projects = new Set<string>();
  for (const id of contributorIds) {
    const inst = byId.get(id);
    if (inst) projects.add(inst.localWorkspaceId);
  }

  return { projects: projects.size, installations: contributorIds.size };
}

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

/**
 * Drop samples that aren't tagged with the expected scope, preserving
 * the order of the input. Pure filter — no parsing / bucketing.
 *
 * Phase 1 only ever emits `scope: "workspace"`; Phase 2 introduces
 * `scope: "agent"`. Keeping this helper explicit lets a caller split
 * once and feed the same filtered sample set to both the fold and
 * the contributor counter, guaranteeing the numbers and the counts
 * come from the same source.
 */
export function filterSamplesByScope(
  samples: readonly ControlPlaneUsageSample[],
  scope: UsageScope,
): ControlPlaneUsageSample[] {
  const out: ControlPlaneUsageSample[] = [];
  for (const sample of samples) {
    const s = (sample.metrics as { scope?: unknown }).scope;
    if (s === scope) out.push(sample);
  }
  return out;
}

/**
 * Turn a list of pre-validated samples into dated `DailyBucket`s,
 * ascending by `windowStart` so a timeseries renders left-to-right
 * without a second sort. Takes `ValidatedSample[]` so validation
 * cannot silently happen twice — see `ValidatedSample` for the
 * single-validation contract.
 */
export function toDailyBuckets(
  samples: readonly ValidatedSample[],
): DailyBucket[] {
  const out: DailyBucket[] = samples.map((s) => ({
    date: s.source.windowStart.slice(0, 10), // YYYY-MM-DD
    metrics: s.metrics,
  }));
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * Back-compat convenience: filter workspace-scoped samples, validate
 * them, and bucket in one call. Existing tests use this shape; new
 * code should use `filterSamplesByScope` → `validateSamples` →
 * `toDailyBuckets` so the validated set can be reused for e.g.
 * contributor counting without re-parsing.
 */
export function extractWorkspaceSamples(
  samples: readonly ControlPlaneUsageSample[],
): DailyBucket[] {
  return toDailyBuckets(validateSamples(filterSamplesByScope(samples, "workspace")));
}

export function foldImpactWindow(input: {
  afterTs: string;
  beforeTs: string;
  buckets: DailyBucket[];
  /**
   * Minimum per-arm size required for window-level causal lift
   * fields to resolve to numbers. Below the threshold the lifts
   * stay `null` so the UI renders an honest waiting state instead
   * of a fabricated number. Default: `DEFAULT_MIN_CAUSAL_COHORT`.
   */
  minCausalCohort?: number;
}): ImpactWindow {
  const { afterTs, beforeTs, buckets } = input;
  const minCausalCohort = input.minCausalCohort ?? DEFAULT_MIN_CAUSAL_COHORT;
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
  let hasCalibration = false;
  let brierWeightedSum = 0;
  let brierWeight = 0;
  let aucWeightedSum = 0;
  let aucWeight = 0;
  let calibrationScoredInjections = 0;
  let calibrationRefitCount = 0;
  let calibrationLastRefitAt: number | null = null;
  let candidatesSeen = 0;
  let candidatesShown = 0;
  let candidatesFiltered = 0;
  let driftInjectionCount = 0;
  let driftPatternsInjected = 0;

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

    const c = bucket.metrics.calibration;
    if (c) {
      hasCalibration = true;
      if (c.brierScore !== null && c.scoredInjections > 0) {
        brierWeightedSum += c.brierScore * c.scoredInjections;
        brierWeight += c.scoredInjections;
      }
      if (c.auc !== null && c.scoredInjections > 0) {
        aucWeightedSum += c.auc * c.scoredInjections;
        aucWeight += c.scoredInjections;
      }
      calibrationScoredInjections += c.scoredInjections;
      calibrationRefitCount += c.refitCount;
      if (c.lastRefitAt !== null) {
        calibrationLastRefitAt =
          calibrationLastRefitAt === null
            ? c.lastRefitAt
            : Math.max(calibrationLastRefitAt, c.lastRefitAt);
      }
      candidatesSeen += c.candidatesSeen;
      candidatesShown += c.candidatesShown;
      candidatesFiltered += c.candidatesFiltered;
      driftInjectionCount += c.driftInjectionCount;
      driftPatternsInjected += c.driftPatternsInjected;
    }
  }

  const resolvedRateWithMemory =
    injectedRuns > 0 ? helpfulRuns / injectedRuns : null;

  const causal = foldCausalAcrossBuckets(buckets, minCausalCohort);
  const calibration: UsageCalibration | undefined = hasCalibration
    ? {
        brierScore: brierWeight > 0 ? brierWeightedSum / brierWeight : null,
        auc: aucWeight > 0 ? aucWeightedSum / aucWeight : null,
        scoredInjections: calibrationScoredInjections,
        refitCount: calibrationRefitCount,
        lastRefitAt: calibrationLastRefitAt,
        candidatesSeen,
        candidatesShown,
        candidatesFiltered,
        candidateFilterRate: candidatesSeen > 0 ? candidatesFiltered / candidatesSeen : null,
        driftInjectionCount,
        driftPatternsInjected,
      }
    : undefined;

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
    // Causal goes on top of `estimated`, never replacing it — the
    // Phase 1 diagnostic signal and the Phase 3 causal signal live
    // on different data (all shadow vs holdout-only) and must be
    // presented separately.
    ...(causal ? { causal } : {}),
    ...(calibration ? { calibration } : {}),
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

/**
 * Aggregate per-bucket `causal` blocks into a single window-level
 * `UsageCausal`. Returns `undefined` when no bucket carried any
 * holdout outcome — the same "experiment not running / no data
 * yet" signal the CLI emits by omitting the field.
 *
 * Rules:
 *   - assisted / holdout cohorts: raw sum of `n` + `resolved`;
 *     `resolvedRate` recomputed from totals (null iff `n === 0`).
 *   - `resolvedLift`: window-level — null unless BOTH arms reach
 *     `minCohortSize`; never fabricated on small samples.
 *   - `tokensLift.value` / `latencyLift.value`: sum of per-bucket
 *     totals (which already carry per-bucket gating from the CLI).
 *     Forced to null at the window level when either arm is below
 *     `minCohortSize` — the guardrail the user flagged as a hard
 *     invariant.
 *   - `sampleSize` stays additive across buckets so the UI can
 *     show "across N paired outcomes" without lying about
 *     coverage.
 */
function foldCausalAcrossBuckets(
  buckets: readonly DailyBucket[],
  minCohortSize: number,
): UsageCausal | undefined {
  const has = buckets.some((b) => b.metrics.causal);
  if (!has) return undefined;

  let aN = 0;
  let aResolved = 0;
  let hN = 0;
  let hResolved = 0;

  let tokensSum = 0;
  let tokensSampleSize = 0;
  let tokensHadAny = false;

  let latencySum = 0;
  let latencySampleSize = 0;
  let latencyHadAny = false;

  for (const bucket of buckets) {
    const c = bucket.metrics.causal;
    if (!c) continue;
    aN += c.assisted.n;
    aResolved += c.assisted.resolved;
    hN += c.holdout.n;
    hResolved += c.holdout.resolved;

    if (c.tokensLift.value !== null) {
      tokensHadAny = true;
      tokensSum += c.tokensLift.value;
    }
    tokensSampleSize += c.tokensLift.sampleSize;

    if (c.latencyLift.value !== null) {
      latencyHadAny = true;
      latencySum += c.latencyLift.value;
    }
    latencySampleSize += c.latencyLift.sampleSize;
  }

  const assisted: UsageCohort = {
    n: aN,
    resolved: aResolved,
    resolvedRate: aN > 0 ? aResolved / aN : null,
  };
  const holdout: UsageCohort = {
    n: hN,
    resolved: hResolved,
    resolvedRate: hN > 0 ? hResolved / hN : null,
  };

  const cohortReady = aN >= minCohortSize && hN >= minCohortSize;
  const resolvedLift =
    cohortReady && assisted.resolvedRate !== null && holdout.resolvedRate !== null
      ? assisted.resolvedRate - holdout.resolvedRate
      : null;

  const tokensLift: UsageEstimate = {
    value: cohortReady && tokensHadAny ? tokensSum : null,
    sampleSize: tokensSampleSize,
    formula:
      "Σ (mean(holdout.tokens) − mean(assisted.tokens)) × assisted.n per bucket — needs ≥ minCohortSize per arm",
  };
  const latencyLift: UsageEstimate = {
    value: cohortReady && latencyHadAny ? latencySum : null,
    sampleSize: latencySampleSize,
    formula:
      "Σ (mean(holdout.durationMs) − mean(assisted.durationMs)) × assisted.n per bucket — needs ≥ minCohortSize per arm",
  };

  return {
    assisted,
    holdout,
    resolvedLift,
    tokensLift,
    latencyLift,
    minCohortSize,
  };
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
    calibration: emptyCalibration(),
    integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
  };
}

function emptyCalibration(): UsageCalibration {
  return {
    brierScore: null,
    auc: null,
    scoredInjections: 0,
    refitCount: 0,
    lastRefitAt: null,
    candidatesSeen: 0,
    candidatesShown: 0,
    candidatesFiltered: 0,
    candidateFilterRate: null,
    driftInjectionCount: 0,
    driftPatternsInjected: 0,
  };
}

/**
 * Schema-validate a `UsageMetrics` payload. The single source of
 * truth for what constitutes a valid sample on the dashboard side.
 * Used both by `validateSamples` on read and by the ingest endpoint
 * on write, so a row that parses anywhere parses everywhere.
 */
export function parseUsageMetrics(raw: unknown): UsageMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  return parseUsageMetricsRecord(raw as Record<string, unknown>);
}

function parseUsageMetricsRecord(raw: Record<string, unknown>): UsageMetrics | null {
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

  // Phase 3.3 — optional causal block. When absent, Phase 1/2
  // clients pass through unchanged. When present, every field
  // must validate; a malformed causal block rejects the whole
  // payload so the ingest gate cannot be bypassed by a caller
  // that submits good observed data wrapped around garbage
  // causal data.
  let causal: UsageCausal | undefined;
  if (raw.causal !== undefined) {
    const parsed = pickCausal(raw.causal);
    if (!parsed) return null;
    causal = parsed;
  }

  let calibration: UsageCalibration | undefined;
  if (raw.calibration !== undefined) {
    const parsed = pickCalibration(raw.calibration);
    if (!parsed) return null;
    calibration = parsed;
  }

  return {
    scope,
    window: {
      ...(typeof window.afterTs === "number" ? { afterTs: window.afterTs } : {}),
      ...(typeof window.beforeTs === "number" ? { beforeTs: window.beforeTs } : {}),
    },
    observed: obs,
    estimated: est,
    ...(causal ? { causal } : {}),
    ...(calibration ? { calibration } : {}),
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
  const a = raw.tokensSaved;
  const b = raw.latencySavedMs;
  const tokens = pickEstimateField(a);
  const latency = pickEstimateField(b);
  if (!tokens || !latency) return null;
  return { tokensSaved: tokens, latencySavedMs: latency };
}

function pickIntegrity(raw: Record<string, unknown>): UsageMetrics["integrity"] | null {
  const s = raw.shadowControlMismatches;
  const o = raw.outcomesWithoutRetrieval;
  if (typeof s !== "number" || typeof o !== "number") return null;
  return { shadowControlMismatches: s, outcomesWithoutRetrieval: o };
}

function pickCalibration(raw: unknown): UsageCalibration | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const brierScore = nullableNumber(r.brierScore);
  const auc = nullableNumber(r.auc);
  const lastRefitAt = nullableNumber(r.lastRefitAt);
  const candidateFilterRate = nullableNumber(r.candidateFilterRate);
  if (brierScore === undefined || auc === undefined) return null;
  if (lastRefitAt === undefined || candidateFilterRate === undefined) return null;
  const numericKeys = [
    "scoredInjections",
    "refitCount",
    "candidatesSeen",
    "candidatesShown",
    "candidatesFiltered",
    "driftInjectionCount",
    "driftPatternsInjected",
  ] as const;
  for (const key of numericKeys) {
    if (typeof r[key] !== "number" || !Number.isFinite(r[key])) return null;
  }
  return {
    brierScore,
    auc,
    scoredInjections: r.scoredInjections as number,
    refitCount: r.refitCount as number,
    lastRefitAt,
    candidatesSeen: r.candidatesSeen as number,
    candidatesShown: r.candidatesShown as number,
    candidatesFiltered: r.candidatesFiltered as number,
    candidateFilterRate,
    driftInjectionCount: r.driftInjectionCount as number,
    driftPatternsInjected: r.driftPatternsInjected as number,
  };
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Validate a `UsageEstimate`-shaped field. Shared between Phase 1
 * `estimated.tokensSaved` / `latencySavedMs` and Phase 3 causal
 * `tokensLift` / `latencyLift` — the two spots use identical
 * validation, so a single pick keeps them locked together.
 */
function pickEstimateField(raw: unknown): UsageEstimate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const { value, sampleSize, formula } = r;
  if (!(value === null || typeof value === "number")) return null;
  if (typeof sampleSize !== "number") return null;
  if (typeof formula !== "string") return null;
  return { value, sampleSize, formula };
}

/**
 * Validate the Phase 3.3 causal block. Every sub-field must be
 * the right shape; one bad field rejects the entire causal block
 * (and by extension the entire sample payload). This is the
 * authoritative source of truth for "does this causal block match
 * the contract" — the dashboard read path and the ingest gate
 * both consume it via `parseUsageMetrics`.
 */
function pickCausal(raw: unknown): UsageCausal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const assisted = pickCohort(r.assisted);
  const holdout = pickCohort(r.holdout);
  if (!assisted || !holdout) return null;

  const resolvedLift = r.resolvedLift;
  if (!(resolvedLift === null || typeof resolvedLift === "number")) return null;

  const tokensLift = pickEstimateField(r.tokensLift);
  const latencyLift = pickEstimateField(r.latencyLift);
  if (!tokensLift || !latencyLift) return null;

  const minCohortSize = r.minCohortSize;
  if (typeof minCohortSize !== "number") return null;

  return {
    assisted,
    holdout,
    resolvedLift,
    tokensLift,
    latencyLift,
    minCohortSize,
  };
}

function pickCohort(raw: unknown): UsageCohort | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const { n, resolved } = r;
  if (typeof n !== "number") return null;
  if (typeof resolved !== "number") return null;
  const rate = r.resolvedRate;
  if (!(rate === null || typeof rate === "number")) return null;
  return { n, resolved, resolvedRate: rate };
}
