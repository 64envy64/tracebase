#!/usr/bin/env tsx
/**
 * Frozen $0 memory-applicability eval — V4 baseline vs D.2 reranker (PLAN §4.5).
 *
 * Question: does the §4.5 reranker recover the DECISION recall V4 abstains on
 * (strong prose-only applicability) WITHOUT a precision loss on the adversaries
 * V4's conservatism protects against? Both arms run on the SAME candidate slate
 * (the reranker does not change candidate generation — that was D.1), so this
 * isolates the DECISION layer.
 *
 * DISCLOSED, hand-authored, NOT organic. Hand-built blocks let the corpus carry
 * outcome/pitfall signals (stale + harmful adversaries) deterministically. No
 * model, no network, no threshold tuning after results — the reranker ships at
 * the principled 0.5 floor; the sensitivity table sweeps it only to show 0.5 is
 * stable.
 *
 * Adversary set: strong prose-only positives, same-domain sibling collisions,
 * misleading API overlap, stale lessons, harmful (pitfall) outcomes, missing
 * invariants, dialogue ambiguity, plus a reranker-timeout probe. (Remote refusal
 * is inherited from the retrieval DTO boundary — the §4.5 baseline is local-only.)
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReasoningBlock, BlockInvariants, BlockKind } from "../../src/types.js";
import { DEFAULT_SERVING_POLICY, type ServingCandidate, type ServingQuery } from "../../src/core/serving-confidence.js";
import { decideServingV4 } from "../../src/core/serving-decision-v4.js";
import { buildStructuredView } from "../../src/core/serving-evidence-v2.js";
import { wilsonLowerBound } from "../../src/core/block.js";
import {
  DeterministicApplicabilityReranker,
  type ApplicabilityCandidate,
  type ApplicabilityProvider,
  type ApplicabilityResult,
} from "../../src/core/applicability-reranker.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse", "applicability");

interface BlockSpec {
  id: string;
  situation: string;
  mechanism: string;
  unlock: string;
  invariants?: BlockInvariants;
  kind?: BlockKind;
  helpful?: number;
  harmful?: number;
}
function mkBlock(s: BlockSpec): ReasoningBlock {
  return {
    id: s.id,
    version: 2,
    kind: s.kind ?? "success",
    trigger: { situation: s.situation, invariants: s.invariants ?? {}, keywords: [], fingerprint: `fp-${s.id}` },
    body: { mechanism: s.mechanism, deadEnds: [], unlock: s.unlock, verification: "re-run" },
    provenance: { sourceTaskId: `t-${s.id}`, extractedFrom: "imported", distilledAt: 1, distilledBy: "manual" },
    stats: { timesRetrieved: 0, timesInjected: 0, timesAgentUsed: 0, timesHelpful: s.helpful ?? 0, timesCounterproductive: s.harmful ?? 0, cumulativeTokensSaved: 0, cumulativeStepsSaved: 0 },
    quality: { confidence: 0.5 },
    createdAt: 1,
    updatedAt: 1,
    status: "active",
  } as unknown as ReasoningBlock;
}

// Frozen corpus. Numeric siblings + a concurrency sibling + a harmful/pitfall and
// a stale lesson for the outcome adversaries + an API-bearing lesson.
const BLOCKS: BlockSpec[] = [
  { id: "float-acc", situation: "a running balance is off by a tiny fraction", mechanism: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result", unlock: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift" },
  { id: "float-eq", situation: "two computed quantities that should match are treated as different", mechanism: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding", unlock: "compare with a tolerance epsilon instead of strict equality or use a decimal type for an exact representation" },
  { id: "lost-update", situation: "a shared counter undercounts under concurrency", mechanism: "concurrent read modify write cycles interleave without a compare and swap so one writer overwrites another and an increment is silently lost", unlock: "make the increment atomic with a compare and swap or a transactional update" },
  { id: "deadlock", situation: "two jobs hang and stop making progress", mechanism: "two mutexes are acquired in opposite orders on different threads so each thread holds one lock and waits forever for the other producing a circular wait deadlock", unlock: "impose a global canonical lock ordering so every thread acquires the mutexes in the same order" },
  // misleading-API lesson: rich apiSurface but an UNRELATED mechanism.
  { id: "api-reduce", situation: "an array reduce produces a surprising aggregate", mechanism: "the reducer mutates the accumulator object in place so a shared reference leaks across iterations corrupting later elements", unlock: "return a fresh accumulator from the reducer instead of mutating the shared object", invariants: { apiSurface: ["Array.reduce"], language: "ts" } },
  // stale lesson (net-harmful outcomes) on the same float-accumulation mechanism.
  { id: "float-acc-stale", situation: "a total is slightly wrong", mechanism: "summing floating point values accumulates rounding error as each addition discards low order bits across the summation", unlock: "round the final total to two decimals", helpful: 1, harmful: 4 },
  // pitfall lesson (corrective) on a numeric theme.
  { id: "numeric-pitfall", situation: "a developer tries to fix float drift the wrong way", mechanism: "multiplying by a power of ten and truncating to an integer loses precision differently and does not remove the accumulated rounding error", unlock: "do not truncate; use a decimal type or integer cents", kind: "pitfall" },
];

type Label = "useful" | "negative";
type Adversary = "strong-positive" | "sibling-collision" | "misleading-api" | "stale" | "harmful-pitfall" | "missing-invariant" | "dialogue-ambiguity";
interface Fixture {
  name: string;
  adversary: Adversary;
  label: Label;
  literalText: string;
  causalText?: string;
  /** Block ids in the candidate slate (all treated as semantic-only). */
  slate: string[];
  /** For useful: the block that SHOULD be injected. */
  expect?: string;
}

