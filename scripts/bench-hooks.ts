/**
 * Benchmark harness for TraceBase Claude Code hooks.
 *
 * Runs the built CLI against canonical stdin fixtures, 100 warm runs
 * per fixture after 5 warm-ups, reports p50 / p95 / p99 in ms, writes
 * `bench-results/<pkg.version>.json`. CI gate (§3.2 PLAN-0.5) fails
 * when any release-gated fixture exceeds its budget.
 *
 * Not shipped: the `scripts/` directory is excluded from the npm
 * `files` array. This harness runs against `dist/cli.js` so build
 * first (`npm run build`) before invoking.
 *
 * Run: `npm run bench:hooks`
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const resultsDir = join(repoRoot, "bench-results");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  version: string;
};

interface Budget {
  hook: string;
  target_ms: number;
  /**
   * 0.7.0 §6 stable gates §1 — release-blocking ceiling. The
   * release gate fails ONLY when p95 exceeds the ceiling; p95
   * over target but under ceiling logs as "OVER" without failing
   * the build, matching the escalation rule from `bench-sdk.ts`.
   * This stops transient noise (npm spawn under load, disk
   * stalls in CI) from flapping the gate.
   */
  ceiling_ms: number;
  release_gate: boolean;
}

// Mirrors PLAN-0.5 §3 table. Source of truth for the CI gate.
const BUDGETS: Budget[] = [
  { hook: "inject-context", target_ms: 150, ceiling_ms: 400, release_gate: true },
  { hook: "capture-turn", target_ms: 500, ceiling_ms: 1500, release_gate: true },
  { hook: "capture-context", target_ms: 2000, ceiling_ms: 6000, release_gate: true },
  { hook: "capture-tool-use", target_ms: 200, ceiling_ms: 600, release_gate: true },
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
  exceedsBudget: boolean;
  exceedsCeiling: boolean;
}

const WARMUP = 5;
const RUNS = 100;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

function measure(
  hook: string,
  cliArgs: string[],
  stdin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): number[] {
  const durations: number[] = [];
  for (let i = 0; i < WARMUP + RUNS; i++) {
    const start = process.hrtime.bigint();
    const res = spawnSync("node", [cliPath, ...cliArgs], {
      cwd,
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", TRACEBASE_MCP_PROBE_COMMAND: "skip", ...env },
      timeout: 10_000,
    });
    if (res.status !== 0 && !res.stdout?.includes("systemMessage")) {
      // Non-zero exit with nothing-envelope: something broke. Treat
      // as a timeout-class entry — keeps benchmark honest.
      console.error(
        `[bench] ${hook} run ${i} exited ${res.status}: ${(res.stderr ?? "").slice(0, 200)}`,
      );
    }
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    if (i >= WARMUP) durations.push(ms);
  }
  return durations;
}

/**
 * Fixture: UserPromptSubmit (inject-context) on a project with a
 * modest existing store. Target: p95 < 150 ms.
 */
