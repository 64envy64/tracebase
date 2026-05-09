#!/usr/bin/env node
/**
 * Deterministic retrieval-only counterfactual.
 *
 * For every fixture, build a corpus of the OTHER fixtures' seeds (same
 * shape the agent harness uses), then ask both retrievers what they'd
 * inject for this query:
 *
 *   - TraceBase: ReasoningLayer.recall(...) + the production confidence
 *     gate from inject.ts (full directive ≥0.85, hint ≥0.72, refuse <0.72).
 *   - Naive cache: bag-of-words Jaccard, no gate.
 *
 * No model API calls — this is purely a retrieval-quality probe. It
 * answers the question "is the lift due to TraceBase's
 * retrieval/weighting, or just to having memory at all?" without burning
 * agent-trajectory token budget.
 *
 * Run: `tsx eval/agentic/retrieval-comparison.ts`
 */

import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReasoningLayer } from "../../src/core/engine.js";
import { loadFixtures } from "./harness.js";
import { naiveRecall, type NaiveCorpusEntry } from "./naive-cache.js";

// Confidence gate thresholds — sourced from inject.ts so the comparison
// reflects production behavior, not a bespoke threshold for this report.
const GATE_FULL = 0.85;
const GATE_HINT = 0.72;

interface TraceBasePick {
  matchedFixtureId: string;
  score: number;
  /** Tier as decided by the production confidence gate. */
  tier: "full" | "hint" | "refused";
}

interface NaivePick {
  matchedFixtureId: string;
  score: number;
}

interface ComparisonRow {
  queryFixtureId: string;
  queryDescription: string;
  tracebase: TraceBasePick | null;
  naive: NaivePick | null;
}

function findFixtureBySituation(
  fixtures: ReturnType<typeof loadFixtures>,
  situation: string,
): string {
  return fixtures.find((f) => f.seed.situation === situation)?.meta.id ?? "<unknown>";
}

function gateTier(score: number): TraceBasePick["tier"] {
  if (score >= GATE_FULL) return "full";
  if (score >= GATE_HINT) return "hint";
  return "refused";
}

function buildLayerForCorpus(
  fixtures: ReturnType<typeof loadFixtures>,
  excludeId: string,
): ReasoningLayer {
  const tmpDb = mkdtempSync(join(tmpdir(), "tb-rcomp-"));
  const layer = new ReasoningLayer({ storagePath: join(tmpDb, "kb.db") });
  for (const other of fixtures) {
    if (other.meta.id === excludeId) continue;
    layer.storeTrace({
      problem: {
        description: other.seed.situation,
        language: other.meta.language,
        errorType: other.meta.bugType,
        tags: other.meta.tags ?? [],
      },
      solution: {
        summary: other.seed.unlock,
        explanation: Array.isArray(other.seed.deadEnds)
          ? other.seed.deadEnds.join(". ")
          : other.seed.deadEnds,
        steps: [],
        outcome: "success",
      },
      metadata: { agent: "seed", source: "eval:seed" },
    });
  }
  return layer;
}

function buildNaiveCorpus(
  fixtures: ReturnType<typeof loadFixtures>,
  excludeId: string,
): NaiveCorpusEntry[] {
  return fixtures
    .filter((f) => f.meta.id !== excludeId)
    .map((f) => ({ meta: f.meta, seed: f.seed }));
}

