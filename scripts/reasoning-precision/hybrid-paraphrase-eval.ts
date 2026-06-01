#!/usr/bin/env tsx
/**
 * Frozen $0 paraphrase eval — sparse FTS vs Phase-C hybrid retrieval.
 *
 * DISCLOSED, hand-authored, NOT organic: each family is a recurring class whose
 * MECHANISM carries vocabulary the trigger situation does not. The paraphrase
 * holdouts are phrased in that body vocabulary (the case FTS-over-trigger
 * struggles with); the hard negatives lexically resemble a family's situation
 * but are a different problem (to keep precision honest). No model, no network,
 * no threshold tuning. Two arms differ ONLY in `retrievalMode` + the provider.
 *
 * Reports, side by side: candidate-recall@useful (did the right block enter the
 * served slate — the substrate's direct lever), decision recall@useful,
 * precision@fire, FP-rate on hard negatives, Wilson lower bound, fire-rate,
 * latency p50/p95, and provider fallbacks. Organic readiness is N/A here (all
 * bootstrap) and reported as such.
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import { wilsonLowerBound } from "../../src/core/block.js";
import { DEFAULT_GATE_THRESHOLD } from "../../src/core/serving-confidence.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse", "hybrid");

interface Family {
  id: string;
  situation: string;
  mechanism: string;
  unlock: string;
  paraphrases: string[]; // body-phrased holdouts
}

// Disclosed: hand-authored recurring classes; mechanism vocabulary is richer
// than the trigger so paraphrases exercise body-aware retrieval.
const FAMILIES: Family[] = [
  {
    id: "idempotency",
    situation: "a webhook handler processes the same delivery twice after a retry",
    mechanism: "the handler is not idempotent so a redelivered event applies its side effect again because there is no dedupe key on the event identifier",
    unlock: "make the handler idempotent: dedupe on a stable event identifier before applying the side effect",
    paraphrases: [
      "duplicate side effects appear when an event is redelivered because nothing dedupes on the identifier",
      "the same operation applies again on a retried delivery since the handler keeps no idempotent dedupe key",
    ],
  },
  {
    id: "n-plus-one",
    situation: "a list endpoint is slow when rendering many rows",
    mechanism: "the resolver issues one query per row instead of batching so the database sees an n plus one explosion of round trips",
    unlock: "batch the per-row fetch with a dataloader so the resolver issues one query for the whole page",
    paraphrases: [
      "the database round trips explode because each row triggers its own query instead of a batched dataloader",
      "per item fetching causes an n plus one query pattern that a batching dataloader would collapse",
    ],
  },
  {
    id: "clock-skew",
    situation: "token validation fails intermittently across two services",
    mechanism: "the two hosts disagree on wall clock time so a freshly issued token looks expired or not yet valid due to clock skew",
    unlock: "allow a small leeway window on expiry and synchronize hosts with ntp to absorb clock skew",
    paraphrases: [
      "a just issued credential is rejected as not yet valid because the hosts have clock skew",
      "expiry checks flap because wall clock time differs between machines and there is no leeway window",
    ],
  },
  {
    id: "connection-pool",
    situation: "the service stalls under load and requests queue up",
    mechanism: "every request opens its own connection and never returns it so the connection pool is exhausted and new work blocks waiting for a free slot",
    unlock: "borrow from a bounded connection pool and always release the connection in a finally so the pool is not exhausted",
    paraphrases: [
      "new work blocks waiting for a free slot because connections are never released back to the pool",
      "the pool is exhausted under load since each request leaks its connection instead of returning it",
    ],
  },
  {
    id: "unicode-normalization",
    situation: "a username lookup fails for some accented names",
    mechanism: "the stored string and the query string use different unicode normalization forms so visually identical text compares unequal byte for byte",
    unlock: "normalize both sides to the same unicode normalization form before comparing or indexing the text",
    paraphrases: [
      "visually identical accented text compares unequal because the two sides use different normalization forms",
      "a lookup misses because the stored and queried strings differ only in unicode normalization",
    ],
  },
];

// Hard negatives: plausible bug reports about DIFFERENT problems — disjoint from
// every family's trigger AND body vocabulary, so a correct system rejects them.
// They probe that hybrid's extra candidate generation does not manufacture
// false positives the sparse path wouldn't already make.
const NEGATIVES: string[] = [
  "a css flexbox row overflows because a child element lacks a min-width constraint",
  "a docker image is huge because apt package caches are kept across build layers",
  "a progress bar animation janks on mobile because it animates layout instead of transform",
  "a markdown table renders with misaligned columns when a cell contains a pipe character",
  "a regex denial of service comes from catastrophic backtracking on nested quantifiers",
];

function buildDtos(frozenAt: number): unknown[] {
  return FAMILIES.map((f) => ({
    schemaVersion: PATTERN_DTO_SCHEMA_VERSION,
    pattern: { situation: f.situation, mechanism: f.mechanism, unlock: f.unlock, verification: "re-run the failing scenario and confirm the class-specific symptom is gone" },
    scope: { language: "general" },
    signals: { tags: [f.id, "recurring-class", "paraphrase-eval"] },
    provenance: { sourceType: "import", sourceRef: `paraphrase:${f.id}`, capturedAt: frozenAt, captureVersion: "hybrid-paraphrase-1" },
    metadata: { familyId: f.id, disclosure: "hand-authored recurring-class paraphrase eval; NOT organic, NOT public-mined" },
  }));
}

interface LabeledQuery { text: string; label: "useful" | "negative"; expectBlockId?: string }
interface ArmRow { fired: boolean; injectedId?: string; inSlate: boolean; correct: boolean; latencyMs: number }

function metrics(rows: ArmRow[], queries: LabeledQuery[]) {
  const useful = rows.filter((_, i) => queries[i]!.label === "useful");
  const negs = rows.filter((_, i) => queries[i]!.label === "negative");
  const fired = rows.filter((r) => r.fired);
  const correctFires = fired.filter((r) => r.correct).length;
  const usefulInjected = useful.filter((r) => r.fired && r.correct).length;
  const usefulInSlate = useful.filter((r) => r.inSlate).length;
  const negFired = negs.filter((r) => r.fired).length;
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const round = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  const pctile = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]! : 0);
  return {
    candidateRecallAtUseful: round(useful.length ? usefulInSlate / useful.length : null),
    recallAtUseful: round(useful.length ? usefulInjected / useful.length : null),
    precisionAtFire: round(fired.length ? correctFires / fired.length : null),
    wilsonLB: round(fired.length ? wilsonLowerBound(correctFires, fired.length) : null),
    falsePositiveRateNegatives: round(negs.length ? negFired / negs.length : null),
    fireRate: round(rows.length ? fired.length / rows.length : 0),
    latencyMsP50: pctile(0.5),
    latencyMsP95: pctile(0.95),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const FROZEN_AT = 1780262013;
  const dtos = buildDtos(FROZEN_AT);
  const jsonl = dtos.map((d) => JSON.stringify(d)).join("\n");
  const corpusHash = createHash("sha256").update(jsonl).digest("hex").slice(0, 16);

  const store = new BlockStore(new Database(":memory:"));
  const summary = importPatternsFromJsonl(store, jsonl, { now: FROZEN_AT });
  const familyBlock = new Map<string, string>();
  summary.results.forEach((r, i) => { if (r.status === "accepted" && r.blockId) familyBlock.set(FAMILIES[i]!.id, r.blockId); });

  const queries: LabeledQuery[] = [];
  for (const f of FAMILIES) {
    const bid = familyBlock.get(f.id);
    if (!bid) continue;
    for (const p of f.paraphrases) queries.push({ text: p, label: "useful", expectBlockId: bid });
  }
  for (const n of NEGATIVES) queries.push({ text: n, label: "negative" });

  // Both arms: V2-family decision at the PRODUCTION gate (DEFAULT_GATE_THRESHOLD,
  // not tuned). Only retrievalMode + the provider differ. The production gate is
  // the honest operating point here: the hard negatives deliberately overlap a
  // family's SITUATION, so a permissive gate would fire on them.
  const gate = DEFAULT_GATE_THRESHOLD;
  const sparseServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false });
  const hybridServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider() });

  const runArm = async (hybrid: boolean): Promise<ArmRow[]> => {
    const rows: ArmRow[] = [];
    for (const q of queries) {
      const t0 = Date.now();
      const r = hybrid ? await hybridServer.recallHybrid({ text: q.text }) : sparseServer.recall({ text: q.text });
      const latencyMs = Date.now() - t0;
      const injectedId = r.blocks.find((h) => h.passesGate)?.block.id;
      const inSlate = q.expectBlockId ? r.blocks.some((h) => h.block.id === q.expectBlockId) : false;
      const correct = r.shouldInject ? q.label === "useful" && injectedId === q.expectBlockId : q.label !== "useful";
      rows.push({ fired: r.shouldInject, ...(injectedId ? { injectedId } : {}), inSlate, correct, latencyMs });
    }
    return rows;
  };

  const sparse = metrics(await runArm(false), queries);
  const hybrid = metrics(await runArm(true), queries);

  const out = {
    label: "Phase C hybrid retrieval paraphrase eval — DISCLOSED hand-authored; NOT organic readiness; no gate tuning; no model/network.",
    corpusHash,
    frozenAt: FROZEN_AT,
    corpus: { families: FAMILIES.length, paraphraseHoldouts: queries.filter((q) => q.label === "useful").length, hardNegatives: NEGATIVES.length },
    provider: "deterministic-local",
    fusion: "RRF (k=60)",
    operatingPoint: { gate, note: "production gate DEFAULT_GATE_THRESHOLD (not tuned); V2-family decision both arms" },
    organicReadiness: "N/A — bootstrap/paraphrase corpus only; never counts toward organic readiness",
    arms: { sparse, hybrid },
    fallbacks: 0,
  };
  writeFileSync(join(OUT_DIR, "paraphrase-eval.json"), JSON.stringify(out, null, 2) + "\n");

  console.log(`\nPhase C paraphrase eval — corpus ${corpusHash} (frozen)\n`);
  const cols = ["arm", "candRecall", "recall@useful", "prec@fire", "wilsonLB", "fp(neg)", "fireRate", "p50", "p95"];
  console.log(cols.join("\t"));
  for (const [name, m] of [["sparse", sparse], ["hybrid", hybrid]] as const) {
    console.log([name, m.candidateRecallAtUseful, m.recallAtUseful, m.precisionAtFire, m.wilsonLB, m.falsePositiveRateNegatives, m.fireRate, m.latencyMsP50, m.latencyMsP95].join("\t"));
  }
  console.log(`\ncorpusHash=${corpusHash}  provider=deterministic-local  fusion=RRF(k=60)`);
  console.log("organic readiness: N/A (bootstrap/paraphrase corpus; reported separately)");
  console.log(`\nwrote ${join("bench-runs", "reasoning-reuse", "hybrid", "paraphrase-eval.json")}`);
  store.close();
}

void main();
