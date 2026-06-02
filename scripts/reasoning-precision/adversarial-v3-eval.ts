#!/usr/bin/env tsx
/**
 * Frozen $0 adversarial eval — sparse-V2 vs hybrid-V2 vs hybrid-V3-shadow.
 *
 * Phase C.2's thesis: hybrid retrieval lifts CANDIDATE recall (a body-phrased
 * query surfaces the right lesson into the slate), but the served V2 decision is
 * lexical-conditional and abstains on a body-only candidate — so candidate recall
 * does not convert to DECISION recall. ServingEvidenceV3's semantic-license lane
 * is the designed converter: it licenses a semantic-only candidate ONLY with ≥2
 * independent privacy-scanned body-field corroborations AND family separation —
 * never via semantic rank. This eval measures whether that conversion happens
 * WITHOUT spending precision, against adversaries built to fool exactly it.
 *
 * DISCLOSED, hand-authored, NOT organic. A NEW frozen corpus (prior eval corpora
 * are untouched). No model, no network, no threshold tuning. The three arms decide
 * at the PRODUCTION gate; they differ ONLY in retrievalMode + provider +
 * evidenceMode. V3 is NEVER served — it is read off the shadow decision.
 *
 * FP is decomposed BY LANE, because Phase C.2 introduces exactly one new decision
 * pathway — the semantic-license lane — and the precision/FP target governs THAT.
 * The pre-existing lexical lane (V2's trigger-based firing) is arm-invariant:
 * sparse-V2, hybrid-V2 and V3's lexical lane decide identically on it. A dedicated
 * lexical-bullseye probe discloses that a verbatim symptom restatement fires in
 * all three arms — a known V2 boundary Phase C.2 neither creates nor fixes.
 *
 * Six adversarial probes:
 *   1. body-token collision     — shares a family's MECHANISM/UNLOCK vocabulary,
 *                                 different root cause → semantic lane must reject.
 *   2. wrong mechanism          — same DOMAIN/symptom (reworded, not a verbatim
 *                                 trigger), contradictory mechanism → must reject.
 *   3. sibling family           — ambiguous within a shared anchor (two siblings)
 *                                 → family separation → abstain.
 *   4. misleading provider rank — a decoy block pinned to provider rank #1; RRF is
 *                                 ordering-only and native scores never become
 *                                 confidence → the decoy must NEVER be injected.
 *   5. provider timeout         — a never-resolving provider → fail open to sparse;
 *                                 served decision must match sparse-V2 exactly.
 *   6. remote boundary privacy  — a remote adapter receives ONLY scrubbed DTOs
 *                                 (no abs paths, no credentials) and is NEVER
 *                                 engaged without explicit opt-in.
 *
 * Targets (the conversion guardrail): semantic-license-lane FP ≤ 0.05, V3
 * precision@fire ≥ 0.90, bounded p95. Organic readiness is N/A (bootstrap) and
 * reported as such. The eval's verdict GATES promotion of V3 from shadow → on.
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
import { DEFAULT_GATE_THRESHOLD } from "../../src/core/serving-confidence.js";
import type {
  RetrievalProvider,
  RetrievalProviderCapabilities,
  RetrievalIntent,
  RetrievalContext,
  RetrievalCandidate,
  RetrievalDocument,
} from "../../src/core/retrieval-provider.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-runs", "reasoning-reuse", "adversarial-v3");
const FROZEN_AT = 1780262013;

// ---------------------------------------------------------------------------
// Frozen corpus — NEW, distinct from hybrid-paraphrase-eval (prior corpora are
// not mutated). Bodies carry discriminative MECHANISM/UNLOCK vocabulary the
// trigger does not; `anchor` groups siblings for family separation.
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
    id: "cache-stampede",
    anchor: "caching",
    situation: "the origin database is hammered right after a popular entry expires",
    mechanism: "when a hot key expires many requests miss simultaneously and all recompute the same value at once stampeding the origin because there is no single flight lock",
    unlock: "serialize recomputation with a single flight lock or early recompute so only one request rebuilds the expired hot key",
    paraphrases: [
      "many requests all recompute the same expired hot key at once and stampede the origin with no single flight guard",
      "a thundering herd hits the origin when a popular key expires because every concurrent miss rebuilds the value",
    ],
  },
  {
    id: "float-accumulation",
    anchor: "numeric",
    situation: "a running total disagrees with the expected sum by a tiny amount",
    mechanism: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result",
    unlock: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift",
    paraphrases: [
      "adding many floating point numbers drifts from the true total because each addition discards low order bits",
      "rounding error accumulates across a long floating point summation so the order of additions changes the result",
    ],
  },
  {
    id: "dst-timezone",
    anchor: "time",
    situation: "a daily job fires twice or is skipped on certain calendar days",
    mechanism: "scheduling on local wall clock time breaks across a daylight saving transition because an hour repeats or is skipped so the naive local timestamp is ambiguous",
    unlock: "schedule in utc and convert to local only for display so a daylight saving transition cannot duplicate or skip the run",
    paraphrases: [
      "a job double fires across a daylight saving change because the repeated wall clock hour is ambiguous in local time",
      "a scheduled run is skipped when the clock springs forward and the missing local hour never occurs",
    ],
  },
];

type NegType = "body-token-collision" | "wrong-mechanism" | "sibling-family" | "disjoint";

interface Negative {
  negType: NegType;
  against?: string; // family/anchor this hard negative is engineered to resemble
  text: string;
}

// Hard negatives — FAIR: a competent reviewer agrees the system should abstain on
// every one. They share surface/body vocabulary but not the lesson's remediation/
// invariants, or are genuinely ambiguous between siblings. (A verbatim symptom
// restatement — which fires V2's lexical lane in ALL arms — is handled separately
// by the lexical-bullseye disclosure probe, not counted here.)
const NEGATIVES: Negative[] = [
  // 1. body-token collision: shares MECHANISM/UNLOCK tokens, different root cause.
  { negType: "body-token-collision", against: "cache-stampede", text: "a build step has to recompute every asset from scratch on each run because the output directory is not reused between builds" },
  { negType: "body-token-collision", against: "float-accumulation", text: "a slider snaps to coarse steps because the floating point value is rounded to one decimal place purely for display" },
  // 2. wrong mechanism: same DOMAIN/symptom (reworded, not a verbatim trigger),
  // clearly DIFFERENT mechanism → no body corroboration → must reject.
  { negType: "wrong-mechanism", against: "lock-order-deadlock", text: "a pair of concurrent workers both sit idle indefinitely because each is awaiting a reply from a slow remote service that never answers" },
  { negType: "wrong-mechanism", against: "float-accumulation", text: "a computed total comes out slightly off not from any rounding but because two amounts use different units and one is never converted before they are added" },
  // 3. sibling family: ambiguous within the concurrency anchor; commits to neither
  // the lock-order nor the lost-update mechanism → family separation → abstain.
  { negType: "sibling-family", against: "concurrency", text: "a concurrent background job intermittently misbehaves under parallelism and the worker threads seem to interact badly with shared state" },
  { negType: "sibling-family", against: "concurrency", text: "two worker threads contend over the same shared resource and the outcome is occasionally wrong under load" },
  // 4. disjoint: unrelated problems → baseline precision.
  { negType: "disjoint", text: "a css grid layout collapses because an implicit row track resolves to zero height" },
  { negType: "disjoint", text: "a shell pipeline silently truncates output because the reader closes the pipe before the writer finishes" },
];

// Verbatim symptom restatement of lock-order-deadlock's trigger, with an
// unrelated mechanism. Fires V2's LEXICAL lane in ALL THREE arms — a pre-existing
// trigger-based property Phase C.2 neither introduces nor repairs. Disclosed via
// its own probe (arm-invariance is the point), NOT mixed into the FP target set.
const LEXICAL_BULLSEYE = "two background jobs stop making progress because the upstream queue is empty so the workers idle waiting for new messages";

function buildDtos(): unknown[] {
  return FAMILIES.map((f) => ({
    schemaVersion: PATTERN_DTO_SCHEMA_VERSION,
    pattern: { situation: f.situation, mechanism: f.mechanism, unlock: f.unlock, verification: "re-run the failing scenario and confirm the class-specific symptom is gone" },
    scope: { language: "general" },
    signals: { tags: [f.id, f.anchor, "recurring-class", "adversarial-v3-eval"] },
    provenance: { sourceType: "import", sourceRef: `adv-v3:${f.id}`, capturedAt: FROZEN_AT, captureVersion: "adversarial-v3-1" },
    metadata: { familyId: f.id, anchor: f.anchor, disclosure: "hand-authored recurring-class adversarial eval; NOT organic, NOT public-mined" },
  }));
}

// ---------------------------------------------------------------------------
// Adversarial providers — each implements the SAME privacy-hardened contract.
// ---------------------------------------------------------------------------
/** Forces a fixed decoy block to provider rank #1 while keeping real candidates. */
class DecoyRankingProvider implements RetrievalProvider {
  readonly name = "decoy-ranking";
  readonly capabilities: RetrievalProviderCapabilities = { location: "local", payload: "sanitized-text", explicitOptIn: false };
  private readonly inner = new DeterministicLocalProvider();
  constructor(private readonly decoyId: string) {}
  async retrieve(intent: RetrievalIntent, ctx: RetrievalContext): Promise<RetrievalCandidate[] | null> {
    const base = (await this.inner.retrieve(intent, ctx)) ?? [];
    const maxScore = base.reduce((m, c) => Math.max(m, c.score), 0);
    const withoutDecoy = base.filter((c) => c.blockId !== this.decoyId);
    return [{ blockId: this.decoyId, score: maxScore + 1 }, ...withoutDecoy]; // rank #1, no body support
  }
}

