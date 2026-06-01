#!/usr/bin/env tsx
/**
 * Phase C.2 ServingEvidenceV3 report — $0, offline, local-only.
 *
 * Summarizes the local `reasoning.evidence_comparison` stream (rollout=shadow):
 * lane breakdown, license-reason breakdown, served-vs-V3 (dis)agreement,
 * licensed + semantic-only candidate counts, fallback, redactions, and latency
 * -- separating organic from bootstrap traffic. Privacy-safe; no raw prompts.
 *
 *   tsx scripts/reasoning-precision/evidence-comparison-report.ts [--db <path>] [--json]
 */
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { loadConfig } from "../../src/core/config.js";
import {
  aggregateEvidenceComparison,
  evidenceAgreementKeys,
  evidenceFallbackKeys,
  type ProvenanceClass,
} from "../../src/analytics/evidence-comparison-report.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const dbPath = arg("--db") ?? loadConfig().storagePath;
  const asJson = process.argv.includes("--json");
  const store = new BlockStore(new Database(dbPath));
  const classify = (id: string): ProvenanceClass => {
    const ef = store.getBlock(id)?.provenance?.extractedFrom;
    if (ef === "trajectory") return "organic";
    if (ef === "imported") return "bootstrap";
    return "unknown";
  };
  const report = aggregateEvidenceComparison(store.readEvents({}), classify);
  store.close();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`\nServingEvidenceV3 shadow report — db=${dbPath}\n`);
  if (report.traffic === 0) {
    console.log("No reasoning.evidence_comparison events found.");
    console.log("Enable with TRACEBASE_REASONING_EVIDENCE=shadow (and hybrid retrieval) and replay traffic.\n");
    return;
  }
  console.log(`traffic: ${report.traffic} recall(s)`);
  console.log("lane:", JSON.stringify(report.byLane));
  console.log("license reason:", JSON.stringify(report.byLicenseReason));
  console.log("\nserved-vs-V3 agreement:");
  for (const k of evidenceAgreementKeys()) console.log(`  ${k}: ${report.agreement[k]}`);
  console.log(`decision disagreement rate: ${report.decisionDisagreementRate}`);
  console.log(`\nrecalls with a V3 license: ${report.recallsWithLicense} (licensed candidates total: ${report.licensedCandidatesTotal})`);
  console.log(`semantic-only candidates total: ${report.semanticOnlyCandidatesTotal}`);
  console.log("fallback:");
  for (const k of evidenceFallbackKeys()) console.log(`  ${k}: ${report.byFallback[k]}`);
  console.log(`redactions: ${report.redactionTotal}`);
  console.log(`V3 latency p50/p95 (ms): ${report.latencyMsP50}/${report.latencyMsP95}`);
  console.log("\nby provenance (ORGANIC counts toward readiness; BOOTSTRAP never does):");
  for (const cls of ["organic", "bootstrap", "unknown"] as ProvenanceClass[]) {
    const s = report.byProvenance[cls];
    console.log(`  ${cls}: traffic=${s.traffic} v3Licensed=${s.v3Licensed} v3OnlyInject=${s.v3OnlyInject}`);
  }
  console.log("\nreadiness blockers:");
  if (report.readinessBlockers.length === 0) console.log("  (none)");
  for (const b of report.readinessBlockers) console.log(`  - ${b}`);
  console.log("");
}

main();
