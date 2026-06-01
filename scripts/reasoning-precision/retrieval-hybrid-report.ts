#!/usr/bin/env tsx
/**
 * Phase C hybrid retrieval report — $0, offline, local-only.
 *
 * Summarizes the local `retrieval.hybrid_comparison` stream (rollout=shadow):
 * provider, fallback breakdown, decision (dis)agreement, slate sizes/overlap,
 * rank movement, semantic-only candidates surfaced, and provider/hybrid latency
 * — separating organic from bootstrap traffic. Privacy-safe; no raw prompts.
 *
 *   tsx scripts/reasoning-precision/retrieval-hybrid-report.ts [--db <path>] [--json]
 */
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { loadConfig } from "../../src/core/config.js";
import {
  aggregateRetrievalHybrid,
  retrievalFallbackKeys,
  retrievalAgreementKeys,
  type ProvenanceClass,
} from "../../src/analytics/retrieval-hybrid-report.js";

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
  const report = aggregateRetrievalHybrid(store.readEvents({}), classify);
  store.close();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`\nHybrid retrieval shadow report — db=${dbPath}\n`);
  if (report.traffic === 0) {
    console.log("No retrieval.hybrid_comparison events found.");
    console.log("Enable with TRACEBASE_REASONING_RETRIEVAL=shadow and replay some traffic.\n");
    return;
  }
  console.log(`traffic: ${report.traffic} recall(s)`);
  console.log("provider:", JSON.stringify(report.byProvider));
  console.log("fallback:");
  for (const k of retrievalFallbackKeys()) console.log(`  ${k}: ${report.byFallback[k]}`);
  console.log(`provider contributed (no fallback): ${report.providerContributed}`);
  console.log("\ndecision agreement (sparse vs hybrid slate):");
  for (const k of retrievalAgreementKeys()) console.log(`  ${k}: ${report.decisionAgreement[k]}`);
  console.log(`decision disagreement rate: ${report.decisionDisagreementRate}`);
  console.log(`\nrecalls where hybrid surfaced new candidates: ${report.recallsWithSemanticOnly} (total semantic-only: ${report.semanticOnlyTotal})`);
  console.log(`avg slate sizes — sparse=${report.avgSparseSlateSize} hybrid=${report.avgHybridSlateSize} overlap=${report.avgOverlap}`);
  console.log(`avg rank movement: ${report.avgRankMovement}`);
  console.log(`provider latency p50/p95 (ms): ${report.providerLatencyMsP50}/${report.providerLatencyMsP95}`);
  console.log(`hybrid overhead p50/p95 (ms): ${report.hybridLatencyMsP50}/${report.hybridLatencyMsP95}`);
  console.log("\nby provenance (ORGANIC counts toward readiness; BOOTSTRAP never does):");
  for (const cls of ["organic", "bootstrap", "unknown"] as ProvenanceClass[]) {
    const s = report.byProvenance[cls];
    console.log(`  ${cls}: traffic=${s.traffic} semanticOnly=${s.semanticOnly} hybridInject=${s.hybridInject}`);
  }
  console.log("\nreadiness blockers:");
  if (report.readinessBlockers.length === 0) console.log("  (none)");
  for (const b of report.readinessBlockers) console.log(`  - ${b}`);
  console.log("");
}

main();
