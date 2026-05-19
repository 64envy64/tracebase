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
import type { EventAggregates, MechanismAggregates } from "../core/analytics.js";

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

/**
 * 0.6.1 — heuristic estimated savings.
 *
 * Constants below are conservative defaults: each "helpful" run
 * (injection ∧ agent_used ∧ outcome.resolved) is credited a
 * fixed token-saved + latency-saved estimate. The number is
 * always a number (never null), but the formula is rendered
 * alongside it so the reader knows it's a heuristic-not-proof
 * estimate. Override by passing `assumedTokensPerHelpful` /
 * `assumedLatencyMsPerHelpful` to `computeUsageMetrics`.
 *
 * Why these defaults:
 *   - 1000 tokens/helpful — order-of-magnitude conservative
 *     for "agent recovered a prior solution it would have
 *     otherwise re-derived". Tunable via config.
 *   - 5000 ms/helpful — same logic for wall-clock.
 */
export const DEFAULT_ASSUMED_TOKENS_PER_HELPFUL = 1000;
export const DEFAULT_ASSUMED_LATENCY_MS_PER_HELPFUL = 5_000;

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
  /**
   * 0.6.1 — heuristic-based always-on estimate. Computed as
   * `helpfulRuns × DEFAULT_ASSUMED_TOKENS_PER_HELPFUL`. Rendered
   * as "estimated saved" — never as just "saved" — to
   * distinguish from the verified causal lift.
   */
  heuristicTokensSaved: UsageEstimate;
  /** Same shape over latency. */
  heuristicLatencySavedMs: UsageEstimate;
}

export interface UsageIntegrity {
  shadowControlMismatches: number;
  outcomesWithoutRetrieval: number;
}

export interface UsageCalibration {
  /** Lower is better. Null until at least one shown memory has an outcome. */
  brierScore: number | null;
  /** Higher is better. Null until both positive and negative labels exist. */
  auc: number | null;
  /** Number of shown block memories included in Brier/AUC. */
  scoredInjections: number;
  /** Successful auto-refits in the window. */
  refitCount: number;
  /** Most recent fittedAt timestamp from a refit event in the window. */
  lastRefitAt: number | null;
  /** Non-shadow block + fact candidates returned by retrieval. */
  candidatesSeen: number;
  /** Candidates that reached the prompt as block/fact injections. */
  candidatesShown: number;
  /** Seen but not shown, after gate + budget. */
  candidatesFiltered: number;
  /** candidatesFiltered / candidatesSeen, null when no candidates were seen. */
  candidateFilterRate: number | null;
  /** Drift-triggered forced recalls that produced injected context. */
  driftInjectionCount: number;
  /** Total patterns surfaced by drift-triggered recalls. */
  driftPatternsInjected: number;
}

/**
 * 0.5.4 §6 — TB TOOL / TB LOOP aggregates. Counts only; the
 * matched substring is never surfaced. `toolFamilyCounts` ships
 * under the eight-family normalised vocabulary
 * (`read` / `search` / `shell` / `edit` / `write` / `web` / `task`
 * / `other`) — literal Claude tool names never reach the wire.
 *
 * `errorClassCounts` is a finite enumerable set
 * (`abs-path-posix` / `abs-path-windows` / `bearer-token` /
 * `api-key-anthropic` / `api-key-github` / `api-key-sk` /
 * `env-line`) — slot names are descriptive labels, not user
 * content.
 *
 * Privacy invariant: the cloud allowlist forbids every other field
 * on `tool_observations` rows from reaching the wire. These
 * aggregates are the only TB TOOL / TB LOOP signal that ships.
 */
