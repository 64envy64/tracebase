/**
 * `tracebase doctor` — deep install-health check with actionable fixes.
 *
 * Each check produces one of:
 *   PASS   — the expected state holds,
 *   WARN   — non-blocking issue (install works, but the user may want
 *            to act),
 *   FAIL   — the install is broken or degraded; `fix` tells them how.
 *
 * Exits non-zero iff any check is FAIL so CI pipelines can gate on it.
 */
import { Command } from "commander";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import Database from "better-sqlite3";
import { findProjectRoot, loadConfig, normalizeInstallAgents } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import type { TraceBaseConfig } from "../../types.js";
import {
  getAgentTargetMeta,
  inspectAgentInstructionFile,
  inspectAgentMcpConfig,
  resolveInstallAgent,
  type InstallAgent,
} from "../install-targets.js";

export type DoctorLevel = "pass" | "warn" | "fail";

export interface DoctorCheck {
  /** Short identifier, e.g. "tracebase-config". */
  name: string;
  level: DoctorLevel;
  /** Human-readable summary for the renderer. */
  message: string;
  /** Actionable hint shown only for warn / fail. */
  fix?: string;
}

export interface DoctorReport {
  projectPath: string;
  checks: DoctorCheck[];
  summary: { pass: number; warn: number; fail: number };
}

export const doctorCommand = new Command("doctor")
  .description("Verify install integrity and surface broken config with fix hints")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--json", "machine-readable JSON output")
  .action((opts: { path: string; json?: boolean }) => {
    const report = runDoctor(opts.path);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      renderDoctor(report);
    }
    if (report.summary.fail > 0) process.exitCode = 1;
  });

