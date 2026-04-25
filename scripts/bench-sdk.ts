/**
 * In-process bench for the 0.5.4 SDK runtime + 0.5.5 auto-sync
 * coordinator hot path. Measures the runtime methods at warm
 * latency (no `npx` cold-start overhead) and asserts the sync
 * coordinator NEVER blocks any hot path with a fetch.
 *
 * Targets / ceilings per PLAN-0.5.4 §7:
 *   - runtime.beforeRun warm           : target 50 ms,  ceiling 150 ms
 *   - runtime.observeToolBatch (8 calls): target 30 ms,  ceiling 200 ms
 *   - runtime.saveContext warm         : target 200 ms, ceiling 2000 ms
 *
 * Hot-path fetch invariant (PLAN-0.5.4 §2.1 + §5.1):
 *   - Every runtime method completes WITHOUT touching the network.
 *   - The bench replaces `globalThis.fetch` with an instrumented
 *     stub and asserts zero calls during runtime methods.
 *
 * Run: `npm run bench:sdk` (after `npm run build`).
 *
 * Output: `bench-results/sdk-<pkg.version>.json`. CI gate fails
 * when any release-gated fixture exceeds its CEILING. Target
 * misses (above target, under ceiling) are documented with a
 * one-line rationale per §7.1 escalation rule.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  { hook: "runtime.beforeRun", target_ms: 50, ceiling_ms: 150, release_gate: true },
  { hook: "runtime.observeToolBatch", target_ms: 30, ceiling_ms: 200, release_gate: true },
  { hook: "runtime.saveContext", target_ms: 200, ceiling_ms: 2000, release_gate: true },
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
  fetchCallsDuringRun: number;
}

const WARMUP = 5;
const RUNS = 100;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Replace globalThis.fetch with a counter so we can assert NO
 * runtime method ever calls fetch on its hot path. The auto-sync
 * coordinator's debounce timer fires fetch eventually, but never
 * synchronously inside a method call.
 */
function instrumentFetch(): { restore: () => void; getCalls: () => number } {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = orig;
    },
    getCalls: () => calls,
  };
}

async function setupProject(): Promise<{ projectDir: string; cleanup: () => void }> {
  const projectDir = mkdtempSync(join(tmpdir(), "tb-bench-sdk-"));
  // Late-imports to keep the bench harness build-light. The repo
  // must be built (`npm run build`) so dist/ exposes the package
  // surface; importing directly from src/ via tsx is fine for dev.
  const { initConfig } = await import("../src/core/config.js");
  initConfig(projectDir);
  return {
    projectDir,
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

async function seedBlock(projectDir: string): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  const { BlockStore } = await import("../src/core/block-store.js");
  const { loadConfig } = await import("../src/core/config.js");
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);
  // 50 distinct blocks. The fingerprint normaliser strips many
  // tokens, so we explicitly stamp each block with `fp-bench-${i}`
  // mirroring what `scripts/bench-hooks.ts` does — the bench
  // measures recall against a populated FTS index, not the
  // distillation pipeline.
  const FRAMEWORKS = ["pytest", "vitest", "jest", "mocha", "tap"];
  const now = Date.now();
  for (let i = 0; i < 50; i++) {
    const fw = FRAMEWORKS[i % FRAMEWORKS.length]!;
    store.storeBlock({
      id: `bench-block-${i}`,
      version: 1,
      kind: "success",
      createdAt: now,
      updatedAt: now,
      status: "candidate",
      trigger: {
        situation: `Bench block #${i} — ${fw} collection picks up the wrong package on fresh clone variant ${i}`,
        fingerprint: `fp-bench-${i}`,
        keywords: [`bench-${i}`, fw, "collection", "shadow", "sys.path"],
        invariants: { language: "python", framework: fw, apiSurface: [] },
      },
      body: {
        mechanism: `shadow helper variant ${i} picks up earlier in sys.path than the intended namespace package`,
        deadEnds: [],
        unlock: `remove the variant-${i} shadow directory or rename helper-${i}`,
        verification: `${fw} --collect-only lists only the intended package`,
      },
      provenance: {
        sourceTaskId: `bench-${i}`,
        extractedFrom: "trajectory",
        distilledAt: now,
        distilledBy: "rule",
      },
      stats: {
        timesRetrieved: 0,
        timesInjected: 0,
        timesAgentUsed: 0,
        timesHelpful: 0,
        timesCounterproductive: 0,
        cumulativeTokensSaved: 0,
        cumulativeStepsSaved: 0,
      },
      quality: { confidence: 0.5, wilsonLowerBound: 0 },
    });
    store.attachCaseRef({
      blockId: `bench-block-${i}`,
      traceId: `bench-trace-${i}`,
      role: "origin",
      evidenceQuality: "strong",
    });
    store.updateBlockStatus(`bench-block-${i}`, "active");
  }
  store.close();
}