export interface UsageToolBatch {
  duplicateCount: number;
  loopCount: number;
  toolFamilyCounts: {
    read: number;
    search: number;
    shell: number;
    edit: number;
    write: number;
    web: number;
    task: number;
    other: number;
  };
  errorClassCounts: {
    "abs-path-posix": number;
    "abs-path-windows": number;
    "bearer-token": number;
    "api-key-anthropic": number;
    "api-key-github": number;
    "api-key-sk": number;
    "env-line": number;
  };
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
  /**
   * Phase 3 causal comparison — assisted vs deterministic holdout.
   * Optional: present only when at least one `holdout` outcome has
   * been recorded, signalling that the experiment is live. The
   * absence of this field is the honest answer for any workspace
   * that has not enabled holdout; the UI renders it as "no causal
   * data yet" instead of a fabricated number.
   *
   * Strictly separate from `estimated` — `estimated` is the Phase 1
   * shadow-based diagnostic (kept as-is for back-compat and coarse
   * signal); `causal` only uses retrieval events tagged
   * `controlReason === "holdout"`. Manual / legacy shadow never
   * enters the causal numbers.
   */
  causal?: UsageCausal;
  /**
   * May-2026 every-run-learning panel. Optional for backward
   * compatibility with older synced samples; current clients always
   * populate it from `EventAggregates.calibration`.
   */
  calibration?: UsageCalibration;
  integrity: UsageIntegrity;
  /**
   * 0.5.4 §6 — TB TOOL / TB LOOP aggregates. Optional: present only
   * when `tool_observations` rows exist for the window. Aggregate
   * counts only; never the literal arg_summary / arg_key / tool
   * names.
   */
  toolBatch?: UsageToolBatch;
  /**
   * 0.5.7 §C — net token impact in the window.
   *
   *   netTokenImpact = causal.tokensLift.value − totalInjectedTokensEstimate
   *
   * `null` when `causal.tokensLift.value === null` (cohort below
   * threshold) — refusing to render a fabricated net on a small
   * sample. Positive = injection arithmetically positive; negative
   * = the layer cost more tokens than it saved over the window.
   *
   * The honest "is this layer paying for itself" metric. Surfaced
   * one-line by `tracebase impact`; cloud allowlist treats it as
   * a primitive leaf.
   */
  netTokenImpact?: number | null;
  /**
   * Window-total of injection-side token spend
   * (`sum(retrieval.injectedTokensEstimate)`). Always present and
   * always non-negative — appears as the second term of
   * `netTokenImpact` and as the input-side cost the dashboard
   * subtracts from `tokensLift.value`.
   */
  totalInjectedTokensEstimate: number;
  /**
   * 0.7.0 §6 stable §2 — per-mechanism aggregates derived from the
   * 0.7-rc.1+ event stream. Counts + closed-enum histograms only;
   * NEVER carries paths, fileIds, sessionId, argKey, or raw tool
   * names. The cloud allowlist's `metrics.mechanisms.*` shape is
   * mirrored exactly so this object can ship as-is to the wire
   * after `sanitizeForCloud` is run.
   *
   * Optional in `UsageMetrics` for backward-compatibility with
   * older payloads (Phase 1 didn't have these aggregates), but
   * `computeUsageMetrics` always populates it for windows
   * computed from a current store.
   */
  mechanisms?: MechanismAggregates;
}

export interface UsageCohort {
  /** Distinct queryIds in this arm that produced an outcome. */
  n: number;
  /** Absolute count of `outcome.resolved === true` outcomes. */
  resolved: number;
  /** `resolved / n`; null when `n === 0`. */
  resolvedRate: number | null;
}

