import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { findProjectRoot, loadConfig, resolveProjectBase } from "../../core/config.js";
import {
  getAgentTargetMeta,
  normalizeInstallAgent,
  removeAgentInstructionFile,
  removeAgentMcpConfig,
  resolveInstallAgent,
  type CleanupResult,
  type InstallAgent,
} from "../install-targets.js";

export interface RemoveReport {
  projectPath: string;
  agent: InstallAgent;
  steps: Array<{
    label: string;
    result: CleanupResult;
  }>;
  failed: boolean;
}

export const removeCommand = new Command("remove")
  .alias("uninstall")
  .description("Remove TraceBase local install artifacts from this project")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("-a, --agent <agent>", "install target: claude-code | cursor | codex")
  .option("--keep-store", "do not remove .tracebase/")
  .option("--keep-mcp-config", "do not touch the agent's MCP configuration")
  .option("--keep-agent-instructions", "do not touch the agent instruction file")
  .action((opts: {
    path: string;
    agent?: string;
    keepStore?: boolean;
    keepMcpConfig?: boolean;
    keepAgentInstructions?: boolean;
  }) => {
    if (opts.agent && !normalizeInstallAgent(opts.agent)) {
      console.error(pc.red("Unsupported agent target: ") + opts.agent);
      console.error("Use one of " + pc.cyan("claude-code") + ", " + pc.cyan("cursor") + ", or " + pc.cyan("codex") + ".");
      process.exit(1);
    }

    const report = runRemove({
      path: opts.path,
      agent: opts.agent,
      keepStore: !!opts.keepStore,
      keepMcpConfig: !!opts.keepMcpConfig,
      keepAgentInstructions: !!opts.keepAgentInstructions,
    });

    renderRemove(report);
    if (report.failed) process.exitCode = 1;
  });

export function runRemove(input: {
  path: string;
  agent?: string;
  keepStore?: boolean;
  keepMcpConfig?: boolean;
  keepAgentInstructions?: boolean;
}): RemoveReport {
  const projectPath = findProjectRoot(input.path) ?? resolveProjectBase(input.path);
  const existingConfig = findProjectRoot(input.path) ? loadConfig(projectPath) : undefined;
  const agent = resolveInstallAgent({
    explicit: input.agent,
    basePath: projectPath,
    stored: existingConfig?.install?.agent,
    preferEnvironment: false,
  });
  const agentMeta = getAgentTargetMeta(agent);
  const steps: RemoveReport["steps"] = [];

  if (!input.keepMcpConfig) {
    steps.push({
      label: agentMeta.mcpLocationLabel,
      result: removeAgentMcpConfig(projectPath, agent),
    });
  }

  if (!input.keepAgentInstructions) {
    steps.push({
      label: agentMeta.instructionFile,
      result: removeAgentInstructionFile(projectPath, agent),
    });
  }

  if (!input.keepStore) {
    steps.push({
      label: ".tracebase/",
      result: removeTraceBaseDirectory(projectPath),
    });
  }

  return {
    projectPath,
    agent,
    steps,
    failed: steps.some((step) => !step.result.ok),
  };
}

function renderRemove(report: RemoveReport): void {
  const agentMeta = getAgentTargetMeta(report.agent);
  console.log();
  console.log(pc.bold("TraceBase removed"));
  console.log(pc.dim(`  project ${report.projectPath}`));
  console.log(pc.dim(`  target ${agentMeta.displayName}`));
  console.log();

  for (const step of report.steps) {
    renderCleanupResult(step.label, step.result);
  }

  console.log();
  if (report.failed) {
    console.log(pc.red("Cleanup incomplete.") + " Fix the failing step above, then re-run " + pc.cyan("npx tracebase remove") + ".");
  } else {
    console.log(pc.bold("Next:"));
    console.log("  1. Re-open your agent if it was running");
    console.log("  2. Re-install any time with " + pc.cyan("npx tracebase init"));
  }
  console.log();
}

function renderCleanupResult(label: string, res: CleanupResult): void {
  if (!res.ok) {
    console.log(pc.red("  -") + " " + label + " " + pc.dim(`(${res.reason})`));
    return;
  }

  const sigil =
    res.kind === "removed" ? pc.green("  -")
    : res.kind === "updated" ? pc.cyan("  ~")
    : pc.dim("  =");
  const note =
    res.kind === "already-absent" ? pc.dim(" (already absent)")
    : res.kind === "updated" ? pc.dim(" (updated)")
    : "";

  console.log(sigil + " " + label + note);
}

function removeTraceBaseDirectory(projectPath: string): CleanupResult {
  const tracebaseDir = join(projectPath, ".tracebase");
  if (!existsSync(tracebaseDir)) {
    return { ok: true, kind: "already-absent", path: tracebaseDir };
  }

  rmSync(tracebaseDir, { recursive: true, force: true });
  return { ok: true, kind: "removed", path: tracebaseDir };
}