/**
 * Resolves only AFTER a delay far longer than the caller's deadline → the
 * caller's timeout always wins the race (exercising the timeout fail-open path).
 * Uses a REF'd timer on purpose: the production timeout timer is `unref()`'d, so
 * a bare-script process would otherwise have no live handle during the probe and
 * exit early. The late resolution is harmless (the race already settled).
 */
class SlowProvider implements RetrievalProvider {
  readonly name = "slow";
  readonly capabilities: RetrievalProviderCapabilities = { location: "local", payload: "sanitized-text", explicitOptIn: false };
  constructor(private readonly delayMs: number) {}
  retrieve(): Promise<RetrievalCandidate[] | null> {
    return new Promise<RetrievalCandidate[] | null>((res) => {
      setTimeout(() => res([]), this.delayMs); // ref'd: keeps the loop alive past the deadline
    });
  }
}

/** A remote adapter that RECORDS exactly what crosses the boundary. */
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
    return []; // contributes nothing; we only inspect what it RECEIVED
  }
}

// ---------------------------------------------------------------------------
// Per-query record + metrics
// ---------------------------------------------------------------------------
interface LabeledQuery {
  text: string;
  label: "useful" | "negative";
  negType?: NegType;
  expectBlockId?: string;
}
type Arm = "sparse-v2" | "hybrid-v2" | "hybrid-v3-shadow";
interface ArmRow {
  fired: boolean;
  injectedId?: string;
  inSlate: boolean;
  correct: boolean;
  latencyMs: number;
  lane?: string;
  licenseReason?: string;
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

