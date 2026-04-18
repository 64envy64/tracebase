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
import { join } from "node:path";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findProjectRoot, loadConfig } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";

interface StatusReport {
  initialized: boolean;
  projectPath: string | null;
  workspaceId: string | null;
  storagePath: string | null;
  storageBytes: number | null;
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
      claudeSettingsPresent: false,
      claudeMdPresent: false,
      blocks: { active: 0, candidate: 0, demoted: 0, merged: 0, retired: 0 },
      factsActive: 0,
      events: { total: 0, retrieval: 0, injection: 0, factInjection: 0, agentUsed: 0, outcome: 0 },
      lastActivityTs: null,
    };
  }

  const cfg = loadConfig(invocationPath);
  const storageBytes = existsSync(cfg.storagePath) ? statSync(cfg.storagePath).size : null;
  const claudeSettingsPresent = existsSync(join(projectRoot, ".claude", "settings.json"));
  const claudeMdPresent = existsSync(join(projectRoot, "CLAUDE.md"));

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
    claudeSettingsPresent,
    claudeMdPresent,
    blocks,
    factsActive,
    events,
    lastActivityTs,
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
  console.log(pc.dim("  storage:  ") + r.storagePath + (r.storageBytes !== null ? pc.dim(`  (${formatBytes(r.storageBytes)})`) : pc.yellow("  (missing)")));
  console.log(pc.dim("  claude:   ") +
    (r.claudeSettingsPresent ? pc.green(".claude/settings.json") : pc.yellow(".claude/settings.json missing")) +
    "  " +
    (r.claudeMdPresent ? pc.green("CLAUDE.md") : pc.yellow("CLAUDE.md missing")),
  );
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

  // Guidance if something's clearly missing.
  if (!r.claudeSettingsPresent || !r.claudeMdPresent) {
    console.log(pc.yellow("  Heads up: ") + "Claude Code config is incomplete.");
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
