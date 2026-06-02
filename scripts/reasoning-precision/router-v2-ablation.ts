#!/usr/bin/env tsx
/**
 * Reasoning Memory Router V2 — frozen $0 offline ablation (no paid agents).
 *
 * Reuses the FROZEN bootstrap corpus (hash de94b5202715edbd) verbatim — it is
 * read from disk and hash-verified, and the holdout queries + negative controls
 * come from the SAME exported `FAMILIES` / `CONTROLS` the corpus was built from,
 * so nothing is retyped and the corpus is never modified.
 *
 * Three arms, identical in EVERY respect except the serving representation:
 *   1. v1                — current production decision (flat lexical, block margin)
 *   2. v2-representation — structured field-aware + rarity-weighted evidence,
 *                          block-vs-block margin
 *   3. v2-family         — structured evidence + reasoning-family aggregation,
 *                          top-family-vs-runner-up-family margin
 *
 * Same corpus, same gate, same policy guards (margin 0.15, floor 0.35),
 * identity calibrator. The ONLY thing that varies is `servingMode`. Serving
 * gates are NOT lowered; any recall lift must come from better evidence.
 *
 * Reports, side by side: precision@fire, Wilson LB, FP-rate (overall + on
 * controls), within-family recall, fire-rate, abstention reasons, latency
 * p50/p95, privacy redactions, feature-version breakdown, and a coverage-risk
 * curve across gates. Writes bench-runs/reasoning-reuse/router-v2/ablation.json.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer, type ServingMode } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { evaluatePrecision, type LabeledQuery } from "../../src/eval/precision-evaluator.js";
import { buildStructuredView } from "../../src/core/serving-evidence-v2.js";
import { DEFAULT_GATE_THRESHOLD, DEFAULT_MARGIN_THRESHOLD, DEFAULT_MIN_EVIDENCE_CONFIDENCE } from "../../src/core/serving-confidence.js";
import { FAMILIES, CONTROLS } from "./bootstrap-phase1.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS_PATH = join(ROOT, "bench-runs", "reasoning-reuse", "bootstrap", "corpus.import.jsonl");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse", "router-v2");
const EXPECTED_HASH = "de94b5202715edbd";
const FROZEN_AT = 1780262013; // the timestamp the frozen corpus was built with

const ARMS: ServingMode[] = ["v1", "v2-representation", "v2-family"];
/** Headline operating point: gate 0 (matches the bootstrap Phase-1 baseline —
 *  precision is enforced by the policy guards, not the calibrated gate). */
const HEADLINE_GATE = 0;
const COVERAGE_GATES = [0, 0.2, DEFAULT_GATE_THRESHOLD, 0.6];

interface ArmMetrics {
  precisionAtFire: number | null;
  precisionWilsonLB: number | null;
  falsePositiveRateOverall: number | null;
  falsePositiveRateControls: number | null;
  withinFamilyRecall: number | null;
  fireRate: number;
  firedUsefulHoldouts: number;
  firedControls: number;
  abstentionByReason: Record<string, number>;
  latencyMsP50: number;
  latencyMsP95: number;
  featureVersionBreakdown: Record<string, number>;
}

/** Read + hash-verify the frozen corpus and cross-check it against FAMILIES. */
function loadFrozenCorpus(): string {
  const raw = readFileSync(CORPUS_PATH, "utf8").replace(/\n$/, "");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  if (hash !== EXPECTED_HASH) {
    throw new Error(`frozen corpus hash mismatch: got ${hash}, expected ${EXPECTED_HASH} — refusing to run`);
  }
  const lines = raw.split("\n");
  if (lines.length !== FAMILIES.length) {
    throw new Error(`corpus line count ${lines.length} != FAMILIES ${FAMILIES.length}`);
  }
  // Cross-check: line i must be family FAMILIES[i] (so the by-index block map is sound).
  lines.forEach((l, i) => {
    const fid = (JSON.parse(l) as { metadata?: { familyId?: string } }).metadata?.familyId;
    if (fid !== FAMILIES[i]!.id) {
      throw new Error(`corpus line ${i + 1} familyId ${fid} != FAMILIES[${i}] ${FAMILIES[i]!.id}`);
    }
  });
  return raw;
}

interface Corpus {
  store: BlockStore;
  blocks: Array<{ id: string; sourceType: "import" }>;
  queries: LabeledQuery[];
}

