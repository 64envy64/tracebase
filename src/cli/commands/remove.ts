import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  detachInstallAgents,
  findProjectRoot,
  loadConfig,
  normalizeInstallAgents,
  resolveProjectBase,
} from "../../core/config.js";
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
  /** Primary adapter (first cleaned). Kept for back-compat reporting. */
  agent: InstallAgent;
  /** Every adapter the CLI removed during this run. */
  agents: InstallAgent[];
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
  const explicit = normalizeInstallAgent(input.agent);
  const configuredAgents = normalizeInstallAgents(existingConfig?.install);

  let agentsToClean: InstallAgent[];
  if (explicit) {
    agentsToClean = [explicit];
  } else if (configuredAgents.length > 0) {
    agentsToClean = configuredAgents;
  } else {
    // Legacy config or no install — fall back to the single-agent
    // resolver so we still clean the one adapter that was wired up.
    agentsToClean = [
      resolveInstallAgent({
        basePath: projectPath,
        stored: existingConfig?.install?.agent,
        preferEnvironment: false,
      }),
    ];
  }

  const steps: RemoveReport["steps"] = [];
  // Track which agents got both their surfaces cleaned, so we can
  // semantically detach them from config.json when the store is kept.
  // An agent with any skip flag (--keep-mcp-config,
  // --keep-agent-instructions) is not considered fully detached —
  // status/doctor should still see the remaining surface.
  const perAgentCleanlyRemoved = new Map<InstallAgent, boolean>();
  for (const agent of agentsToClean) {
    const meta = getAgentTargetMeta(agent);
    let mcpOk = true;
    let instructionsOk = true;
    if (!input.keepMcpConfig) {
      const res = removeAgentMcpConfig(projectPath, agent);
      steps.push({
        label: `${meta.displayName} · ${meta.mcpLocationLabel}`,
        result: res,
      });
      mcpOk = res.ok;
    } else {
      mcpOk = false; // surface intentionally preserved, so not detached
    }
    if (!input.keepAgentInstructions) {
      const res = removeAgentInstructionFile(projectPath, agent);
      steps.push({
        label: `${meta.displayName} · ${meta.instructionFile}`,
        result: res,
      });
      instructionsOk = res.ok;
    } else {
      instructionsOk = false;
    }
    perAgentCleanlyRemoved.set(agent, mcpOk && instructionsOk);
  }

  if (!input.keepStore) {
    steps.push({
      label: ".tracebase/",
      result: removeTraceBaseDirectory(projectPath),
    });
  } else {
    // Store is staying. Detach every agent that was physically
    // cleaned so `status` / `doctor` stop reporting them as
    // "configured but broken" — that was the semantic detach gap in
    // the previous behaviour.
    const detachable: InstallAgent[] = [];
    for (const [agent, cleanly] of perAgentCleanlyRemoved) {
      if (cleanly) detachable.push(agent);
    }
    if (detachable.length > 0 && existsSync(join(projectPath, ".tracebase"))) {
      detachInstallAgents(projectPath, detachable);
    }
  }

  return {
    projectPath,
    agent: agentsToClean[0]!,
    agents: agentsToClean,
    steps,
    failed: steps.some((step) => !step.result.ok),
  };
}

function renderRemove(report: RemoveReport): void {
  const names = report.agents.map((a) => getAgentTargetMeta(a).displayName).join(", ");
  console.log();
  console.log(pc.bold("TraceBase removed"));
  console.log(pc.dim(`  project ${report.projectPath}`));
  console.log(pc.dim(`  targets ${names}`));
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
