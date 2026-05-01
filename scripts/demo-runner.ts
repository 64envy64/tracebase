#!/usr/bin/env node
/**
 * `tsx scripts/demo-runner.ts --task <id> --variant <off|on>`
 *
 * The reproducible YC demo harness. Lays out one comparable run per
 * variant by:
 *
 *   1. Resetting the workspace at `demo-runs/<task>/<variant>-workspace`
 *      to a clean copy of `demo-tasks/<task>/state-<variant>/`
 *      (the recorded final repo state for that variant).
 *   2. Running the task verifier against that workspace and capturing
 *      the real exit code + truncated output.
 *   3. Reading the recorded run transcript at
 *      `demo-tasks/<task>/runs/<variant>.json` for the agent-side
 *      metrics (wall-clock, tool calls, tokens, TraceBase telemetry).
 *   4. Composing a final `RunArtifact` with the recorded transcript
 *      metrics + the freshly-measured verifier result, and writing
 *      it to `demo-runs/<task>/<variant>.json`.
 *
 * The transcript JSONs that ship with each fixture are synthetic
 * baselines — replace them with real-agent recordings before any
 * external demo. The verifier is real either way: state-off contains
 * a broken workspace and check.sh fails; state-on contains the fix
 * and check.sh passes. So even with synthetic transcripts the
 * verifier-agreement column in the report is honest.
 *
 * To wire a real agent loop (Anthropic SDK + tools + MCP for ON),
 * add a `--mode anthropic` branch that builds a fresh workspace from
 * `state-off` for both variants, drives the model, and writes the
 * resulting trajectory back to demo-tasks/.../runs/<variant>.json
 * before falling through to step 2 above. The metric pipeline below
 * doesn't change.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import type {
  RunArtifact,
  TaskDefinition,
  Variant,
  VerifierResult,
} from "../src/demo/types.js";

const TASKS_DIR = resolve("demo-tasks");
const RUNS_DIR = resolve("demo-runs");

interface ParsedArgs {
  task: string;
  variant: Variant;
  skipVerifier: boolean;
}

function usage(): never {
  console.error(
    "Usage: tsx scripts/demo-runner.ts --task <id> --variant <off|on> [--skip-verifier]\n" +
      "Tasks live under demo-tasks/<id>/. Output goes to demo-runs/<id>/<variant>.json.",
  );
  process.exit(2);
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const task = arg(args, "--task");
  const variant = arg(args, "--variant");
  if (!task || !variant) usage();
  if (variant !== "off" && variant !== "on") {
    console.error(`--variant must be off or on; got ${variant}`);
    process.exit(2);
  }
  return {
    task: task!,
    variant: variant as Variant,
    skipVerifier: args.includes("--skip-verifier"),
  };
}

function loadTask(task: string): TaskDefinition {
  const path = join(TASKS_DIR, task, "task.json");
  if (!existsSync(path)) {
    console.error(`No task at ${path}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as TaskDefinition;
}

function loadRecorded(task: string, variant: Variant): RunArtifact {
  const path = join(TASKS_DIR, task, "runs", `${variant}.json`);
  if (!existsSync(path)) {
    console.error(`No recorded transcript at ${path}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as RunArtifact;
}

function resetWorkspace(task: string, variant: Variant): string {
  const stateDir = join(TASKS_DIR, task, `state-${variant}`);
  if (!existsSync(stateDir)) {
    console.error(`No state directory at ${stateDir}`);
    process.exit(2);
  }
  const workspace = join(RUNS_DIR, task, `${variant}-workspace`);
  if (existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true });
  }
  mkdirSync(workspace, { recursive: true });
  cpSync(stateDir, workspace, { recursive: true });
  return workspace;
}

function runVerifier(workspace: string, command: string): VerifierResult {
  const start = performance.now();
  const proc = spawnSync(command, {
    cwd: workspace,
    shell: true,
    encoding: "utf-8",
  });
  const elapsedMs = Math.round(performance.now() - start);
  const exitCode = typeof proc.status === "number" ? proc.status : 1;
  const output = ((proc.stdout ?? "") + (proc.stderr ?? "")).slice(0, 500);
  const pass = exitCode === 0;
  console.log(`Verifier finished in ${elapsedMs}ms — exit ${exitCode} (${pass ? "PASS" : "FAIL"})`);
  return {
    command,
    exitCode,
    pass,
    outputExcerpt: output,
  };
}

function main(): void {
  const { task, variant, skipVerifier } = parseArgs();
  const taskDef = loadTask(task);
  const recorded = loadRecorded(task, variant);

  console.log(`Task: ${taskDef.id}`);
  console.log(`Variant: ${variant}`);
  console.log(
    `Verifier: ${skipVerifier ? "skipped (transcript value retained)" : taskDef.verifier}`,
  );

  let verifier = recorded.verifier;
  if (!skipVerifier) {
    const workspace = resetWorkspace(task, variant);
    verifier = runVerifier(workspace, taskDef.verifier);
  }

  const artifact: RunArtifact = { ...recorded, verifier };
  const outDir = join(RUNS_DIR, task);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${variant}.json`);
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
}

main();
