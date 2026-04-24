/**
 * `tracebase status` — one-screen health snapshot for the local install.
 *
 * Answers: "is this project wired up, and what does the store look like
 * right now?". Intended as the first thing the user runs after
 * `tracebase init` and at any point when they want a quick overview.
 *
 * Non-invasive:
 *   - read-only against the block store and event log,
 *   - zero network,
 *   - safe to run even if init was never completed (reports that case
 *     as its primary finding).
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findProjectRoot, loadConfig, normalizeInstallAgents } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import {
  getAgentTargetMeta,
  inspectAgentHookConfig,
  inspectAgentInstructionFile,
  inspectAgentMcpConfig,
  resolveInstallAgent,
  type HookEventName,
  type HookEventState,
  type InstallAgent,
} from "../install-targets.js";

export interface AgentInstallReport {
  agent: InstallAgent;
  agentDisplayName: string;
  mcpLocation: string;
  instructionFile: string;
  mcpConfigured: boolean;
  instructionsPresent: boolean;
  /**
   * Hook state, per managed event. Undefined when the agent has no
   * hook surface (cursor, codex today). For Claude Code, both
   * `UserPromptSubmit` and `Stop` appear here with one of
   * `canonical | non-canonical | missing`. `status` renders this as
   * a separate line next to MCP + instructions; doctor emits a WARN
   * when anything is missing or non-canonical.
   */
  hooks?: {
    supported: boolean;
    present: boolean;
    canonical: boolean;
    events: Partial<Record<HookEventName, HookEventState>>;
  };
}

interface StatusReport {
  initialized: boolean;
  projectPath: string | null;
  workspaceId: string | null;
  storagePath: string | null;
  storageBytes: number | null;
  /** Primary adapter (first in the configured list). Kept for back-compat. */
  agent: InstallAgent | null;
  agentDisplayName: string | null;
  /** Primary MCP surface location. Kept for back-compat. */
  mcpLocation: string | null;
  /** Primary instruction-file name. Kept for back-compat. */
  instructionFile: string | null;
  /** Full list of agents wired up by `init`, with per-agent integrity. */
  agents: AgentInstallReport[];
  mcpConfigured: boolean;
  instructionsPresent: boolean;
  claudeSettingsPresent: boolean;
  claudeMdPresent: boolean;
  blocks: {
    active: number;
    candidate: number;
    demoted: number;
    merged: number;
    retired: number;
  };
  factsActive: number;
  events: {
    total: number;
    retrieval: number;
    injection: number;
    factInjection: number;
    agentUsed: number;
    outcome: number;
  };
  lastActivityTs: number | null;
  cloudLinked: boolean;
  cloudApiUrl: string | null;
  cloudWorkspaceSlug: string | null;
}

export const statusCommand = new Command("status")
  .description("Show a one-screen snapshot of the local install and store")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--json", "machine-readable JSON output")
  .action((opts: { path: string; json?: boolean }) => {
    const report = buildStatusReport(opts.path);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    renderStatus(report);
  });

