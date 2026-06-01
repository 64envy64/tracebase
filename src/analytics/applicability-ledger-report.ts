/**
 * Applicability ledger report + readiness assessment (Router V2, Phase D.3).
 *
 * Ties the ledger joiner to the off-policy replay and produces a single
 * privacy-safe, local-only surface: the observability-class distribution, the
 * named-policy replay table, the observed-corpus provenance split, and a
 * READINESS verdict for whether shadow evidence can yet justify a semantic-
 * provider evaluation or Phase-E calibration.
 *
 * The load-bearing readiness truth: the reranker's headline value is
 * `reranker_only_apply` recall recovery, which is COUNTERFACTUAL — never served,
 * never observed. No amount of shadow data identifies it. Promotion therefore
 * requires SERVED exposure (an explicit opt-in canary, which D.3 does not
 * activate). The readiness blockers say this plainly.
 */
import type { AnalyticsEvent } from "../types.js";
import {
  joinApplicabilityTrials,
  type ApplicabilityObservability,
  type ApplicabilityJoinDiagnostics,
  type ApplicabilityTrialV1,
  type JoinOptions,
} from "./applicability-ledger.js";
import {
  replayNamedPolicies,
  type ApplicabilityReplayReport,
  type TrialProvenanceClass,
  type ReplayOptions,
} from "./applicability-replay.js";

/** Minimum observed-exposed ORGANIC trials before a policy can be evaluated at all. */
export const MIN_OBSERVED_ORGANIC = 30;

export interface ApplicabilityReadiness {
  /** Ready to evaluate a candidate policy / proceed toward Phase-E calibration? */
  ready: boolean;
  blockers: string[];
}

export interface ApplicabilityLedgerReport {
  trialVersion: number;
  totalTrials: number;
  observability: Record<ApplicabilityObservability, number>;
  diagnostics: ApplicabilityJoinDiagnostics;
  /** Named-policy replays (baseline-v4 / reranker / …) on the identifiable subset. */
  policies: Record<string, ApplicabilityReplayReport>;
  /** Observed-corpus provenance split (organic gates readiness). */
  corpus: Record<TrialProvenanceClass, number>;
  /** Counterfactual apply opportunities the reranker would create but shadow can't score. */
  counterfactualApplyOpportunities: number;
  /** Formerly-counterfactual applies the canary treatment SERVED and made observable (Phase D.4). */
  canaryObservedApplies: number;
  readiness: ApplicabilityReadiness;
}

function countObservability(trials: readonly ApplicabilityTrialV1[]): Record<ApplicabilityObservability, number> {
  const c: Record<ApplicabilityObservability, number> = { observed_exposed: 0, observed_holdout: 0, counterfactual_unobserved: 0, incomplete: 0 };
  for (const t of trials) c[t.observability]++;
  return c;
}

export interface LedgerReportOptions extends JoinOptions, ReplayOptions {}

/**
 * Build the full ledger report from the local event log. Pure + deterministic.
 */
export function buildApplicabilityLedgerReport(events: readonly AnalyticsEvent[], opts: LedgerReportOptions = {}): ApplicabilityLedgerReport {
  const { trials, diagnostics } = joinApplicabilityTrials(events, opts);
  const policies = replayNamedPolicies(trials, opts);
  const observability = countObservability(trials);

  // The reranker's counterfactual apply opportunities — its headline recall that
  // shadow data cannot score.
  const reranker = policies["reranker"];
  const counterfactualApplyOpportunities = reranker?.unidentifiable.applyOpportunities ?? 0;
  const canaryObservedApplies = reranker?.canary.observedViaCanary ?? 0;
  const corpus = reranker?.corpus ?? { organic: 0, bootstrap: 0, synthetic: 0, unknown: 0 };

  const blockers: string[] = [];
  if (corpus.organic < MIN_OBSERVED_ORGANIC) {
    blockers.push(`only ${corpus.organic} observed-exposed ORGANIC trials (< ${MIN_OBSERVED_ORGANIC}); cannot evaluate a policy on organic evidence`);
  }
  if (observability.observed_exposed === 0) {
    blockers.push("no observed-exposed trials at all — the ledger has nothing to score");
  }
  if (counterfactualApplyOpportunities > 0 && (reranker?.identifiable.applied ?? 0) === 0 && canaryObservedApplies === 0) {
    blockers.push(`the reranker's apply value is ENTIRELY counterfactual (${counterfactualApplyOpportunities} unserved apply opportunities, 0 served) — recall recovery is unidentifiable from shadow; a served canary is required`);
  }
  if (diagnostics.crossRun > 0 || diagnostics.ambiguous > 0) {
    blockers.push(`data-quality issues: ${diagnostics.crossRun} cross-run, ${diagnostics.ambiguous} ambiguous — fix attribution plumbing before trusting metrics`);
  }
  if (diagnostics.featureVersionMismatch > 0) {
    blockers.push(`${diagnostics.featureVersionMismatch} trials at a stale feature version — exclude or re-collect before comparing policies`);
  }

  return {
    trialVersion: 1,
    totalTrials: trials.length,
    observability,
    diagnostics,
    policies,
    corpus,
    counterfactualApplyOpportunities,
    canaryObservedApplies,
    readiness: { ready: blockers.length === 0, blockers },
  };
}

/** Stable list of the observability classes for table rendering. */
export function observabilityKeys(): ApplicabilityObservability[] {
  return ["observed_exposed", "observed_holdout", "counterfactual_unobserved", "incomplete"];
}