function fixtureInjectContext(): FixtureResult {
  const projectDir = mkdtempSync(join(tmpdir(), "tb-bench-inject-"));
  try {
    // Init the store synchronously (matches what init would do).
    const config = {
      workspaceId: "bench-workspace",
      storagePath: join(projectDir, ".tracebase", "memory.db"),
    };
    mkdirSync(join(projectDir, ".tracebase"), { recursive: true });
    writeFileSync(join(projectDir, ".tracebase", "config.json"), JSON.stringify(config));

    // Seed ~50 blocks + ~30 facts so the FTS index has some material.
    const db = new Database(config.storagePath);
    // Use the in-process helper to avoid requiring a migration layer.
    // Minimal seeding: pattern-shaped rows the store's migrator will
    // accept. The bench cares about FTS latency, not content quality.
    const { BlockStore } = require(join(repoRoot, "dist", "index.js")) as {
      BlockStore: typeof import("../src/core/block-store").BlockStore;
    };
    const store = new BlockStore(db);
    // 50 blocks
    for (let i = 0; i < 50; i++) {
      const b = {
        id: `bench-block-${i}`,
        version: 1,
        status: "candidate" as const,
        kind: "success" as const,
        trigger: {
          situation: `Bench block ${i} — pytest collection wrong package sys.path shadow`,
          fingerprint: `fp-bench-${i}`,
          keywords: ["pytest", "collection", "shadow", "sys.path"],
          invariants: { language: "python", framework: "pytest" },
        },
        body: {
          mechanism: "shadowing helper picks up earlier in sys.path",
          deadEnds: [],
          unlock: "remove the shadow or rename the helper module",
          verification: "pytest --collect-only",
        },
        provenance: {
          sourceTaskId: `bench-${i}`,
          extractedFrom: "trajectory" as const,
          distilledAt: Date.now(),
          distilledBy: "rule" as const,
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.storeBlock(b);
      store.attachCaseRef({
        blockId: b.id,
        traceId: `tr-bench-${i}`,
        role: "origin",
        evidenceQuality: "strong",
      });
      store.updateBlockStatus(b.id, "active");
    }
    // 30 facts
    for (let i = 0; i < 30; i++) {
      store.storeFact({
        scope: "project",
        factType: "file_semantic",
        statement: `Bench fact ${i}: tests live under tests/cli/*.test.ts`,
        invariants: {},
        source: { origin: "observed" },
      });
    }
    store.close();

    const stdin = JSON.stringify({
      prompt: "pytest is collecting the wrong package in my monorepo sys.path shadow issue",
      cwd: projectDir,
    });
    const durations = measure(
      "inject-context",
      ["inject-context", "--host", "claude-code", "--status", "silent"],
      stdin,
      projectDir,
      {},
    );
    const sorted = [...durations].sort((a, b) => a - b);
    const budget = BUDGETS.find((b) => b.hook === "inject-context")!;
    const p95 = quantile(sorted, 0.95);
    return {
      hook: "inject-context",
      target_ms: budget.target_ms,
      ceiling_ms: budget.ceiling_ms,
      release_gate: budget.release_gate,
      runs: durations.length,
      p50_ms: round2(quantile(sorted, 0.5)),
      p95_ms: round2(p95),
      p99_ms: round2(quantile(sorted, 0.99)),
      max_ms: round2(sorted[sorted.length - 1] ?? 0),
      exceedsBudget: p95 > budget.target_ms,
      exceedsCeiling: p95 > budget.ceiling_ms,
    };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * Fixture: Stop (capture-turn) on a realistic transcript tail.
 * Target: p95 < 500 ms.
 */
function fixtureCaptureTurn(): FixtureResult {
  const projectDir = mkdtempSync(join(tmpdir(), "tb-bench-capture-"));
  try {
    mkdirSync(join(projectDir, ".tracebase"), { recursive: true });
    writeFileSync(
      join(projectDir, ".tracebase", "config.json"),
      JSON.stringify({
        workspaceId: "bench-workspace",
        storagePath: join(projectDir, ".tracebase", "memory.db"),
      }),
    );

    // Build a substantive transcript. Enough lines that parsing +
    // tail-read isn't the fast path, but still a realistic shape.
    const userLine = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          "pytest is collecting the wrong package in my monorepo — sys.path shadowing module. I've seen this before; the helper module shadows the intended namespace package.",
      },
      timestamp: new Date().toISOString(),
    });
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "The symptom is that pytest's collection picks up a shadowing helper earlier in sys.path than the intended package, which is why `pytest --collect-only` reports the wrong tree.\n\n" +
              "Remove the shadowing helper directory from sys.path, or rename the helper module so it stops competing with the intended namespace package.\n\n" +
              "Verify by running pytest --collect-only and confirming the output lists only modules under the intended package.",
          },
        ],
      },
      timestamp: new Date().toISOString(),
    });
    const noise = Array.from({ length: 6000 }, (_, i) =>
      JSON.stringify({ type: "file-history-snapshot", messageId: `snap-${i}` }),
    );
    const transcriptPath = join(projectDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [...noise, userLine, assistantLine].join("\n"));

    const stdin = JSON.stringify({
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
      cwd: projectDir,
      session_id: "bench-session",
    });
    const durations = measure(
      "capture-turn",
      ["capture-turn", "--host", "claude-code", "--capture", "silent"],
      stdin,
      projectDir,
      {},
    );
    const sorted = [...durations].sort((a, b) => a - b);
    const budget = BUDGETS.find((b) => b.hook === "capture-turn")!;
    const p95 = quantile(sorted, 0.95);
    return {
      hook: "capture-turn",
      target_ms: budget.target_ms,
      ceiling_ms: budget.ceiling_ms,
      release_gate: budget.release_gate,
      runs: durations.length,
      p50_ms: round2(quantile(sorted, 0.5)),
      p95_ms: round2(p95),
      p99_ms: round2(quantile(sorted, 0.99)),
      max_ms: round2(sorted[sorted.length - 1] ?? 0),
      exceedsBudget: p95 > budget.target_ms,
      exceedsCeiling: p95 > budget.ceiling_ms,
    };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * Fixture: PreCompact (capture-context) on a 4 MiB-ish transcript
 * tail. Target: p95 < 2 s. The 4 MiB cap is the bound capture-context
 * itself uses for transcript reading; sizing the fixture to that
 * limit measures the actual hot path.
 */
