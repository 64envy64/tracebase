#!/usr/bin/env node
/**
 * `tsx scripts/demo-report.ts [--task <id>]`
 *
 * Walks `demo-runs/real/<task>/{off,on}.json`, computes per-task
 * comparison reports via the pure `computeComparison` helper, and
 * writes `demo-runs/real/summary.md`.
 *
 * 2026-05-23 — synthetic fixtures were removed from the repo. The
 * `--source` flag (synthetic/real/both) is gone with them; the
 * report is real-agent only. Run `scripts/demo-real-runner.ts`
 * against both variants of a task first.
 *
 * No clocks, no I/O beyond reading runner outputs and writing the
 * summary — every number comes from the JSONs the runner just
 * produced.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  computeComparison,
  renderComparisonMarkdown,
} from "../src/demo/metrics.js";
import type { ComparisonReport, RunArtifact } from "../src/demo/types.js";

const REAL_DIR = resolve("demo-runs/real");

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function loadArtifact(path: string): RunArtifact {
  return JSON.parse(readFileSync(path, "utf-8")) as RunArtifact;
}

function listTaskDirs(root: string, taskFilter: string | undefined): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.endsWith("-workspace"))
    .filter((name) => !taskFilter || name === taskFilter)
    .sort();
}

function buildReports(root: string, taskFilter: string | undefined): {
  reports: ComparisonReport[];
  skipped: string[];
} {
  const tasks = listTaskDirs(root, taskFilter);
  const reports: ComparisonReport[] = [];
  const skipped: string[] = [];
  for (const task of tasks) {
    const offPath = join(root, task, "off.json");
    const onPath = join(root, task, "on.json");
    if (!existsSync(offPath) || !existsSync(onPath)) {
      skipped.push(task);
      continue;
    }
    reports.push(computeComparison(loadArtifact(offPath), loadArtifact(onPath)));
  }
  return { reports, skipped };
}

function writeSummary(
  outDir: string,
  reports: ComparisonReport[],
  skipped: string[],
): { path: string; taskCount: number } {
  const lines: string[] = [];
  lines.push("# YC demo — TraceBase OFF vs ON · Real-agent recordings");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Each task ran twice against the same model, prompt, and verifier — TraceBase OFF " +
      "vs TraceBase ON. Numbers come from real-agent recordings produced by " +
      "`scripts/demo-real-runner.ts` (Anthropic API usage + tool-use trace). The " +
      "verifier exit code is real; the workspace is reset to the broken state " +
      "before each run; ON adds a recalled `<tracebase>` directive to the system " +
      "prompt and supervised block-after-N for repeated tool calls.",
  );
  lines.push("");
  if (skipped.length > 0) {
    lines.push(`_Skipped (missing off.json or on.json): ${skipped.join(", ")}_`);
    lines.push("");
  }
  for (const r of reports) {
    lines.push(renderComparisonMarkdown(r));
  }

  const summary = lines.join("\n");
  mkdirSync(outDir, { recursive: true });
  const summaryPath = join(outDir, "summary.md");
  writeFileSync(summaryPath, summary);
  process.stdout.write(summary);
  process.stdout.write(`\nWrote ${summaryPath}\n`);
  return { path: summaryPath, taskCount: reports.length };
}

function main(): void {
  const args = process.argv.slice(2);
  const taskFilter = arg(args, "--task");

  const { reports, skipped } = buildReports(REAL_DIR, taskFilter);
  if (reports.length === 0) {
    console.error(
      `No real-agent runs under ${REAL_DIR}. ` +
        `Run scripts/demo-real-runner.ts for both variants first.`,
    );
    process.exit(2);
  }
  writeSummary(REAL_DIR, reports, skipped);
}

main();
