/**
 * Applicability shadow-outcome ledger (Router V2, Phase D.3).
 *
 * WHY THIS EXISTS
 *   D.2 emits shadow `reasoning.applicability_comparison` events with useful
 *   changed-decisions, but their outcomes are NOT equally observable:
 *     • `reranker_withholds` — the baseline INJECTED the block, so the served
 *       outcome tells us whether withholding it would have been right.
 *     • `reranker_only_apply` — the baseline ABSTAINED, the block was NEVER
 *       shown, so whether applying it would have helped is COUNTERFACTUAL and
 *       unknowable from shadow data alone.
 *   Optimizing providers or fitting a Phase-E policy on a corpus that silently
 *   labels unserved applies as "helpful" would be self-deception. This module is
 *   the honest substrate: a deterministic joiner that classifies every trial into
 *   a CLOSED observability class and NEVER labels an unserved apply.
 *
 * THE JOIN
 *   Each `reasoning.applicability_comparison` event is the spine of a trial. We
 *   join — by queryId, never across runId — the served `injection` events (did
 *   the baseline expose the candidate block?), the `agent_used` attribution
 *   (strength), and the `outcome` (resolved / regressed / control / provenance).
 *
 * PRIVACY
 *   A trial carries ONLY opaque ids, a queryHash, version strings, closed enums,
 *   and bounded numbers — never raw prompt / body / token text. Local-only;
 *   cloud-stripped wholesale.
 */
import type {
  AnalyticsEvent,
  ReasoningApplicabilityComparisonEvent,
  InjectionEvent,
  AgentUsedEvent,
  OutcomeEvent,
  ApplicabilityCanaryExposureEvent,
} from "../types.js";

export const APPLICABILITY_TRIAL_VERSION = 1 as const;

/** Closed observability class — the heart of the honesty contract. */
export type ApplicabilityObservability =
  | "observed_exposed" // the candidate block WAS served → its outcome is attributable.
  | "observed_holdout" // a control/holdout run → no injection shown; a baseline-rate row, no per-block label.
  | "counterfactual_unobserved" // the candidate was NEVER served (e.g. reranker_only_apply) → unknowable.
  | "incomplete"; // missing/ambiguous join (orphan) → not evaluable.

export type ApplicabilityTrialLabel = "helpful" | "harmful" | "unresolved";
export type ChangedDecision = "none" | "reranker_only_apply" | "reranker_withholds";

/**
 * Versioned, local-only trial DTO. The unit of off-policy replay. A `label` is
 * present ONLY for `observed_exposed` trials — the type does not even admit a
 * label for a counterfactual row, but the joiner also enforces it at runtime.
 */
export interface ApplicabilityTrialV1 {
  trialVersion: typeof APPLICABILITY_TRIAL_VERSION;
  queryId: string;
  runId?: string;
  queryHash: string;
  /** Applicability provider identity (policy under which this trial was generated). */
  policyVersion: string;
  /** Serving feature version of the exposed injection (V4 family); absent when not exposed. */
  servedFeatureVersion?: number;
  applicabilityFeatureVersion: number;
  changedDecision: ChangedDecision;
  v4Action: "inject" | "abstain";
  applicabilityVerdict: "applicable" | "uncertain" | "inapplicable" | "none";
  /** Opaque id of the block under judgement (reranker's apply target / baseline's inject). */
  candidateBlockId?: string;
  /** Did the served path inject the candidate block? */
  baselineExposed: boolean;
  /** Was this a control/holdout run (no injection shown)? */
  holdout: boolean;
  observability: ApplicabilityObservability;
  /** Outcome label — ONLY for observed_exposed. Undefined for every other class. */
  label?: ApplicabilityTrialLabel;
  /** Provenance of the outcome claim (explicit self-report vs inferred). */
  labelProvenance?: "explicit" | "inferred";
  /** Attribution strength of the agent_used evidence that closed the loop. */
  attributionStrength?: "explicit" | "strong" | "moderate" | "weak";
  /**
   * Phase D.4 — the explicit-opt-in canary exposure that drove this trial, when
   * one matched. A `treatment` exposure SERVED the candidate (an injection event
   * was emitted), so a previously-counterfactual `reranker_only_apply` becomes
   * `observed_exposed`. `propensity` is logged for off-policy correction.
   */
  canary?: { arm: "treatment" | "control"; propensity: number };
  /** Reranker decision latency (ms), from the comparison event. */
  latencyMs: number;
}