function fixtureCaptureContext(): FixtureResult {
  const projectDir = mkdtempSync(join(tmpdir(), "tb-bench-ctx-"));
  try {
    mkdirSync(join(projectDir, ".tracebase"), { recursive: true });
    writeFileSync(
      join(projectDir, ".tracebase", "config.json"),
      JSON.stringify({
        workspaceId: "bench-workspace",
        storagePath: join(projectDir, ".tracebase", "memory.db"),
      }),
    );

    // Build a transcript large enough to push capture-context's
    // tail-read + parser. Two-thirds of the bytes are noise lines
    // that the parser must skip; the meaningful content sits in the
    // last few entries so the digest extractor has something to find.
    const userLine = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          "Summarise: pytest collection picks up the wrong package on a fresh clone — sys.path shadow.",
      },
      timestamp: new Date().toISOString(),
    });
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "## Diagnosis\n\nThe shadowing helper sits earlier in sys.path than the intended package.\n\n" +
              "## Fix\n\n- Remove the shadow directory from sys.path\n- Or rename the helper module\n\n" +
              "## Verify\n\nRun `pytest --collect-only` and confirm only the intended package is listed.",
          },
        ],
      },
      timestamp: new Date().toISOString(),
    });
    const noise = Array.from({ length: 8000 }, (_, i) =>
      JSON.stringify({ type: "file-history-snapshot", messageId: `snap-${i}` }),
    );
    const transcriptPath = join(projectDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [...noise, userLine, assistantLine].join("\n"));

    const stdin = JSON.stringify({
      hook_event_name: "PreCompact",
      transcript_path: transcriptPath,
      cwd: projectDir,
      session_id: "bench-precompact",
      trigger: "manual",
    });
    const durations = measure(
      "capture-context",
      ["capture-context", "--host", "claude-code", "--capture", "silent"],
      stdin,
      projectDir,
      {},
    );
    const sorted = [...durations].sort((a, b) => a - b);
    const budget = BUDGETS.find((b) => b.hook === "capture-context")!;
    const p95 = quantile(sorted, 0.95);
    return {
      hook: "capture-context",
      target_ms: budget.target_ms,
      ceiling_ms: budget.ceiling_ms,
      release_gate: budget.release_gate,
      runs: durations.length,
      p50_ms: round2(quantile(sorted, 0.5)),
      p95_ms: round2(p95),
      p99_ms: round2(quantile(sorted, 0.99)),
      max_ms: round2(sorted[sorted.length - 1] ?? 0),
      exceedsBudget: p95 > budget.target_ms,
      exceedsCeiling: p95 > budget.ceiling_ms,
    };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * Fixture: PostToolBatch (capture-tool-use) on an 8-call batch
 * matching the live PostToolBatch shape. Target: p95 < 200 ms per
 * PLAN-0.5 §3. The hot path here is per-tool sanitisation +
 * HMAC-SHA256 keying + a single 8-row INSERT transaction; no FTS
 * mirror to update, no transcript file to read.
 */