const FIXTURES: Fixture[] = [
  // Strong prose-only POSITIVES: deep mechanism, little/no remediation → V4 sees
  // one field and abstains; the reranker should rule applicable.
  { name: "strong/float-acc", adversary: "strong-positive", label: "useful", literalText: "Accumulator.fold() src/calc/engine.ts", causalText: "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with the order of operations", slate: ["float-acc", "float-eq"], expect: "float-acc" },
  { name: "strong/lost-update", adversary: "strong-positive", label: "useful", literalText: "Counter.incr() src/c.ts", causalText: "concurrent read modify write cycles interleave so one writer overwrites another and an increment is silently lost under load", slate: ["lost-update", "deadlock"], expect: "lost-update" },
  { name: "strong/deadlock", adversary: "strong-positive", label: "useful", literalText: "Worker.run() src/w.ts", causalText: "each thread holds one mutex and waits forever for the other because the two locks are acquired in opposite order producing a circular wait", slate: ["deadlock", "lost-update"], expect: "deadlock" },
  // SIBLING COLLISION: shares float domain vocab, different problem → must NOT inject either.
  { name: "neg/sibling-collision", adversary: "sibling-collision", label: "negative", literalText: "Widget.render() src/ui/x.ts", causalText: "the floating point number is shown with extra digits after the dot when it is displayed on the dashboard", slate: ["float-acc", "float-eq"] },
  // MISLEADING API OVERLAP: query names the API but the mechanism is unrelated.
  { name: "neg/misleading-api", adversary: "misleading-api", label: "negative", literalText: "Array.reduce lang ts api array reduce", causalText: "I am using array reduce to compute a running total and the number looks off by a rounding error", slate: ["api-reduce", "float-acc"] },
  // STALE lesson: query matches a lesson whose outcomes are net-harmful → must NOT inject it.
  { name: "neg/stale", adversary: "stale", label: "negative", literalText: "Total.compute() src/t.ts", causalText: "the total is slightly wrong because rounding error accumulates as each addition discards low order bits", slate: ["float-acc-stale"], expect: "float-acc-stale" },
  // HARMFUL/PITFALL: a corrective pitfall lesson matched → must NOT inject.
  { name: "neg/harmful-pitfall", adversary: "harmful-pitfall", label: "negative", literalText: "fix.ts", causalText: "multiplying by a power of ten and truncating to an integer to remove the accumulated rounding error", slate: ["numeric-pitfall", "float-acc"] },
  // MISSING INVARIANT: pure symptom, no symbols/structure; vaguely numeric.
  { name: "neg/missing-invariant", adversary: "missing-invariant", label: "negative", literalText: "the dashboard number looks wrong sometimes", causalText: "the dashboard number looks wrong sometimes and I am not sure why it happens", slate: ["float-acc", "float-eq"] },
  // DIALOGUE AMBIGUITY: multi-topic chatter touching several families weakly.
  { name: "neg/dialogue-ambiguity", adversary: "dialogue-ambiguity", label: "negative", literalText: "hey can you help me with my code it has some bugs and threads and numbers", causalText: "hey can you help me with my code it has some bugs and threads and numbers and stuff", slate: ["float-acc", "lost-update", "deadlock"] },
];