export interface UsageCausal {
  /**
   * Assisted cohort — retrieval event with `shadow === false` AND
   * at least one injection (block or fact) event for the queryId.
   * Runs where the gate filtered every candidate are excluded:
   * they never received memory, so including them would dilute the
   * treatment arm with "never assisted" runs.
   */
  assisted: UsageCohort;
  /**
   * Holdout cohort — retrieval event with `shadow === true` AND
   * `controlReason === "holdout"`. By construction these are
   * gate-eligible runs (Phase 3.2.1) that the deterministic
   * experiment withheld from injection.
   */
  holdout: UsageCohort;
  /**
   * `assisted.resolvedRate − holdout.resolvedRate`. Positive = assist
   * improved resolve rate. Null when either arm has fewer than
   * `minCohortSize` outcomes — refusing to fabricate lift on small
   * cohorts is the whole point of the threshold.
   */
  resolvedLift: number | null;
  /**
   * Total tokens saved across the window, attributable to the
   * assist: `(mean(holdout.tokens) − mean(assisted.tokens)) ×
   * assisted.n`. Positive = savings. Null with its `value` below
   * when either arm has fewer than `minCohortSize` token-carrying
   * outcomes.
   */
  tokensLift: UsageEstimate;
  /** Same shape as `tokensLift`, over outcome.durationMs. */
  latencyLift: UsageEstimate;
  /** Threshold the computation applied to decide null vs numeric lift. */
  minCohortSize: number;
}

/** Default minimum cohort size for causal-lift reporting. */
export const DEFAULT_MIN_CAUSAL_COHORT = 30;

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
  /**
   * Minimum per-arm size required before `causal.resolvedLift` /
   * `tokensLift.value` / `latencyLift.value` resolve to numbers.
   * Below the threshold they stay `null` so the UI cannot render a
   * fabricated "assisted helps by X" on 2 samples. Default:
   * `DEFAULT_MIN_CAUSAL_COHORT` (30).
   */
  minCausalCohort?: number;
  /**
   * 0.6.1 — heuristic estimate scaling constants. Override to
   * tune for a specific deployment / model class. Defaults are
   * conservative and rendered alongside the estimate so the
   * reader knows it's a heuristic.
   */
  assumedTokensPerHelpful?: number;
  assumedLatencyMsPerHelpful?: number;
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
  const minCausalCohort = opts.minCausalCohort ?? DEFAULT_MIN_CAUSAL_COHORT;

  const resolvedRateWithMemory =
    funnel.injectedRuns > 0 ? funnel.helpfulRuns / funnel.injectedRuns : null;

  const tokenDelta = perRunDelta(outcome.tokensShadow, outcome.tokensTreatment);
  const durationDelta = perRunDelta(outcome.durationsShadow, outcome.durationsTreatment);

  // 0.6.1 — heuristic estimated savings.
  // helpfulRuns × per-run constant. Conservative defaults
  // (1000 tok / 5000ms) tunable via opts. Always populates so
  // `tracebase impact` can show an "estimated saved" line on
  // every install, no holdout / shadow runs required.
  const tokensPerHelpful = opts.assumedTokensPerHelpful ?? DEFAULT_ASSUMED_TOKENS_PER_HELPFUL;
  const latencyPerHelpful = opts.assumedLatencyMsPerHelpful ?? DEFAULT_ASSUMED_LATENCY_MS_PER_HELPFUL;
  const heuristicTokensSaved: UsageEstimate = {
    value: funnel.helpfulRuns * tokensPerHelpful,
    sampleSize: funnel.helpfulRuns,
    formula: `helpfulRuns × ${tokensPerHelpful} tokens (heuristic)`,
  };
  const heuristicLatencySavedMs: UsageEstimate = {
    value: funnel.helpfulRuns * latencyPerHelpful,
    sampleSize: funnel.helpfulRuns,
    formula: `helpfulRuns × ${latencyPerHelpful} ms (heuristic)`,
  };

  const causal = computeCausal(agg, minCausalCohort);

  // 0.5.7 §C — netTokenImpact: tokensLift.value minus the window's
  // total injection-side token spend. Null whenever the lift
  // itself is null (cohort < threshold), since subtracting a
  // known cost from an unknown lift produces a junk number.
  const totalInjectedTokensEstimate = agg.retrieval.totalInjectedTokensEstimate;
  const netTokenImpact =
    causal && typeof causal.tokensLift.value === "number"
      ? causal.tokensLift.value - totalInjectedTokensEstimate
      : null;

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
      heuristicTokensSaved,
      heuristicLatencySavedMs,
    },
    // Optional: present only when the holdout arm has at least one
    // outcome on record. Absence is the honest "experiment not
    // running / no data yet" signal.
    ...(causal ? { causal } : {}),
    calibration: { ...agg.calibration },
    integrity: {
      shadowControlMismatches: integrity.shadowControlMismatches,
      outcomesWithoutRetrieval: integrity.outcomesWithoutRetrieval,
    },
    netTokenImpact,
    totalInjectedTokensEstimate,
    // 0.7.0 §6 stable §2 — mechanism aggregates pass through
    // verbatim. They are already in the cloud-allowlist shape
    // (counts + closed-enum histograms) — `sanitizeForCloud`
    // drops anything outside the declared keys at the wire so
    // a future spec drift here is caught defensively, but the
    // local aggregate is also constructed against the closed
    // vocabulary in `tallyMechanismEvent`.
    mechanisms: agg.mechanisms,
  };
}