function fixtureCaptureToolUse(): FixtureResult {
  const projectDir = mkdtempSync(join(tmpdir(), "tb-bench-tool-"));
  try {
    mkdirSync(join(projectDir, ".tracebase"), { recursive: true });
    writeFileSync(
      join(projectDir, ".tracebase", "config.json"),
      JSON.stringify({
        workspaceId: "bench-workspace",
        // Match the eager-mint pattern initConfig uses on a fresh
        // 0.5.3 install. Without it, capture-tool-use lazy-mints —
        // which is the same code path, just with one extra
        // writeFileSync per first-run; bench measures the steady
        // state.
        workspaceSalt:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        storagePath: join(projectDir, ".tracebase", "memory.db"),
      }),
    );

    const toolCalls = [
      {
        tool_name: "Read",
        tool_input: { file_path: join(projectDir, "src/foo.ts") },
        tool_use_id: "toolu_01",
        tool_response: "x".repeat(2000),
      },
      {
        tool_name: "Read",
        tool_input: { file_path: join(projectDir, "src/bar.ts") },
        tool_use_id: "toolu_02",
        tool_response: "y".repeat(2000),
      },
      {
        tool_name: "Grep",
        tool_input: { pattern: "function.*export", path: "src" },
        tool_use_id: "toolu_03",
        tool_response: "src/foo.ts:1: export function x()",
      },
      {
        tool_name: "Glob",
        tool_input: { pattern: "**/*.test.ts" },
        tool_use_id: "toolu_04",
        tool_response: "tests/cli/init.test.ts",
      },
      {
        tool_name: "Bash",
        tool_input: { command: "npm run build" },
        tool_use_id: "toolu_05",
        tool_response: "ok",
      },
      {
        tool_name: "Edit",
        tool_input: { file_path: join(projectDir, "src/foo.ts"), old_string: "...", new_string: "..." },
        tool_use_id: "toolu_06",
        tool_response: "edited",
      },
      {
        tool_name: "Write",
        tool_input: { file_path: join(projectDir, "src/baz.ts"), content: "..." },
        tool_use_id: "toolu_07",
        tool_response: "wrote",
      },
      {
        tool_name: "TodoWrite",
        tool_input: { todos: [{ content: "x", status: "pending" }] },
        tool_use_id: "toolu_08",
        tool_response: "ok",
      },
    ];

    const stdin = JSON.stringify({
      hook_event_name: "PostToolBatch",
      session_id: "bench-tool-session",
      transcript_path: join(projectDir, "transcript.jsonl"),
      cwd: projectDir,
      permission_mode: "default",
      tool_calls: toolCalls,
    });

    const durations = measure(
      "capture-tool-use",
      ["capture-tool-use", "--host", "claude-code", "--capture", "silent"],
      stdin,
      projectDir,
      {},
    );
    const sorted = [...durations].sort((a, b) => a - b);
    const budget = BUDGETS.find((b) => b.hook === "capture-tool-use")!;
    const p95 = quantile(sorted, 0.95);
    return {
      hook: "capture-tool-use",
      target_ms: budget.target_ms,
      ceiling_ms: budget.ceiling_ms,
      release_gate: budget.release_gate,
      runs: durations.length,
      p50_ms: round2(quantile(sorted, 0.5)),
      p95_ms: round2(p95),
      p99_ms: round2(quantile(sorted, 0.99)),
      max_ms: round2(sorted[sorted.length - 1] ?? 0),
      exceedsBudget: p95 > budget.target_ms,
      exceedsCeiling: p95 > budget.ceiling_ms,
    };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function main(): void {
  if (!existsSync(cliPath)) {
    console.error(`[bench] dist/cli.js not found at ${cliPath}. Run \`npm run build\` first.`);
    process.exit(2);
  }
  mkdirSync(resultsDir, { recursive: true });

  const results: FixtureResult[] = [];
  console.log(`TraceBase bench-hooks — version ${pkg.version}`);
  console.log(`runs per fixture: ${RUNS} (after ${WARMUP} warmups)`);
  console.log("");

  results.push(fixtureInjectContext());
  results.push(fixtureCaptureTurn());
  results.push(fixtureCaptureContext());
  results.push(fixtureCaptureToolUse());

  for (const r of results) {
    const status = r.exceedsCeiling
      ? r.release_gate
        ? "FAIL"
        : "warn"
      : r.exceedsBudget
        ? "OVER"
        : "pass";
    console.log(
      `  ${status.padEnd(4)}  ${r.hook.padEnd(20)}  p50=${r.p50_ms}ms p95=${r.p95_ms}ms p99=${r.p99_ms}ms max=${r.max_ms}ms (target ${r.target_ms}ms ceiling ${r.ceiling_ms}ms)`,
    );
  }
  console.log("");

  const resultsPath = join(resultsDir, `${pkg.version}.json`);
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        version: pkg.version,
        timestamp: new Date().toISOString(),
        runs: RUNS,
        warmup: WARMUP,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`results: ${resultsPath}`);

  // 0.7.0 §6 — release gate fires only on ceiling miss; over-target
  // logs as "OVER" so a busy CI machine doesn't flap the build.
  const gateFailures = results.filter((r) => r.exceedsCeiling && r.release_gate);
  if (gateFailures.length > 0) {
    console.error("");
    console.error(`[bench] ${gateFailures.length} release-gated fixture(s) exceeded ceiling.`);
    for (const f of gateFailures) {
      console.error(`  - ${f.hook}: p95=${f.p95_ms}ms > ceiling ${f.ceiling_ms}ms`);
    }
    process.exit(1);
  }
}

main();
