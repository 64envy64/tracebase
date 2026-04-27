/**
 * Retrieval eval harness (PLAN-0.7 §6 stable gates §1).
 *
 * Runs hand-crafted golden cases across the three retrieval paths
 * the layer ships:
 *   - prior_fix    : `ReasoningLayer.recall()` over stored traces
 *   - file_memory  : `BlockStore.recallFilesForPrompt()` over file
 *                    index rows
 *   - context_fold : `BlockStore.recallSessionChunksForPrompt()`
 *                    over session chunks
 *
 * For each case kind we compute Recall@5, nDCG@5, MRR over the
 * full case set. The case file declares per-kind thresholds; the
 * runner exits non-zero if any metric falls below its floor — that
 * is the release gate.
 *
 * Honesty contract: thresholds are conservative regression-catchers,
 * not state-of-the-art targets. The point is "did a recent change
 * make recall worse on cases we already verified worked", not
 * "are we beating an external benchmark".
 *
 * Run: `npm run eval:retrieval`. Output: `bench-results/eval-
 * retrieval-<version>.json` plus a one-line per-kind summary on
 * stdout.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { ReasoningLayer } from "../../src/core/engine.js";
import { BlockStore } from "../../src/core/block-store.js";
import { recallFiles } from "../../src/core/file-indexer.js";

const __filename = fileURLToPath(import.meta.url);
const evalRoot = dirname(__filename);
const repoRoot = resolve(evalRoot, "..", "..");
const resultsDir = join(repoRoot, "bench-results");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  version: string;
};

// ---------------------------------------------------------------------------
// Case schema
// ---------------------------------------------------------------------------

interface Thresholds {
  recall_at_5: number;
  ndcg_at_5: number;
  mrr: number;
}

interface PriorFixMemory {
  id: string;
  problem: string;
  solution: string;
}

interface PriorFixCase {
  id: string;
  memory: PriorFixMemory[];
  query: string;
  expected: string[];
}

interface PriorFixCaseFile {
  kind: "prior_fix";
  thresholds: Thresholds;
  cases: PriorFixCase[];
}

interface FileMemoryDocument {
  id: string;
  path: string;
  summary: string;
  bytes: number;
}

interface FileMemoryCase {
  id: string;
  memory: FileMemoryDocument[];
  query: string;
  expected: string[];
}

interface FileMemoryCaseFile {
  kind: "file_memory";
  thresholds: Thresholds;
  cases: FileMemoryCase[];
}

interface ContextFoldChunk {
  id: string;
  chunkStartTurn: number;
  chunkEndTurn: number;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
}

interface ContextFoldCase {
  id: string;
  sessionId: string;
  memory: ContextFoldChunk[];
  query: string;
  expected: string[];
}

interface ContextFoldCaseFile {
  kind: "context_fold";
  thresholds: Thresholds;
  cases: ContextFoldCase[];
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

const K = 5;

function recallAtK(retrieved: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const set = new Set(retrieved.slice(0, k));
  let hit = 0;
  for (const e of expected) if (set.has(e)) hit += 1;
  return hit / expected.length;
}

function dcg(scores: number[]): number {
  let acc = 0;
  for (let i = 0; i < scores.length; i++) {
    // log2(i+2) so the first slot contributes 1× the gain.
    acc += scores[i]! / Math.log2(i + 2);
  }
  return acc;
}

function ndcgAtK(retrieved: string[], expected: string[], k: number): number {
  const expectedSet = new Set(expected);
  const gains = retrieved.slice(0, k).map((id) => (expectedSet.has(id) ? 1 : 0));
  const idealGains = new Array(Math.min(expected.length, k)).fill(1);
  while (idealGains.length < k) idealGains.push(0);
  const denom = dcg(idealGains);
  if (denom === 0) return 0;
  return dcg(gains) / denom;
}

function reciprocalRank(retrieved: string[], expected: string[]): number {
  const expectedSet = new Set(expected);
  for (let i = 0; i < retrieved.length; i++) {
    if (expectedSet.has(retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Per-kind runners
// ---------------------------------------------------------------------------

interface KindReport {
  kind: string;
  cases: number;
  recall_at_5: number;
  ndcg_at_5: number;
  mrr: number;
  thresholds: Thresholds;
  passed: boolean;
  failures: Array<{ caseId: string; reason: string }>;
}

function runPriorFixKind(file: PriorFixCaseFile): KindReport {
  const recalls: number[] = [];
  const ndcgs: number[] = [];
  const rrs: number[] = [];
  const failures: Array<{ caseId: string; reason: string }> = [];

  for (const c of file.cases) {
    const dbPath = join(tmpdir(), `tb-eval-prior-${randomUUID()}.db`);
    const layer = new ReasoningLayer({ storagePath: dbPath });
    try {
      const idMap = new Map<string, string>(); // case-id → trace.id
      for (const mem of c.memory) {
        const trace = layer.storeTrace({
          problem: { description: mem.problem, tags: [] },
          solution: { summary: mem.solution, steps: [], outcome: "success" },
        });
        idMap.set(mem.id, trace.id);
      }
      const results = layer.recall({ problem: c.query, limit: K });
      const retrievedTraceIds = results.map((r) => r.trace.id);
      const expectedTraceIds = c.expected
        .map((e) => idMap.get(e))
        .filter((id): id is string => typeof id === "string");

      if (expectedTraceIds.length !== c.expected.length) {
        failures.push({
          caseId: c.id,
          reason: `expected id missing from memory: ${c.expected.find((e) => !idMap.has(e))}`,
        });
      }

      const r = recallAtK(retrievedTraceIds, expectedTraceIds, K);
      const n = ndcgAtK(retrievedTraceIds, expectedTraceIds, K);
      const m = reciprocalRank(retrievedTraceIds, expectedTraceIds);
      recalls.push(r);
      ndcgs.push(n);
      rrs.push(m);
    } finally {
      layer.close();
      try {
        for (const sfx of ["", "-wal", "-shm"]) {
          if (existsSync(dbPath + sfx)) {
            // best-effort cleanup
            const fs = require("node:fs") as typeof import("node:fs");
            fs.unlinkSync(dbPath + sfx);
          }
        }
      } catch {
        // best-effort
      }
    }
  }

  const recall_at_5 = mean(recalls);
  const ndcg_at_5 = mean(ndcgs);
  const mrr = mean(rrs);
  const passed =
    recall_at_5 >= file.thresholds.recall_at_5 &&
    ndcg_at_5 >= file.thresholds.ndcg_at_5 &&
    mrr >= file.thresholds.mrr;
  return {
    kind: file.kind,
    cases: file.cases.length,
    recall_at_5,
    ndcg_at_5,
    mrr,
    thresholds: file.thresholds,
    passed,
    failures,
  };
}

function runFileMemoryKind(file: FileMemoryCaseFile): KindReport {
  const recalls: number[] = [];
  const ndcgs: number[] = [];
  const rrs: number[] = [];
  const failures: Array<{ caseId: string; reason: string }> = [];

  for (const c of file.cases) {
    const dbPath = join(tmpdir(), `tb-eval-file-${randomUUID()}.db`);
    const db = new Database(dbPath);
    const store = new BlockStore(db);
    try {
      const idMap = new Map<string, string>(); // case-id → relPath used by store
      const rawDb = store.rawDb;
      const insert = rawDb.prepare(
        `INSERT INTO indexed_files
           (id, rel_path, hash, language, size_bytes,
            summary, symbols, summarizer, indexed_at, updated_at)
         VALUES
           (@id, @rel_path, @hash, NULL, @size_bytes,
            @summary, '{}', 'heuristic', @ts, @ts)`,
      );
      let n = 0;
      for (const f of c.memory) {
        insert.run({
          id: `eval-file-${c.id}-${n++}`,
          rel_path: f.path,
          hash: `eval-${c.id}-${f.id}`,
          size_bytes: f.bytes,
          summary: f.summary,
          ts: Date.now(),
        });
        idMap.set(f.id, f.path);
      }
      const hits = recallFiles(store, { prompt: c.query, k: K });
      const retrievedPaths = hits.map((h) => h.relPath);
      const expectedPaths = c.expected
        .map((e) => idMap.get(e))
        .filter((p): p is string => typeof p === "string");

      if (expectedPaths.length !== c.expected.length) {
        failures.push({
          caseId: c.id,
          reason: `expected id missing from memory: ${c.expected.find((e) => !idMap.has(e))}`,
        });
      }

      recalls.push(recallAtK(retrievedPaths, expectedPaths, K));
      ndcgs.push(ndcgAtK(retrievedPaths, expectedPaths, K));
      rrs.push(reciprocalRank(retrievedPaths, expectedPaths));
    } finally {
      store.close();
    }
  }

  const recall_at_5 = mean(recalls);
  const ndcg_at_5 = mean(ndcgs);
  const mrr = mean(rrs);
  const passed =
    recall_at_5 >= file.thresholds.recall_at_5 &&
    ndcg_at_5 >= file.thresholds.ndcg_at_5 &&
    mrr >= file.thresholds.mrr;
  return {
    kind: file.kind,
    cases: file.cases.length,
    recall_at_5,
    ndcg_at_5,
    mrr,
    thresholds: file.thresholds,
    passed,
    failures,
  };
}

function runContextFoldKind(file: ContextFoldCaseFile): KindReport {
  const recalls: number[] = [];
  const ndcgs: number[] = [];
  const rrs: number[] = [];
  const failures: Array<{ caseId: string; reason: string }> = [];

  for (const c of file.cases) {
    const dbPath = join(tmpdir(), `tb-eval-fold-${randomUUID()}.db`);
    const db = new Database(dbPath);
    const store = new BlockStore(db);
    try {
      const FOURTEEN_DAYS_MS = 14 * 86_400_000;
      const expiresAt = Date.now() + FOURTEEN_DAYS_MS;
      const chunks = c.memory.map((m, i) => ({
        sessionId: c.sessionId,
        chunkStartTurn: m.chunkStartTurn,
        chunkEndTurn: m.chunkEndTurn,
        turnHash: `eval-${c.id}-${i}`,
        summary: m.summary,
        tokensBefore: m.tokensBefore,
        tokensAfter: m.tokensAfter,
        summarizer: "heuristic" as const,
        expiresAt,
      }));
      store.recordSessionChunks(chunks);

      const hits = store.recallSessionChunksForPrompt(c.sessionId, c.query, K);
      // Map back to case ids by chunkStartTurn
      const idByStartTurn = new Map<number, string>();
      for (const m of c.memory) idByStartTurn.set(m.chunkStartTurn, m.id);
      const retrievedIds = hits
        .map((h) => idByStartTurn.get(h.chunkStartTurn))
        .filter((x): x is string => typeof x === "string");

      const r = recallAtK(retrievedIds, c.expected, K);
      const n = ndcgAtK(retrievedIds, c.expected, K);
      const m = reciprocalRank(retrievedIds, c.expected);
      recalls.push(r);
      ndcgs.push(n);
      rrs.push(m);
    } finally {
      store.close();
    }
  }

  const recall_at_5 = mean(recalls);
  const ndcg_at_5 = mean(ndcgs);
  const mrr = mean(rrs);
  const passed =
    recall_at_5 >= file.thresholds.recall_at_5 &&
    ndcg_at_5 >= file.thresholds.ndcg_at_5 &&
    mrr >= file.thresholds.mrr;
  return {
    kind: file.kind,
    cases: file.cases.length,
    recall_at_5,
    ndcg_at_5,
    mrr,
    thresholds: file.thresholds,
    passed,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadCaseFile<T>(name: string): T {
  const path = join(evalRoot, "cases", name);
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function renderKindLine(r: KindReport): string {
  const status = r.passed ? "PASS" : "FAIL";
  return [
    `[${status}] ${r.kind}`,
    `cases=${r.cases}`,
    `recall@5=${fmt(r.recall_at_5)} (≥${fmt(r.thresholds.recall_at_5)})`,
    `ndcg@5=${fmt(r.ndcg_at_5)} (≥${fmt(r.thresholds.ndcg_at_5)})`,
    `mrr=${fmt(r.mrr)} (≥${fmt(r.thresholds.mrr)})`,
  ].join("  ");
}

function main(): void {
  const reports: KindReport[] = [];

  const priorFix = loadCaseFile<PriorFixCaseFile>("prior-fix.json");
  reports.push(runPriorFixKind(priorFix));

  const fileMem = loadCaseFile<FileMemoryCaseFile>("file-memory.json");
  reports.push(runFileMemoryKind(fileMem));

  const ctxFold = loadCaseFile<ContextFoldCaseFile>("context-fold.json");
  reports.push(runContextFoldKind(ctxFold));

  // Print results
  for (const r of reports) {
    process.stdout.write(renderKindLine(r) + "\n");
    for (const f of r.failures) {
      process.stderr.write(`  ⚠ ${f.caseId}: ${f.reason}\n`);
    }
  }

  // Persist
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `eval-retrieval-${pkg.version}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        version: pkg.version,
        ts: new Date().toISOString(),
        reports,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`wrote ${outPath}\n`);

  const allPassed = reports.every((r) => r.passed);
  if (!allPassed) {
    process.stderr.write(
      "EVAL FAIL: at least one retrieval kind missed its threshold.\n",
    );
    process.exit(1);
  }
}

main();