export function buildStatusReport(invocationPath: string): StatusReport {
  // Walk up from the invocation dir; the real project root may be an
  // ancestor. All subsequent file-presence checks must key off this
  // resolved root, not `invocationPath`, otherwise running the command
  // from a nested subdirectory gives false negatives.
  const projectRoot = findProjectRoot(invocationPath);
  const initialized = projectRoot !== null;

  if (!initialized) {
    return {
      initialized: false,
      projectPath: null,
      workspaceId: null,
      storagePath: null,
      storageBytes: null,
      agent: null,
      agentDisplayName: null,
      mcpLocation: null,
      instructionFile: null,
      agents: [],
      mcpConfigured: false,
      instructionsPresent: false,
      claudeSettingsPresent: false,
      claudeMdPresent: false,
      blocks: { active: 0, candidate: 0, demoted: 0, merged: 0, retired: 0 },
      factsActive: 0,
      events: { total: 0, retrieval: 0, injection: 0, factInjection: 0, agentUsed: 0, outcome: 0 },
      lastActivityTs: null,
      cloudLinked: false,
      cloudApiUrl: null,
      cloudWorkspaceSlug: null,
    };
  }

  const cfg = loadConfig(invocationPath);
  const storageBytes = existsSync(cfg.storagePath) ? statSync(cfg.storagePath).size : null;
  const configuredAgents = normalizeInstallAgents(cfg.install);
  // Distinguish three states:
  //   - install field absent entirely (legacy pre-multi-agent config)
  //     → fall back to the single-agent resolver so old projects keep
  //       showing their adapter.
  //   - install.agents empty (deliberately cleared by `remove --keep-store`)
  //     → respect that; status should say "no adapters wired up".
  //   - install.agents non-empty → use the list verbatim.
  const installPresent = cfg.install !== undefined;
  const agents: InstallAgent[] =
    configuredAgents.length > 0
      ? configuredAgents
      : installPresent
        ? []
        : [
            resolveInstallAgent({
              basePath: projectRoot,
              stored: cfg.install?.agent,
              preferEnvironment: false,
            }),
          ];
  const primaryAgent = agents[0] ?? null;
  const meta = primaryAgent ? getAgentTargetMeta(primaryAgent) : null;
  const agentReports: AgentInstallReport[] = agents.map((a) => {
    const m = getAgentTargetMeta(a);
    const mcp = inspectAgentMcpConfig(projectRoot, a);
    const instr = inspectAgentInstructionFile(projectRoot, a);
    const hook = inspectAgentHookConfig(projectRoot, a);
    const report: AgentInstallReport = {
      agent: a,
      agentDisplayName: m.displayName,
      mcpLocation: m.mcpLocationLabel,
      instructionFile: m.instructionFile,
      mcpConfigured: mcp.present && mcp.canonical,
      instructionsPresent: instr.present && instr.managed,
    };
    if (hook.supported) {
      report.hooks = {
        supported: hook.supported,
        present: hook.present,
        canonical: hook.canonical,
        events: hook.events,
      };
    }
    return report;
  });
  const primaryReport = agentReports[0];
  const claudeReport = agentReports.find((r) => r.agent === "claude-code");
  const claudeSettingsPresent = claudeReport ? claudeReport.mcpConfigured : false;
  const claudeMdPresent = claudeReport ? claudeReport.instructionsPresent : false;

  const blocks = { active: 0, candidate: 0, demoted: 0, merged: 0, retired: 0 };
  let factsActive = 0;
  const events = { total: 0, retrieval: 0, injection: 0, factInjection: 0, agentUsed: 0, outcome: 0 };
  let lastActivityTs: number | null = null;

  if (storageBytes !== null) {
    // Open the store read-only from our perspective; BlockStore manages
    // its own connection, which we close immediately after sampling.
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    try {
      blocks.active = store.countBlocks("active");
      blocks.candidate = store.countBlocks("candidate");
      blocks.demoted = store.countBlocks("demoted");
      blocks.merged = store.countBlocks("merged");
      blocks.retired = store.countBlocks("retired");
      factsActive = store.countFacts("active");
      events.total = store.countEvents();
      events.retrieval = store.countEvents("retrieval");
      events.injection = store.countEvents("injection");
      events.factInjection = store.countEvents("fact_injection");
      events.agentUsed = store.countEvents("agent_used");
      events.outcome = store.countEvents("outcome");
      if (events.total > 0) {
        const row = db
          .prepare("SELECT MAX(ts) AS ts FROM analytics_events")
          .get() as { ts: number | null };
        lastActivityTs = row.ts ?? null;
      }
    } finally {
      store.close();
    }
  }

  return {
    initialized: true,
    projectPath: projectRoot,
    workspaceId: cfg.workspaceId ?? null,
    storagePath: cfg.storagePath,
    storageBytes,
    agent: primaryAgent,
    agentDisplayName: meta?.displayName ?? null,
    mcpLocation: meta?.mcpLocationLabel ?? null,
    instructionFile: meta?.instructionFile ?? null,
    agents: agentReports,
    mcpConfigured: primaryReport?.mcpConfigured ?? false,
    instructionsPresent: primaryReport?.instructionsPresent ?? false,
    claudeSettingsPresent,
    claudeMdPresent,
    blocks,
    factsActive,
    events,
    lastActivityTs,
    cloudLinked: Boolean(cfg.cloud?.workspaceId),
    cloudApiUrl: cfg.cloud?.apiUrl ?? null,
    cloudWorkspaceSlug: cfg.cloud?.workspaceSlug ?? null,
  };
}

// ---------------------------------------------------------------------------
// Human-readable renderer
// ---------------------------------------------------------------------------

