#!/usr/bin/env tsx
/**
 * Phase D.3 applicability ledger report — $0, offline, local-only.
 *
 * Joins the local event log into applicability trials, replays the named
 * policies on the IDENTIFIABLE (served) subset, and prints the observability
 * distribution, the policy table, the organic/bootstrap/synthetic split, and the
 * readiness verdict. Privacy-safe; no raw prompts/bodies/tokens.
 *
 *   tsx scripts/reasoning-precision/applicability-ledger-report.ts [--db <path>] [--json]
 */
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { loadConfig } from "../../src/core/config.js";
import { buildApplicabilityLedgerReport, observabilityKeys, type LedgerReportOptions } from "../../src/analytics/applicability-ledger-report.js";
import { APPLICABILITY_FEATURE_VERSION } from "../../src/core/applicability-reranker.js";
import type { TrialProvenanceClass } from "../../src/analytics/applicability-replay.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const dbPath = arg("--db") ?? loadConfig().storagePath;
  const asJson = process.argv.includes("--json");
  const store = new BlockStore(new Database(dbPath));
  // Provenance split mirrors the other reports: trajectory→organic, imported→bootstrap.
  const classifyBlock = (id: string): TrialProvenanceClass => {
    const ef = store.getBlock(id)?.provenance?.extractedFrom;
    if (ef === "trajectory") return "organic";
    if (ef === "imported") return "bootstrap";
    if (ef === "distilled") return "synthetic";
    return "unknown";
  };
  const opts: LedgerReportOptions = { featureVersion: APPLICABILITY_FEATURE_VERSION, classifyBlock };
  const report = buildApplicabilityLedgerReport(store.readEvents({}), opts);
  store.close();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`\nApplicability ledger report — db=${dbPath}\n`);
  console.log(`trials: ${report.totalTrials}`);
  if (report.totalTrials === 0) {
    console.log("\nNo applicability trials. Enable TRACEBASE_REASONING_APPLICABILITY=shadow (+ hybrid retrieval) and replay traffic.\n");
    return;
  }
  console.log("observability:");
  for (const k of observabilityKeys()) console.log(`  ${k}: ${report.observability[k]}`);
  console.log("\ndiagnostics:", JSON.stringify(report.diagnostics));
  console.log("\nobserved corpus (ORGANIC gates readiness; bootstrap/synthetic never do):");
  for (const cls of ["organic", "bootstrap", "synthetic", "unknown"] as TrialProvenanceClass[]) console.log(`  ${cls}: ${report.corpus[cls]}`);

  console.log("\npolicy replay (IDENTIFIABLE = served outcomes only):");
  console.log("  policy\t\tobserved\tapplied\tprec@fire\twilsonLB\twithholdOK\tcoverage\tapplyOpp(counterfactual)");
  for (const [name, p] of Object.entries(report.policies)) {
    const i = p.identifiable;
    console.log(`  ${name.padEnd(22)}\t${p.observedTrials}\t${i.applied}\t${i.precisionAtObservedFire}\t${i.wilsonLB}\t${i.withholdCorrectness}\t${i.coverage}\t${p.unidentifiable.applyOpportunities}`);
  }
  console.log(`\ncounterfactual apply opportunities (reranker recall NOT scoreable from shadow): ${report.counterfactualApplyOpportunities}`);

  console.log(`\nreadiness for semantic-provider eval / Phase-E: ${report.readiness.ready ? "READY" : "NOT READY"}`);
  for (const b of report.readiness.blockers) console.log(`  blocker: ${b}`);
  console.log("");
}

main();