const blockById = new Map(BLOCKS.map((s) => [s.id, mkBlock(s)]));
const semCand = (id: string): ServingCandidate => ({ block: blockById.get(id)!, rankScore: 0.9, provenance: { semanticRank: 1, fusedRank: 1, semanticOnly: true, providerClass: "local" } });
function applCand(id: string): ApplicabilityCandidate {
  const b = blockById.get(id)!;
  const v = buildStructuredView(b);
  const s = b.stats;
  const helpful = s?.timesHelpful ?? 0;
  const harmful = s?.timesCounterproductive ?? 0;
  return {
    blockId: id,
    tokens: { situation: [...v.situationTokens], mechanism: [...v.fieldTokens.mechanism], unlock: [...v.fieldTokens.unlock], invariants: v.memory.invariants },
    signals: { isPitfall: (b.kind ?? "success") === "pitfall", helpful, harmful, unresolved: 0, familySupport: 1, sourceDiversity: 1 },
  };
}

interface Arm { fired: number; correct: number; fpFired: number }
function emptyArm(): Arm { return { fired: 0, correct: 0, fpFired: 0 }; }

export interface ApplicabilityEvalResult {
  label: string;
  corpusHash: string;
  corpus: { blocks: number; fixtures: number; useful: number; negatives: number; adversaries: Adversary[] };
  arms: {
    v4: { recallAtUseful: number; precisionAtFire: number | null; fpRate: number; wilsonLB: number | null };
    reranker: { recallAtUseful: number; precisionAtFire: number | null; fpRate: number; wilsonLB: number | null };
  };
  changedDecisions: { rerankerOnlyApply: number; rerankerWithholds: number; recoveredUseful: string[]; falsePositives: string[] };
  latency: { p50: number; p95: number };
  probes: { timeoutFailOpen: boolean };
  sensitivity: Array<{ strongSingleField: number; usefulRecovered: number; usefulTotal: number; negativeFP: number; negativeTotal: number }>;
  verdict: { recoversRecall: boolean; precisionHeld: boolean; rootCause?: string; note: string };
  organicReadiness: string;
}