async function fixtureBeforeRun(): Promise<FixtureResult> {
  const { projectDir, cleanup } = await setupProject();
  await seedBlock(projectDir);
  const { ReasoningLayer } = await import("../src/core/engine.js");
  const { createRuntime } = await import("../src/sdk/runtime.js");
  const layer = new ReasoningLayer();
  const runtime = createRuntime(layer, {
    projectPath: projectDir,
    autoSync: false, // bench measures runtime only; coordinator covered separately
  });
  const fetchInstr = instrumentFetch();
  try {
    const durations: number[] = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const start = process.hrtime.bigint();
      await runtime.beforeRun({
        prompt: "Pytest collects the wrong package on a fresh clone — sys.path shadow shows up",
      });
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1e6;
      if (i >= WARMUP) durations.push(ms);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = quantile(sorted, 0.95);
    const budget = BUDGETS.find((b) => b.hook === "runtime.beforeRun")!;
    return {
      hook: "runtime.beforeRun",
      target_ms: budget.target_ms,
      ceiling_ms: budget.ceiling_ms,
      release_gate: budget.release_gate,
      runs: durations.length,
      p50_ms: round2(quantile(sorted, 0.5)),
      p95_ms: round2(p95),
      p99_ms: round2(quantile(sorted, 0.99)),
      max_ms: round2(sorted[sorted.length - 1] ?? 0),
      exceedsTarget: p95 > budget.target_ms,
      exceedsCeiling: p95 > budget.ceiling_ms,
      fetchCallsDuringRun: fetchInstr.getCalls(),
    };
  } finally {
    fetchInstr.restore();
    await runtime.close();
    cleanup();
  }
}

async function fixtureObserveToolBatch(): Promise<FixtureResult> {
  const { projectDir, cleanup } = await setupProject();
  const { ReasoningLayer } = await import("../src/core/engine.js");
  const { createRuntime } = await import("../src/sdk/runtime.js");
  const layer = new ReasoningLayer();
  const runtime = createRuntime(layer, {
    projectPath: projectDir,
    autoSync: false,
  });
  const fetchInstr = instrumentFetch();
  try {
    const durations: number[] = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const calls = Array.from({ length: 8 }, (_, j) => ({
        toolName: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "Read", "Grep"][j]!,
        toolInput: { file_path: join(projectDir, `f${i}_${j}.ts`), pattern: "x", command: "npm" },
      }));
      const start = process.hrtime.bigint();
      await runtime.observeToolBatch({
        sessionId: `bench-sess-${i}`,
        projectPath: projectDir,
        toolCalls: calls,
      });
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1e6;
      if (i >= WARMUP) durations.push(ms);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = quantile(sorted, 0.95);
    const budget = BUDGETS.find((b) => b.hook === "runtime.observeToolBatch")!;
    return {
      hook: "runtime.observeToolBatch",
      target_ms: budget.target_ms,
      ceiling_ms: budget.ceiling_ms,
      release_gate: budget.release_gate,
      runs: durations.length,
      p50_ms: round2(quantile(sorted, 0.5)),
      p95_ms: round2(p95),
      p99_ms: round2(quantile(sorted, 0.99)),
      max_ms: round2(sorted[sorted.length - 1] ?? 0),
      exceedsTarget: p95 > budget.target_ms,
      exceedsCeiling: p95 > budget.ceiling_ms,
      fetchCallsDuringRun: fetchInstr.getCalls(),
    };
  } finally {
    fetchInstr.restore();
    await runtime.close();
    cleanup();
  }
}

async function fixtureSaveContext(): Promise<FixtureResult> {
  const { projectDir, cleanup } = await setupProject();
  const { ReasoningLayer } = await import("../src/core/engine.js");
  const { createRuntime } = await import("../src/sdk/runtime.js");
  const layer = new ReasoningLayer();
  const runtime = createRuntime(layer, {
    projectPath: projectDir,
    autoSync: false,
  });
  const fetchInstr = instrumentFetch();
  // Realistic-ish 12-turn conversation. Each turn ~80-120 chars to
  // stress the digest extractor without spilling into MAX_DIGEST_CHARS.
  const turns = Array.from({ length: 12 }, (_, i) => {
    const role = i % 2 === 0 ? ("user" as const) : ("assistant" as const);
    const content =
      role === "user"
        ? `What about the migration runner step ${i} — anything I should pay attention to in the script?`
        : `## Step ${i}\n\nThe runner expects a clean schema state — drop the legacy table first, then apply the migration in a single transaction.\n\n- Drop legacy_users\n- Apply 0042_user_schema\n- Verify with SELECT count`;
    return { role, content };
  });
  try {
    const durations: number[] = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const start = process.hrtime.bigint();
      await runtime.saveContext({
        sessionId: `bench-ctx-${i}`,
        projectPath: projectDir,
        turns,
      });
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1e6;
      if (i >= WARMUP) durations.push(ms);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = quantile(sorted, 0.95);
    const budget = BUDGETS.find((b) => b.hook === "runtime.saveContext")!;
    return {
      hook: "runtime.saveContext",
      target_ms: budget.target_ms,
      ceiling_ms: budget.ceiling_ms,
      release_gate: budget.release_gate,
      runs: durations.length,
      p50_ms: round2(quantile(sorted, 0.5)),
      p95_ms: round2(p95),
      p99_ms: round2(quantile(sorted, 0.99)),
      max_ms: round2(sorted[sorted.length - 1] ?? 0),
      exceedsTarget: p95 > budget.target_ms,
      exceedsCeiling: p95 > budget.ceiling_ms,
      fetchCallsDuringRun: fetchInstr.getCalls(),
    };
  } finally {
    fetchInstr.restore();
    await runtime.close();
    cleanup();
  }
}