  // Lane decomposition of negative-set false positives (V3 carries lane info).
  const negRows = rows.filter((_, i) => queries[i]!.label === "negative");
  const lexicalLaneFP = negRows.filter((r) => r.fired && r.lane === "lexical").length;
  const semanticLaneFP = negRows.filter((r) => r.fired && r.lane === "semantic-license").length;

  return {
    candidateRecallAtUseful: round(useful.length ? usefulInSlate / useful.length : null),
    recallAtUseful: round(useful.length ? usefulInjected / useful.length : null),
    precisionAtFire: round(fired.length ? correctFires / fired.length : null),
    wilsonLB: round(fired.length ? wilsonLowerBound(correctFires, fired.length) : null),
    falsePositiveRateNegatives: round(negs.length ? negFired / negs.length : null),
    fpByType,
    fpByLane: { lexical: lexicalLaneFP, "semantic-license": semanticLaneFP, ofNegatives: negs.length },
    semanticLicenseLaneFP: round(negs.length ? semanticLaneFP / negs.length : null),
    fireRate: round(rows.length ? fired.length / rows.length : 0),
    firedCount: fired.length,
    correctFires,
    latencyMsP50: pctile(0.5),
    latencyMsP95: pctile(0.95),
  };
}

export interface AdversarialEvalResult {
  label: string;
  corpusHash: string;
  frozenAt: number;
  acceptedFamilies: number;
  corpus: { families: number; anchors: number; paraphraseHoldouts: number; hardNegatives: number; negativeTypes: NegType[] };
  provider: string;
  fusion: string;
  operatingPoint: { gate: number; note: string };
  organicReadiness: string;
  arms: Record<Arm, ReturnType<typeof metrics>>;
  /** The clean headline: did V3 convert the hybrid's semantic-only candidate lift into correct injects? */
  conversion: { semanticOnlyUseful: number; convertedByV3: number; conversionRate: number | null; v2RecallOnThose: number };
  /** Phase C.2 introduces no new lexical-lane FP: sparse-V2 and hybrid-V2 decide negatives identically. */
  lexicalLaneInvariant: boolean;
  probes: {
    misleadingProviderRank: { decoyBlock: string; trials: number; decoyInjections: number; candidateRecallUnderDecoy: number | null };
    providerTimeout: { trials: number; failOpenParityWithSparse: boolean };
    remoteBoundaryPrivacy: { engagedWithOptIn: boolean; boundaryClean: boolean; engagedWithoutOptIn: boolean; noOptInParityWithSparse: boolean; scrubbed: string[] };
    lexicalBullseye: { firesSparseV2: boolean; firesHybridV2: boolean; firesV3: boolean; v3Lane: string; armInvariant: boolean };
  };
  targets: {
    precisionFloor: number;
    fpCeiling: number;
    v3: { precisionMet: boolean; semanticLaneFpMet: boolean; recallNotBelowV2: boolean };
    safetyProbesPass: boolean;
  };
  /** Promotion gate: may V3 graduate from shadow → on? */
  promotion: { readyForOn: boolean; blockers: string[]; note: string };
  fallbacks: number;
}

