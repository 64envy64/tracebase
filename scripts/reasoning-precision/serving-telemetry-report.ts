#!/usr/bin/env tsx
/**
 * Serving-telemetry aggregation report (Phase 1).
 *
 * Reads the analytics event log (a BlockStore SQLite DB) and reports the
 * serving-decision health metrics from the `serving` records stamped on every
 * retrieval event, joined with attribution (agent_used) + outcome events for
 * the precision view. Privacy-safe: reads only queryHash, never raw prompts.
 *
 * Usage:
 *   npx tsx scripts/reasoning-precision/serving-telemetry-report.ts [--db <path>] [--json <out>]
 *   (default DB: ./.tracebase/memory.db)
 *
 * Reports: fire-rate, abstention-rate by reason, precision@fire,
 * false-positive rate, recall@useful (when outcome labels exist), latency
 * p50/p95, corpus size, calibrated vs uncalibrated buckets, outcome coverage.
 */
import Database from "better-sqlite3";
import { existsSync, writeFileSync } from "node:fs";
import { BlockStore } from "../../src/core/block-store.js";
import type { RetrievalEvent, ServingTelemetry } from "../../src/types.js";
import {
  effectiveAttributionStrength,
  meetsHelpfulThreshold,
} from "../../src/runtime/attribution-evidence.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = arg("--db", ".tracebase/memory.db")!;
const jsonOut = arg("--json");
if (!existsSync(dbPath)) {
  console.error(`No event DB at ${dbPath}. Run the runtime first, or pass --db <path>.`);
  process.exit(1);
}

const store = new BlockStore(new Database(dbPath, { readonly: true }));
const events = store.readEvents({ limit: 5_000_000 });

// ── Collect serving records + attribution ─────────────────────────────────
const servings: ServingTelemetry[] = [];
// "queryId|blockId" → helpful? (agent_used meets threshold ∧ outcome resolved)
const helpfulByPair = new Map<string, boolean>();
const strengthByPair = new Map<string, boolean>(); // meetsHelpfulThreshold seen
const resolvedByQuery = new Map<string, boolean>();

for (const ev of events) {
  switch (ev.event) {
    case "retrieval": {
      const s = (ev as RetrievalEvent).serving;
      if (s) servings.push(s);
      break;
    }
    case "agent_used":
      strengthByPair.set(`${ev.queryId}|${ev.blockId}`, meetsHelpfulThreshold(effectiveAttributionStrength(ev)));
      break;
    case "outcome":
      resolvedByQuery.set(ev.queryId, ev.resolved);
      break;
    default:
      break;
  }
}
for (const [pair, strong] of strengthByPair) {
  const qid = pair.split("|")[0]!;
  helpfulByPair.set(pair, strong && (resolvedByQuery.get(qid) ?? false));
}

// ── Metrics ────────────────────────────────────────────────────────────────
const total = servings.length;
const fired = servings.filter((s) => s.decision === "inject");
const abstained = servings.filter((s) => s.decision === "abstain");

const reasonDist: Record<string, number> = {};
for (const s of abstained) reasonDist[s.reason] = (reasonDist[s.reason] ?? 0) + 1;

// Precision view: a fired retrieval is helpful iff any injected block has a
// helpful pair; "has outcome" iff its query produced an outcome event.
let firedWithOutcome = 0, firedHelpful = 0, firedHarmful = 0;
for (const s of fired) {
  const hasOutcome = resolvedByQuery.has(s.retrievalId);
  if (!hasOutcome) continue;
  firedWithOutcome++;
  const helpful = s.injectedBlockIds.some((b) => helpfulByPair.get(`${s.retrievalId}|${b}`));
  if (helpful) firedHelpful++;
  else firedHarmful++;
}

const lat = servings.map((s) => s.latencyMs).sort((a, b) => a - b);
const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]! : 0);
const calibrated = servings.filter((s) => s.calibratorVersion !== "identity").length;
const corpusSizes = servings.map((s) => s.corpusSize);

const report = {
  totalRecalls: total,
  fireRate: round(fired.length / Math.max(1, total)),
  abstentionRate: round(abstained.length / Math.max(1, total)),
  abstentionByReason: reasonDist,
  outcomeCoverage: round(firedWithOutcome / Math.max(1, fired.length)),
  precisionAtFire: firedWithOutcome ? round(firedHelpful / firedWithOutcome) : null,
  falsePositiveRate: firedWithOutcome ? round(firedHarmful / firedWithOutcome) : null,
  recallAtUseful: null as number | null, // requires a labelled useful set (offline eval)
  latencyMsP50: pct(0.5),
  latencyMsP95: pct(0.95),
  corpusSize: { min: Math.min(...corpusSizes, 0), max: Math.max(...corpusSizes, 0) },
  calibratedBucket: calibrated,
  uncalibratedBucket: total - calibrated,
};

console.log("=== Serving-telemetry report ===");
console.log(`db: ${dbPath}`);
console.log(JSON.stringify(report, null, 2));
if (firedWithOutcome === 0) {
  console.log("\nNote: no fired retrievals have downstream outcomes yet — precision@fire/FP-rate need");
  console.log("the attribution loop (agent_used + outcome) to close. recall@useful needs a labelled set");
  console.log("(see the offline organic eval).");
}
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nWrote ${jsonOut}`);
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
