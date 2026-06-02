#!/usr/bin/env tsx
/**
 * Frozen $0 adversarial eval — baseline V2 vs V3-shadow vs V4-shadow (Phase C.3).
 *
 * Phase C.2 proved V3's absolute ≥2-field semantic license leaks on a same-domain
 * sibling collision (float display-rounding licensed against float-ACCUMULATION).
 * V4 adds a CONTRASTIVE gate: a semantic-only candidate licenses only when the
 * MAJORITY of its corroborating body tokens discriminate it from the strongest
 * competing sibling/family. This eval measures whether V4 closes that leak while
 * retaining a MATERIAL recall lift over V2, against an expanded adversary set.
 *
 * DISCLOSED, hand-authored, NOT organic. A NEW frozen corpus (prior eval corpora
 * untouched) whose domains carry SAME-DOMAIN SIBLINGS (concurrency: deadlock vs
 * lost-update; numeric: accumulation vs equality; caching: stampede vs staleness)
 * so the contrastive gap has a real competitor. No model, no network. Constants
 * are NOT tuned after seeing results — the V4 majority floor is the shipped 0.5;
 * the sensitivity table below sweeps it ONLY to show 0.5 sits in a stable region.
 *
 * Adversaries: correct paraphrases (discriminative); same-domain sibling
 * collisions; lexically-rich wrong candidates; ambiguous-sibling queries;
 * disjoint negatives; plus probes for rank inversion, missing sibling, provider
 * timeout, and remote-DTO refusal.
 *
 * Targets: V4 semantic-lane FP ≤ 0.05 AND a material recall lift over V2
 * (≥ +0.15 absolute, retaining ≥ 70% of V3's recall). If unmet, the verdict
 * reports the root cause; the policy is NOT weakened. Organic readiness is N/A.
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import type { RecallV2Result } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import { wilsonLowerBound } from "../../src/core/block.js";
import { DEFAULT_SERVING_POLICY, DEFAULT_GATE_THRESHOLD, type ServingCandidate, type ServingQuery } from "../../src/core/serving-confidence.js";
import { decideServingV4 } from "../../src/core/serving-decision-v4.js";
import type { ReasoningBlock } from "../../src/types.js";
import type {
  RetrievalProvider,
  RetrievalProviderCapabilities,
  RetrievalIntent,
  RetrievalContext,
  RetrievalCandidate,
  RetrievalDocument,
} from "../../src/core/retrieval-provider.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse", "adversarial-v4");
const FROZEN_AT = 1780262013;

// ---------------------------------------------------------------------------
// Frozen corpus — NEW. Each anchor has TWO same-domain siblings so the
// contrastive gap has a real competitor (the C.2 leak had none).
// ---------------------------------------------------------------------------
interface Family {
  id: string;
  anchor: string;
  situation: string;
  mechanism: string;
  unlock: string;
  paraphrases: string[]; // body-phrased holdouts (trigger words deliberately absent)
}

const FAMILIES: Family[] = [
  {
    id: "lock-order-deadlock",
    anchor: "concurrency",
    situation: "two background jobs occasionally hang and stop making progress",
    mechanism: "two mutexes are acquired in opposite orders on different threads so each thread holds one lock and waits forever for the other producing a circular wait deadlock",
    unlock: "impose a global canonical lock ordering so every thread acquires the two mutexes in the same order which breaks the circular wait",
    paraphrases: [
      "two threads each hold one mutex and block forever waiting for the other because the locks are taken in opposite order",
      "a circular wait develops between threads when two locks are acquired in inconsistent order so neither can proceed",
    ],
  },
  {
    id: "lost-update-race",
    anchor: "concurrency",
    situation: "a shared counter occasionally undercounts when many workers update it",
    mechanism: "concurrent read modify write cycles interleave without a compare and swap so one writer overwrites another and an increment is silently lost",
    unlock: "make the increment atomic with a compare and swap or a transactional update so no concurrent write is overwritten",
    paraphrases: [
      "a read modify write interleaves with another writer and one increment overwrites the other so the update is lost",
      "concurrent writers clobber each other because the increment is not atomic and there is no compare and swap",
    ],
  },
  {
    id: "float-accumulation",
    anchor: "numeric",
    situation: "a running total disagrees with the expected sum by a tiny amount",
    mechanism: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result",
    unlock: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift",
    paraphrases: [
      "rounding error accumulates across a long floating point summation so the order of additions changes the result",
      "adding many floating point numbers drifts from the true total because each addition discards the low order bits",
    ],
  },
  {
    id: "float-equality",
    anchor: "numeric",
    situation: "two values that should be equal are treated as different",
    mechanism: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding",
    unlock: "compare with a tolerance epsilon instead of strict equality or use a decimal type for an exact representation",
    paraphrases: [
      "two numbers that should match compare as unequal because the floating point representation differs after rounding",
      "a strict equality check on computed floats fails since the same value has several bit representations",
    ],
  },
  {
    id: "cache-stampede",
    anchor: "caching",
    situation: "the origin database is hammered right after a popular entry expires",
    mechanism: "when a hot key expires many requests miss simultaneously and all recompute the same value at once stampeding the origin because there is no single flight lock",
    unlock: "serialize recomputation with a single flight lock or early recompute so only one request rebuilds the expired hot key",
    paraphrases: [
      "many concurrent misses all rebuild the same expired hot key at once and overwhelm the origin with no single flight guard",
      "a thundering herd recomputes one popular key simultaneously because nothing serializes the rebuild",
    ],
  },
  {
    id: "cache-staleness",
    anchor: "caching",
    situation: "users keep seeing outdated data after it should have changed",
    mechanism: "a write updates the database but the cached copy is never invalidated so reads keep returning the previous value until the entry expires on its own",
    unlock: "invalidate or update the cached entry on write so reads never serve a value older than the last write",
    paraphrases: [
      "reads keep returning the previous value after a write because the cached entry was never invalidated",
      "stale data is served because a write updates the store but does not invalidate the cached copy",
    ],
  },
];

type NegType = "sibling-collision" | "lexically-rich-wrong" | "ambiguous-sibling" | "disjoint";

interface Negative {
  negType: NegType;
  against?: string;
  text: string;
}

// Hard negatives — FAIR: a competent reviewer agrees the system should abstain.
const NEGATIVES: Negative[] = [
  // same-domain sibling collision: shares a domain's surface vocabulary, but is a
  // DIFFERENT problem than either sibling → V3 leaks, V4 must abstain.
  { negType: "sibling-collision", against: "numeric", text: "a slider snaps to coarse steps because the floating point value is rounded to one decimal place purely for display" },
  { negType: "sibling-collision", against: "caching", text: "the cache holds far more entries than expected because nothing ever evicts cold keys under memory pressure" },
  // lexically-rich wrong: rich BODY-vocabulary overlap, different root cause.
  { negType: "lexically-rich-wrong", against: "float-accumulation", text: "an audit log accumulates millions of rows because each request appends an entry and nothing ever compacts the old ones" },
  { negType: "lexically-rich-wrong", against: "lost-update-race", text: "a configuration value is read once at startup and then overwritten in memory by a later reload so the original is lost" },
  // ambiguous-sibling: genuinely ambiguous between the two siblings → abstain.
  { negType: "ambiguous-sibling", against: "concurrency", text: "two worker threads contend over shared state under load and the result is occasionally wrong" },
  { negType: "ambiguous-sibling", against: "numeric", text: "a numeric computation gives slightly different results than expected from one run to the next" },
  // disjoint: unrelated.
  { negType: "disjoint", text: "a css grid layout collapses because an implicit row track resolves to zero height" },
  { negType: "disjoint", text: "a shell pipeline silently truncates output because the reader closes the pipe before the writer finishes" },
];

function buildDtos(): unknown[] {
  return FAMILIES.map((f) => ({
    schemaVersion: PATTERN_DTO_SCHEMA_VERSION,
    pattern: { situation: f.situation, mechanism: f.mechanism, unlock: f.unlock, verification: "re-run the failing scenario and confirm the class-specific symptom is gone" },
    scope: { language: "general" },
    signals: { tags: [f.id, f.anchor, "recurring-class", "adversarial-v4-eval"] },
    provenance: { sourceType: "import", sourceRef: `adv-v4:${f.id}`, capturedAt: FROZEN_AT, captureVersion: "adversarial-v4-1" },
    metadata: { familyId: f.id, anchor: f.anchor, disclosure: "hand-authored recurring-class adversarial eval; NOT organic, NOT public-mined" },
  }));
}

// ---------------------------------------------------------------------------
// Adversarial providers (same privacy-hardened contract).
// ---------------------------------------------------------------------------
class DecoyRankingProvider implements RetrievalProvider {
  readonly name = "decoy-ranking";
  readonly capabilities: RetrievalProviderCapabilities = { location: "local", payload: "sanitized-text", explicitOptIn: false };
  private readonly inner = new DeterministicLocalProvider();
  constructor(private readonly decoyId: string) {}
  async retrieve(intent: RetrievalIntent, ctx: RetrievalContext): Promise<RetrievalCandidate[] | null> {
    const baseList = (await this.inner.retrieve(intent, ctx)) ?? [];
    const maxScore = baseList.reduce((m, c) => Math.max(m, c.score), 0);
    return [{ blockId: this.decoyId, score: maxScore + 1 }, ...baseList.filter((c) => c.blockId !== this.decoyId)];
  }
}
class SlowProvider implements RetrievalProvider {
  readonly name = "slow";
  readonly capabilities: RetrievalProviderCapabilities = { location: "local", payload: "sanitized-text", explicitOptIn: false };
  constructor(private readonly delayMs: number) {}
  retrieve(): Promise<RetrievalCandidate[] | null> {
    return new Promise<RetrievalCandidate[] | null>((res) => setTimeout(() => res([]), this.delayMs));
  }
}
class RecordingRemoteProvider implements RetrievalProvider {
  readonly name = "recording-remote";
  readonly capabilities: RetrievalProviderCapabilities;
  readonly captured: { intents: RetrievalIntent[]; docBatches: RetrievalDocument[][] } = { intents: [], docBatches: [] };
  constructor(optIn: boolean) {
    this.capabilities = { location: "remote", payload: "sanitized-text", explicitOptIn: optIn };
  }
  async retrieve(intent: RetrievalIntent, ctx: RetrievalContext): Promise<RetrievalCandidate[] | null> {
    this.captured.intents.push(intent);
    this.captured.docBatches.push([...ctx.documents]);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
interface LabeledQuery {
  text: string;
  label: "useful" | "negative";
  negType?: NegType;
  expectBlockId?: string;
}
type Arm = "sparse-v2" | "hybrid-v3-shadow" | "hybrid-v4-shadow";
interface ArmRow {
  fired: boolean;
  injectedId?: string;
  inSlate: boolean;
  correct: boolean;
  latencyMs: number;
  lane?: string;
}

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
  const fpByType: Record<string, { fired: number; total: number }> = {};
  rows.forEach((r, i) => {
    const q = queries[i]!;
    if (q.label !== "negative") return;
    const t = q.negType ?? "disjoint";
    (fpByType[t] ??= { fired: 0, total: 0 }).total++;
    if (r.fired) fpByType[t]!.fired++;
  });
  const semanticLaneFP = negs.filter((r) => r.fired && r.lane === "semantic-license").length;
  return {
    candidateRecallAtUseful: round(useful.length ? usefulInSlate / useful.length : null),
    recallAtUseful: round(useful.length ? usefulInjected / useful.length : null),
    precisionAtFire: round(fired.length ? correctFires / fired.length : null),
    wilsonLB: round(fired.length ? wilsonLowerBound(correctFires, fired.length) : null),
    falsePositiveRateNegatives: round(negs.length ? negFired / negs.length : null),
    fpByType,
    semanticLicenseLaneFP: round(negs.length ? semanticLaneFP / negs.length : null),
    fireRate: round(rows.length ? fired.length / rows.length : 0),
    latencyMsP50: pctile(0.5),
    latencyMsP95: pctile(0.95),
  };
}

export interface AdversarialV4EvalResult {
  label: string;
  corpusHash: string;
  frozenAt: number;
  acceptedFamilies: number;
  corpus: { families: number; anchors: number; paraphraseHoldouts: number; hardNegatives: number; negativeTypes: NegType[] };
  arms: Record<Arm, ReturnType<typeof metrics>>;
  /** V3→V4 deltas: leaks V4 closed and the recall it cost. */
  contrastive: { v3FiredV4AbstainedNeg: number; v3FiredV4AbstainedUseful: number; v4RecallRetainedVsV3: number | null };
  probes: {
    rankInversion: { decoyBlock: string; trials: number; decoyInjectionsV4: number };
    providerTimeout: { trials: number; failOpenParityWithSparse: boolean };
    remoteBoundary: { engagedWithOptIn: boolean; boundaryClean: boolean; engagedWithoutOptIn: boolean; scrubbed: string[] };
    missingSibling: { v3Action: string; v4Action: string; v4LicenseReason: string };
  };
  /** Declared sensitivity of V4 to the discriminative-support floor (shipped = 0.5). */
  sensitivity: Array<{ discriminativeSupportMin: number; usefulLicensed: number; usefulTotal: number; collisionLicensed: number; collisionTotal: number }>;
  targets: { semanticLaneFpCeiling: number; materialRecallLift: number; v3RecallRetentionFloor: number; v4SemanticLaneFpMet: boolean; v4MaterialLiftMet: boolean; v4RetainsV3RecallMet: boolean; allMet: boolean };
  verdict: { closesLeak: boolean; retainsRecall: boolean; rootCause?: string; note: string };
  organicReadiness: string;
}

