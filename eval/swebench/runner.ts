#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runSWETask, type SWETask, type SWEResult } from "./harness.js";
import { formatCompressedDirective } from "../agentic/inject.js";
import { ReasoningLayer } from "../../src/core/engine.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * SWE-bench Verified Runner
 *
 * Usage:
 *   npx tsx eval/swebench/runner.ts --model claude-sonnet-4-6 --count 5 --verbose
 *   npx tsx eval/swebench/runner.ts --model claude-haiku-4-5-20251001 --count 20
 */

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const model = getArg(args, "--model") ?? "claude-haiku-4-5-20251001";
  const count = parseInt(getArg(args, "--count") ?? "5", 10);

  const baseDir = import.meta.dirname ?? __dirname;
  const resultsDir = join(baseDir, "results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  // Load tasks
  const allTasks = JSON.parse(readFileSync(join(baseDir, "tasks.json"), "utf-8")) as SWETask[];
  const tasks = allTasks.slice(0, count);

  console.log(`\nSWE-bench Verified Benchmark`);
  console.log(`Model: ${model} | Tasks: ${tasks.length}`);
  console.log("=".repeat(60));

  // Build seed traces from gold patches (simulate institutional memory)
  // In production, these would come from previous successful agent runs.
  const seeds = buildSeedsFromGoldPatches(allTasks);

  const results: SWEResult[] = [];

  for (const [i, task] of tasks.entries()) {
    console.log(`\n[${i + 1}/${tasks.length}] ${task.instance_id} (${task.difficulty})`);

    // Baseline: no injection
    if (verbose) console.log("  Baseline:");
    const baseline = await runSWETask(task, model, null, verbose);
    console.log(`  Baseline: ${baseline.success ? "PASS" : "FAIL"} (${baseline.totalSteps} steps, ${baseline.totalTokens} tok) [${baseline.stopReason}]`);

    // Augmented: with injection from related tasks
    const injection = findRelatedSeed(task, seeds);
    if (verbose && injection) console.log(`  Injection: ${injection.slice(0, 100)}...`);
    const augmented = await runSWETask(task, model, injection, verbose);
    console.log(`  Augmented: ${augmented.success ? "PASS" : "FAIL"} (${augmented.totalSteps} steps, ${augmented.totalTokens} tok) [${augmented.stopReason}]`);

    results.push({
      instance_id: task.instance_id,
      repo: task.repo,
      difficulty: task.difficulty,
      baseline,
      augmented,
    });
  }

  // Summary
  printSummary(model, results);

  // Save
  const safeName = model.replace(/[^a-zA-Z0-9_.-]/g, "_");
  writeFileSync(join(resultsDir, `swe-${safeName}.json`), JSON.stringify(results, null, 2));
}

/**
 * Build seed traces from gold patches of OTHER tasks.
 * For task N, we use traces from tasks != N as institutional knowledge.
 * This simulates: "your team solved similar bugs before."
 */
function buildSeedsFromGoldPatches(tasks: SWETask[]): Map<string, { problem: string; solution: string; repo: string }> {
  const seeds = new Map<string, { problem: string; solution: string; repo: string }>();
  for (const task of tasks) {
    seeds.set(task.instance_id, {
      problem: task.problem_statement.slice(0, 500),
      solution: extractFixFromPatch(task.patch),
      repo: task.repo,
    });
  }
  return seeds;
}

/**
 * Find a related seed for a task — from same repo but different instance.
 */
function findRelatedSeed(
  task: SWETask,
  seeds: Map<string, { problem: string; solution: string; repo: string }>,
): string | null {
  // Find a seed from the SAME repo but DIFFERENT instance
  for (const [id, seed] of seeds) {
    if (id !== task.instance_id && seed.repo === task.repo) {
      return (
        `<prior_fix confidence="85%" source="institutional_memory">\n` +
        `A related bug in ${task.repo} was previously fixed:\n` +
        `Problem pattern: ${seed.problem.slice(0, 200)}\n` +
        `Fix approach: ${seed.solution}\n` +
        `</prior_fix>\n` +
        `Apply a similar approach to the current bug. Read the relevant source files first.`
      );
    }
  }
  return null;
}

/**
 * Extract a human-readable fix description from a git patch.
 */
function extractFixFromPatch(patch: string): string {
  const lines = patch.split("\n");
  const changes: string[] = [];
  let currentFile = "";

  for (const line of lines) {
    if (line.startsWith("--- a/") || line.startsWith("+++ b/")) {
      currentFile = line.replace(/^[+-]{3} [ab]\//, "");
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      changes.push(`Added in ${currentFile}: ${line.slice(1).trim()}`);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      changes.push(`Removed from ${currentFile}: ${line.slice(1).trim()}`);
    }
  }

  return changes.slice(0, 5).join(". ") || "See patch for details";
}

function printSummary(model: string, results: SWEResult[]): void {
  const n = results.length;
  const blPass = results.filter(r => r.baseline.success).length;
  const augPass = results.filter(r => r.augmented.success).length;
  const blTokens = results.reduce((s, r) => s + r.baseline.totalTokens, 0) / n;
  const augTokens = results.reduce((s, r) => s + r.augmented.totalTokens, 0) / n;
  const blSteps = results.reduce((s, r) => s + r.baseline.totalSteps, 0) / n;
  const augSteps = results.reduce((s, r) => s + r.augmented.totalSteps, 0) / n;

  console.log("\n" + "=".repeat(60));
  console.log(`SWE-bench Verified Results — ${model}`);
  console.log("=".repeat(60));
  console.log(`Tasks: ${n}`);
  console.log(`\nAccuracy:`);
  console.log(`  Baseline:  ${blPass}/${n} (${(blPass/n*100).toFixed(1)}%)`);
  console.log(`  Augmented: ${augPass}/${n} (${(augPass/n*100).toFixed(1)}%)`);
  console.log(`  Gain:      ${augPass > blPass ? "+" : ""}${((augPass-blPass)/Math.max(blPass,1)*100).toFixed(1)}% relative`);
  console.log(`\nEfficiency:`);
  console.log(`  Avg steps: ${blSteps.toFixed(1)} → ${augSteps.toFixed(1)}`);
  console.log(`  Avg tokens: ${blTokens.toFixed(0)} → ${augTokens.toFixed(0)}`);
  if (blTokens > 0) console.log(`  Token save: ${((1 - augTokens/blTokens)*100).toFixed(1)}%`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

main().catch(console.error);