function main(): void {
  const baseDir = import.meta.dirname ?? __dirname;
  const fixturesDir = join(baseDir, "fixtures");
  const fixtures = loadFixtures(fixturesDir);

  if (fixtures.length === 0) {
    console.error(`No fixtures found at ${fixturesDir}`);
    process.exit(1);
  }

  const rows: ComparisonRow[] = [];

  for (const fixture of fixtures) {
    const layer = buildLayerForCorpus(fixtures, fixture.meta.id);
    const tbResults = layer.recall({
      problem: fixture.meta.description,
      limit: 1,
      minScore: 0.1,
      context: {
        language: fixture.meta.language,
        errorType: fixture.meta.bugType,
      },
    });
    let tracebase: TraceBasePick | null = null;
    if (tbResults.length > 0) {
      const r = tbResults[0]!;
      tracebase = {
        matchedFixtureId: findFixtureBySituation(fixtures, r.trace.problem.description),
        score: r.score,
        tier: gateTier(r.score),
      };
    }
    layer.close();

    const naiveResult = naiveRecall(
      fixture.meta.description,
      buildNaiveCorpus(fixtures, fixture.meta.id),
    );
    const naive: NaivePick | null = naiveResult
      ? { matchedFixtureId: naiveResult.meta.id, score: naiveResult.score }
      : null;

    rows.push({
      queryFixtureId: fixture.meta.id,
      queryDescription: fixture.meta.description,
      tracebase,
      naive,
    });
  }

  // ---- Aggregate ----
  let tbAnyPick = 0;
  let tbFull = 0;
  let tbHint = 0;
  let tbRefused = 0;
  let naiveAnyPick = 0;
  let agreedPick = 0;
  let disagreedPick = 0;
  // "Naive injects something TraceBase refused" — the noise-control proxy.
  let naiveInjectsWhereTbRefuses = 0;

  for (const row of rows) {
    if (row.tracebase) {
      tbAnyPick++;
      if (row.tracebase.tier === "full") tbFull++;
      else if (row.tracebase.tier === "hint") tbHint++;
      else tbRefused++;
    } else {
      tbRefused++;
    }
    if (row.naive) naiveAnyPick++;

    if (row.tracebase && row.naive) {
      if (row.tracebase.matchedFixtureId === row.naive.matchedFixtureId) agreedPick++;
      else disagreedPick++;
    }
    const tbWouldInject = row.tracebase && row.tracebase.tier !== "refused";
    if (!tbWouldInject && row.naive) naiveInjectsWhereTbRefuses++;
  }

  // ---- Print report ----
  console.log("Retrieval-only counterfactual — TraceBase vs naive Jaccard cache");
  console.log(`Fixtures: ${fixtures.length}\n`);

  console.log("Per-query picks:");
  console.log("-".repeat(110));
  console.log(
    "query".padEnd(22) +
      " | " +
      "TB pick (score, tier)".padEnd(38) +
      " | " +
      "naive pick (score)".padEnd(30) +
      " | " +
      "agree?",
  );
  console.log("-".repeat(110));
  for (const row of rows) {
    const tbStr = row.tracebase
      ? `${row.tracebase.matchedFixtureId} (${row.tracebase.score.toFixed(3)}, ${row.tracebase.tier})`
      : "<none>";
    const naiveStr = row.naive
      ? `${row.naive.matchedFixtureId} (${row.naive.score.toFixed(3)})`
      : "<none>";
    let agree = "—";
    if (row.tracebase && row.naive) {
      agree = row.tracebase.matchedFixtureId === row.naive.matchedFixtureId ? "yes" : "NO";
    }
    console.log(
      row.queryFixtureId.padEnd(22) +
        " | " +
        tbStr.padEnd(38) +
        " | " +
        naiveStr.padEnd(30) +
        " | " +
        agree,
    );
  }

  console.log("\n=== Aggregates ===");
  console.log(`TraceBase: pick rate ${tbAnyPick}/${fixtures.length}`);
  console.log(`  by tier:  full=${tbFull}  hint=${tbHint}  refused=${tbRefused}`);
  console.log(`Naive:     pick rate ${naiveAnyPick}/${fixtures.length} (no gate; any overlap injects)`);
  console.log(
    `Agreement on top pick (when both pick): ${agreedPick} agreed / ${disagreedPick} disagreed`,
  );
  console.log(
    `Noise-control wins: ${naiveInjectsWhereTbRefuses}/${fixtures.length} cases where naive would inject but TraceBase refuses`,
  );

  // ---- Persist machine-readable output ----
  const outDir = join(baseDir, "results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const out = {
    timestamp: Date.now(),
    fixtureCount: fixtures.length,
    gateFull: GATE_FULL,
    gateHint: GATE_HINT,
    rows,
    aggregate: {
      tbAnyPick,
      tbFull,
      tbHint,
      tbRefused,
      naiveAnyPick,
      agreedPick,
      disagreedPick,
      naiveInjectsWhereTbRefuses,
    },
  };
  const outPath = join(outDir, "retrieval-comparison.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main();
