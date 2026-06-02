/**
 * Phase D.3 — applicability shadow-outcome ledger joiner.
 *
 * The load-bearing guarantee: a candidate that was NEVER served (e.g.
 * reranker_only_apply) is `counterfactual_unobserved` and gets NO helpful/harmful
 * label — only a served (observed_exposed) candidate is labelled. Plus holdout,
 * incomplete, orphan, ambiguous, cross-run and feature-version diagnostics.
 */
import { describe, it, expect } from "vitest";
import type { AnalyticsEvent } from "../../src/types.js";
import { joinApplicabilityTrials, type ApplicabilityTrialV1 } from "../../src/analytics/applicability-ledger.js";

let ts = 0;
const cmp = (o: Partial<AnalyticsEvent> & { queryId: string; changedDecision: "none" | "reranker_only_apply" | "reranker_withholds" }): AnalyticsEvent =>
  ({
    event: "reasoning.applicability_comparison",
    ts: ts++,
    queryHash: "q_h",
    corpusSize: 10,
    candidateCount: 3,
    v4Action: "abstain",
    applicabilityProvider: "deterministic-applicability.v1",
    applicabilityFeatureVersion: 1,
    applicabilityVerdict: "applicable",
    verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 },
    reasonCounts: {},
    fallback: "none",
    latencyMs: 2,
    ...o,
  }) as AnalyticsEvent;
const inj = (queryId: string, blockId: string, runId?: string, featureVersion = 4): AnalyticsEvent =>
  ({ event: "injection", ts: ts++, queryId, ...(runId ? { runId } : {}), blockId, score: 0.9, featureVersion }) as AnalyticsEvent;
const used = (queryId: string, blockId: string, evidenceStrength: "explicit" | "strong" | "moderate" | "weak", runId?: string): AnalyticsEvent =>
  ({ event: "agent_used", ts: ts++, queryId, ...(runId ? { runId } : {}), blockId, matchSignal: "explicit", matchScore: 1, evidenceStrength }) as AnalyticsEvent;
const outcome = (queryId: string, o: { resolved?: boolean; regressed?: boolean; control?: boolean; attribution?: "explicit" | "inferred"; runId?: string } = {}): AnalyticsEvent =>
  ({ event: "outcome", ts: ts++, queryId, ...(o.runId ? { runId: o.runId } : {}), resolved: o.resolved ?? true, control: o.control ?? false, ...(o.regressed !== undefined ? { regressed: o.regressed } : {}), ...(o.attribution ? { attribution: o.attribution } : {}) }) as AnalyticsEvent;

const find = (trials: ApplicabilityTrialV1[], queryId: string) => trials.find((t) => t.queryId === queryId)!;

