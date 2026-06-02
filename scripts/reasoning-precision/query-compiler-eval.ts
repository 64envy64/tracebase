#!/usr/bin/env tsx
/**
 * Frozen $0 two-view query-compiler eval — baseline / literal-hybrid /
 * literal+causal (Phase D.1). Drives the REAL shadow wiring
 * (BlockServer.emitQueryCompilerComparison) over a broader frozen corpus and
 * reads the local-only comparison events, so it measures exactly what the
 * runtime would record.
 *
 * Question: does routing structured signal to the literal lane and mechanism
 * PROSE to a distilled causal lane convert candidate-recall the sparse/literal
 * arms miss into DECISION recall — WITHOUT raising false positives? If the
 * causal lane adds no decisions (token reshuffling) or raises FP, the verdict
 * says so and proposes the next mechanism-level fix; the policy is NOT weakened.
 *
 * DISCLOSED, hand-authored, NOT organic. NEW frozen corpus (prior corpora
 * untouched) with same-domain siblings so V4's contrastive gate stays honest.
 * No model, no network, no constant tuning after results.
 *
 * Adversary set: symbol-heavy causal paraphrases, symptom-only paraphrases,
 * missing-invariant queries, same-domain sibling collisions, unrelated
 * negatives, symbol-noise-only negatives, plus provider-timeout + remote-refusal
 * probes.
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
import { DEFAULT_GATE_THRESHOLD } from "../../src/core/serving-confidence.js";
import type { ReasoningQueryCompilerComparisonEvent } from "../../src/types.js";
import type {
  RetrievalProvider,
  RetrievalProviderCapabilities,
  RetrievalIntent,
  RetrievalContext,
  RetrievalCandidate,
  RetrievalDocument,
} from "../../src/core/retrieval-provider.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse", "query-compiler");
const FROZEN_AT = 1780262013;

interface Family {
  id: string;
  anchor: string;
  situation: string;
  mechanism: string;
  unlock: string;
}
const FAMILIES: Family[] = [
  { id: "lock-order-deadlock", anchor: "concurrency", situation: "two background jobs occasionally hang and stop making progress", mechanism: "two mutexes are acquired in opposite orders on different threads so each thread holds one lock and waits forever for the other producing a circular wait deadlock", unlock: "impose a global canonical lock ordering so every thread acquires the two mutexes in the same order which breaks the circular wait" },
  { id: "lost-update-race", anchor: "concurrency", situation: "a shared counter occasionally undercounts when many workers update it", mechanism: "concurrent read modify write cycles interleave without a compare and swap so one writer overwrites another and an increment is silently lost", unlock: "make the increment atomic with a compare and swap or a transactional update so no concurrent write is overwritten" },
  { id: "float-accumulation", anchor: "numeric", situation: "a running balance is off by a tiny fraction", mechanism: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result", unlock: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift" },
  { id: "float-equality", anchor: "numeric", situation: "two computed quantities that should match are treated as different", mechanism: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding", unlock: "compare with a tolerance epsilon instead of strict equality or use a decimal type for an exact representation" },
  { id: "cache-stampede", anchor: "caching", situation: "the origin is hammered right after a popular entry expires", mechanism: "when a hot key expires many requests miss simultaneously and all recompute the same value at once stampeding the origin because there is no single flight lock", unlock: "serialize recomputation with a single flight lock or early recompute so only one request rebuilds the expired hot key" },
  { id: "cache-staleness", anchor: "caching", situation: "users keep seeing outdated information after a change", mechanism: "a write updates the database but the cached copy is never invalidated so reads keep returning the previous value until the entry expires on its own", unlock: "invalidate or update the cached entry on write so reads never serve a value older than the last write" },
];

type QKind = "symbol-causal" | "symptom" | "missing-invariant";
interface Useful { family: string; kind: QKind; text: string }
// Body-phrased queries that BURY the mechanism + remediation in symbols (or carry
// no symbols at all). Trigger words deliberately avoided so the sparse/literal
// lanes struggle and the distilled causal lane is the lever.
const USEFUL: Useful[] = [
  { family: "float-accumulation", kind: "symbol-causal", text: "Accumulator.fold() in src/calc/engine.ts returns a wrong figure because each addition accumulates rounding error and discards low order bits so we should switch to kahan summation or integer cents to avoid the drift" },
  { family: "float-accumulation", kind: "symptom", text: "my long running sum comes out a hair off and I think rounding error keeps accumulating as each addition discards the low order bits maybe kahan summation or integer cents would avoid the drift" },
  { family: "float-equality", kind: "symbol-causal", text: "assertEquals(a,b) in src/math/cmp.ts fails even though the numbers look identical because comparing them with strict equality breaks when the same value has several bit representations after rounding so use a tolerance epsilon or a decimal type" },
  { family: "cache-staleness", kind: "symbol-causal", text: "UserRepo.read() in src/store/user.ts keeps returning the previous value after a write because the cached copy is never invalidated on write so we must invalidate the cached entry when the database is updated" },
  { family: "cache-stampede", kind: "symptom", text: "right after a popular entry expires the origin gets hammered because many requests miss at once and all recompute the same value with nothing to serialize the rebuild so a single flight lock or early recompute would help" },
  { family: "lost-update-race", kind: "symbol-causal", text: "Counter.incr() in src/c.ts loses updates because concurrent read modify write cycles interleave without a compare and swap so one writer overwrites another and we should make the increment atomic with a compare and swap" },
  { family: "lock-order-deadlock", kind: "missing-invariant", text: "two of my worker threads freeze because each holds one mutex and waits forever for the other since the two locks are acquired in opposite order so a global canonical lock ordering would break the circular wait" },
];

type NegKind = "sibling-collision" | "unrelated" | "symbol-noise";
interface Negative { kind: NegKind; text: string }
const NEGATIVES: Negative[] = [
  { kind: "sibling-collision", text: "a slider snaps to coarse steps because the floating point value is rounded to one decimal place purely for display in Widget.render() at src/ui/widget.ts" },
  { kind: "sibling-collision", text: "the cache holds far more entries than expected because nothing ever evicts cold keys under memory pressure in CacheStore.put() at src/store/cache.ts" },
  { kind: "unrelated", text: "a css grid layout collapses because an implicit row track resolves to zero height in Grid.layout() at src/ui/grid.ts" },
  { kind: "unrelated", text: "a shell pipeline truncates output because the reader closes the pipe before the writer finishes in pipe.sh" },
  { kind: "symbol-noise", text: "TypeError ECONNRESET FooBar.baz() src/a/b/c.ts v2 handler.ts ApiClient.fetch() lib/net/x.ts" },
  { kind: "symbol-noise", text: "NullPointerException at com.example.Service.handle in build/gen/Out.class line 42 thread-7" },
];

function buildDtos(): unknown[] {
  return FAMILIES.map((f) => ({
    schemaVersion: PATTERN_DTO_SCHEMA_VERSION,
    pattern: { situation: f.situation, mechanism: f.mechanism, unlock: f.unlock, verification: "re-run and confirm the class-specific symptom is gone" },
    scope: { language: "general" },
    signals: { tags: [f.id, f.anchor, "recurring-class", "query-compiler-eval"] },
    provenance: { sourceType: "import", sourceRef: `qc:${f.id}`, capturedAt: FROZEN_AT, captureVersion: "query-compiler-1" },
    metadata: { familyId: f.id, anchor: f.anchor, disclosure: "hand-authored recurring-class query-compiler eval; NOT organic" },
  }));
}

class SlowProvider implements RetrievalProvider {
  readonly name = "slow";
  readonly capabilities: RetrievalProviderCapabilities = { location: "local", payload: "sanitized-text", explicitOptIn: false };
  constructor(private readonly delayMs: number) {}
  retrieve(): Promise<RetrievalCandidate[] | null> {
    return new Promise((res) => setTimeout(() => res([]), this.delayMs));
  }
}
class RecordingRemoteProvider implements RetrievalProvider {
  readonly name = "recording-remote";
  readonly capabilities: RetrievalProviderCapabilities;
  engaged = false;
  constructor(optIn: boolean) {
    this.capabilities = { location: "remote", payload: "sanitized-text", explicitOptIn: optIn };
  }
  async retrieve(_intent: RetrievalIntent, _ctx: RetrievalContext): Promise<RetrievalCandidate[] | null> {
    this.engaged = true;
    return [];
  }
}

interface Arm { fired: number; correct: number; fpFired: number; semanticLaneFP: number }
function emptyArm(): Arm { return { fired: 0, correct: 0, fpFired: 0, semanticLaneFP: 0 }; }

export interface QueryCompilerEvalResult {
  label: string;
  corpusHash: string;
  acceptedFamilies: number;
  corpus: { families: number; usefulQueries: number; negatives: number };
  arms: {
    sparse: { recallAtUseful: number; precisionAtFire: number | null; fpRate: number };
    literal: { recallAtUseful: number; precisionAtFire: number | null; fpRate: number };
    causal: { recallAtUseful: number; precisionAtFire: number | null; fpRate: number; semanticLaneFP: number };
  };
  causalLift: { causalAddedDecisions: number; causalLaneInvoked: number; causalSemanticOnlyTotal: number; usefulConverted: string[] };
  latency: { incrementalP50: number; incrementalP95: number };
  probes: { providerTimeoutFailOpen: boolean; remoteEngagedWithoutOptIn: boolean };
  verdict: { causalAddsRecall: boolean; fpHeld: boolean; reshufflingOnly: boolean; rootCause?: string; note: string };
  organicReadiness: string;
}

export async function runQueryCompilerEval(): Promise<QueryCompilerEvalResult> {
  const dtos = buildDtos();
  const jsonl = dtos.map((d) => JSON.stringify(d)).join("\n");
  const corpusHash = createHash("sha256").update(jsonl).digest("hex").slice(0, 16);
  const store = new BlockStore(new Database(":memory:"));
  try {
    const summary = importPatternsFromJsonl(store, jsonl, { now: FROZEN_AT });
    const familyBlock = new Map<string, string>();
    summary.results.forEach((r, i) => { if (r.status === "accepted" && r.blockId) familyBlock.set(FAMILIES[i]!.id, r.blockId); });
    const acceptedFamilies = familyBlock.size;
    const gate = DEFAULT_GATE_THRESHOLD;
    const server = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: true, retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), queryCompilerMode: "shadow" });

    const evAfter = (qid: string): ReasoningQueryCompilerComparisonEvent | undefined =>
      (store.readEvents({}).filter((e) => e.event === "reasoning.query_compiler_comparison" && (e as ReasoningQueryCompilerComparisonEvent).queryId === qid)[0]) as ReasoningQueryCompilerComparisonEvent | undefined;

    const sparse = emptyArm();
    const literal = emptyArm();
    const causal = emptyArm();
    let causalAddedDecisions = 0;
    let causalLaneInvoked = 0;
    let causalSemanticOnlyTotal = 0;
    const usefulConverted: string[] = [];
    const lat: number[] = [];

    let i = 0;
    const score = (arm: Arm, action: string, top: string | undefined, expect: string | undefined, isUseful: boolean): void => {
      const fired = action === "inject";
      if (!fired) return;
      arm.fired++;
      if (isUseful && top === expect) arm.correct++;
      else if (!isUseful) arm.fpFired++;
    };

    for (const u of USEFUL) {
      const qid = `u${i++}`;
      await server.emitQueryCompilerComparison({ text: u.text }, qid);
      const e = evAfter(qid);
      if (!e) continue;
      const expect = familyBlock.get(u.family);
      score(sparse, e.sparseV4Action, e.sparseV4TopBlockId, expect, true);
      score(literal, e.literalV4Action, e.literalV4TopBlockId, expect, true);
      score(causal, e.causalV4Action, e.causalV4TopBlockId, expect, true);
      if (e.causalLaneInvoked) causalLaneInvoked++;
      causalSemanticOnlyTotal += e.causalSemanticOnly;
      lat.push(e.incrementalLatencyMs);
      if (e.causalAddedDecision && e.causalV4TopBlockId === expect) {
        causalAddedDecisions++;
        usefulConverted.push(`${u.family}/${u.kind}`);
      }
    }
    for (const n of NEGATIVES) {
      const qid = `n${i++}`;
      await server.emitQueryCompilerComparison({ text: n.text }, qid);
      const e = evAfter(qid);
      if (!e) continue;
      score(sparse, e.sparseV4Action, e.sparseV4TopBlockId, undefined, false);
      score(literal, e.literalV4Action, e.literalV4TopBlockId, undefined, false);
      score(causal, e.causalV4Action, e.causalV4TopBlockId, undefined, false);
      // A negative that the causal arm fired AND the literal arm did NOT is a
      // semantic-lane FP introduced by the causal lane.
      if (e.causalV4Action === "inject" && e.literalV4Action !== "inject") causal.semanticLaneFP++;
      causalSemanticOnlyTotal += e.causalSemanticOnly;
      lat.push(e.incrementalLatencyMs);
    }

    const nUseful = USEFUL.length;
    const nNeg = NEGATIVES.length;
    const round = (x: number) => Math.round(x * 1000) / 1000;
    const recall = (a: Arm) => round(a.correct / nUseful);
    const prec = (a: Arm) => (a.fired ? round(a.correct / a.fired) : null);
    const fp = (a: Arm) => round(a.fpFired / nNeg);
    const sortedLat = lat.slice().sort((x, y) => x - y);
    const pctile = (p: number) => (sortedLat.length ? sortedLat[Math.min(sortedLat.length - 1, Math.floor(p * sortedLat.length))]! : 0);

    // ── Probes ──
    const timeoutServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new SlowProvider(40), retrievalDeadlineMs: 1, queryCompilerMode: "shadow" });
    let providerTimeoutFailOpen = true;
    try {
      const s = await timeoutServer.emitQueryCompilerComparison({ text: USEFUL[0]!.text }, "timeoutprobe");
      // Fail-open: the call returns (no throw); the sparse FTS arm still decides.
      providerTimeoutFailOpen = s === undefined || typeof s.sparseAction === "string";
    } catch {
      providerTimeoutFailOpen = false;
    }
    const recRemote = new RecordingRemoteProvider(false);
    const remoteServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: recRemote, queryCompilerMode: "shadow" });
    await remoteServer.emitQueryCompilerComparison({ text: USEFUL[0]!.text }, "remoteprobe");
    const remoteEngagedWithoutOptIn = recRemote.engaged;

    // ── Verdict ──
    const causalAddsRecall = causalAddedDecisions > 0 && recall(causal) > recall(literal);
    const fpHeld = fp(causal) <= fp(literal) && fp(causal) <= fp(sparse);
    const reshufflingOnly = causalSemanticOnlyTotal === 0 || causalAddedDecisions === 0;
    let rootCause: string | undefined;
    if (!fpHeld) rootCause = `causal arm FP ${fp(causal)} exceeds literal/sparse — the causal lane surfaced a negative V4 then licensed; do NOT promote. Next: tighten the contrastive gate's competitor coverage, not the compiler.`;
    else if (reshufflingOnly) rootCause = "the causal lane added no semantic-only candidates / converted no decisions — it is token reshuffling here. Next mechanism-level fix: a learned/dense causal retriever (not in scope) or richer structured-invariant extraction.";
    else if (!causalAddsRecall) rootCause = "the causal lane surfaced candidates but V4's contrastive gate licensed none beyond the literal arm (conservatism). Next: revisit the 2-field corroboration requirement for prose-only matches.";

    return {
      label: "Phase D.1 two-view query-compiler eval — baseline / literal-hybrid / literal+causal, V4 over each. DISCLOSED hand-authored; NOT organic; no model/network; no tuning.",
      corpusHash,
      acceptedFamilies,
      corpus: { families: FAMILIES.length, usefulQueries: nUseful, negatives: nNeg },
      arms: {
        sparse: { recallAtUseful: recall(sparse), precisionAtFire: prec(sparse), fpRate: fp(sparse) },
        literal: { recallAtUseful: recall(literal), precisionAtFire: prec(literal), fpRate: fp(literal) },
        causal: { recallAtUseful: recall(causal), precisionAtFire: prec(causal), fpRate: fp(causal), semanticLaneFP: round(causal.semanticLaneFP / nNeg) },
      },
      causalLift: { causalAddedDecisions, causalLaneInvoked, causalSemanticOnlyTotal, usefulConverted },
      latency: { incrementalP50: pctile(0.5), incrementalP95: pctile(0.95) },
      probes: { providerTimeoutFailOpen, remoteEngagedWithoutOptIn },
      verdict: {
        causalAddsRecall,
        fpHeld,
        reshufflingOnly,
        ...(rootCause ? { rootCause } : {}),
        note: "`on` is forbidden by the rollout. This eval gauges promotion-readiness of the causal candidate lane; the policy is reported as-is and never weakened to hit a target.",
      },
      organicReadiness: "N/A — bootstrap/adversarial corpus only; never counts toward organic readiness",
    };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = await runQueryCompilerEval();
  writeFileSync(join(OUT_DIR, "eval.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\nPhase D.1 query-compiler eval — corpus ${out.corpusHash} (frozen)\n`);
  console.log("arm\trecall@useful\tprec@fire\tfp(neg)\tsemLaneFP");
  console.log(`sparse\t${out.arms.sparse.recallAtUseful}\t\t${out.arms.sparse.precisionAtFire}\t\t${out.arms.sparse.fpRate}\t-`);
  console.log(`literal\t${out.arms.literal.recallAtUseful}\t\t${out.arms.literal.precisionAtFire}\t\t${out.arms.literal.fpRate}\t-`);
  console.log(`causal\t${out.arms.causal.recallAtUseful}\t\t${out.arms.causal.precisionAtFire}\t\t${out.arms.causal.fpRate}\t${out.arms.causal.semanticLaneFP}`);
  const c = out.causalLift;
  console.log(`\ncausal lift: addedDecisions=${c.causalAddedDecisions} (converted: ${c.usefulConverted.join(", ") || "none"}); laneInvoked=${c.causalLaneInvoked}; semanticOnly candidates added=${c.causalSemanticOnlyTotal}`);
  console.log(`incremental latency p50/p95 (ms): ${out.latency.incrementalP50}/${out.latency.incrementalP95}`);
  console.log(`probes: providerTimeoutFailOpen=${out.probes.providerTimeoutFailOpen} remoteEngagedWithoutOptIn=${out.probes.remoteEngagedWithoutOptIn} (target false)`);
  console.log(`\nverdict: causalAddsRecall=${out.verdict.causalAddsRecall} fpHeld=${out.verdict.fpHeld} reshufflingOnly=${out.verdict.reshufflingOnly}`);
  if (out.verdict.rootCause) console.log(`root cause: ${out.verdict.rootCause}`);
  console.log(`organic readiness: N/A\n\nwrote ${join("bench-runs", "reasoning-reuse", "query-compiler", "eval.json")}`);
}

if (!process.env.VITEST) void main();
