/**
 * Off-policy replay over frozen applicability trials (Router V2, Phase D.3).
 *
 * Replays a candidate applicability POLICY (a deterministic apply/withhold rule
 * over a trial's recorded decision signals) against the frozen ledger, and
 * reports IDENTIFIABLE metrics — those derivable from served (observed_exposed)
 * outcomes — STRICTLY SEPARATELY from UNIDENTIFIABLE opportunities (apply
 * decisions on never-served candidates). No causal claim is ever made from
 * counterfactual rows: an apply on an unserved candidate is counted as an
 * opportunity, never scored.
 *
 * Pure + deterministic. No DB, no clock, no randomness.
 */
import { wilsonLowerBound } from "../core/block.js";
import type { ApplicabilityTrialV1 } from "./applicability-ledger.js";

export type PolicyAction = "apply" | "withhold";
/** A candidate policy: a deterministic apply/withhold rule over a trial's signals. */
export type ApplicabilityPolicy = (trial: ApplicabilityTrialV1) => PolicyAction;

/** Named policies replayable over the ledger (functions of the recorded decision). */
export const POLICIES: Record<string, ApplicabilityPolicy> = {
  // The served baseline: V4's actual action.
  "baseline-v4": (t) => (t.v4Action === "inject" ? "apply" : "withhold"),
  // The D.2 reranker verdict.
  reranker: (t) => (t.applicabilityVerdict === "applicable" ? "apply" : "withhold"),
  // Reranker AND V4 must agree to apply (most conservative).
  "reranker-conservative": (t) => (t.applicabilityVerdict === "applicable" && t.v4Action === "inject" ? "apply" : "withhold"),
  // Reranker OR V4 (most permissive — the union recall ceiling).
  "reranker-or-v4": (t) => (t.applicabilityVerdict === "applicable" || t.v4Action === "inject" ? "apply" : "withhold"),
};

export type TrialProvenanceClass = "organic" | "bootstrap" | "synthetic" | "unknown";

export interface ApplicabilityReplayReport {
  policy: string;
  featureVersion?: number;
  totalTrials: number;
  /** Trials excluded because their feature version != the replay's target. */
  staleFeatureVersion: number;
  observedTrials: number;
  /** Identifiable fraction = observed / (total in-version). */
  completeness: number;
  /** Metrics derivable ONLY from served (observed_exposed) outcomes. */
  identifiable: {
    applied: number;
    helpfulFires: number;
    precisionAtObservedFire: number | null;
    wilsonLB: number | null;
    withheld: number;
    withholdCorrect: number;
    withholdCorrectness: number | null;
    coverage: number | null;
    abstention: number | null;
    latencyMsP50: number;
    latencyMsP95: number;
  };
  /** Opportunities that CANNOT be scored from shadow data — reported, never scored. */
  unidentifiable: {
    /** Policy says apply, but the candidate was never served (counterfactual). */
    applyOpportunities: number;
    holdoutRows: number;
    incompleteRows: number;
  };
  /** Composition of the OBSERVED corpus by provenance (organic gates readiness). */
  corpus: Record<TrialProvenanceClass, number>;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export interface ReplayOptions {
  /** Only replay trials at this applicability feature version (others are stale). */
  featureVersion?: number;
  /** Classify a candidate block's provenance (organic gates readiness). */
  classifyBlock?: (blockId: string) => TrialProvenanceClass;
}

/**
 * Replay one policy over the frozen trials. Scores ONLY observed_exposed rows;
 * apply-on-counterfactual is an opportunity, never a labelled fire.
 */
export function replayApplicabilityPolicy(
  trials: readonly ApplicabilityTrialV1[],
  policy: ApplicabilityPolicy,
  policyName: string,
  opts: ReplayOptions = {},
): ApplicabilityReplayReport {
  const classify = opts.classifyBlock ?? (() => "unknown" as TrialProvenanceClass);
  const round = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000);

  let staleFeatureVersion = 0;
  const inVersion: ApplicabilityTrialV1[] = [];
  for (const t of trials) {
    if (opts.featureVersion !== undefined && t.applicabilityFeatureVersion !== opts.featureVersion) {
      staleFeatureVersion++;
      continue;
    }
    inVersion.push(t);
  }

  let observedTrials = 0;
  let applied = 0;
  let helpfulFires = 0;
  let withheld = 0;
  let withholdCorrect = 0;
  let applyOpportunities = 0;
  let holdoutRows = 0;
  let incompleteRows = 0;
  const lat: number[] = [];
  const corpus: Record<TrialProvenanceClass, number> = { organic: 0, bootstrap: 0, synthetic: 0, unknown: 0 };

  for (const t of inVersion) {
    const action = policy(t);
    switch (t.observability) {
      case "observed_exposed": {
        observedTrials++;
        lat.push(t.latencyMs);
        corpus[t.candidateBlockId ? classify(t.candidateBlockId) : "unknown"]++;
        if (action === "apply") {
          applied++;
          if (t.label === "helpful") helpfulFires++;
        } else {
          // The baseline served this block (observed_exposed) → we KNOW its label.
          withheld++;
          if (t.label !== "helpful") withholdCorrect++; // withholding a non-helpful served block is correct
        }
        break;
      }
      case "counterfactual_unobserved":
        if (action === "apply") applyOpportunities++; // unscoreable — never a labelled fire
        break;
      case "observed_holdout":
        holdoutRows++;
        break;
      case "incomplete":
        incompleteRows++;
        break;
    }
  }

  const sorted = lat.slice().sort((a, b) => a - b);
  return {
    policy: policyName,
    ...(opts.featureVersion !== undefined ? { featureVersion: opts.featureVersion } : {}),
    totalTrials: trials.length,
    staleFeatureVersion,
    observedTrials,
    completeness: inVersion.length ? round(observedTrials / inVersion.length)! : 0,
    identifiable: {
      applied,
      helpfulFires,
      precisionAtObservedFire: applied ? round(helpfulFires / applied) : null,
      wilsonLB: applied ? round(wilsonLowerBound(helpfulFires, applied)) : null,
      withheld,
      withholdCorrect,
      withholdCorrectness: withheld ? round(withholdCorrect / withheld) : null,
      coverage: observedTrials ? round(applied / observedTrials) : null,
      abstention: observedTrials ? round(withheld / observedTrials) : null,
      latencyMsP50: pct(sorted, 0.5),
      latencyMsP95: pct(sorted, 0.95),
    },
    unidentifiable: { applyOpportunities, holdoutRows, incompleteRows },
    corpus,
  };
}

/** Replay every named policy and return the reports keyed by name. */
export function replayNamedPolicies(
  trials: readonly ApplicabilityTrialV1[],
  opts: ReplayOptions = {},
): Record<string, ApplicabilityReplayReport> {
  const out: Record<string, ApplicabilityReplayReport> = {};
  for (const [name, policy] of Object.entries(POLICIES)) out[name] = replayApplicabilityPolicy(trials, policy, name, opts);
  return out;
}
