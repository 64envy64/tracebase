/**
 * `bench-gate.ts` — single release-acceptance entry point that
 * runs every gated bench + the eval harness in sequence and exits
 * non-zero if any gate fails.
 *
 * What it runs (PLAN-0.7 §6 stable gates §1):
 *   1. `bench:hooks`        — inject-context, capture-turn,
 *                             capture-context, capture-tool-use
 *                             (existing 0.5.x + 0.7 paths).
 *   2. `bench:sdk`          — runtime.beforeRun, observeToolBatch,
 *                             saveContext (SDK warm latency).
 *   3. `bench:mechanisms`   — prompt-cache.attach, mechanism-
 *                             savings.compute (0.7-rc.7 paths).
 *   4. `eval:retrieval`     — prior_fix + file_memory + context_fold
 *                             goldens with Recall@5/nDCG@5/MRR.
 *
 * Each child writes its own per-version result file under
 * `bench-results/`. This script consolidates pass/fail signal
 * into one summary and a single exit code.
 *
 * Wired as `npm run bench:gate`. CI / release acceptance fails
 * the build if this exits non-zero.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const resultsDir = join(repoRoot, "bench-results");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  version: string;
};

interface Stage {
  /** npm script name (`npm run <stage.script>`). */
  script: string;
  /** Human-readable label. */
  label: string;
}

const STAGES: Stage[] = [
  { script: "bench:hooks", label: "Hook latency (inject/capture-turn/capture-context/capture-tool-use)" },
  { script: "bench:sdk", label: "SDK warm latency (beforeRun/observeToolBatch/saveContext)" },
  { script: "bench:mechanisms", label: "Mechanism micro-benches (prompt-cache.attach + savings.compute)" },
  { script: "eval:retrieval", label: "Retrieval eval (prior_fix + file_memory + context_fold goldens)" },
];

interface StageResult {
  script: string;
  label: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function runStage(stage: Stage): StageResult {
  const t0 = Date.now();
  const res = spawnSync("npm", ["run", "--silent", stage.script], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    script: stage.script,
    label: stage.label,
    exitCode: res.status ?? 1,
    durationMs: Date.now() - t0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function main(): void {
  const results: StageResult[] = [];
  let firstFailure: StageResult | null = null;

  for (const stage of STAGES) {
    process.stdout.write(`\n=== ${stage.label} ===\n`);
    const res = runStage(stage);
    results.push(res);
    // Pass through the child's stdout/stderr so the operator
    // can see per-stage detail without opening JSON files.
    process.stdout.write(res.stdout);
    if (res.stderr.length > 0) process.stderr.write(res.stderr);
    process.stdout.write(
      `--- ${stage.script}: ${res.exitCode === 0 ? "PASS" : "FAIL"} (${res.durationMs}ms)\n`,
    );
    if (res.exitCode !== 0 && firstFailure === null) firstFailure = res;
  }

  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `gate-${pkg.version}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        version: pkg.version,
        ts: new Date().toISOString(),
        passed: firstFailure === null,
        stages: results.map((r) => ({
          script: r.script,
          label: r.label,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`\nwrote ${outPath}\n`);

  process.stdout.write("\nGATE SUMMARY:\n");
  for (const r of results) {
    const status = r.exitCode === 0 ? "PASS" : "FAIL";
    process.stdout.write(`  [${status}] ${r.script.padEnd(20)} ${r.durationMs}ms\n`);
  }

  if (firstFailure) {
    process.stderr.write(
      `\nGATE FAIL: ${firstFailure.script} exited ${firstFailure.exitCode}.\n` +
        "Release blocked until all stages pass.\n",
    );
    process.exit(1);
  }
  process.stdout.write("\nGATE PASS — all release-acceptance stages green.\n");
}

main();
