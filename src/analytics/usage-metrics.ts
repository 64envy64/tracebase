/**
 * UsageMetrics — the single serializable surface both the CLI and the
 * dashboard consume. Derived purely from `EventAggregates`; no
 * independent helpfulness or funnel logic lives anywhere else.
 *
 * The shape is deliberately narrow:
 *   - `scope`    — "workspace" (Phase 1) or "agent" (Phase 2+). See
 *     the Phase 1C.1 note below.
 *   - `observed` — counts the event log can prove.
 *   - `estimated` — derived quantities (tokens/latency saved) the UI
 *     must render with an explicit estimate indicator. Each field
 *     carries its formula string and sample size so a reader can
 *     always trace the number back to raw events.
 *   - `integrity` — upstream data-quality flags carried through from
 *     `EventAggregates.integrity`.
 *   - `window` — the time window the metrics cover (inclusive/exclusive
 *     semantics match `computeAggregates`).
 *
 * Phase 3 will introduce `causal` alongside `observed` / `estimated`.
 * Until a deterministic holdout cohort exists, token/latency "saved"
 * is an estimate and must never be rendered without the estimate tag.
 *
 * ---------------------------------------------------------------------
 * Phase 1C.1 note — scope semantics (and a naming caveat)
 *
 * In Phase 1 the local event log (retrieval / injection / agent_used /
 * outcome) does **not** carry an agent dimension. All adapters in a
 * multi-agent project share the same event stream, so a UsageMetrics
 * computed from that stream is a *project × all-agents* aggregate,
 * not a per-adapter impact snapshot.
 *
 * The cloud schema *does* carry per-adapter identity on
 * `tracebase_installations` — each adapter gets its own row. We keep
 * that identity because Pattern Health (Phase 2) and the per-agent
 * event tagging that comes with it will need it. Phase 1 just refuses
 * to pretend it can split an un-tagged event log after the fact.
 *
 * Concretely:
 *   - `scope: "workspace"` — per-sample tag meaning "this rollup is
 *     NOT split by agent; it represents one project's activity for
 *     one time window, all adapters combined." Emitted by
 *     `tracebase usage sync` today.
 *   - `scope: "agent"` — per-adapter rollup. Only emitted once events
 *     carry an agent field (Phase 2).
 *
 * Naming caveat: the word "workspace" is overloaded. Here it's a
 * sample-scope tag — "no agent split". The control plane also has a
 * concept called "workspace" which is a Clerk-authenticated user /
 * org account that can contain **many** projects. The dashboard
 * therefore folds N `scope: "workspace"` samples — each from a
 * different project — into a *control-plane-workspace-wide* total.
 * That is why the Impact view is labelled "Workspace activity" and
 * not "Project activity": the summed output is no longer a single
 * project. Per-project breakdown arrives alongside per-agent in
 * Phase 2.
 */
import type { EventAggregates } from "../core/analytics.js";

/**
 * Granularity of the aggregated sample. See the module docstring
 * above — Phase 1 only ever emits `"workspace"`.
 */
export type UsageScope = "workspace" | "agent";

export interface UsageWindow {
  /** Epoch ms. `undefined` means open-ended on that side. */
  afterTs?: number;
  beforeTs?: number;
}

export interface UsageObserved {
  /** Distinct queryIds that produced any retrieval event. */
  eligibleRuns: number;
  /** Subset of eligibleRuns where retrieval returned ≥1 candidate. */
  recalledRuns: number;
  /** Distinct queryIds with at least one block or fact injection. */
  injectedRuns: number;
  /** Distinct queryIds with at least one `agent_used` or `fact_agent_used`. */
  usedRuns: number;
  /**
   * Distinct queryIds satisfying §L6: injection ∧ agent_used ∧
   * outcome.resolved. Monotonically ≤ usedRuns.
   */
  helpfulRuns: number;
  /**
   * Of runs that actually got a memory injection, what fraction
   * resolved. `null` when there are no injected runs yet.
   * Formula: helpfulRuns ÷ injectedRuns.
   */
  resolvedRateWithMemory: number | null;
}

export interface UsageEstimate {
  /**
   * Estimated number (tokens or ms). `null` when the shadow arm is
   * empty — without it there is no reference distribution to compare
   * treatment against.
   */
  value: number | null;
  /**
   * Minimum of the two samples the estimate is averaged over. Smaller
   * sample sizes are noisier; the UI should surface this number.
   */
  sampleSize: number;
  /** Human-readable formula the UI renders verbatim in a tooltip. */
  formula: string;
}