export interface ApplicabilityJoinDiagnostics {
  /** Comparison events with no outcome (or no candidate block) to join. */
  orphans: number;
  /** queryIds with more than one same-run outcome — cannot attribute. */
  ambiguous: number;
  /** Comparison events whose only outcome/injection lived under a DIFFERENT runId. */
  crossRun: number;
  /** Trials whose applicabilityFeatureVersion differs from `opts.featureVersion`. */
  featureVersionMismatch: number;
}

export interface ApplicabilityJoinResult {
  trials: ApplicabilityTrialV1[];
  diagnostics: ApplicabilityJoinDiagnostics;
}

export interface JoinOptions {
  /** Current applicability feature version; trials off this version are flagged stale. */
  featureVersion?: number;
  /**
   * Minimum agent_used strength that counts toward a `helpful` label. Mirrors the
   * canonical loop (`injection ∧ agent_used(strength≥moderate) ∧ resolved`).
   * "weak" never closes the loop. Default "moderate".
   */
  minStrength?: "explicit" | "strong" | "moderate" | "weak";
}

const STRENGTH_ORDER: Record<NonNullable<AgentUsedEvent["evidenceStrength"]>, number> = { weak: 0, moderate: 1, strong: 2, explicit: 3 };

function sameRun(a: { runId?: string }, b: { runId?: string }): boolean {
  // Join only within a run. If EITHER side omits runId, fall back to queryId-only
  // (legacy/un-correlated events); a runId present on BOTH that differs is cross-run.
  if (a.runId === undefined || b.runId === undefined) return true;
  return a.runId === b.runId;
}

/**
 * Deterministically join the local event log into applicability trials. Pure: no
 * DB, no clock, no randomness. Stable input order → stable output. NEVER assigns
 * a helpful/harmful label to a trial whose candidate block was not served.
 */
