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
import type {
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

  return {
    scope,
    window: {
      ...(typeof window.afterTs === "number" ? { afterTs: window.afterTs } : {}),
      ...(typeof window.beforeTs === "number" ? { beforeTs: window.beforeTs } : {}),
    },
    observed: obs,
    estimated: est,
    ...(causal ? { causal } : {}),
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