export function runDoctor(invocationPath: string): DoctorReport {
  const checks: DoctorCheck[] = [];

  // Walk up from the invocation dir. All subsequent checks key off the
  // discovered project root so running `doctor` from a subdirectory
  // doesn't false-negative on .claude/settings.json or CLAUDE.md.
  const projectRoot = findProjectRoot(invocationPath);
  if (!projectRoot) {
    checks.push({
      name: "tracebase-config",
      level: "fail",
      message: ".tracebase/config.json is missing",
      fix: "Run `npx tracebase init` in this project directory.",
    });
    return finalize(invocationPath, checks);
  }

  // --- .tracebase/config.json
  //
  // Read the config file DIRECTLY rather than going through loadConfig,
  // because loadConfig silently swallows JSON parse errors and returns
  // defaults — a forgiving runtime contract that would hide file
  // corruption from a deep integrity check.
  const configFile = join(projectRoot, ".tracebase", "config.json");
  let cfg: TraceBaseConfig | null = null;
  if (!existsSync(configFile)) {
    checks.push({
      name: "tracebase-config",
      level: "fail",
      message: ".tracebase/config.json is missing",
      fix: "Run `npx tracebase init` in this project directory.",
    });
    return finalize(projectRoot, checks);
  }

  let rawConfig: string;
  try {
    rawConfig = readFileSync(configFile, "utf-8");
  } catch (e) {
    checks.push({
      name: "tracebase-config",
      level: "fail",
      message: `config.json is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      fix: "Check file permissions; re-run `npx tracebase init --force` if necessary.",
    });
    return finalize(projectRoot, checks);
  }

  try {
    cfg = JSON.parse(rawConfig) as TraceBaseConfig;
  } catch (e) {
    checks.push({
      name: "tracebase-config",
      level: "fail",
      message: `config.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      fix: "Fix the JSON by hand or re-run `npx tracebase init --force` (this rewrites the file).",
    });
    return finalize(projectRoot, checks);
  }

  // Merge with loadConfig's defaults so downstream checks have the
  // resolved storagePath etc.; loadConfig is safe to call now, parse
  // errors would already have been caught above.
  const resolvedCfg = loadConfig(invocationPath);

  if (!cfg.workspaceId) {
    checks.push({
      name: "tracebase-config",
      level: "warn",
      message: "config.json parseable but workspaceId is missing",
      fix: "Re-run `npx tracebase init` to generate one.",
    });
  } else {
    checks.push({
      name: "tracebase-config",
      level: "pass",
      message: `parseable, workspaceId ${cfg.workspaceId.slice(0, 8)}…`,
    });
  }
  cfg = resolvedCfg;

  const configuredAgents = normalizeInstallAgents(cfg.install);
  const agents: InstallAgent[] =
    configuredAgents.length > 0
      ? configuredAgents
      : [
          resolveInstallAgent({
            basePath: projectRoot,
            stored: cfg.install?.agent,
            preferEnvironment: false,
          }),
        ];

  // --- storage
  if (!existsSync(cfg.storagePath)) {
    checks.push({
      name: "storage",
      level: "warn",
      message: `storage file missing (${cfg.storagePath})`,
      fix: "Will be created on first write. Safe to ignore on a fresh install.",
    });
  } else {
    const size = statSync(cfg.storagePath).size;
    // Open read-only to check schema version.
    let schemaVersion: number | null = null;
    let err: string | null = null;
    try {
      const db = new Database(cfg.storagePath, { readonly: true, fileMustExist: true });
      try {
        const row = db
          .prepare("SELECT value FROM v2_schema_meta WHERE key = 'version'")
          .get() as { value: string } | undefined;
        schemaVersion = row ? parseInt(row.value, 10) : null;
      } catch {
        // Table not yet created — v1 DB, acceptable.
        schemaVersion = null;
      }
      db.close();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }

    if (err) {
      checks.push({
        name: "storage",
        level: "fail",
        message: `SQLite open failed: ${err}`,
        fix: "Check file permissions or remove the file to recreate it.",
      });
    } else {
      const versionNote = schemaVersion !== null ? `v2 schema v${schemaVersion}` : "v1-only";
      checks.push({
        name: "storage",
        level: "pass",
        message: `${cfg.storagePath} (${versionNote}, ${formatBytes(size)})`,
      });
    }
  }

  for (const a of agents) {
    const meta = getAgentTargetMeta(a);
    appendAgentIntegrationChecks(checks, projectRoot, a, meta.displayName);
  }

  // --- MCP SDK availability (optional peer dep)
  let mcpSdkAvailable = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
    mcpSdkAvailable = true;
  } catch {
    mcpSdkAvailable = false;
  }
  checks.push(
    mcpSdkAvailable
      ? {
          name: "mcp-sdk",
          level: "pass",
          message: "@modelcontextprotocol/sdk resolvable",
        }
      : {
          name: "mcp-sdk",
          level: "warn",
          message: "@modelcontextprotocol/sdk not installed in this project",
          fix: "The MCP server loads the SDK via `npx -y tracebase-ai` at run-time, so this warning is safe for consumers. For local development only: `npm install @modelcontextprotocol/sdk`.",
        },
  );

  // --- store content summary (informational)
  if (existsSync(cfg.storagePath)) {
    const db = new Database(cfg.storagePath, { readonly: true });
    try {
      const store = new BlockStore(db, { skipMigrate: true });
      const activeBlocks = store.countBlocks("active");
      const candidateBlocks = store.countBlocks("candidate");
      if (activeBlocks === 0 && candidateBlocks === 0) {
        checks.push({
          name: "store-content",
          level: "warn",
          message: "no blocks in the store yet",
          fix: "Use the MCP `store` tool from Claude Code, or seed manually with `tracebase store`.",
        });
      } else {
        checks.push({
          name: "store-content",
          level: "pass",
          message: `${activeBlocks} active, ${candidateBlocks} candidate`,
        });
      }
    } finally {
      db.close();
    }
  }

  return finalize(projectRoot, checks);
}