export interface UsageEstimated {
  /**
   * Per-run mean token reduction × injectedRuns. Not a causal lift —
   * Phase 3 (holdout control) will provide the causal variant.
   */
  tokensSaved: UsageEstimate;
  /**
   * Per-run mean wall-clock reduction × injectedRuns, in milliseconds.
   * Requires `OutcomeEvent.durationMs` to be recorded in both arms.
   */
  latencySavedMs: UsageEstimate;
}

export interface UsageIntegrity {
  shadowControlMismatches: number;
  outcomesWithoutRetrieval: number;
}

export interface UsageMetrics {
  /**
   * Granularity tag. Phase 1 emits `"workspace"` exclusively because
   * local events do not carry an agent dimension — attributing the
   * same event stream to individual adapters would be fabrication.
   * Phase 2 flips per-agent samples on once the event log itself is
   * tagged. Consumers must render workspace-scoped samples as
   * project-level, never per-adapter.
   */
  scope: UsageScope;
  window: UsageWindow;
  observed: UsageObserved;
  estimated: UsageEstimated;
  integrity: UsageIntegrity;
}

/** Convenience tag the UI uses to render the estimate label. */
export const USAGE_ESTIMATE_TAG = "estimate" as const;

export interface ComputeUsageMetricsOptions {
  /**
   * Granularity of the resulting sample. Defaults to `"workspace"`
   * because Phase 1 cannot honestly split a shared event stream by
   * agent. Only pass `"agent"` when the event stream itself has
   * already been filtered to one agent (Phase 2+).
   */
  scope?: UsageScope;
}

/**
 * Derive a `UsageMetrics` snapshot from a computed `EventAggregates`.
 * Pure — same inputs always produce the same outputs. Safe to call
 * both from the CLI (against a local SQLite store) and from the
 * dashboard (against a previously-synced aggregate).
 */
export function computeUsageMetrics(
  agg: EventAggregates,
  opts: ComputeUsageMetricsOptions = {},
): UsageMetrics {
  const { funnel, outcome, integrity, window } = agg;
  const scope: UsageScope = opts.scope ?? "workspace";

  const resolvedRateWithMemory =
    funnel.injectedRuns > 0 ? funnel.helpfulRuns / funnel.injectedRuns : null;

  const tokenDelta = perRunDelta(outcome.tokensShadow, outcome.tokensTreatment);
  const durationDelta = perRunDelta(outcome.durationsShadow, outcome.durationsTreatment);

  return {
    scope,
    window,
    observed: {
      eligibleRuns: funnel.eligibleRuns,
      recalledRuns: funnel.recalledRuns,
      injectedRuns: funnel.injectedRuns,
      usedRuns: funnel.usedRuns,
      helpfulRuns: funnel.helpfulRuns,
      resolvedRateWithMemory,
    },
    estimated: {
      tokensSaved: scaleEstimate(tokenDelta, funnel.injectedRuns, "tokens"),
      latencySavedMs: scaleEstimate(durationDelta, funnel.injectedRuns, "ms"),
    },
    integrity: {
      shadowControlMismatches: integrity.shadowControlMismatches,
      outcomesWithoutRetrieval: integrity.outcomesWithoutRetrieval,
    },
  };
}

/**
 * Per-run mean delta (shadow − treatment). Positive means treatment
 * consumed less of the thing (tokens, ms) per run — i.e. a saving.
 * `null` when either arm is empty.
 */
function perRunDelta(
  shadow: readonly number[],
  treatment: readonly number[],
): { delta: number | null; sampleSize: number } {
  if (shadow.length === 0 || treatment.length === 0) {
    return { delta: null, sampleSize: Math.min(shadow.length, treatment.length) };
  }
  const delta = mean(shadow) - mean(treatment);
  return { delta, sampleSize: Math.min(shadow.length, treatment.length) };
}

function scaleEstimate(
  perRun: { delta: number | null; sampleSize: number },
  injectedRuns: number,
  unit: "tokens" | "ms",
): UsageEstimate {
  if (perRun.delta === null) {
    return {
      value: null,
      sampleSize: perRun.sampleSize,
      formula:
        unit === "tokens"
          ? "mean(shadow.tokens) − mean(treatment.tokens) × injectedRuns — needs shadow arm"
          : "mean(shadow.durationMs) − mean(treatment.durationMs) × injectedRuns — needs shadow arm",
    };
  }
  return {
    value: perRun.delta * injectedRuns,
    sampleSize: perRun.sampleSize,
    formula:
      unit === "tokens"
        ? "(mean(shadow.tokens) − mean(treatment.tokens)) × injectedRuns"
        : "(mean(shadow.durationMs) − mean(treatment.durationMs)) × injectedRuns",
  };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}