describe("joinApplicabilityTrials", () => {
  it("labels an OBSERVED served candidate helpful/harmful/unresolved", () => {
    const events: AnalyticsEvent[] = [
      // agree-inject, served, used (moderate), resolved → helpful.
      cmp({ queryId: "h", changedDecision: "none", v4Action: "inject", v4TopBlockId: "b1", applicabilityTopBlockId: "b1" }),
      inj("h", "b1"), used("h", "b1", "moderate"), outcome("h", { resolved: true, attribution: "inferred" }),
      // withhold, served, regressed → harmful (withholding would have been right).
      cmp({ queryId: "x", changedDecision: "reranker_withholds", v4Action: "inject", v4TopBlockId: "b2", applicabilityVerdict: "inapplicable" }),
      inj("x", "b2"), outcome("x", { regressed: true }),
      // served, resolved but only WEAK use → unresolved (weak never closes the loop).
      cmp({ queryId: "w", changedDecision: "none", v4Action: "inject", v4TopBlockId: "b3", applicabilityTopBlockId: "b3" }),
      inj("w", "b3"), used("w", "b3", "weak"), outcome("w", { resolved: true }),
    ];
    const { trials } = joinApplicabilityTrials(events);
    const h = find(trials, "h");
    expect(h.observability).toBe("observed_exposed");
    expect(h.label).toBe("helpful");
    expect(h.labelProvenance).toBe("inferred");
    expect(h.attributionStrength).toBe("moderate");
    expect(find(trials, "x").label).toBe("harmful");
    expect(find(trials, "w").label).toBe("unresolved");
  });

  it("NEVER labels an unserved reranker_only_apply — it is counterfactual_unobserved", () => {
    const events: AnalyticsEvent[] = [
      cmp({ queryId: "ca", changedDecision: "reranker_only_apply", v4Action: "abstain", applicabilityTopBlockId: "bX" }),
      // The reranker wanted bX, but the baseline abstained → bX was never injected.
      outcome("ca", { resolved: true }), // the run resolved (without bX) — must NOT credit bX.
    ];
    const { trials } = joinApplicabilityTrials(events);
    const t = find(trials, "ca");
    expect(t.observability).toBe("counterfactual_unobserved");
    expect(t.baselineExposed).toBe(false);
    expect(t.label).toBeUndefined(); // the honesty guarantee
  });

  it("classifies a holdout/control run as observed_holdout with no per-block label", () => {
    const events: AnalyticsEvent[] = [
      cmp({ queryId: "ho", changedDecision: "reranker_only_apply", v4Action: "abstain", applicabilityTopBlockId: "bH" }),
      outcome("ho", { resolved: true, control: true }),
    ];
    const t = find(joinApplicabilityTrials(events).trials, "ho");
    expect(t.observability).toBe("observed_holdout");
    expect(t.holdout).toBe(true);
    expect(t.label).toBeUndefined();
  });

  it("marks a missing-outcome trial incomplete (orphan diagnostic)", () => {
    const events: AnalyticsEvent[] = [cmp({ queryId: "orph", changedDecision: "reranker_withholds", v4Action: "inject", v4TopBlockId: "b9" }), inj("orph", "b9")];
    const { trials, diagnostics } = joinApplicabilityTrials(events);
    expect(find(trials, "orph").observability).toBe("incomplete");
    expect(diagnostics.orphans).toBe(1);
  });

  it("flags ambiguous (two same-run outcomes) and never attributes", () => {
    const events: AnalyticsEvent[] = [
      cmp({ queryId: "amb", changedDecision: "none", v4Action: "inject", v4TopBlockId: "b1", applicabilityTopBlockId: "b1" }),
      inj("amb", "b1"), outcome("amb", { resolved: true }), outcome("amb", { resolved: false }),
    ];
    const { trials, diagnostics } = joinApplicabilityTrials(events);
    expect(diagnostics.ambiguous).toBe(1);
    expect(find(trials, "amb").observability).toBe("incomplete");
    expect(find(trials, "amb").label).toBeUndefined();
  });

  it("never joins across runId (cross-run diagnostic) — an outcome from another run is not ours", () => {
    const events: AnalyticsEvent[] = [
      cmp({ queryId: "cr", runId: "runA", changedDecision: "none", v4Action: "inject", v4TopBlockId: "b1", applicabilityTopBlockId: "b1" }),
      inj("cr", "b1", "runB"), // injection under a different run
      outcome("cr", { resolved: true, runId: "runB" }),
    ];
    const { trials, diagnostics } = joinApplicabilityTrials(events);
    expect(diagnostics.crossRun).toBe(1);
    expect(find(trials, "cr").baselineExposed).toBe(false); // the runB injection is not joined
    expect(find(trials, "cr").observability).toBe("incomplete"); // no in-run outcome
  });

  it("flags stale feature-version trials against the current version", () => {
    const events: AnalyticsEvent[] = [
      cmp({ queryId: "v1", changedDecision: "none", v4Action: "inject", v4TopBlockId: "b1", applicabilityTopBlockId: "b1", applicabilityFeatureVersion: 1 }),
      inj("v1", "b1"), used("v1", "b1", "explicit"), outcome("v1", {}),
    ];
    const { diagnostics } = joinApplicabilityTrials(events, { featureVersion: 2 });
    expect(diagnostics.featureVersionMismatch).toBe(1);
  });

  it("is deterministic + privacy-safe: stable output, no raw text", () => {
    const events: AnalyticsEvent[] = [
      cmp({ queryId: "d", changedDecision: "none", v4Action: "inject", v4TopBlockId: "b1", applicabilityTopBlockId: "b1" }),
      inj("d", "b1"), used("d", "b1", "strong"), outcome("d", { resolved: true }),
    ];
    const a = joinApplicabilityTrials(events);
    const b = joinApplicabilityTrials(events);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("prompt");
    expect(JSON.stringify(a)).toContain("q_h"); // only the hash
  });
});
