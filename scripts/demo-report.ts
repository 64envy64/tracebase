#!/usr/bin/env node
/**
 * `tsx scripts/demo-report.ts [--task <id>]`
 *
 * Reads every `demo-runs/<task>/{off,on}.json` produced by
 * `demo-runner`, computes the comparison report via the pure
 * `computeComparison` helper, and writes a single
 * `demo-runs/summary.md` with one section per task plus the rendered
 * markdown to stdout.
 *
 * No clocks, no I/O beyond reading the runner outputs and writing
 * the summary — every number you see comes from the JSONs the runner
 * just produced.
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

const RUNS_DIR = resolve("demo-runs");

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function loadArtifact(path: string): RunArtifact {
  return JSON.parse(readFileSync(path, "utf-8")) as RunArtifact;
}

function main(): void {
  const args = process.argv.slice(2);
  const taskFilter = arg(args, "--task");

  if (!existsSync(RUNS_DIR)) {
    console.error(
      `No demo-runs/ at ${RUNS_DIR}. Run scripts/demo-runner.ts first ` +
        `(needs both --variant off and --variant on for the task).`,
    );
    process.exit(2);
  }

  const taskNames = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.endsWith("-workspace"))
    .filter((name) => !taskFilter || name === taskFilter)
    .sort();

  if (taskNames.length === 0) {
    console.error(
      taskFilter
        ? `No runs for task ${taskFilter} under ${RUNS_DIR}`
        : `No task runs under ${RUNS_DIR}`,
    );
    process.exit(2);
  }

  const reports: ComparisonReport[] = [];
  const skipped: string[] = [];
  for (const taskName of taskNames) {
    const offPath = join(RUNS_DIR, taskName, "off.json");
    const onPath = join(RUNS_DIR, taskName, "on.json");
    if (!existsSync(offPath) || !existsSync(onPath)) {
      skipped.push(taskName);
      continue;
    }
    reports.push(computeComparison(loadArtifact(offPath), loadArtifact(onPath)));
  }

  if (reports.length === 0) {
    console.error(
      "Found task directories but none had both off.json and on.json. " +
        "Run the runner for both variants first.",
    );
    process.exit(2);
  }

  const lines: string[] = [];
  lines.push("# YC demo — TraceBase OFF vs ON");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Each task ran twice against an identical model + verifier. The OFF variant " +
      "had no `tracebase inject-context` hook, no PreToolUse supervision, no Stop " +
      "capture. The ON variant ran the normal TraceBase runtime. The verifier " +
      "is a real shell command run against a freshly-reset workspace; the " +
      "agent-side metrics come from the recorded transcript at " +
      "`demo-tasks/<task>/runs/<variant>.json`.",
  );
  lines.push("");
  if (skipped.length > 0) {
    lines.push(
      `_Skipped (missing off.json or on.json): ${skipped.join(", ")}_`,
    );
    lines.push("");
  }
  for (const r of reports) {
    lines.push(renderComparisonMarkdown(r));
  }

  const summary = lines.join("\n");
  mkdirSync(RUNS_DIR, { recursive: true });
  const summaryPath = join(RUNS_DIR, "summary.md");
  writeFileSync(summaryPath, summary);
  process.stdout.write(summary);
  process.stdout.write(`\nWrote ${summaryPath}\n`);
}

main();