function appendAgentIntegrationChecks(
  checks: DoctorCheck[],
  projectRoot: string,
  agent: InstallAgent,
  displayName: string,
): void {
  const mcp = inspectAgentMcpConfig(projectRoot, agent);
  const instruction = inspectAgentInstructionFile(projectRoot, agent);
  const instructionFile = getAgentTargetMeta(agent).instructionFile;
  const initCommand = "npx tracebase init";
  // Check names are prefixed by agent so multi-agent installs don't
  // collide. Legacy aliases "claude-settings" / "claude-md" /
  // "agents-md" are kept inside the renderer for back-compat output.
  const mcpCheckName = `${agent}-mcp`;
  const instructionCheckName = `${agent}-instructions`;

  if (mcp.parseError) {
    checks.push({
      name: mcpCheckName,
      level: mcp.cliMissing ? "fail" : "fail",
      message:
        agent === "codex"
          ? `codex MCP inspection failed: ${mcp.parseError}`
          : `${getAgentTargetMeta(agent).mcpLocationLabel} is not valid JSON`,
      fix:
        agent === "codex"
          ? "Ensure the `codex` CLI is installed and re-run `npx tracebase init --agent codex --force`."
          : `Fix the file manually, or re-run \`${initCommand} --force\`.`,
    });
  } else if (!mcp.present) {
    const missingConfigSurface = agent === "claude-code" && mcp.containerPresent === false;
    checks.push({
      name: mcpCheckName,
      level: missingConfigSurface ? "warn" : "fail",
      message:
        missingConfigSurface
          ? `${getAgentTargetMeta(agent).mcpLocationLabel} is missing`
        : agent === "codex"
          ? "tracebase is not registered under codex mcp"
          : `${getAgentTargetMeta(agent).mcpLocationLabel} is missing or has no tracebase entry`,
      fix:
        missingConfigSurface
          ? `Run \`${initCommand}\` (${displayName} will not see TraceBase until then).`
          : agent === "claude-code"
          ? `Run \`${initCommand}\` (${displayName} will not see TraceBase until then).`
          : `Run \`${initCommand}\` to register the MCP server.`,
    });
  } else if (!mcp.canonical) {
    checks.push({
      name: mcpCheckName,
      level: "warn",
      message: "tracebase MCP entry has a non-canonical shape",
      fix: `Re-run \`${initCommand} --force\` to reset to the canonical entry.`,
    });
  } else {
    checks.push({
      name: mcpCheckName,
      level: "pass",
      message: "tracebase MCP entry installed",
    });
  }

  if (!instruction.present) {
    checks.push({
      name: instructionCheckName,
      level: "warn",
      message: `${instructionFile} is missing`,
      fix: `Run \`${initCommand}\` to create the instruction block.`,
    });
  } else if (!instruction.managed) {
    checks.push({
      name: instructionCheckName,
      level: "warn",
      message: `${instructionFile} exists but the managed section is missing`,
      fix: `Re-run \`${initCommand}\` to append the managed block.`,
    });
  } else {
    checks.push({
      name: instructionCheckName,
      level: "pass",
      message: "managed section present",
    });
  }
}

function finalize(projectPath: string, checks: DoctorCheck[]): DoctorReport {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.level]++;
  return { projectPath, checks, summary };
}

function renderDoctor(report: DoctorReport): void {
  console.log();
  console.log(pc.bold("TraceBase doctor"));
  console.log();

  // Align check names for readability.
  const nameWidth = Math.max(14, ...report.checks.map((c) => c.name.length));
  for (const c of report.checks) {
    const badge =
      c.level === "pass" ? pc.green("PASS")
      : c.level === "warn" ? pc.yellow("WARN")
      : pc.red("FAIL");
    const namePad = c.name.padEnd(nameWidth);
    console.log(`  ${badge}  ${namePad}  ${c.message}`);
    if (c.fix) console.log(pc.dim(" ".repeat(2 + 6 + nameWidth + 2) + "fix: " + c.fix));
  }

  console.log();
  const parts: string[] = [];
  if (report.summary.pass) parts.push(pc.green(`${report.summary.pass} PASS`));
  if (report.summary.warn) parts.push(pc.yellow(`${report.summary.warn} WARN`));
  if (report.summary.fail) parts.push(pc.red(`${report.summary.fail} FAIL`));
  console.log("  Summary: " + parts.join(pc.dim(" · ")));
  console.log();
  if (report.summary.fail > 0) {
    console.log(pc.red("  One or more critical checks failed. ") + pc.dim("See fix hints above."));
    console.log();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
