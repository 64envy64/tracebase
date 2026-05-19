#!/usr/bin/env node
/**
 * Cross-agent demo report.
 *
 * Input layout:
 *   demo-runs/cross-agent/<agent>/<task>/off.json
 *   demo-runs/cross-agent/<agent>/<task>/on.json
 *
 * Each JSON is a normal RunArtifact produced by a provider-specific
 * runner. This script deliberately does not call providers: it gives
 * Claude/GPT/Gemini loops one shared reporting contract and one table
 * for the demo frame "institutional memory works between models".
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { computeComparison } from "../src/demo/metrics.js";
import type { ComparisonReport, RunArtifact } from "../src/demo/types.js";

const DEFAULT_ROOT = resolve("demo-runs", "cross-agent");
const DEFAULT_OUT = join(DEFAULT_ROOT, "summary.md");

interface AgentReport {
  agent: string;
  comparisons: ComparisonReport[];
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function usage(): never {
  console.error(
    "Usage: tsx scripts/cross-agent-report.ts [--root demo-runs/cross-agent] [--out summary.md]\n" +
      "Expected layout: <root>/<agent>/<task>/{off,on}.json",
  );
  process.exit(2);
}

function readArtifact(path: string): RunArtifact {
  return JSON.parse(readFileSync(path, "utf-8")) as RunArtifact;
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function buildAgentReport(root: string, agent: string): AgentReport {
  const comparisons: ComparisonReport[] = [];
  for (const task of listDirs(join(root, agent))) {
    const taskDir = join(root, agent, task);
    const offPath = join(taskDir, "off.json");
    const onPath = join(taskDir, "on.json");
    if (!existsSync(offPath) || !existsSync(onPath)) continue;
    comparisons.push(computeComparison(readArtifact(offPath), readArtifact(onPath)));
  }
  return { agent, comparisons };
}

function solvedCount(reports: readonly ComparisonReport[], variant: "off" | "on"): number {
  return reports.filter((r) => r[variant].verifier.pass).length;
}

function sum(reports: readonly ComparisonReport[], pick: (r: ComparisonReport) => number): number {
  let total = 0;
  for (const r of reports) total += pick(r);
  return total;
}

function statusCell(report: ComparisonReport | undefined): string {
  if (!report) return "-";
  const off = report.off.verifier.pass ? "PASS" : "FAIL";
  const on = report.on.verifier.pass ? "PASS" : "FAIL";
  return off === on ? on : `${off}->${on}`;
}

function render(reports: readonly AgentReport[]): string {
  const lines: string[] = [];
  lines.push("# Cross-agent TraceBase ON/OFF");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Same task set, same artifact schema, separate model loops. OFF runs without TraceBase; ON runs with the shared institutional memory layer.",
  );
  lines.push("");
  lines.push("| Agent | Tasks | OFF solved | ON solved | Net tokens saved | TraceBase injected | Drift blocks |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const r of reports) {
    const tasks = r.comparisons.length;
    const offSolved = solvedCount(r.comparisons, "off");
    const onSolved = solvedCount(r.comparisons, "on");
    const netTokens = sum(r.comparisons, (c) => c.delta.tokensTotalNet);
    const injected = sum(r.comparisons, (c) => c.delta.injectedTokens);
    const blocked = sum(r.comparisons, (c) => c.delta.blockedToolCalls);
    lines.push(
      `| ${r.agent} | ${tasks} | ${offSolved}/${tasks} | ${onSolved}/${tasks} | ${signed(netTokens)} | ${injected} | ${blocked} |`,
    );
  }
  lines.push("");

  const tasks = new Set<string>();
  for (const r of reports) {
    for (const c of r.comparisons) tasks.add(c.task);
  }
  const agents = reports.map((r) => r.agent);
  if (tasks.size > 0 && agents.length > 0) {
    lines.push("## Task matrix");
    lines.push("");
    lines.push(`| Task | ${agents.join(" | ")} |`);
    lines.push(`|---|${agents.map(() => "---:").join("|")}|`);
    for (const task of [...tasks].sort()) {
      const cells = agents.map((agent) => {
        const report = reports
          .find((r) => r.agent === agent)
          ?.comparisons.find((c) => c.task === task);
        return statusCell(report);
      });
      lines.push(`| ${task} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function signed(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : `${n}`;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  const root = resolve(arg(args, "--root") ?? DEFAULT_ROOT);
  const out = resolve(arg(args, "--out") ?? DEFAULT_OUT);
  const agentReports = listDirs(root)
    .map((agent) => buildAgentReport(root, agent))
    .filter((r) => r.comparisons.length > 0);
  if (agentReports.length === 0) {
    console.error(`No cross-agent OFF/ON pairs found under ${root}`);
    process.exit(2);
  }
  const md = render(agentReports);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md + "\n");
  process.stdout.write(md + `\nWrote ${out}\n`);
}

main();