/** Pure, deterministic runner (no fs, no console). Used by the eval test + main. */
export async function runAdversarialEval(): Promise<AdversarialEvalResult> {
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
    const hybridServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider() });
    const shadowServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), evidenceMode: "shadow" });

    const v2InjectedId = (r: RecallV2Result): string | undefined => (r.shouldInject ? r.blocks.find((h) => h.passesGate)?.block.id : undefined);
    const inSlate = (q: LabeledQuery, r: RecallV2Result): boolean => (q.expectBlockId ? r.blocks.some((h) => h.block.id === q.expectBlockId) : false);
    const judge = (q: LabeledQuery, fired: boolean, id: string | undefined): boolean => (fired ? q.label === "useful" && id === q.expectBlockId : q.label !== "useful");

    const sparseRows: ArmRow[] = [];
    const hybridV2Rows: ArmRow[] = [];
    const hybridV3Rows: ArmRow[] = [];
    // Track conversion of the semantic-only candidate lift (FTS-missed ⇒ hybrid-found).
    let semanticOnlyUseful = 0;
    let convertedByV3 = 0;
    let v2RecallOnThose = 0;

    for (const q of queries) {
      const ts = Date.now();
      const s = sparseServer.recall({ text: q.text });
      const ls = Date.now() - ts;
      const th = Date.now();
      const h2 = await hybridServer.recallHybrid({ text: q.text });
      const lh2 = Date.now() - th;
      const tv = Date.now();
      const h3 = await shadowServer.recallHybrid({ text: q.text });
      const lh3 = Date.now() - tv;

      const sId = v2InjectedId(s);
      sparseRows.push({ fired: s.shouldInject, ...(sId ? { injectedId: sId } : {}), inSlate: inSlate(q, s), correct: judge(q, s.shouldInject, sId), latencyMs: ls, lane: "lexical" });

      const h2Id = v2InjectedId(h2);
      hybridV2Rows.push({ fired: h2.shouldInject, ...(h2Id ? { injectedId: h2Id } : {}), inSlate: inSlate(q, h2), correct: judge(q, h2.shouldInject, h2Id), latencyMs: lh2, lane: "lexical" });

      const v3 = h3.shadowV3; // fail open to served V2 if absent
      const v3Fired = v3 ? v3.action === "inject" : h3.shouldInject;
      const v3Id = v3 ? (v3.action === "inject" ? v3.topBlockId : undefined) : v2InjectedId(h3);
      hybridV3Rows.push({
        fired: v3Fired,
        ...(v3Id ? { injectedId: v3Id } : {}),
        inSlate: inSlate(q, h3),
        correct: judge(q, v3Fired, v3Id),
        latencyMs: lh3,
        lane: v3?.lane ?? "lexical",
        licenseReason: v3?.licenseReason ?? "lexical",
      });

      if (q.label === "useful") {
        const semOnly = inSlate(q, h2) && !inSlate(q, s); // FTS missed it, hybrid surfaced it
        if (semOnly) {
          semanticOnlyUseful++;
          if (v3Fired && v3Id === q.expectBlockId) convertedByV3++;
          if (s.shouldInject && sId === q.expectBlockId) v2RecallOnThose++;
        }
      }
    }

    const arms: Record<Arm, ReturnType<typeof metrics>> = {
      "sparse-v2": metrics(sparseRows, queries),
      "hybrid-v2": metrics(hybridV2Rows, queries),
      "hybrid-v3-shadow": metrics(hybridV3Rows, queries),
    };

    // Phase C.2 adds no new lexical-lane FP: the two V2 arms decide negatives identically.
    const negIdx = queries.map((q, i) => (q.label === "negative" ? i : -1)).filter((i) => i >= 0);
    const lexicalLaneInvariant = negIdx.every((i) => sparseRows[i]!.fired === hybridV2Rows[i]!.fired);

    // ---- Probe 4: misleading provider rank --------------------------------
    const decoyId = familyBlock.get("float-accumulation")!;
    const decoyServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new DecoyRankingProvider(decoyId), evidenceMode: "shadow" });
    let decoyInjections = 0;
    let decoyRecallHeld = 0;
    let decoyTrials = 0;
    for (const q of queries) {
      if (q.label !== "useful" || q.expectBlockId === decoyId) continue;
      decoyTrials++;
      const r = await decoyServer.recallHybrid({ text: q.text });
      const v3 = r.shadowV3;
      const injectedId = v3 ? (v3.action === "inject" ? v3.topBlockId : undefined) : v2InjectedId(r);
      if (injectedId === decoyId) decoyInjections++;
      if (q.expectBlockId && r.blocks.some((h) => h.block.id === q.expectBlockId)) decoyRecallHeld++;
    }

    // ---- Probe 5: provider timeout (fail open to sparse) ------------------
    const timeoutServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: new SlowProvider(40), retrievalDeadlineMs: 1, evidenceMode: "shadow" });
    let timeoutParity = true;
    for (const q of queries) {
      const s = sparseServer.recall({ text: q.text });
      const t = await timeoutServer.recallHybrid({ text: q.text });
      if (t.shouldInject !== s.shouldInject || v2InjectedId(t) !== v2InjectedId(s)) timeoutParity = false;
    }

    // ---- Probe 6: remote boundary privacy ---------------------------------
    const SECRET_PATH = "/Users/alice/svc/main.ts";
    const SECRET_BEARER = "Bearer abcdef0123456789ABCDEF";
    const SECRET_KEY = "sk-ant-0123456789abcdefghijABCD";
    const SENSITIVE = `login fails at ${SECRET_PATH} when ${SECRET_BEARER} is rejected and the key ${SECRET_KEY} leaks into a log line`;

    const recOptIn = new RecordingRemoteProvider(true);
    const remoteServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: recOptIn });
    await remoteServer.recallHybrid({ text: SENSITIVE });
    const capturedOptIn = JSON.stringify(recOptIn.captured);
    const leakChecks: Array<[string, string]> = [["abs-path", SECRET_PATH], ["bearer-token", SECRET_BEARER], ["api-key", SECRET_KEY]];
    const scrubbed = leakChecks.filter(([, span]) => !capturedOptIn.includes(span)).map(([name]) => name);
    const engagedWithOptIn = recOptIn.captured.intents.length > 0;
    const boundaryClean = engagedWithOptIn && scrubbed.length === leakChecks.length;

    const recNoOpt = new RecordingRemoteProvider(false);
    const noOptServer = new BlockServer(store, { gateThreshold: gate, servingMode: "v2-family", emitEvents: false, retrievalMode: "on", retrievalProvider: recNoOpt });
    const noOptResult = await noOptServer.recallHybrid({ text: SENSITIVE });
    const engagedWithoutOptIn = recNoOpt.captured.intents.length > 0;
    const sparseSensitive = sparseServer.recall({ text: SENSITIVE });
    const noOptInParityWithSparse = noOptResult.shouldInject === sparseSensitive.shouldInject && v2InjectedId(noOptResult) === v2InjectedId(sparseSensitive);

    // ---- Probe: lexical bullseye (verbatim symptom; arm-invariant lexical fire) --
    const lbSparse = sparseServer.recall({ text: LEXICAL_BULLSEYE });
    const lbHybrid = await hybridServer.recallHybrid({ text: LEXICAL_BULLSEYE });
    const lbShadow = await shadowServer.recallHybrid({ text: LEXICAL_BULLSEYE });
    const lbV3 = lbShadow.shadowV3;
    const lbFiresV3 = lbV3 ? lbV3.action === "inject" : lbShadow.shouldInject;
    const lexicalBullseye = {
      firesSparseV2: lbSparse.shouldInject,
      firesHybridV2: lbHybrid.shouldInject,
      firesV3: lbFiresV3,
      v3Lane: lbV3?.lane ?? "lexical",
      armInvariant: lbSparse.shouldInject === lbHybrid.shouldInject && lbHybrid.shouldInject === lbFiresV3,
    };

    // ---- Targets + promotion verdict --------------------------------------
    const precisionFloor = 0.9;
    const fpCeiling = 0.05;
    const v3 = arms["hybrid-v3-shadow"];
    const precisionMet = v3.precisionAtFire === null ? true : v3.precisionAtFire >= precisionFloor;
    const semanticLaneFpMet = v3.semanticLicenseLaneFP === null ? true : v3.semanticLicenseLaneFP <= fpCeiling;
    const recallNotBelowV2 = (v3.recallAtUseful ?? 0) >= (arms["hybrid-v2"].recallAtUseful ?? 0);
    const safetyProbesPass = decoyInjections === 0 && timeoutParity && boundaryClean && !engagedWithoutOptIn && noOptInParityWithSparse;

    const blockers: string[] = [];
    if (!semanticLaneFpMet) blockers.push(`semantic-license lane FP ${v3.semanticLicenseLaneFP} > ${fpCeiling} ceiling (same-domain body-token collision corroborates; e.g. floating-point rounding vocabulary)`);
    if (!precisionMet) blockers.push(`V3 precision@fire ${v3.precisionAtFire} < ${precisionFloor} floor`);
    if (!recallNotBelowV2) blockers.push("V3 recall regressed below V2");
    if (!safetyProbesPass) blockers.push("a safety/privacy probe failed (decoy/timeout/remote-boundary)");
    const readyForOn = blockers.length === 0;

    const anchors = new Set(FAMILIES.map((f) => f.anchor)).size;
    return {
      label: "Phase C.2 adversarial eval — sparse-V2 vs hybrid-V2 vs hybrid-V3-shadow. DISCLOSED hand-authored; NOT organic readiness; no gate tuning; no model/network.",
      corpusHash,
      frozenAt: FROZEN_AT,
      acceptedFamilies,
      corpus: {
        families: FAMILIES.length,
        anchors,
        paraphraseHoldouts: queries.filter((q) => q.label === "useful").length,
        hardNegatives: NEGATIVES.length,
        negativeTypes: [...new Set(NEGATIVES.map((n) => n.negType))],
      },
      provider: "deterministic-local (+ adversarial decoy/timeout/remote probes)",
      fusion: "RRF (k=60)",
      operatingPoint: { gate, note: "production gate DEFAULT_GATE_THRESHOLD (not tuned); V2-family decision; V3 shadow on the same slate" },
      organicReadiness: "N/A — bootstrap/adversarial corpus only; never counts toward organic readiness",
      arms,
      conversion: {
        semanticOnlyUseful,
        convertedByV3,
        conversionRate: semanticOnlyUseful ? Math.round((convertedByV3 / semanticOnlyUseful) * 1000) / 1000 : null,
        v2RecallOnThose,
      },
      lexicalLaneInvariant,
      probes: {
        misleadingProviderRank: { decoyBlock: "float-accumulation (pinned to provider rank #1)", trials: decoyTrials, decoyInjections, candidateRecallUnderDecoy: decoyTrials ? Math.round((decoyRecallHeld / decoyTrials) * 1000) / 1000 : null },
        providerTimeout: { trials: queries.length, failOpenParityWithSparse: timeoutParity },
        remoteBoundaryPrivacy: { engagedWithOptIn, boundaryClean, engagedWithoutOptIn, noOptInParityWithSparse, scrubbed },
        lexicalBullseye,
      },
      targets: { precisionFloor, fpCeiling, v3: { precisionMet, semanticLaneFpMet, recallNotBelowV2 }, safetyProbesPass },
      promotion: {
        readyForOn,
        blockers,
        note: "Promotion is gated by this eval. `on` is not permitted by the rollout regardless; the default-off/shadow posture is the safe state these blockers validate.",
      },
      fallbacks: 0,
    };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = await runAdversarialEval();
  writeFileSync(join(OUT_DIR, "eval.json"), JSON.stringify(out, null, 2) + "\n");

  console.log(`\nPhase C.2 adversarial eval — corpus ${out.corpusHash} (frozen)\n`);
  const cols = ["arm", "candRecall", "recall@useful", "prec@fire", "wilsonLB", "fp(neg)", "semLaneFP", "fireRate", "p50", "p95"];
  console.log(cols.join("\t"));
  for (const arm of ["sparse-v2", "hybrid-v2", "hybrid-v3-shadow"] as Arm[]) {
    const m = out.arms[arm];
    console.log([arm, m.candidateRecallAtUseful, m.recallAtUseful, m.precisionAtFire, m.wilsonLB, m.falsePositiveRateNegatives, m.semanticLicenseLaneFP, m.fireRate, m.latencyMsP50, m.latencyMsP95].join("\t"));
  }
  const c = out.conversion;
  console.log(`\nconversion of semantic-only candidate lift → V3 injects: ${c.convertedByV3}/${c.semanticOnlyUseful} (rate ${c.conversionRate}); V2 recall on those: ${c.v2RecallOnThose}`);
  console.log(`lexical-lane invariant (sparse-V2 == hybrid-V2 on negatives): ${out.lexicalLaneInvariant}`);
  console.log("\nFP by negative type (hybrid-v3-shadow):");
  for (const [t, v] of Object.entries(out.arms["hybrid-v3-shadow"].fpByType)) console.log(`  ${t}: ${v.fired}/${v.total}`);
  console.log("\nadversarial probes:");
  const p = out.probes;
  console.log(`  misleading provider rank: decoyInjections=${p.misleadingProviderRank.decoyInjections}/${p.misleadingProviderRank.trials} (target 0); candRecallUnderDecoy=${p.misleadingProviderRank.candidateRecallUnderDecoy}`);
  console.log(`  provider timeout: failOpenParityWithSparse=${p.providerTimeout.failOpenParityWithSparse} (target true)`);
  console.log(`  remote boundary: engagedWithOptIn=${p.remoteBoundaryPrivacy.engagedWithOptIn} boundaryClean=${p.remoteBoundaryPrivacy.boundaryClean} scrubbed=[${p.remoteBoundaryPrivacy.scrubbed.join(",")}] engagedWithoutOptIn=${p.remoteBoundaryPrivacy.engagedWithoutOptIn} (target false) noOptParity=${p.remoteBoundaryPrivacy.noOptInParityWithSparse}`);
  console.log(`  lexical bullseye (verbatim symptom): firesSparseV2=${p.lexicalBullseye.firesSparseV2} firesHybridV2=${p.lexicalBullseye.firesHybridV2} firesV3=${p.lexicalBullseye.firesV3} (lane=${p.lexicalBullseye.v3Lane}) armInvariant=${p.lexicalBullseye.armInvariant}`);
  console.log(`\npromotion shadow→on: readyForOn=${out.promotion.readyForOn}`);
  for (const b of out.promotion.blockers) console.log(`  blocker: ${b}`);
  console.log("organic readiness: N/A (bootstrap/adversarial corpus; reported separately)");
  console.log(`\nwrote ${join("bench-runs", "reasoning-reuse", "adversarial-v3", "eval.json")}`);
}

// Run as a script, but NOT when imported by the eval test (Vitest sets VITEST).
if (!process.env.VITEST) void main();