export function joinApplicabilityTrials(events: readonly AnalyticsEvent[], opts: JoinOptions = {}): ApplicabilityJoinResult {
  const minStrength = STRENGTH_ORDER[opts.minStrength ?? "moderate"];

  const comparisons: ReasoningApplicabilityComparisonEvent[] = [];
  const injectionsByQuery = new Map<string, InjectionEvent[]>();
  const agentUsedByQuery = new Map<string, AgentUsedEvent[]>();
  const outcomesByQuery = new Map<string, OutcomeEvent[]>();
  const exposuresByQuery = new Map<string, ApplicabilityCanaryExposureEvent[]>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T): void => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  for (const e of events) {
    switch (e.event) {
      case "reasoning.applicability_comparison":
        comparisons.push(e);
        break;
      case "injection":
        push(injectionsByQuery, e.queryId, e);
        break;
      case "agent_used":
        push(agentUsedByQuery, e.queryId, e);
        break;
      case "outcome":
        push(outcomesByQuery, e.queryId, e);
        break;
      case "reasoning.applicability_canary_exposure":
        push(exposuresByQuery, e.queryId, e);
        break;
      default:
        break;
    }
  }

  const diagnostics: ApplicabilityJoinDiagnostics = { orphans: 0, ambiguous: 0, crossRun: 0, featureVersionMismatch: 0 };
  const trials: ApplicabilityTrialV1[] = [];

  for (const cmp of comparisons) {
    if (opts.featureVersion !== undefined && cmp.applicabilityFeatureVersion !== opts.featureVersion) {
      diagnostics.featureVersionMismatch++;
    }

    // The block under judgement: reranker's apply target for an apply decision;
    // the baseline's injected block for a withhold decision.
    const candidateBlockId =
      cmp.changedDecision === "reranker_withholds"
        ? cmp.v4TopBlockId
        : (cmp.applicabilityTopBlockId ?? cmp.v4TopBlockId);

    // Cross-run guard: an injection/outcome under a DIFFERENT runId is not ours.
    const allInjections = injectionsByQuery.get(cmp.queryId) ?? [];
    const allOutcomes = outcomesByQuery.get(cmp.queryId) ?? [];
    const sameRunInjections = allInjections.filter((i) => sameRun(cmp, i));
    const sameRunOutcomes = allOutcomes.filter((o) => sameRun(cmp, o));
    if (allOutcomes.length > sameRunOutcomes.length || allInjections.length > sameRunInjections.length) {
      diagnostics.crossRun++;
    }

    const exposedInjection = candidateBlockId ? sameRunInjections.find((i) => i.blockId === candidateBlockId) : undefined;
    const baselineExposed = !!exposedInjection;

    // Phase D.4: a matched canary exposure (same run) records the arm + propensity.
    // A `treatment` exposure also emitted the injection joined above, so the trial
    // is observed_exposed; `control` preserves the baseline abstain.
    const canaryEvent = (exposuresByQuery.get(cmp.queryId) ?? []).find((e) => sameRun(cmp, e));

    // Outcome: must be exactly one in-run outcome to attribute.
    let outcome: OutcomeEvent | undefined;
    if (sameRunOutcomes.length === 1) outcome = sameRunOutcomes[0];
    else if (sameRunOutcomes.length > 1) diagnostics.ambiguous++;

    const base: Omit<ApplicabilityTrialV1, "observability"> = {
      trialVersion: APPLICABILITY_TRIAL_VERSION,
      queryId: cmp.queryId,
      ...(cmp.runId ? { runId: cmp.runId } : {}),
      queryHash: cmp.queryHash,
      policyVersion: cmp.applicabilityProvider,
      applicabilityFeatureVersion: cmp.applicabilityFeatureVersion,
      changedDecision: cmp.changedDecision,
      v4Action: cmp.v4Action,
      applicabilityVerdict: cmp.applicabilityVerdict,
      ...(candidateBlockId ? { candidateBlockId } : {}),
      baselineExposed,
      holdout: outcome?.control ?? false,
      ...(exposedInjection?.featureVersion !== undefined ? { servedFeatureVersion: exposedInjection.featureVersion } : {}),
      ...(canaryEvent ? { canary: { arm: canaryEvent.arm, propensity: canaryEvent.propensity } } : {}),
      latencyMs: cmp.latencyMs,
    };

    // ── Observability classification + the honesty rule ──
    if (!candidateBlockId || (!outcome && sameRunOutcomes.length !== 1)) {
      diagnostics.orphans++;
      trials.push({ ...base, observability: "incomplete" });
      continue;
    }
    if (outcome!.control) {
      // Holdout/control: no injection was shown → a baseline-rate row, never a
      // per-block helpful/harmful label.
      trials.push({ ...base, observability: "observed_holdout" });
      continue;
    }
    if (!baselineExposed) {
      // The candidate was never served (e.g. reranker_only_apply). Counterfactual:
      // NO label, ever. This is the load-bearing honesty guarantee.
      trials.push({ ...base, observability: "counterfactual_unobserved" });
      continue;
    }

    // observed_exposed: the candidate WAS served → attribute the outcome to it.
    const used = (agentUsedByQuery.get(cmp.queryId) ?? []).filter(
      (a) => sameRun(cmp, a) && a.blockId === candidateBlockId,
    );
    const strongestUse = used.reduce<AgentUsedEvent | undefined>((best, a) => {
      const s = STRENGTH_ORDER[a.evidenceStrength ?? "weak"];
      return best === undefined || s > STRENGTH_ORDER[best.evidenceStrength ?? "weak"] ? a : best;
    }, undefined);
    const useStrength = strongestUse?.evidenceStrength ?? "weak";
    const qualifyingUse = STRENGTH_ORDER[useStrength] >= minStrength;

    let label: ApplicabilityTrialLabel;
    if (outcome!.regressed) label = "harmful";
    else if (outcome!.resolved && qualifyingUse) label = "helpful";
    else label = "unresolved";

    trials.push({
      ...base,
      observability: "observed_exposed",
      label,
      // OutcomeEvent.attribution: absent === "explicit" (canonical convention).
      labelProvenance: outcome!.attribution ?? "explicit",
      ...(strongestUse ? { attributionStrength: useStrength } : {}),
    });
  }

  return { trials, diagnostics };
}