/** Pure, deterministic runner. */
export async function runAdversarialV4Eval(): Promise<AdversarialV4EvalResult> {
  const dtos = buildDtos();
  const jsonl = dtos.map((d) => JSON.stringify(d)).join("\n");
  const corpusHash = createHash("sha256").update(jsonl).digest("hex").slice(0, 16);

  const store = new BlockStore(new Database(":memory:"));
  try {
    const summary = importPatternsFromJsonl(store, jsonl, { now: FROZEN_AT });
    const familyBlock = new Map<string, string>();
    summary.results.forEach((r, i) => {
      if (r.status === "accepted" && r.blockId) familyBlock.set(FAMILIES[i]!.id, r.blockId);
    });
    const acceptedFamilies = familyBlock.size;

    const queries: LabeledQuery[] = [];
    for (const f of FAMILIES) {
      const bid = familyBlock.get(f.id);
      if (!bid) continue;
      for (const p of f.paraphrases) queries.push({ text: p, label: "useful", expectBlockId: bid });
    }
    for (const n of NEGATIVES) queries.push({ text: n.text, label: "negative", negType: n.negType });

    const gate = DEFAULT_GATE_THRESHOLD;
    const sparseServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false });
    const shadowServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), evidenceMode: "shadow" });

    const v2InjectedId = (r: RecallV2Result): string | undefined => (r.shouldInject ? r.blocks.find((h) => h.passesGate)?.block.id : undefined);
    const inSlate = (q: LabeledQuery, r: RecallV2Result): boolean => (q.expectBlockId ? r.blocks.some((h) => h.block.id === q.expectBlockId) : false);
    const judge = (q: LabeledQuery, fired: boolean, id: string | undefined): boolean => (fired ? q.label === "useful" && id === q.expectBlockId : q.label !== "useful");

    const sparseRows: ArmRow[] = [];
    const v3Rows: ArmRow[] = [];
    const v4Rows: ArmRow[] = [];
    let v3FiredV4AbstainedNeg = 0;
    let v3FiredV4AbstainedUseful = 0;
    let v3Recall = 0;
    let v4RecallRetained = 0;

    for (const q of queries) {
      const t0 = Date.now();
      const s = sparseServer.recall({ text: q.text });
      const ls = Date.now() - t0;
      const t1 = Date.now();
      const r = await shadowServer.recallHybrid({ text: q.text });
      const lh = Date.now() - t1;

      const sId = v2InjectedId(s);
      sparseRows.push({ fired: s.shouldInject, ...(sId ? { injectedId: sId } : {}), inSlate: inSlate(q, s), correct: judge(q, s.shouldInject, sId), latencyMs: ls, lane: "lexical" });

      const v3 = r.shadowV3;
      const v3Fired = v3 ? v3.action === "inject" : r.shouldInject;
      const v3Id = v3 ? (v3.action === "inject" ? v3.topBlockId : undefined) : v2InjectedId(r);
      v3Rows.push({ fired: v3Fired, ...(v3Id ? { injectedId: v3Id } : {}), inSlate: inSlate(q, r), correct: judge(q, v3Fired, v3Id), latencyMs: lh, lane: v3?.lane ?? "lexical" });

      const v4 = r.shadowV4;
      const v4Fired = v4 ? v4.action === "inject" : r.shouldInject;
      const v4Id = v4 ? (v4.action === "inject" ? v4.topBlockId : undefined) : v2InjectedId(r);
      v4Rows.push({ fired: v4Fired, ...(v4Id ? { injectedId: v4Id } : {}), inSlate: inSlate(q, r), correct: judge(q, v4Fired, v4Id), latencyMs: lh, lane: v4?.lane ?? "lexical" });

      // V3→V4 deltas.
      const v3Correct = judge(q, v3Fired, v3Id);
      const v4Correct = judge(q, v4Fired, v4Id);
      if (q.label === "useful" && v3Fired && v3Correct) {
        v3Recall++;
        if (v4Fired && v4Correct) v4RecallRetained++;
        else v3FiredV4AbstainedUseful++;
      }
      if (q.label === "negative" && v3Fired && !v4Fired) v3FiredV4AbstainedNeg++;
    }

    const arms: Record<Arm, ReturnType<typeof metrics>> = {
      "sparse-v2": metrics(sparseRows, queries),
      "hybrid-v3-shadow": metrics(v3Rows, queries),
      "hybrid-v4-shadow": metrics(v4Rows, queries),
    };

    // ── Probe: rank inversion (decoy at provider rank #1 never injects) ──
    const decoyId = familyBlock.get("float-accumulation")!;
    const decoyServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new DecoyRankingProvider(decoyId), evidenceMode: "shadow" });
    let decoyInjectionsV4 = 0;
    let decoyTrials = 0;
    for (const q of queries) {
      if (q.label !== "useful" || q.expectBlockId === decoyId) continue;
      decoyTrials++;
      const r = await decoyServer.recallHybrid({ text: q.text });
      const v4 = r.shadowV4;
      const id = v4 ? (v4.action === "inject" ? v4.topBlockId : undefined) : v2InjectedId(r);
      if (id === decoyId) decoyInjectionsV4++;
    }

    // ── Probe: provider timeout (fail open to sparse parity) ──
    const timeoutServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new SlowProvider(40), retrievalDeadlineMs: 1, evidenceMode: "shadow" });
    let timeoutParity = true;
    for (const q of queries) {
      const s = sparseServer.recall({ text: q.text });
      const t = await timeoutServer.recallHybrid({ text: q.text });
      if (t.shouldInject !== s.shouldInject || v2InjectedId(t) !== v2InjectedId(s)) timeoutParity = false;
    }

    // ── Probe: remote DTO refusal ──
    const SECRET_PATH = "/Users/alice/svc/main.ts";
    const SECRET_BEARER = "Bearer abcdef0123456789ABCDEF";
    const SECRET_KEY = "sk-ant-0123456789abcdefghijABCD";
    const SENSITIVE = `login fails at ${SECRET_PATH} when ${SECRET_BEARER} is rejected and the key ${SECRET_KEY} leaks into a log line`;
    const recOptIn = new RecordingRemoteProvider(true);
    await new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: recOptIn }).recallHybrid({ text: SENSITIVE });
    const capturedOptIn = JSON.stringify(recOptIn.captured);
    const leakChecks: Array<[string, string]> = [["abs-path", SECRET_PATH], ["bearer-token", SECRET_BEARER], ["api-key", SECRET_KEY]];
    const scrubbed = leakChecks.filter(([, span]) => !capturedOptIn.includes(span)).map(([name]) => name);
    const engagedWithOptIn = recOptIn.captured.intents.length > 0;
    const boundaryClean = engagedWithOptIn && scrubbed.length === leakChecks.length;
    const recNoOpt = new RecordingRemoteProvider(false);
    await new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: recNoOpt }).recallHybrid({ text: SENSITIVE });
    const engagedWithoutOptIn = recNoOpt.captured.intents.length > 0;

    // ── Probe: missing sibling (singleton slate → V4 conservatively abstains) ──
    const accBlock = store.getBlock(familyBlock.get("float-accumulation")!)!;
    const solo: ServingCandidate[] = [{ block: accBlock, rankScore: 0.9, provenance: { semanticRank: 1, fusedRank: 1, semanticOnly: true, providerClass: "local" } }];
    const soloQuery: ServingQuery = { text: FAMILIES[2]!.paraphrases[0]! }; // a true float-acc paraphrase
    const v4Solo = decideServingV4(soloQuery, solo, DEFAULT_SERVING_POLICY);
    const v4SoloSel = v4Solo.evidenceV4.find((e) => e.blockId === v4Solo.decision.topCandidateId);

    // ── Declared sensitivity table: sweep the discriminative-support floor ──
    // Representative semantic-only slates: each useful paraphrase + its anchor
    // sibling; each sibling-collision + both domain siblings. Shipped floor 0.5.
    const blockOf = (id: string): ReasoningBlock => store.getBlock(familyBlock.get(id)!)!;
    const semCand = (b: ReasoningBlock): ServingCandidate => ({ block: b, rankScore: 0.9, provenance: { semanticRank: 1, fusedRank: 1, semanticOnly: true, providerClass: "local" } });
    const siblingOf = (id: string): string | undefined => {
      const f = FAMILIES.find((x) => x.id === id)!;
      return FAMILIES.find((x) => x.anchor === f.anchor && x.id !== id)?.id;
    };
    const usefulSlates = FAMILIES.flatMap((f) => {
      const sib = siblingOf(f.id);
      const cands = sib ? [semCand(blockOf(f.id)), semCand(blockOf(sib))] : [semCand(blockOf(f.id))];
      return f.paraphrases.map((p) => ({ q: { text: p } as ServingQuery, expect: familyBlock.get(f.id)!, cands }));
    });
    const collisionSlates = NEGATIVES.filter((n) => n.negType === "sibling-collision").map((n) => {
      const anchorFamilies = FAMILIES.filter((f) => f.anchor === n.against);
      return { q: { text: n.text } as ServingQuery, cands: anchorFamilies.map((f) => semCand(blockOf(f.id))) };
    });
    const sensitivity = [0.3, 0.4, 0.5, 0.6, 0.7].map((min) => {
      let usefulLicensed = 0;
      for (const u of usefulSlates) {
        const d = decideServingV4(u.q, u.cands, DEFAULT_SERVING_POLICY, undefined, { discriminativeSupportMin: min });
        if (d.decision.action === "inject" && d.decision.topCandidateId === u.expect) usefulLicensed++;
      }
      let collisionLicensed = 0;
      for (const c of collisionSlates) {
        const d = decideServingV4(c.q, c.cands, DEFAULT_SERVING_POLICY, undefined, { discriminativeSupportMin: min });
        if (d.decision.action === "inject") collisionLicensed++;
      }
      return { discriminativeSupportMin: min, usefulLicensed, usefulTotal: usefulSlates.length, collisionLicensed, collisionTotal: collisionSlates.length };
    });

    // ── Targets + verdict ──
    const semanticLaneFpCeiling = 0.05;
    const materialRecallLift = 0.15;
    const v3RecallRetentionFloor = 0.7;
    const v4 = arms["hybrid-v4-shadow"];
    const v2 = arms["sparse-v2"];
    const v4SemanticLaneFpMet = (v4.semanticLicenseLaneFP ?? 0) <= semanticLaneFpCeiling;
    const v4MaterialLiftMet = (v4.recallAtUseful ?? 0) - (v2.recallAtUseful ?? 0) >= materialRecallLift;
    const v4RecallRetainedVsV3 = v3Recall ? Math.round((v4RecallRetained / v3Recall) * 1000) / 1000 : null;
    const v4RetainsV3RecallMet = (v4RecallRetainedVsV3 ?? 1) >= v3RecallRetentionFloor;
    const allMet = v4SemanticLaneFpMet && v4MaterialLiftMet && v4RetainsV3RecallMet && decoyInjectionsV4 === 0 && timeoutParity && boundaryClean && !engagedWithoutOptIn;

    let rootCause: string | undefined;
    if (!v4SemanticLaneFpMet) rootCause = `V4 semantic-lane FP ${v4.semanticLicenseLaneFP} > ${semanticLaneFpCeiling}: a contrastive gap did not separate a negative from its nearest sibling`;
    else if (!v4MaterialLiftMet) rootCause = `V4 recall lift over V2 (${(v4.recallAtUseful ?? 0) - (v2.recallAtUseful ?? 0)}) < ${materialRecallLift}: too few paraphrases convert through the contrastive gate`;
    else if (!v4RetainsV3RecallMet) rootCause = `V4 retained only ${v4RecallRetainedVsV3} of V3 recall (< ${v3RecallRetentionFloor}): the contrastive gate is over-conservative`;

    const anchors = new Set(FAMILIES.map((f) => f.anchor)).size;
    return {
      label: "Phase C.3 adversarial eval — baseline V2 vs V3-shadow vs V4-shadow. DISCLOSED hand-authored; NOT organic readiness; no gate/constant tuning; no model/network.",
      corpusHash,
      frozenAt: FROZEN_AT,
      acceptedFamilies,
      corpus: { families: FAMILIES.length, anchors, paraphraseHoldouts: queries.filter((q) => q.label === "useful").length, hardNegatives: NEGATIVES.length, negativeTypes: [...new Set(NEGATIVES.map((n) => n.negType))] },
      arms,
      contrastive: { v3FiredV4AbstainedNeg, v3FiredV4AbstainedUseful, v4RecallRetainedVsV3 },
      probes: {
        rankInversion: { decoyBlock: "float-accumulation (pinned to provider rank #1)", trials: decoyTrials, decoyInjectionsV4 },
        providerTimeout: { trials: queries.length, failOpenParityWithSparse: timeoutParity },
        remoteBoundary: { engagedWithOptIn, boundaryClean, engagedWithoutOptIn, scrubbed },
        missingSibling: { v3Action: "inject (no sibling to contrast)", v4Action: v4Solo.decision.action, v4LicenseReason: v4SoloSel?.licenseReason ?? "?" },
      },
      sensitivity,
      targets: { semanticLaneFpCeiling, materialRecallLift, v3RecallRetentionFloor, v4SemanticLaneFpMet, v4MaterialLiftMet, v4RetainsV3RecallMet, allMet },
      verdict: {
        closesLeak: v4SemanticLaneFpMet && v3FiredV4AbstainedNeg > 0,
        retainsRecall: v4MaterialLiftMet && v4RetainsV3RecallMet,
        ...(rootCause ? { rootCause } : {}),
        note: "`on` is forbidden by the rollout. This eval evaluates promotion-readiness of the contrastive lane; the policy is reported as-is and never weakened to hit a target.",
      },
      organicReadiness: "N/A — bootstrap/adversarial corpus only; never counts toward organic readiness",
    };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = await runAdversarialV4Eval();
  writeFileSync(join(OUT_DIR, "eval.json"), JSON.stringify(out, null, 2) + "\n");

  console.log(`\nPhase C.3 adversarial eval — corpus ${out.corpusHash} (frozen)\n`);
  const cols = ["arm", "candRecall", "recall@useful", "prec@fire", "wilsonLB", "fp(neg)", "semLaneFP", "p95"];
  console.log(cols.join("\t"));
  for (const arm of ["sparse-v2", "hybrid-v3-shadow", "hybrid-v4-shadow"] as Arm[]) {
    const m = out.arms[arm];
    console.log([arm, m.candidateRecallAtUseful, m.recallAtUseful, m.precisionAtFire, m.wilsonLB, m.falsePositiveRateNegatives, m.semanticLicenseLaneFP, m.latencyMsP95].join("\t"));
  }
  console.log("\nFP by negative type (V3 → V4):");
  for (const t of out.corpus.negativeTypes) {
    const v3 = out.arms["hybrid-v3-shadow"].fpByType[t] ?? { fired: 0, total: 0 };
    const v4 = out.arms["hybrid-v4-shadow"].fpByType[t] ?? { fired: 0, total: 0 };
    console.log(`  ${t}: V3 ${v3.fired}/${v3.total} → V4 ${v4.fired}/${v4.total}`);
  }
  const c = out.contrastive;
  console.log(`\ncontrastive: V3-fired-V4-abstained negatives=${c.v3FiredV4AbstainedNeg} (leaks closed); useful cost=${c.v3FiredV4AbstainedUseful}; V4 retains ${c.v4RecallRetainedVsV3} of V3 recall`);
  console.log("\nprobes:");
  console.log(`  rank inversion: decoyInjectionsV4=${out.probes.rankInversion.decoyInjectionsV4}/${out.probes.rankInversion.trials} (target 0)`);
  console.log(`  provider timeout: failOpenParityWithSparse=${out.probes.providerTimeout.failOpenParityWithSparse}`);
  console.log(`  remote boundary: clean=${out.probes.remoteBoundary.boundaryClean} scrubbed=[${out.probes.remoteBoundary.scrubbed.join(",")}] engagedWithoutOptIn=${out.probes.remoteBoundary.engagedWithoutOptIn}`);
  console.log(`  missing sibling: V4=${out.probes.missingSibling.v4Action} (${out.probes.missingSibling.v4LicenseReason})`);
  console.log("\nsensitivity (discriminative-support floor; shipped=0.5):");
  console.log("  min\tuseful licensed\tcollision licensed");
  for (const s of out.sensitivity) console.log(`  ${s.discriminativeSupportMin}\t${s.usefulLicensed}/${s.usefulTotal}\t\t${s.collisionLicensed}/${s.collisionTotal}`);
  console.log(`\ntargets: semLaneFP<=${out.targets.semanticLaneFpCeiling}, recall lift>=${out.targets.materialRecallLift}, retainV3>=${out.targets.v3RecallRetentionFloor} — allMet=${out.targets.allMet}`);
  if (out.verdict.rootCause) console.log(`root cause: ${out.verdict.rootCause}`);
  console.log(`verdict: closesLeak=${out.verdict.closesLeak} retainsRecall=${out.verdict.retainsRecall}`);
  console.log("organic readiness: N/A (bootstrap/adversarial corpus)\n");
  console.log(`wrote ${join("bench-runs", "reasoning-reuse", "adversarial-v4", "eval.json")}`);
}

if (!process.env.VITEST) void main();
