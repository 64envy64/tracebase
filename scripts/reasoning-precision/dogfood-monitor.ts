#!/usr/bin/env tsx
/**
 * Runtime dogfood monitor + readiness gate (Phase 5). ONE read-only command:
 *
 *   npx tsx scripts/reasoning-precision/dogfood-monitor.ts [--db <path>] [--json]
 *
 * Reports, from the live runtime store (no raw prompts, no re-running recall —
 * quality is computed from stored telemetry events):
 *   captured · deduped · attributed · recurring-family count · fired ·
 *   precision-ready · privacy rejects · calibrator coverage
 * and a readiness verdict that prints READY only when the LOCKED organic gate is
 * truly met (≥50 captured runtime blocks, ≥30 precision-ready, precision@fire
 * ≥0.90, Wilson-LB ≥0.80, FP ≤0.05). Pure core is exported for tests.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { BlockStore } from "../../src/core/block-store.js";
import { buildDogfoodManifest, type DogfoodSummary } from "../../src/eval/dogfood-manifest.js";
import { clusterFamilies, type FamilyStats, type FingerprintableBlock } from "../../src/eval/family-fingerprint.js";
import { wilsonLowerBound } from "../../src/core/block.js";

export const ORGANIC_GATE = { capturedRuntime: 50, precisionReady: 30, precisionAtFire: 0.9, precisionWilsonLB: 0.8, falsePositiveRate: 0.05 };

export interface DogfoodReport {
  store: DogfoodSummary;
  privacy: { captureErrors: number; byReason: Record<string, number>; privacyRejects: number; rawPromptsStored: number };
  calibrator: { version: string; coverage: number; injectionEvents: number };
  quality: { firedQueries: number; correctFires: number; precisionAtFire: number | null; precisionWilsonLB: number | null; falsePositiveRateProxy: number | null };
  families: FamilyStats & { familiesWithHoldoutOutcomes: number };
  gate: Record<string, { value: number | null; required: number; comparator: "gte" | "lte"; pass: boolean }>;
  ready: boolean;
  blockers: string[];
}

export function buildDogfoodReport(store: BlockStore): DogfoodReport {
  const manifest = buildDogfoodManifest(store);
  const s = manifest.summary;
  const events = store.readEvents({ limit: 5_000_000 });

  // Query-level quality from events (the runtime store keeps no raw query text,
  // so precision is computed from injection/agent_used/outcome events, not by
  // re-running recall).
  const injQ = new Set<string>(), usedQ = new Set<string>(), resolvedQ = new Set<string>();
  const captureErrByReason: Record<string, number> = {};
  let injectionEvents = 0, calibratedEvents = 0;
  let calibratorVersion = "identity";
  for (const ev of events) {
    const e = ev as any;
    switch (ev.event) {
      case "injection": injQ.add(e.queryId); injectionEvents++; {
        const cv = e.calibratorVersion ?? e.serving?.calibratorVersion;
        if (cv && cv !== "identity") { calibratedEvents++; calibratorVersion = String(cv); }
        break;
      }
      case "agent_used": usedQ.add(e.queryId); break;
      case "outcome": if (e.resolved) resolvedQ.add(e.queryId); break;
      case "capture.error": { const r = String(e.reason ?? e.phase ?? "unknown"); captureErrByReason[r] = (captureErrByReason[r] ?? 0) + 1; break; }
      default: break;
    }
  }
  const firedQueries = injQ.size;
  const correctFires = [...injQ].filter((q) => usedQ.has(q) && resolvedQ.has(q)).length;
  const precisionAtFire = firedQueries ? correctFires / firedQueries : null;
  const precisionWilsonLB = firedQueries ? wilsonLowerBound(correctFires, firedQueries) : null;
  const falsePositiveRateProxy = firedQueries ? (firedQueries - correctFires) / firedQueries : null;

  // Recurring families over RUNTIME blocks only (runtime-first observability).
  const runtimeBlocks: FingerprintableBlock[] = [];
  for (const e of manifest.entries) {
    if (e.extractedFrom !== "trajectory") continue;
    const b = store.getBlock(e.blockId);
    if (b) runtimeBlocks.push({ id: b.id, trigger: { situation: b.trigger.situation }, body: { mechanism: b.body.mechanism } });
  }
  const families = clusterFamilies(runtimeBlocks);
  // Recurring families that already have a leakage-safe holdout outcome (a member
  // block attributed to a resolved recall). 0 until problems genuinely recur AND
  // a later instance recalls them — the signal the dogfood path is meant to grow.
  const attrByBlock = new Map(manifest.entries.map((e) => [e.blockId, e.attributedResolved]));
  const familiesWithHoldoutOutcomes = families.recurring.filter((f) => f.blockIds.some((id) => (attrByBlock.get(id) ?? 0) > 0)).length;

  // privacy rejects = capture-store rejections (validation/leakage). rawPromptsStored
  // is 0 by construction (blocks store distilled, scanned situations; the exported
  // manifest carries only situationHash) — surfaced explicitly for the operator.
  const privacyRejects = (captureErrByReason["validation"] ?? 0) + (captureErrByReason["leakage"] ?? 0) + (captureErrByReason["pattern_store"] ?? 0);
  const captureErrors = Object.values(captureErrByReason).reduce((a, b) => a + b, 0);

  const G = ORGANIC_GATE;
  const gate = {
    capturedRuntime: { value: s.runtimeCaptured, required: G.capturedRuntime, comparator: "gte" as const, pass: s.runtimeCaptured >= G.capturedRuntime },
    precisionReady: { value: s.precisionReady, required: G.precisionReady, comparator: "gte" as const, pass: s.precisionReady >= G.precisionReady },
    precisionAtFire: { value: precisionAtFire, required: G.precisionAtFire, comparator: "gte" as const, pass: (precisionAtFire ?? 0) >= G.precisionAtFire },
    precisionWilsonLB: { value: precisionWilsonLB, required: G.precisionWilsonLB, comparator: "gte" as const, pass: (precisionWilsonLB ?? 0) >= G.precisionWilsonLB },
    falsePositiveRate: { value: falsePositiveRateProxy, required: G.falsePositiveRate, comparator: "lte" as const, pass: (falsePositiveRateProxy ?? 1) <= G.falsePositiveRate },
  };
  const ready = Object.values(gate).every((g) => g.pass);
  const blockers = Object.entries(gate).filter(([, g]) => !g.pass).map(([k, g]) => `${k}: ${g.value ?? "n/a"} (need ${g.comparator === "gte" ? "≥" : "≤"}${g.required})`);
  if (families.recurringFamilies === 0) blockers.push("recurring-families: 0 (precondition for any reuse signal — no repeated problem classes captured yet)");

  return {
    store: s,
    privacy: { captureErrors, byReason: captureErrByReason, privacyRejects, rawPromptsStored: 0 },
    calibrator: { version: calibratorVersion, coverage: injectionEvents ? calibratedEvents / injectionEvents : 0, injectionEvents },
    quality: { firedQueries, correctFires, precisionAtFire, precisionWilsonLB, falsePositiveRateProxy },
    families: { ...families, familiesWithHoldoutOutcomes },
    gate,
    ready,
    blockers,
  };
}

function format(r: DogfoodReport): string {
  const pc = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const L: string[] = [];
  L.push(`=== TraceBase runtime dogfood monitor ===`);
  L.push(`capture:  ${r.store.captured} captured (${r.store.runtimeCaptured} runtime, ${r.store.imported} imported) · deduped ${r.store.duplicates} · attributed ${r.store.attributed}`);
  L.push(`serving:  fired ${r.store.fired} blocks · ${r.quality.firedQueries} fired queries · precision-ready ${r.store.precisionReady}`);
  L.push(`quality:  precision@fire ${pc(r.quality.precisionAtFire)} · WilsonLB ${pc(r.quality.precisionWilsonLB)} · FP(proxy) ${pc(r.quality.falsePositiveRateProxy)}`);
  L.push(`families: ${r.families.families} total · ${r.families.recurringFamilies} recurring (≥2 captures) · ${r.families.familiesWithHoldoutOutcomes} with holdout outcomes · largest ${r.families.largestFamilySize}`);
  L.push(`privacy:  ${r.privacy.privacyRejects} privacy/validation rejects · ${r.privacy.captureErrors} capture errors · raw prompts stored ${r.privacy.rawPromptsStored}`);
  L.push(`calibrator: ${r.calibrator.version} · coverage ${pc(r.calibrator.coverage)} (${r.calibrator.injectionEvents} injections)`);
  L.push(`\nreadiness gate (locked organic):`);
  for (const [k, g] of Object.entries(r.gate)) L.push(`  ${g.pass ? "PASS" : "FAIL"}  ${k}: ${g.value ?? "n/a"} (${g.comparator === "gte" ? "≥" : "≤"}${g.required})`);
  L.push(`\nVERDICT: ${r.ready ? "READY" : "NOT READY"}`);
  if (!r.ready) for (const b of r.blockers) L.push(`  blocker: ${b}`);
  return L.join("\n");
}

// CLI
const invokedDirectly = process.argv[1]?.includes("dogfood-monitor");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const opt = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const dbPath = opt("--db", ".tracebase/memory.db")!;
  if (!existsSync(dbPath)) { console.error(`No store at ${dbPath} — run the runtime (Stop hook) first, or pass --db <path>.`); process.exit(1); }
  const store = new BlockStore(new Database(dbPath, { readonly: true }), { skipMigrate: true });
  try {
    const report = buildDogfoodReport(store);
    if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(format(report));
    process.exit(report.ready ? 0 : 2);
  } finally { store.close(); }
}
