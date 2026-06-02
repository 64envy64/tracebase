#!/usr/bin/env tsx
/**
 * Frozen $0 applicability ledger + replay eval (Phase D.3).
 *
 * A FROZEN, disclosed-synthetic event log covering every join case — observed
 * helpful, observed harmful, holdout, unserved apply (counterfactual), missing
 * outcome, inferred-vs-explicit attribution, cross-run collision, stale feature
 * version — joined into trials and replayed. Demonstrates the machinery and the
 * HONEST readiness verdict on a reproducible corpus. No model/network/tuning.
 *
 * Because the corpus is SYNTHETIC (not organic runtime traffic), readiness is
 * correctly NOT READY — synthetic rows exercise the joiner/replay but never gate
 * promotion. That is the point: the substrate is honest before any data exists.
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalyticsEvent } from "../../src/types.js";
import { buildApplicabilityLedgerReport, type ApplicabilityLedgerReport } from "../../src/analytics/applicability-ledger-report.js";
import type { TrialProvenanceClass } from "../../src/analytics/applicability-replay.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse", "applicability-ledger");
const FEATURE_VERSION = 1;

// ── Frozen event makers (stable ts; no clock) ──
let T = 0;
const cmp = (queryId: string, changedDecision: "none" | "reranker_only_apply" | "reranker_withholds", o: Record<string, unknown> = {}): AnalyticsEvent =>
  ({ event: "reasoning.applicability_comparison", ts: T++, queryId, queryHash: `q_${queryId}`, corpusSize: 12, candidateCount: 3, v4Action: "abstain", applicabilityProvider: "deterministic-applicability.v1", applicabilityFeatureVersion: FEATURE_VERSION, applicabilityVerdict: "applicable", verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 0 }, reasonCounts: {}, fallback: "none", latencyMs: 2, changedDecision, ...o }) as AnalyticsEvent;
const inj = (queryId: string, blockId: string, o: Record<string, unknown> = {}): AnalyticsEvent =>
  ({ event: "injection", ts: T++, queryId, blockId, score: 0.9, featureVersion: 4, ...o }) as AnalyticsEvent;
const used = (queryId: string, blockId: string, evidenceStrength: "explicit" | "strong" | "moderate" | "weak", o: Record<string, unknown> = {}): AnalyticsEvent =>
  ({ event: "agent_used", ts: T++, queryId, blockId, matchSignal: "explicit", matchScore: 1, evidenceStrength, ...o }) as AnalyticsEvent;
const out = (queryId: string, o: Record<string, unknown> = {}): AnalyticsEvent =>
  ({ event: "outcome", ts: T++, queryId, resolved: true, control: false, ...o }) as AnalyticsEvent;

// ── The frozen corpus (8 documented cases) ──
function buildEvents(): AnalyticsEvent[] {
  T = 0;
  return [
    // 1. observed helpful (agree-inject, served, used explicit, resolved).
    cmp("obs-helpful", "none", { v4Action: "inject", v4TopBlockId: "syn-A", applicabilityTopBlockId: "syn-A" }),
    inj("obs-helpful", "syn-A"), used("obs-helpful", "syn-A", "explicit"), out("obs-helpful", { resolved: true, attribution: "explicit" }),
    // 2. observed harmful (withhold target was served and regressed → withholding right).
    cmp("obs-harmful", "reranker_withholds", { v4Action: "inject", v4TopBlockId: "syn-B", applicabilityVerdict: "inapplicable" }),
    inj("obs-harmful", "syn-B"), out("obs-harmful", { regressed: true }),
    // 3. holdout / control.
    cmp("holdout", "reranker_only_apply", { applicabilityTopBlockId: "syn-C" }), out("holdout", { control: true }),
    // 4. unserved apply (reranker wants syn-D, baseline abstained, nothing served) → counterfactual.
    cmp("unserved", "reranker_only_apply", { applicabilityTopBlockId: "syn-D" }), out("unserved", { resolved: true }),
    // 5. missing outcome → incomplete (orphan).
    cmp("orphan", "reranker_withholds", { v4Action: "inject", v4TopBlockId: "syn-E" }), inj("orphan", "syn-E"),
    // 6. inferred-vs-explicit attribution (two served helpfuls, different provenance).
    cmp("inferred", "none", { v4Action: "inject", v4TopBlockId: "syn-F", applicabilityTopBlockId: "syn-F" }),
    inj("inferred", "syn-F"), used("inferred", "syn-F", "moderate"), out("inferred", { resolved: true, attribution: "inferred" }),
    cmp("explicit", "none", { v4Action: "inject", v4TopBlockId: "syn-G", applicabilityTopBlockId: "syn-G" }),
    inj("explicit", "syn-G"), used("explicit", "syn-G", "explicit"), out("explicit", { resolved: true, attribution: "explicit" }),
    // 7. cross-run collision (cmp runA; injection/outcome under runB) → not joined.
    cmp("crossrun", "none", { runId: "runA", v4Action: "inject", v4TopBlockId: "syn-H", applicabilityTopBlockId: "syn-H" }),
    inj("crossrun", "syn-H", { runId: "runB" }), out("crossrun", { resolved: true, runId: "runB" }),
    // 8. stale feature version (served + resolved but applicabilityFeatureVersion=0) → excluded from replay.
    cmp("stale", "none", { v4Action: "inject", v4TopBlockId: "syn-I", applicabilityTopBlockId: "syn-I", applicabilityFeatureVersion: 0 }),
    inj("stale", "syn-I"), used("stale", "syn-I", "explicit"), out("stale", { resolved: true }),
  ];
}

export interface ApplicabilityLedgerEvalResult {
  label: string;
  corpusHash: string;
  report: ApplicabilityLedgerReport;
}

export function runApplicabilityLedgerEval(): ApplicabilityLedgerEvalResult {
  const events = buildEvents();
  const corpusHash = createHash("sha256").update(JSON.stringify(events)).digest("hex").slice(0, 16);
  // The whole corpus is hand-authored synthetic — classify accordingly so it
  // exercises the machinery but NEVER counts toward organic readiness.
  const classifyBlock = (_id: string): TrialProvenanceClass => "synthetic";
  const report = buildApplicabilityLedgerReport(events, { featureVersion: FEATURE_VERSION, classifyBlock });
  return {
    label: "Phase D.3 applicability ledger + replay eval — FROZEN disclosed-synthetic; exercises every join case; readiness is NOT READY by construction (synthetic, not organic).",
    corpusHash,
    report,
  };
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const out_ = runApplicabilityLedgerEval();
  writeFileSync(join(OUT_DIR, "eval.json"), JSON.stringify(out_, null, 2) + "\n");
  const r = out_.report;
  console.log(`\nPhase D.3 applicability ledger eval — corpus ${out_.corpusHash} (frozen)\n`);
  console.log(`trials: ${r.totalTrials}`);
  console.log("observability:", JSON.stringify(r.observability));
  console.log("diagnostics:", JSON.stringify(r.diagnostics));
  console.log("\npolicy replay (identifiable = served only):");
  console.log("  policy\t\tobserved\tapplied\tprec@fire\twithholdOK\tapplyOpp(counterfactual)\tstaleExcluded");
  for (const [name, p] of Object.entries(r.policies)) {
    const i = p.identifiable;
    console.log(`  ${name.padEnd(22)}\t${p.observedTrials}\t${i.applied}\t${i.precisionAtObservedFire}\t${i.withholdCorrectness}\t${p.unidentifiable.applyOpportunities}\t${p.staleFeatureVersion}`);
  }
  console.log(`\ncounterfactual apply opportunities: ${r.counterfactualApplyOpportunities}`);
  console.log(`observed corpus: ${JSON.stringify(r.corpus)}`);
  console.log(`\nreadiness: ${r.readiness.ready ? "READY" : "NOT READY"}`);
  for (const b of r.readiness.blockers) console.log(`  blocker: ${b}`);
  console.log(`\nwrote ${join("bench-runs", "reasoning-reuse", "applicability-ledger", "eval.json")}`);
}

if (!process.env.VITEST) main();
