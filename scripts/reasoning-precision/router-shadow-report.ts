#!/usr/bin/env tsx
/**
 * Router V2 shadow comparison report — $0, offline, local-only.
 *
 * Reads the local `router.shadow_comparison` event stream (produced when
 * TRACEBASE_REASONING_ROUTER=shadow) and prints a privacy-safe summary of how
 * the served V1 decision compared to the side-by-side V2-family decision.
 * Bootstrap/imported and organic (runtime-captured) traffic are separated;
 * organic readiness blockers are surfaced. No network, no raw prompts.
 *
 *   tsx scripts/reasoning-precision/router-shadow-report.ts [--db <path>] [--json]
 */
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { loadConfig } from "../../src/core/config.js";
import {
  aggregateRouterShadow,
  agreementKeys,
  type ProvenanceClass,
} from "../../src/analytics/router-shadow-report.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const dbPath = arg("--db") ?? loadConfig().storagePath;
  const asJson = process.argv.includes("--json");

  const store = new BlockStore(new Database(dbPath));
  const events = store.readEvents({});
  const classify = (id: string): ProvenanceClass => {
    const b = store.getBlock(id);
    const ef = b?.provenance?.extractedFrom;
    if (ef === "trajectory") return "organic";
    if (ef === "imported") return "bootstrap";
    return "unknown";
  };
  const report = aggregateRouterShadow(events, classify);
  store.close();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\nRouter V2 shadow report — db=${dbPath}\n`);
  if (report.traffic === 0) {
    console.log("No router.shadow_comparison events found.");
    console.log("Enable shadow mode with TRACEBASE_REASONING_ROUTER=shadow and replay some traffic.\n");
    return;
  }
  console.log(`traffic: ${report.traffic} recall(s)`);
  console.log(`V1 inject/abstain: ${report.v1.inject}/${report.v1.abstain} (inject rate ${report.v1.injectRate})`);
  console.log(`V2 inject/abstain: ${report.v2.inject}/${report.v2.abstain} (inject rate ${report.v2.injectRate})`);
  console.log(`agreement rate (same action+block): ${report.agreementRate}`);
  console.log("\ndisagreement matrix:");
  for (const k of agreementKeys()) console.log(`  ${k}: ${report.agreement[k]}`);
  console.log("\nV1 reasons:", JSON.stringify(report.v1Reasons));
  console.log("V2 reasons:", JSON.stringify(report.v2Reasons));
  console.log("\ntop-family support distribution (distinct cases → recalls):", JSON.stringify(report.topFamilySupportDistribution));
  console.log(`bridges prevented: ${report.bridgesPreventedTotal} across ${report.bridgesPreventedRecalls} recall(s)`);
  console.log(`privacy redactions: ${report.redactionTotal} across ${report.redactionRecalls} recall(s)`);
  console.log(`V2 fallbacks: ${report.fallbackCount}`);
  console.log(`V2 overhead p50/p95 (ms): ${report.v2OverheadMsP50}/${report.v2OverheadMsP95}`);
  console.log(
    `\nattributed served-path outcomes (where available): ${report.attributedOutcomes.withOutcome} with outcome, ` +
      `${report.attributedOutcomes.resolved} resolved, ${report.attributedOutcomes.regressed} regressed`,
  );
  console.log("\nby provenance (ORGANIC counts toward readiness; BOOTSTRAP never does):");
  for (const cls of ["organic", "bootstrap", "unknown"] as ProvenanceClass[]) {
    const s = report.byProvenance[cls];
    console.log(`  ${cls}: traffic=${s.traffic} v1Inject=${s.v1Inject} v2Inject=${s.v2Inject} recurringFamilyHits=${s.recurringFamilyHits}`);
  }
  console.log(`\norganic recurring-family coverage: ${report.organicRecurringFamilyHits} recall(s)`);
  console.log("\nreadiness blockers:");
  if (report.readinessBlockers.length === 0) console.log("  (none)");
  for (const b of report.readinessBlockers) console.log(`  - ${b}`);
  console.log("");
}

main();
