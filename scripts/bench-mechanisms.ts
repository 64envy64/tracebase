/**
 * Mechanism micro-benches — paths added in 0.7.0 rc cycle that the
 * existing `bench-hooks.ts` and `bench-sdk.ts` don't cover.
 *
 * Hot paths benched here:
 *   - prompt-cache.attach   : Anthropic `cache_control` attachment
 *                             (string-system + array-system shapes,
 *                             idempotency check). Attached on every
 *                             wrapped Anthropic call when the model
 *                             is in the supported list.
 *   - mechanism-savings.compute: aggregator over a synthetic 1k-event
 *                             store (context.folded + file_memory.
 *                             recalled + tool_supervision.* +
 *                             cache.prompt_hit). Exercised on every
 *                             `tracebase impact` and `tracebase
 *                             usage` invocation.
 *
 * Targets / ceilings (PLAN-0.7 §6 stable gates §1):
 *   - prompt-cache.attach (string)        : target 0.05 ms, ceiling 1 ms
 *   - prompt-cache.attach (array of 8)    : target 0.10 ms, ceiling 1 ms
 *   - mechanism-savings.compute (1k events): target 30 ms, ceiling 200 ms
 *
 * Run: `npm run build` first, then `tsx scripts/bench-mechanisms.ts`.
 * Output: `bench-results/mechanisms-<pkg.version>.json`. Aggregated
 * by `bench-gate.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { attachAnthropicCacheControl } from "../src/middleware/prompt-cache.js";
import { computeMechanismSavings } from "../src/analytics/mechanism-savings.js";
import { BlockStore } from "../src/core/block-store.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const resultsDir = join(repoRoot, "bench-results");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  version: string;
};

interface Budget {
  hook: string;
  target_ms: number;
  ceiling_ms: number;
  release_gate: boolean;
}

const BUDGETS: Budget[] = [
  { hook: "prompt-cache.attach.string", target_ms: 0.05, ceiling_ms: 1, release_gate: true },
  { hook: "prompt-cache.attach.array8", target_ms: 0.10, ceiling_ms: 1, release_gate: true },
  { hook: "mechanism-savings.compute.1k", target_ms: 30, ceiling_ms: 200, release_gate: true },
];

interface FixtureResult {
  hook: string;
  target_ms: number;
  ceiling_ms: number;
  release_gate: boolean;
  runs: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  exceedsTarget: boolean;
  exceedsCeiling: boolean;
}

const WARMUP = 50;
const RUNS = 1000;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function bench(hook: string, fn: () => void | Promise<void>): Promise<FixtureResult> {
  // Warmup: discard so JIT settles.
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const budget = BUDGETS.find((b) => b.hook === hook)!;
  const max = samples[samples.length - 1]!;
  return {
    hook,
    target_ms: budget.target_ms,
    ceiling_ms: budget.ceiling_ms,
    release_gate: budget.release_gate,
    runs: samples.length,
    p50_ms: round3(quantile(samples, 0.5)),
    p95_ms: round3(quantile(samples, 0.95)),
    p99_ms: round3(quantile(samples, 0.99)),
    max_ms: round3(max),
    exceedsTarget: round3(quantile(samples, 0.95)) > budget.target_ms,
    exceedsCeiling: round3(quantile(samples, 0.95)) > budget.ceiling_ms,
  };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function buildSyntheticEvents(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tb-bench-mech-"));
  const dbPath = join(dir, "store.db");
  const db = new Database(dbPath);
  const store = new BlockStore(db);

  // 250 of each kind = 1000 events, mixed timestamps so window
  // filters have something to chew on.
  const tBase = Date.now() - 7 * 86_400_000;
  for (let i = 0; i < 250; i++) {
    store.appendEvent({
      ts: tBase + i * 1000,
      queryId: `bench-fold-${i}`,
      event: "context.folded",
      sessionId: `s-${i % 8}`,
      chunkRange: `${i * 8}-${(i + 1) * 8 - 1}`,
      tokensBefore: 4000,
      tokensAfter: 200,
      summarizer: "heuristic",
    });
    store.appendEvent({
      ts: tBase + i * 1000 + 100,
      queryId: `bench-fm-${i}`,
      event: "file_memory.recalled",
      fileIds: [`src/a${i}.ts`],
      tokensInjected: 150,
      bytesAvoided: 6000,
    });
    store.appendEvent({
      ts: tBase + i * 1000 + 200,
      queryId: `bench-tool-${i}`,
      event: "tool_supervision.suppressed",
      argKey: `k${i}`,
      toolName: i % 2 === 0 ? "Read" : "Grep",
      blocked: true,
    });
    store.appendEvent({
      ts: tBase + i * 1000 + 300,
      queryId: `bench-cache-${i}`,
      event: "cache.prompt_hit",
      surface: i % 2 === 0 ? "anthropic" : "openai",
      tokensSaved: 800,
    });
  }
  store.close();

  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const results: FixtureResult[] = [];

  // 1. prompt-cache.attach (string)
  results.push(
    await bench("prompt-cache.attach.string", () => {
      attachAnthropicCacheControl({
        model: "claude-sonnet-4-5",
        system: "You are a helpful assistant. Use the prior context provided.",
      });
    }),
  );

  // 2. prompt-cache.attach (array of 8)
  const arrayParams = {
    model: "claude-sonnet-4-5",
    system: Array.from({ length: 8 }, (_, i) => ({
      type: "text",
      text: `system-block-${i}: ${"x".repeat(200)}`,
    })),
  };
  results.push(
    await bench("prompt-cache.attach.array8", () => {
      attachAnthropicCacheControl(arrayParams);
    }),
  );

  // 3. mechanism-savings.compute over 1k events
  const synth = buildSyntheticEvents();
  try {
    const dbReadOnly = new Database(synth.dbPath, { readonly: true });
    const storeReadOnly = new BlockStore(dbReadOnly, { skipMigrate: true });
    try {
      results.push(
        await bench("mechanism-savings.compute.1k", () => {
          computeMechanismSavings(storeReadOnly);
        }),
      );
    } finally {
      storeReadOnly.close();
    }
  } finally {
    synth.cleanup();
  }

  // Persist
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `mechanisms-${pkg.version}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        version: pkg.version,
        ts: new Date().toISOString(),
        results,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`wrote ${outPath}\n`);

  // Print
  for (const r of results) {
    const status = r.exceedsCeiling ? "FAIL" : r.exceedsTarget ? "OVER" : "OK";
    process.stdout.write(
      `[${status}] ${r.hook}  p50=${r.p50_ms}ms p95=${r.p95_ms}ms p99=${r.p99_ms}ms ` +
        `(target=${r.target_ms}ms ceiling=${r.ceiling_ms}ms)\n`,
    );
  }

  const anyCeilingMiss = results.some((r) => r.release_gate && r.exceedsCeiling);
  if (anyCeilingMiss) {
    process.stderr.write("BENCH FAIL: at least one mechanism path exceeded its ceiling.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`bench-mechanisms crashed: ${err}\n`);
  process.exit(2);
});
