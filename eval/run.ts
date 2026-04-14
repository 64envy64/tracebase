#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runBenchmark, type SeedTrace } from "./harness.js";
import { MockAgent } from "./agents/mock-agent.js";
import { LLMAgent } from "./agents/llm-agent.js";
import type { EvalTask, BenchmarkResults } from "./types.js";

/**
 * CLI entry point for the TraceBase eval framework.
 *
 * Usage:
 *   npx tsx eval/run.ts                                   # Mock agent, all tasks
 *   npx tsx eval/run.ts --model claude-haiku-4-5-20251001  # Real model
 *   npx tsx eval/run.ts --model claude-opus-4-6 --verbose  # Verbose
 *   npx tsx eval/run.ts --all                              # All 6 real models
 */
const ALL_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "gpt-5.4-nano",
  "gpt-5.4-mini",
  "gpt-5.3-chat",
];

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const runAll = args.includes("--all");
  const modelArg = getArg(args, "--model");
  const taskFilter = getArg(args, "--tasks");

  const baseDir = import.meta.dirname ?? __dirname;
  const tasksDir = join(baseDir, "tasks");
  const resultsDir = join(baseDir, "results");

  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  // Load tasks
  const tasks = loadAllTasks(tasksDir, taskFilter);
  // Load all seed traces (seeds.jsonl + seeds-hard.jsonl etc.)
  const seeds = loadSeeds(tasksDir);

  console.log(`\nTraceBase Benchmark — ${tasks.length} tasks, ${seeds.length} seed traces`);
  console.log("=".repeat(60));

  const models = runAll ? ALL_MODELS : modelArg ? [modelArg] : [];

  if (models.length === 0) {
    // Mock agent fallback
    console.log("Agent: mock (use --model or --all for real models)\n");
    const agent = new MockAgent();
    const result = await runBenchmark(agent, tasks, { verbose, seeds });
    printSummary(result);
    saveResult(resultsDir, "mock", result);
    return;
  }

  const allResults: BenchmarkResults[] = [];

  for (const model of models) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Model: ${model}`);
    console.log("=".repeat(60));

    const agent = new LLMAgent(model);
    const result = await runBenchmark(agent, tasks, { verbose, seeds });
    printSummary(result);
    saveResult(resultsDir, model, result);
    allResults.push(result);
  }

  // Save combined results
  if (allResults.length > 1) {
    writeFileSync(
      join(resultsDir, "all-models.json"),
      JSON.stringify(allResults, null, 2),
    );

    console.log("\n" + "=".repeat(60));
    console.log("CROSS-MODEL COMPARISON");
    console.log("=".repeat(60));
    console.log("\nAccuracy:");
    console.log("  Model".padEnd(35) + "Baseline".padEnd(12) + "+ TraceBase".padEnd(14) + "Gain");
    console.log("  " + "-".repeat(65));
    for (const r of allResults) {
      const bl = (r.baseline.successRate * 100).toFixed(1) + "%";
      const aug = (r.augmented.successRate * 100).toFixed(1) + "%";
      const gain = "+" + r.delta.successRateDelta.toFixed(1) + " pp";
      console.log(`  ${r.agentName.padEnd(33)} ${bl.padEnd(12)}${aug.padEnd(14)}${gain}`);
    }

    console.log("\nEfficiency:");
    console.log("  Model".padEnd(35) + "Avg Token Save".padEnd(18) + "Recall Hit");
    console.log("  " + "-".repeat(65));
    for (const r of allResults) {
      const tok = r.delta.tokenSavingsPercent.toFixed(1) + "%";
      const hit = (r.delta.recallHitRate * 100).toFixed(1) + "%";
      console.log(`  ${r.agentName.padEnd(33)} ${tok.padEnd(18)}${hit}`);
    }
  }
}

function loadAllTasks(dir: string, filter?: string): EvalTask[] {
  const tasks: EvalTask[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("seeds"));
  for (const file of files) {
    if (filter && !file.includes(filter)) continue;
    const content = readFileSync(join(dir, file), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { tasks.push(JSON.parse(trimmed) as EvalTask); } catch { /* skip */ }
    }
  }
  return tasks;
}

function loadSeeds(dir: string): SeedTrace[] {
  const seeds: SeedTrace[] = [];
  const files = readdirSync(dir).filter((f) => f.startsWith("seeds") && f.endsWith(".jsonl"));
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { seeds.push(JSON.parse(trimmed) as SeedTrace); } catch { /* skip */ }
    }
  }
  return seeds;
}

function printSummary(r: BenchmarkResults): void {
  console.log("\n--- All Tasks ---");
  console.log(`  Baseline:  ${(r.baseline.successRate * 100).toFixed(1)}% success, ${r.baseline.avgTokens.toFixed(0)} avg tokens`);
  console.log(`  Augmented: ${(r.augmented.successRate * 100).toFixed(1)}% success, ${r.augmented.avgTokens.toFixed(0)} avg tokens`);
  console.log(`  Delta:     ${r.delta.successRateDelta >= 0 ? "+" : ""}${r.delta.successRateDelta.toFixed(1)} pp accuracy, ${r.delta.tokenSavingsPercent >= 0 ? "-" : "+"}${Math.abs(r.delta.tokenSavingsPercent).toFixed(1)}% tokens`);
  console.log(`  Recall:    ${(r.delta.recallHitRate * 100).toFixed(1)}% hit rate`);

  // High-confidence matches subset (like ReasonBlocks reports)
  const highConf = r.perTask.filter((t) => t.augmented.recallHit && (t.augmented.injectedScore ?? 0) > 0.5);
  if (highConf.length > 0 && highConf.length < r.taskCount) {
    const hcBaselineSuccess = highConf.filter((t) => t.baseline.success).length;
    const hcAugSuccess = highConf.filter((t) => t.augmented.success).length;
    const hcBaselineTokens = highConf.reduce((s, t) => s + t.baseline.tokensUsed, 0) / highConf.length;
    const hcAugTokens = highConf.reduce((s, t) => s + t.augmented.tokensUsed, 0) / highConf.length;
    const hcTokenSave = hcBaselineTokens > 0 ? ((hcBaselineTokens - hcAugTokens) / hcBaselineTokens * 100) : 0;

    // Peak token save (best single-task saving)
    let peakSave = 0;
    for (const t of highConf) {
      if (t.baseline.tokensUsed > 0) {
        const save = (t.baseline.tokensUsed - t.augmented.tokensUsed) / t.baseline.tokensUsed * 100;
        if (save > peakSave) peakSave = save;
      }
    }

    console.log(`\n--- High-Confidence Matches (${highConf.length}/${r.taskCount} tasks, recall score > 50%) ---`);
    console.log(`  Baseline:  ${(hcBaselineSuccess / highConf.length * 100).toFixed(1)}% success`);
    console.log(`  Augmented: ${(hcAugSuccess / highConf.length * 100).toFixed(1)}% success`);
    console.log(`  Gain:      +${((hcAugSuccess - hcBaselineSuccess) / Math.max(hcBaselineSuccess, 1) * 100).toFixed(1)}% relative`);
    console.log(`  Avg token save: ${hcTokenSave.toFixed(1)}%`);
    console.log(`  Peak token save: ${peakSave.toFixed(1)}%`);
  }
}

function saveResult(dir: string, name: string, result: BenchmarkResults): void {
  const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const path = join(dir, `${safeName}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`  Saved: ${path}`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

main().catch(console.error);
