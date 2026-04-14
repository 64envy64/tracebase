#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadFixtures, runAgenticBenchmark } from "./harness.js";
import type { AgenticBenchmarkResults } from "./types.js";

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
  const fixtureFilter = getArg(args, "--fixture");

  const baseDir = import.meta.dirname ?? __dirname;
  const fixturesDir = join(baseDir, "fixtures");
  const resultsDir = join(baseDir, "results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

  let fixtures = loadFixtures(fixturesDir);
  if (fixtureFilter) {
    fixtures = fixtures.filter((f) => f.meta.id.includes(fixtureFilter));
  }

  console.log(`\nTraceBase Agentic Benchmark — ${fixtures.length} fixtures, max 10 steps`);
  console.log("=".repeat(60));

  const models = runAll ? ALL_MODELS : modelArg ? [modelArg] : ["claude-haiku-4-5-20251001"];
  const allResults: AgenticBenchmarkResults[] = [];

  for (const model of models) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Model: ${model}`);
    console.log("=".repeat(60));

    const result = await runAgenticBenchmark(model, fixtures, { verbose });
    printSummary(result);
    saveResult(resultsDir, model, result);
    allResults.push(result);
  }

  if (allResults.length > 1) {
    writeFileSync(join(resultsDir, "all-models.json"), JSON.stringify(allResults, null, 2));
    printCrossModel(allResults);
  }
}

function printSummary(r: AgenticBenchmarkResults): void {
  console.log("\n--- All Fixtures ---");
  console.log(`  Baseline:  ${(r.baseline.accuracy * 100).toFixed(1)}% accuracy, ${r.baseline.avgSteps.toFixed(1)} avg steps, ${r.baseline.avgTokens.toFixed(0)} avg tokens`);
  console.log(`  Augmented: ${(r.augmented.accuracy * 100).toFixed(1)}% accuracy, ${r.augmented.avgSteps.toFixed(1)} avg steps, ${r.augmented.avgTokens.toFixed(0)} avg tokens`);
  console.log(`  Accuracy:  ${r.delta.accuracyDeltaPP >= 0 ? "+" : ""}${r.delta.accuracyDeltaPP.toFixed(1)} pp (${r.delta.accuracyGainRelative >= 0 ? "+" : ""}${r.delta.accuracyGainRelative.toFixed(1)}% relative)`);
  console.log(`  Step save: ${r.delta.avgStepSave.toFixed(1)}%`);
  console.log(`  Token save: ${r.delta.avgTokenSave.toFixed(1)}% avg, ${r.delta.peakTokenSave.toFixed(1)}% peak`);
}

function printCrossModel(all: AgenticBenchmarkResults[]): void {
  console.log("\n" + "=".repeat(70));
  console.log("CROSS-MODEL COMPARISON (Trajectory-Level)");
  console.log("=".repeat(70));

  console.log("\nAccuracy:");
  console.log("  Model".padEnd(35) + "Baseline".padEnd(12) + "+ TraceBase".padEnd(14) + "Gain");
  console.log("  " + "-".repeat(65));
  for (const r of all) {
    console.log(
      `  ${r.model.padEnd(33)} ${(r.baseline.accuracy * 100).toFixed(1).padStart(5)}%` +
      `      ${(r.augmented.accuracy * 100).toFixed(1).padStart(5)}%` +
      `      ${r.delta.accuracyGainRelative >= 0 ? "+" : ""}${r.delta.accuracyGainRelative.toFixed(1)}%`
    );
  }

  console.log("\nEfficiency:");
  console.log("  Model".padEnd(35) + "Step Save".padEnd(14) + "Avg Token Save".padEnd(18) + "Peak Token Save");
  console.log("  " + "-".repeat(65));
  for (const r of all) {
    console.log(
      `  ${r.model.padEnd(33)} +${r.delta.avgStepSave.toFixed(0)}%`.padEnd(48) +
      `${r.delta.avgTokenSave.toFixed(0)}%`.padEnd(18) +
      `Up to ${r.delta.peakTokenSave.toFixed(0)}%`
    );
  }
}

function saveResult(dir: string, model: string, result: AgenticBenchmarkResults): void {
  const name = model.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const path = join(dir, `agentic-${name}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`  Saved: ${path}`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

main().catch(console.error);
