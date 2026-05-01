#!/usr/bin/env node
/**
 * `tsx scripts/demo-report.ts [--task <id>] [--source synthetic|real|both]`
 *
 * Walks `demo-runs/{<task>,real/<task>}/{off,on}.json`, computes per-task
 * comparison reports via the pure `computeComparison` helper, and writes
 * up to two summaries:
 *
 *   --source synthetic → demo-runs/summary.md      (synthetic only)
 *   --source real      → demo-runs/real/summary.md (real-agent only)
 *   --source both      → both files (default)
 *
 * Synthetic and real runs are NEVER mixed in a single comparison —
 * `computeComparison` throws on source mismatch. The two summaries
 * each carry an explicit "Synthetic fixture" / "Real-agent recording"
 * banner per task so they can't be confused if you copy the table
 * into a slide.
 *
 * No clocks, no I/O beyond reading runner outputs and writing the
 * summaries — every number comes from the JSONs the runners just
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
import type { ComparisonReport, RunArtifact, RunSource } from "../src/demo/types.js";

const SYNTHETIC_DIR = resolve("demo-runs");
const REAL_DIR = resolve("demo-runs/real");

type SourceFlag = "synthetic" | "real" | "both";

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function parseSource(raw: string | undefined): SourceFlag {
  if (raw === undefined) return "both";
  if (raw !== "synthetic" && raw !== "real" && raw !== "both") {
    console.error(`--source must be synthetic, real, or both; got ${raw}`);
    process.exit(2);
  }
  return raw;
}

function loadArtifact(path: string): RunArtifact {
  return JSON.parse(readFileSync(path, "utf-8")) as RunArtifact;
}

interface SectionWriteResult {
  path: string;
  taskCount: number;
}

function listTaskDirs(root: string, taskFilter: string | undefined): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.endsWith("-workspace"))
    // Skip the nested `real/` sub-tree when we're scanning the
    // synthetic root. The real runner writes there; the synthetic
    // walker would double-count if we let it descend.
    .filter((name) => name !== "real")
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
  source: RunSource,
  outDir: string,
  reports: ComparisonReport[],
  skipped: string[],
): SectionWriteResult {
  const lines: string[] = [];
  const banner =
    source === "real"
      ? "# YC demo — TraceBase OFF vs ON · Real-agent recordings"
      : "# YC demo — TraceBase OFF vs ON · Synthetic fixtures (illustrative)";
  lines.push(banner);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    source === "real"
      ? "Each task ran twice against the same model, prompt, and verifier — TraceBase OFF " +
          "vs TraceBase ON. Numbers come from real-agent recordings produced by " +
          "`scripts/demo-real-runner.ts` (Anthropic API usage + tool-use trace). The " +
          "verifier exit code is real; the workspace is reset to the broken state " +
          "before each run; ON adds a recalled `<tracebase>` directive to the system " +
          "prompt and supervised block-after-N for repeated tool calls."
      : "Each task ran twice against the same model, prompt, and verifier. The agent-side " +
          "metrics come from synthetic transcripts checked into `demo-tasks/<task>/runs/<variant>.json` — " +
          "they are illustrative for the harness contract and **must not** be used in any " +
          "external demo. Replace them with real-agent recordings via `scripts/demo-real-runner.ts` " +
          "for the YC overlay. The verifier is real either way: state-off is broken, state-on " +
          "is fixed, so the off-fail-on-pass column is honest in both modes.",
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
  const source = parseSource(arg(args, "--source"));

  const wantSynthetic = source === "synthetic" || source === "both";
  const wantReal = source === "real" || source === "both";

  const written: SectionWriteResult[] = [];

  if (wantSynthetic) {
    const { reports, skipped } = buildReports(SYNTHETIC_DIR, taskFilter);
    if (reports.length === 0 && source === "synthetic") {
      console.error(
        `No synthetic runs under ${SYNTHETIC_DIR}. ` +
          `Run scripts/demo-runner.ts for both variants first.`,
      );
      process.exit(2);
    }
    if (reports.length > 0) {
      written.push(writeSummary("synthetic", SYNTHETIC_DIR, reports, skipped));
    } else {
      console.warn(`(synthetic: no task runs found — skipping summary)`);
    }
  }

  if (wantReal) {
    const { reports, skipped } = buildReports(REAL_DIR, taskFilter);
    if (reports.length === 0 && source === "real") {
      console.error(
        `No real-agent runs under ${REAL_DIR}. ` +
          `Run scripts/demo-real-runner.ts for both variants first.`,
      );
      process.exit(2);
    }
    if (reports.length > 0) {
      written.push(writeSummary("real", REAL_DIR, reports, skipped));
    } else if (source === "both") {
      console.warn(`(real: no task runs found — synthetic summary only)`);
    }
  }

  if (written.length === 0) {
    console.error("Nothing to write — no runs found for the requested source.");
    process.exit(2);
  }
}

main();