/** Fresh in-memory store with the frozen corpus imported + the labeled query set. */
function freshCorpus(jsonl: string): Corpus {
  const store = new BlockStore(new Database(":memory:"));
  const summary = importPatternsFromJsonl(store, jsonl, { now: FROZEN_AT });
  const familyBlock = new Map<string, string>();
  summary.results.forEach((r, i) => {
    if (r.status === "accepted" && r.blockId) familyBlock.set(FAMILIES[i]!.id, r.blockId);
  });
  const blocks = [...familyBlock.values()].map((id) => ({ id, sourceType: "import" as const }));

  const queries: LabeledQuery[] = [];
  for (const f of FAMILIES) {
    const bid = familyBlock.get(f.id);
    if (!bid) continue;
    for (const h of f.holdouts) queries.push({ text: h, label: "useful", expectBlockId: bid, provenanceClass: "bootstrap" });
  }
  for (const c of CONTROLS) queries.push({ text: c, label: "unrelated", provenanceClass: "bootstrap" });
  return { store, blocks, queries };
}

/** Count privacy redactions the V2 structured view would apply across the corpus. */
function privacyRedactions(jsonl: string): number {
  const { store } = freshCorpus(jsonl);
  let n = 0;
  for (const b of store.listBlocks().filter((x) => x.status === "active")) {
    n += buildStructuredView(b).redactedFields.length;
  }
  store.close();
  return n;
}

/** Run one arm at one gate. `tallyEvents` reads the emitted feature versions. */
function runArm(jsonl: string, mode: ServingMode, gate: number, tallyEvents: boolean): ArmMetrics {
  const { store, blocks, queries } = freshCorpus(jsonl);
  const server = new BlockServer(store, { gateThreshold: gate, servingMode: mode, emitEvents: tallyEvents });
  const report = evaluatePrecision(server, blocks, queries, { organicCaptureWorks: true });

  // Direct fire counts (recompute on a non-emitting server to avoid event noise).
  const countServer = new BlockServer(store, { gateThreshold: gate, servingMode: mode, emitEvents: false });
  const usefulQs = queries.filter((q) => q.label === "useful");
  const controlQs = queries.filter((q) => q.label === "unrelated");
  const firedUseful = usefulQs.filter((q) => countServer.recall({ text: q.text }).shouldInject).length;
  const firedControls = controlQs.filter((q) => countServer.recall({ text: q.text }).shouldInject).length;

  const featureVersionBreakdown: Record<string, number> = {};
  if (tallyEvents) {
    for (const e of store.readEvents({})) {
      if (e.event === "retrieval") {
        const fv = (e as { serving?: { featureVersion?: number } }).serving?.featureVersion;
        if (fv !== undefined) featureVersionBreakdown[String(fv)] = (featureVersionBreakdown[String(fv)] ?? 0) + 1;
      }
    }
  }

  store.close();
  return {
    precisionAtFire: report.precisionAtFire,
    precisionWilsonLB: report.precisionWilsonLB,
    falsePositiveRateOverall: report.falsePositiveRate,
    falsePositiveRateControls: controlQs.length ? firedControls / controlQs.length : null,
    withinFamilyRecall: report.recallAtUseful,
    fireRate: report.fireRate,
    firedUsefulHoldouts: firedUseful,
    firedControls,
    abstentionByReason: report.abstentionByReason,
    latencyMsP50: report.latencyMsP50,
    latencyMsP95: report.latencyMsP95,
    featureVersionBreakdown,
  };
}

interface CoveragePoint {
  gate: number;
  fireRate: number;
  precisionAtFire: number | null;
  withinFamilyRecall: number | null;
  falsePositiveRateControls: number | null;
}