/**
 * Hot-path no-fetch invariant. Exercises every runtime method
 * with autoSync ENABLED and asserts NO fetch landed during the
 * synchronous portion of any call. The coordinator's debounce
 * timer can fire afterward; we just prove it doesn't land
 * synchronously inside the methods.
 */
async function fixtureMarkDirtyNoFetch(): Promise<{
  ok: boolean;
  fetchCallsDuringRun: number;
}> {
  const { projectDir, cleanup } = await setupProject();
  const { ReasoningLayer } = await import("../src/core/engine.js");
  const { createRuntime } = await import("../src/sdk/runtime.js");
  const layer = new ReasoningLayer();
  const runtime = createRuntime(layer, {
    projectPath: projectDir,
    sessionId: "bench-no-fetch",
    autoSync: true, // explicitly on to prove the hot path is still clean
  });
  const fetchInstr = instrumentFetch();
  try {
    for (let i = 0; i < 20; i++) {
      await runtime.beforeRun({
        prompt: "Long enough prompt to bypass the trivial gate handily here",
      });
      await runtime.observeToolBatch({
        sessionId: "bench-no-fetch",
        projectPath: projectDir,
        toolCalls: [{ toolName: "Read", toolInput: { file_path: join(projectDir, "x.ts") } }],
      });
      await runtime.afterRun({
        userText: "ask",
        assistantText: "answer",
        sessionId: "bench-no-fetch",
      });
    }
    const calls = fetchInstr.getCalls();
    return { ok: calls === 0, fetchCallsDuringRun: calls };
  } finally {
    fetchInstr.restore();
    await runtime.close();
    cleanup();
  }
}

async function main(): Promise<void> {
  mkdirSync(resultsDir, { recursive: true });
  console.log(`TraceBase bench-sdk — version ${pkg.version}`);
  console.log(`runs per fixture: ${RUNS} (after ${WARMUP} warmups)`);
  console.log("");

  const results: FixtureResult[] = [];
  results.push(await fixtureBeforeRun());
  results.push(await fixtureObserveToolBatch());
  results.push(await fixtureSaveContext());
  const noFetch = await fixtureMarkDirtyNoFetch();

  for (const r of results) {
    let status: string;
    if (r.exceedsCeiling) status = r.release_gate ? "FAIL" : "warn";
    else if (r.exceedsTarget) status = "miss"; // documented per §7.1
    else status = "pass";
    console.log(
      `  ${status.padEnd(4)}  ${r.hook.padEnd(28)}  p50=${r.p50_ms}ms p95=${r.p95_ms}ms p99=${r.p99_ms}ms max=${r.max_ms}ms (target ${r.target_ms} / ceiling ${r.ceiling_ms} / fetch=${r.fetchCallsDuringRun})`,
    );
  }
  console.log("");
  console.log(
    `  ${noFetch.ok ? "pass" : "FAIL"}  hot-path-no-fetch              fetchCallsDuringRun=${noFetch.fetchCallsDuringRun} (expected 0)`,
  );
  console.log("");

  const resultsPath = join(resultsDir, `sdk-${pkg.version}.json`);
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        version: pkg.version,
        timestamp: new Date().toISOString(),
        runs: RUNS,
        warmup: WARMUP,
        results,
        hotPathNoFetch: noFetch,
      },
      null,
      2,
    ),
  );
  console.log(`results: ${resultsPath}`);

  const ceilingFailures = results.filter((r) => r.exceedsCeiling && r.release_gate);
  if (ceilingFailures.length > 0 || !noFetch.ok) {
    console.error("");
    if (ceilingFailures.length > 0) {
      console.error(`[bench:sdk] ${ceilingFailures.length} fixture(s) exceeded the CEILING:`);
      for (const f of ceilingFailures) {
        console.error(`  - ${f.hook}: p95=${f.p95_ms}ms > ceiling ${f.ceiling_ms}ms`);
      }
    }
    if (!noFetch.ok) {
      console.error(`[bench:sdk] hot-path-no-fetch FAILED: ${noFetch.fetchCallsDuringRun} fetch call(s) landed during runtime methods`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[bench:sdk] crashed:", err);
  process.exit(2);
});

if (!existsSync(resultsDir)) {
  // ensure dir even if the import order skipped main
  mkdirSync(resultsDir, { recursive: true });
}