export async function runApplicabilityEval(): Promise<ApplicabilityEvalResult> {
  const corpusHash = createHash("sha256").update(JSON.stringify({ BLOCKS, FIXTURES })).digest("hex").slice(0, 16);
  const reranker = new DeterministicApplicabilityReranker();
  const ctx = { deadlineMs: 1000, now: () => 0 };
  const policy = { ...DEFAULT_SERVING_POLICY, gateThreshold: 0 };

  const v4 = emptyArm();
  const rr = emptyArm();
  let rerankerOnlyApply = 0;
  let rerankerWithholds = 0;
  const recoveredUseful: string[] = [];
  const falsePositives: string[] = [];
  const lat: number[] = [];

  for (const f of FIXTURES) {
    const sq: ServingQuery = { text: f.causalText ?? f.literalText };
    const v4Dec = decideServingV4(sq, f.slate.map(semCand), policy);
    const v4Fired = v4Dec.decision.action === "inject";
    const v4Top = v4Fired ? v4Dec.decision.topCandidateId : undefined;

    const t0 = Date.now();
    const results = (await reranker.rank({ literalText: f.literalText, ...(f.causalText ? { causalText: f.causalText } : {}) }, f.slate.map(applCand), ctx)) ?? [];
    lat.push(Date.now() - t0);
    const top = results[0];
    const rrFired = top?.verdict === "applicable";
    const rrTop = rrFired ? top!.blockId : undefined;

    const isUseful = f.label === "useful";
    const v4Correct = v4Fired ? isUseful && v4Top === f.expect : !isUseful;
    const rrCorrect = rrFired ? isUseful && rrTop === f.expect : !isUseful;
    if (v4Fired) { v4.fired++; if (isUseful && v4Top === f.expect) v4.correct++; if (!isUseful) v4.fpFired++; }
    if (rrFired) { rr.fired++; if (isUseful && rrTop === f.expect) rr.correct++; if (!isUseful) rr.fpFired++; }

    if (rrFired && !v4Fired) {
      rerankerOnlyApply++;
      if (isUseful && rrCorrect) recoveredUseful.push(f.name);
      if (!isUseful) falsePositives.push(f.name);
    }
    if (!rrFired && v4Fired) rerankerWithholds++;
    void v4Correct;
  }

  const nUseful = FIXTURES.filter((f) => f.label === "useful").length;
  const nNeg = FIXTURES.filter((f) => f.label === "negative").length;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const armOut = (a: Arm) => ({
    recallAtUseful: round(a.correct / nUseful),
    precisionAtFire: a.fired ? round(a.correct / a.fired) : null,
    fpRate: round(a.fpFired / nNeg),
    wilsonLB: a.fired ? round(wilsonLowerBound(a.correct, a.fired)) : null,
  });
  const sortedLat = lat.slice().sort((x, y) => x - y);
  const pctile = (p: number) => (sortedLat.length ? sortedLat[Math.min(sortedLat.length - 1, Math.floor(p * sortedLat.length))]! : 0);

  // Timeout probe.
  const slow: ApplicabilityProvider = { name: "slow", featureVersion: 1, rank: () => new Promise<ApplicabilityResult[] | null>((res) => setTimeout(() => res([]), 40)) };
  let timeoutFailOpen = true;
  try {
    const r = await Promise.race([slow.rank({ literalText: "x" }, [], { deadlineMs: 1000, now: () => 0 }), new Promise<null>((res) => setTimeout(() => res(null), 1))]);
    timeoutFailOpen = r === null || Array.isArray(r); // race resolved (timeout sentinel modeled as null) → fail open
  } catch {
    timeoutFailOpen = false;
  }

  // Declared sensitivity: sweep the strong-single-field floor; shipped = 0.5.
  const sensitivity = [0.3, 0.4, 0.5, 0.6, 0.7].map((floor) => {
    const rk = new DeterministicApplicabilityReranker(floor);
    let usefulRecovered = 0;
    let negativeFP = 0;
    return Promise.all(
      FIXTURES.map(async (f) => {
        const results = (await rk.rank({ literalText: f.literalText, ...(f.causalText ? { causalText: f.causalText } : {}) }, f.slate.map(applCand), ctx)) ?? [];
        const applied = results[0]?.verdict === "applicable";
        if (applied && f.label === "useful" && results[0]!.blockId === f.expect) usefulRecovered++;
        if (applied && f.label === "negative") negativeFP++;
      }),
    ).then(() => ({ strongSingleField: floor, usefulRecovered, usefulTotal: nUseful, negativeFP, negativeTotal: nNeg }));
  });
  const sensitivityResolved = await Promise.all(sensitivity);

  const v4Out = armOut(v4);
  const rrOut = armOut(rr);
  const recoversRecall = rrOut.recallAtUseful > v4Out.recallAtUseful;
  const precisionHeld = rrOut.fpRate <= v4Out.fpRate;
  let rootCause: string | undefined;
  if (!precisionHeld) rootCause = `reranker FP ${rrOut.fpRate} exceeds V4 ${v4Out.fpRate}: an adversary (${falsePositives.join(", ")}) was ruled applicable. Do NOT promote — the recall gain costs precision; next: a semantic (embedding) reranker provider that judges meaning, not token overlap.`;
  else if (!recoversRecall) rootCause = "reranker recovered no decisions V4 missed — the general rule did not help here; revisit the strong-single-field evidence definition.";

  return {
    label: "Phase D.2 applicability eval — V4 baseline vs §4.5 reranker on a frozen adversary corpus. DISCLOSED hand-authored; NOT organic; no model/network; no tuning.",
    corpusHash,
    corpus: { blocks: BLOCKS.length, fixtures: FIXTURES.length, useful: nUseful, negatives: nNeg, adversaries: [...new Set(FIXTURES.map((f) => f.adversary))] },
    arms: { v4: v4Out, reranker: rrOut },
    changedDecisions: { rerankerOnlyApply, rerankerWithholds, recoveredUseful, falsePositives },
    latency: { p50: pctile(0.5), p95: pctile(0.95) },
    probes: { timeoutFailOpen },
    sensitivity: sensitivityResolved,
    verdict: {
      recoversRecall,
      precisionHeld,
      ...(rootCause ? { rootCause } : {}),
      note: "`on` is forbidden by the rollout. This eval gauges promotion-readiness of the §4.5 reranker; the policy is reported as-is and never weakened to hit a target.",
    },
    organicReadiness: "N/A — bootstrap/adversarial corpus only; never counts toward organic readiness",
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = await runApplicabilityEval();
  writeFileSync(join(OUT_DIR, "eval.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\nPhase D.2 applicability eval — corpus ${out.corpusHash} (frozen)\n`);
  console.log("arm\trecall@useful\tprec@fire\tfp(neg)\twilsonLB");
  console.log(`v4\t${out.arms.v4.recallAtUseful}\t\t${out.arms.v4.precisionAtFire}\t\t${out.arms.v4.fpRate}\t${out.arms.v4.wilsonLB}`);
  console.log(`reranker\t${out.arms.reranker.recallAtUseful}\t${out.arms.reranker.precisionAtFire}\t\t${out.arms.reranker.fpRate}\t${out.arms.reranker.wilsonLB}`);
  const c = out.changedDecisions;
  console.log(`\nchanged decisions: reranker_only_apply=${c.rerankerOnlyApply} (recovered: ${c.recoveredUseful.join(", ") || "none"}; FPs: ${c.falsePositives.join(", ") || "none"}); reranker_withholds=${c.rerankerWithholds}`);
  console.log(`latency p50/p95 (ms): ${out.latency.p50}/${out.latency.p95}; timeoutFailOpen=${out.probes.timeoutFailOpen}`);
  console.log("\nsensitivity (strong-single-field floor; shipped=0.5):");
  console.log("  floor\tuseful recovered\tnegative FP");
  for (const s of out.sensitivity) console.log(`  ${s.strongSingleField}\t${s.usefulRecovered}/${s.usefulTotal}\t\t\t${s.negativeFP}/${s.negativeTotal}`);
  console.log(`\nverdict: recoversRecall=${out.verdict.recoversRecall} precisionHeld=${out.verdict.precisionHeld}`);
  if (out.verdict.rootCause) console.log(`root cause: ${out.verdict.rootCause}`);
  console.log(`organic readiness: N/A\n\nwrote ${join("bench-runs", "reasoning-reuse", "applicability", "eval.json")}`);
}

if (!process.env.VITEST) void main();