function coverageRisk(jsonl: string, mode: ServingMode): CoveragePoint[] {
  return COVERAGE_GATES.map((gate) => {
    const m = runArm(jsonl, mode, gate, false);
    return {
      gate,
      fireRate: m.fireRate,
      precisionAtFire: m.precisionAtFire,
      withinFamilyRecall: m.withinFamilyRecall,
      falsePositiveRateControls: m.falsePositiveRateControls,
    };
  });
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonl = loadFrozenCorpus();

  const armMetrics: Record<string, ArmMetrics> = {};
  const coverage: Record<string, CoveragePoint[]> = {};
  for (const mode of ARMS) {
    armMetrics[mode] = runArm(jsonl, mode, HEADLINE_GATE, true);
    coverage[mode] = coverageRisk(jsonl, mode);
  }

  const redactions = privacyRedactions(jsonl);

  const TARGETS = { precisionAtFire: 0.9, falsePositiveRate: 0.05, withinFamilyRecall: 0.3 };
  const verdict: Record<string, { precisionOk: boolean; fpOk: boolean; recallOk: boolean; meetsTarget: boolean }> = {};
  for (const mode of ARMS) {
    const m = armMetrics[mode]!;
    const precisionOk = (m.precisionAtFire ?? 0) >= TARGETS.precisionAtFire || m.fireRate === 0;
    const fpOk = (m.falsePositiveRateControls ?? 1) <= TARGETS.falsePositiveRate;
    const recallOk = (m.withinFamilyRecall ?? 0) >= TARGETS.withinFamilyRecall;
    verdict[mode] = { precisionOk, fpOk, recallOk, meetsTarget: precisionOk && fpOk && recallOk };
  }

  const out = {
    label: "Router V2 frozen $0 offline ablation — reuses bootstrap corpus; no gate tuning; no paid agents.",
    corpusHash: EXPECTED_HASH,
    frozenHashVerified: true,
    corpus: {
      families: FAMILIES.length,
      importedPatterns: FAMILIES.length,
      usefulHoldouts: FAMILIES.reduce((n, f) => n + f.holdouts.length, 0),
      controls: CONTROLS.length,
    },
    operatingPoint: {
      headlineGate: HEADLINE_GATE,
      marginThreshold: DEFAULT_MARGIN_THRESHOLD,
      minEvidenceConfidence: DEFAULT_MIN_EVIDENCE_CONFIDENCE,
      calibrator: "identity",
      note: "gate 0 matches the Phase-1 baseline; precision is enforced by margin+floor guards, NOT a calibrated gate. Gates unchanged across arms.",
    },
    privacy: { redactionsInCorpus: redactions, note: redactions === 0 ? "no privacy regression — clean corpus, zero structured-field redactions" : "redactions observed (see structured-view guards)" },
    targets: TARGETS,
    arms: armMetrics,
    verdict,
    coverageRisk: coverage,
  };

  writeFileSync(join(OUT_DIR, "ablation.json"), JSON.stringify(out, null, 2) + "\n");

  // Console summary.
  const r3 = (x: number | null) => (x === null ? "n/a" : String(Math.round(x * 1000) / 1000));
  console.log(`\nRouter V2 ablation — frozen corpus ${EXPECTED_HASH} (hash verified) @ gate=${HEADLINE_GATE}\n`);
  const head = ["arm", "prec@fire", "wilsonLB", "fp(ctrl)", "recall@fam", "fireRate", "fireUseful", "fireCtrl"];
  console.log(head.join("\t"));
  for (const mode of ARMS) {
    const m = armMetrics[mode]!;
    console.log(
      [
        mode,
        r3(m.precisionAtFire),
        r3(m.precisionWilsonLB),
        r3(m.falsePositiveRateControls),
        r3(m.withinFamilyRecall),
        r3(m.fireRate),
        `${m.firedUsefulHoldouts}/${out.corpus.usefulHoldouts}`,
        `${m.firedControls}/${out.corpus.controls}`,
      ].join("\t"),
    );
  }
  console.log("\nabstention reasons:");
  for (const mode of ARMS) console.log(`  ${mode}: ${JSON.stringify(armMetrics[mode]!.abstentionByReason)}`);
  console.log("\nfeature-version breakdown (retrieval events):");
  for (const mode of ARMS) console.log(`  ${mode}: ${JSON.stringify(armMetrics[mode]!.featureVersionBreakdown)}`);
  console.log("\nlatency p50/p95 (ms):");
  for (const mode of ARMS) console.log(`  ${mode}: ${armMetrics[mode]!.latencyMsP50}/${armMetrics[mode]!.latencyMsP95}`);
  console.log(`\nprivacy redactions in corpus: ${redactions}`);
  console.log("\ntargets: prec@fire>=0.90  fp<=0.05  recall@fam>=0.30");
  for (const mode of ARMS) {
    const v = verdict[mode]!;
    console.log(`  ${mode}: ${v.meetsTarget ? "MEETS" : "below"} (prec=${v.precisionOk} fp=${v.fpOk} recall=${v.recallOk})`);
  }
  console.log("\ncoverage-risk curve (gate -> fire/prec/recall/fp):");
  for (const mode of ARMS) {
    console.log(`  ${mode}:`);
    for (const p of coverage[mode]!) {
      console.log(`    gate=${p.gate}: fire=${r3(p.fireRate)} prec=${r3(p.precisionAtFire)} recall=${r3(p.withinFamilyRecall)} fp=${r3(p.falsePositiveRateControls)}`);
    }
  }
  console.log(`\nwrote ${join("bench-runs", "reasoning-reuse", "router-v2", "ablation.json")}`);
}

main();