/**
 * Causal numbers. Lift fields resolve to null until each arm has at
 * least `minCohortSize` outcomes on record; this refuses to render
 * "+42% resolve rate on n=3" as if it were proof.
 *
 * The arms themselves (`assisted`, `holdout`) are reported as
 * observed counts regardless of size so a user can see "waiting for
 * the cohort to grow to 30" instead of a blank screen.
 */
function computeCausal(
  agg: EventAggregates,
  minCohortSize: number,
): UsageCausal | null {
  const { assisted, holdout } = agg.causal;
  if (holdout.n === 0) {
    // No experiment data yet — omit the block entirely so UIs don't
    // render an empty shell.
    return null;
  }
  const arms: UsageCausal = {
    assisted: toCohort(assisted),
    holdout: toCohort(holdout),
    resolvedLift: null,
    tokensLift: {
      value: null,
      sampleSize: Math.min(holdout.tokens.length, assisted.tokens.length),
      formula:
        "(mean(holdout.tokens) − mean(assisted.tokens)) × assisted.n — needs ≥ minCohortSize per arm",
    },
    latencyLift: {
      value: null,
      sampleSize: Math.min(holdout.durations.length, assisted.durations.length),
      formula:
        "(mean(holdout.durationMs) − mean(assisted.durationMs)) × assisted.n — needs ≥ minCohortSize per arm",
    },
    minCohortSize,
  };

  const cohortReady = assisted.n >= minCohortSize && holdout.n >= minCohortSize;
  if (cohortReady) {
    if (arms.assisted.resolvedRate !== null && arms.holdout.resolvedRate !== null) {
      arms.resolvedLift = arms.assisted.resolvedRate - arms.holdout.resolvedRate;
    }
  }

  const tokensReady =
    holdout.tokens.length >= minCohortSize && assisted.tokens.length >= minCohortSize;
  if (tokensReady) {
    const perRunDelta = mean(holdout.tokens) - mean(assisted.tokens);
    arms.tokensLift = {
      value: perRunDelta * assisted.n,
      sampleSize: Math.min(holdout.tokens.length, assisted.tokens.length),
      formula: "(mean(holdout.tokens) − mean(assisted.tokens)) × assisted.n",
    };
  }

  const latencyReady =
    holdout.durations.length >= minCohortSize && assisted.durations.length >= minCohortSize;
  if (latencyReady) {
    const perRunDelta = mean(holdout.durations) - mean(assisted.durations);
    arms.latencyLift = {
      value: perRunDelta * assisted.n,
      sampleSize: Math.min(holdout.durations.length, assisted.durations.length),
      formula: "(mean(holdout.durationMs) − mean(assisted.durationMs)) × assisted.n",
    };
  }

  return arms;
}

function toCohort(c: { n: number; resolved: number }): UsageCohort {
  return {
    n: c.n,
    resolved: c.resolved,
    resolvedRate: c.n > 0 ? c.resolved / c.n : null,
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
