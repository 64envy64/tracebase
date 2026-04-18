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
import { findConfigDir, loadConfig } from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";

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

export function runDoctor(projectPath: string): DoctorReport {
  const checks: DoctorCheck[] = [];

  // --- .tracebase/config.json
  const configDir = findConfigDir(projectPath);
  if (!configDir) {
    checks.push({
      name: "tracebase-config",
      level: "fail",
      message: ".tracebase/config.json is missing",
      fix: "Run `npx tracebase init` in this project directory.",
    });
    return finalize(projectPath, checks);
  }

  const configFile = join(configDir, "config.json");
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(projectPath);
  } catch (e) {
    checks.push({
      name: "tracebase-config",
      level: "fail",
      message: `config.json is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      fix: "Inspect .tracebase/config.json or re-run `npx tracebase init --force`.",
    });
    return finalize(projectPath, checks);
  }

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

  // --- .claude/settings.json
  const settingsFile = join(projectPath, ".claude", "settings.json");
  if (!existsSync(settingsFile)) {
    checks.push({
      name: "claude-settings",
      level: "warn",
      message: ".claude/settings.json is missing",
      fix: "Run `npx tracebase init` (Claude Code will not see TraceBase until then).",
    });
  } else {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      checks.push({
        name: "claude-settings",
        level: "fail",
        message: ".claude/settings.json is not valid JSON",
        fix: "Fix the file manually, or re-run `npx tracebase init --force`.",
      });
    } else {
      const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
      const entry = servers.tracebase as Record<string, unknown> | undefined;
      if (!entry) {
        checks.push({
          name: "claude-settings",
          level: "fail",
          message: "no tracebase entry under mcpServers",
          fix: "Run `npx tracebase init` to register the MCP server.",
        });
      } else if (entry.command !== "npx" || !Array.isArray(entry.args)) {
        checks.push({
          name: "claude-settings",
          level: "warn",
          message: "tracebase MCP entry has a non-canonical shape",
          fix: "Re-run `npx tracebase init --force` to reset to the canonical entry.",
        });
      } else {
        checks.push({
          name: "claude-settings",
          level: "pass",
          message: "tracebase MCP entry installed",
        });
      }
    }
  }

  // --- CLAUDE.md
  const claudeMd = join(projectPath, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    checks.push({
      name: "claude-md",
      level: "warn",
      message: "CLAUDE.md is missing",
      fix: "Run `npx tracebase init` to create the instruction block.",
    });
  } else {
    const content = readFileSync(claudeMd, "utf-8");
    if (!content.includes("<!-- tracebase:begin") || !content.includes("<!-- tracebase:end -->")) {
      checks.push({
        name: "claude-md",
        level: "warn",
        message: "CLAUDE.md exists but the managed section is missing",
        fix: "Re-run `npx tracebase init` to append the managed block.",
      });
    } else {
      checks.push({
        name: "claude-md",
        level: "pass",
        message: "managed section present",
      });
    }
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

  return finalize(projectPath, checks);
  // config file path is included only so finalize can skip it in JSON.
  void configFile;
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