function renderStatus(r: StatusReport): void {
  console.log();
  if (!r.initialized) {
    console.log(pc.yellow("⚠ Not initialized."));
    console.log();
    console.log("  Run " + pc.cyan("npx tracebase init") + " in your project directory.");
    console.log();
    return;
  }

  const wsTag = r.workspaceId ? pc.dim(" — workspace " + r.workspaceId.slice(0, 8) + "…") : "";
  console.log(pc.bold("TraceBase") + wsTag);
  console.log();
  console.log(pc.dim("  project:  ") + r.projectPath);
  console.log(
    pc.dim("  storage:  ") +
      r.storagePath +
      (r.storageBytes !== null
        ? pc.dim(`  (${formatBytes(r.storageBytes)})`)
        : pc.dim("  (created on first agent turn — reasoning blocks stay local for latency)")),
  );
  if (r.cloudLinked) {
    console.log(
      pc.dim("  cloud:    ") +
        (r.cloudWorkspaceSlug ?? "linked") +
        (r.cloudApiUrl ? pc.dim(`  (${r.cloudApiUrl})`) : ""),
    );
  } else {
    console.log(
      pc.dim("  cloud:    ") +
        "local only " +
        pc.dim("(dashboard sync disabled — pass --api-key to `init` or set TRACEBASE_API_KEY to link)"),
    );
  }
  console.log();

  if (r.agents.length === 0) {
    console.log(pc.bold("Agents ") + pc.dim("(no adapters wired up)"));
    console.log(pc.dim("  Run ") + pc.cyan("npx tracebase init") + pc.dim(" to pick adapters again."));
  } else {
    console.log(pc.bold("Agents ") + pc.dim(`(${r.agents.length} wired up)`) + ":");
    for (const a of r.agents) {
      const mcpBadge = a.mcpConfigured ? pc.green("ok") : pc.yellow("missing");
      const instrBadge = a.instructionsPresent ? pc.green("ok") : pc.yellow("missing");
      console.log(
        "  " +
          pc.bold(a.agentDisplayName.padEnd(12)) +
          pc.dim(a.mcpLocation) +
          " " +
          mcpBadge +
          pc.dim(" · ") +
          pc.dim(a.instructionFile) +
          " " +
          instrBadge,
      );
      // Hook row — shown only for agents with a hook surface. Listed
      // per-event so users diagnose "MCP fine, Stop hook missing"
      // without cross-referencing doctor output.
      if (a.hooks?.supported) {
        const parts = Object.entries(a.hooks.events).map(([event, state]) => {
          const badge =
            state === "canonical" ? pc.green("ok")
            : state === "non-canonical" ? pc.yellow("non-canonical")
            : pc.yellow("missing");
          return pc.dim(event) + " " + badge;
        });
        console.log(
          "  " +
            " ".repeat(12) +
            pc.dim("hooks       ") +
            parts.join(pc.dim(" · ")),
        );
      }
    }
  }
  console.log();
  console.log(pc.bold("Blocks ") + pc.dim("(active / candidate / demoted / merged / retired):"));
  console.log("  " +
    pc.green(String(r.blocks.active)) + pc.dim(" / ") +
    String(r.blocks.candidate) + pc.dim(" / ") +
    pc.yellow(String(r.blocks.demoted)) + pc.dim(" / ") +
    String(r.blocks.merged) + pc.dim(" / ") +
    String(r.blocks.retired),
  );
  console.log();
  console.log(pc.bold("Facts:") + "  " + pc.green(String(r.factsActive)) + pc.dim(" active"));
  console.log();
  console.log(pc.bold("Events") + pc.dim(` (total ${r.events.total}):`));
  console.log(
    pc.dim("  ") +
    `retrieval ${r.events.retrieval}` + pc.dim(" · ") +
    `injection ${r.events.injection}` + pc.dim(" · ") +
    `fact_injection ${r.events.factInjection}` + pc.dim(" · ") +
    `agent_used ${r.events.agentUsed}` + pc.dim(" · ") +
    `outcome ${r.events.outcome}`,
  );
  if (r.lastActivityTs) {
    console.log(pc.dim("  last activity: ") + new Date(r.lastActivityTs).toISOString());
  } else {
    console.log(pc.dim("  no activity recorded yet"));
  }
  console.log();

  // Guidance if any configured agent is missing a surface. Hook
  // health counts too — a Claude Code install with MCP + CLAUDE.md
  // canonical but Stop hook missing is NOT fully OK; it silently
  // degrades capture UX back to the MCP permission prompt.
  const broken = r.agents.filter(
    (a) =>
      !a.mcpConfigured ||
      !a.instructionsPresent ||
      (a.hooks?.supported === true && !a.hooks.canonical),
  );
  if (broken.length > 0) {
    const names = broken.map((a) => a.agentDisplayName).join(", ");
    console.log(pc.yellow("  Heads up: ") + `${names} config is incomplete.`);
    console.log("  Re-run " + pc.cyan("npx tracebase init") + " to refresh.");
    console.log();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
