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
import { spawnSync } from "node:child_process";
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
  MCP_ENTRY,
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
  // Same three-state handling as `status`: distinguish legacy
  // pre-multi-agent configs (no `install` field) from explicit
  // detach (`install.agents: []`) so doctor doesn't invent a phantom
  // default adapter after uninstall.
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

  if (agents.length === 0) {
    checks.push({
      name: "install",
      level: "warn",
      message: "no adapters wired up",
      fix: "Run `npx tracebase init` to attach Claude Code, Cursor, or Codex.",
    });
  } else {
    for (const a of agents) {
      const meta = getAgentTargetMeta(a);
      appendAgentIntegrationChecks(checks, projectRoot, a, meta.displayName);
    }
  }

  // --- cloud-link — informational, never FAIL.
  //
  // Three valid states:
  //   linked + installationIds present → "cloud-linked" (fully active)
  //   linked but no installationIds    → "linked but not yet registered" (WARN)
  //   not linked                       → "local only" (PASS — intentional mode)
  //
  // Connectivity to the control plane is NOT tested here: a cold install on a
  // laptop without internet is still a valid install, so we don't regress on
  // a flaky network. Use `tracebase usage sync --dry-run` when you need to
  // prove reachability.
  const cloud = cfg.cloud;
  if (cloud?.workspaceId) {
    const anyInstallationId =
      cloud.installationId ||
      (cloud.installationIds && Object.values(cloud.installationIds).some(Boolean));
    if (anyInstallationId) {
      checks.push({
        name: "cloud-link",
        level: "pass",
        message: `linked to ${cloud.workspaceSlug ?? cloud.workspaceId}${cloud.apiUrl ? ` (${cloud.apiUrl})` : ""}`,
      });
    } else {
      checks.push({
        name: "cloud-link",
        level: "warn",
        message: "cloud workspace linked but no installationId recorded",
        fix: "Re-run `npx tracebase init` with a valid --api-key to complete registration.",
      });
    }
  } else {
    checks.push({
      name: "cloud-link",
      level: "pass",
      message: "local only (no cloud link — sync disabled, local recall still works)",
    });
  }

  // --- MCP SDK availability (hard dependency)
  //
  // `@modelcontextprotocol/sdk` is a runtime dependency of
  // tracebase-ai, not an optional peer. `npx -y tracebase-ai serve
  // --mcp` will always install it; a missing SDK here means the
  // install is genuinely broken (corrupted node_modules, pinned
  // override, etc.) — FAIL, not WARN.
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
          level: "fail",
          message: "@modelcontextprotocol/sdk is not resolvable from the tracebase-ai install",
          fix:
            "The SDK is a hard dependency. Refresh the install with `npx -y tracebase-ai@latest serve --mcp` " +
            "or (for local dev) run `npm install` in the tracebase-ai package.",
        },
  );

  // --- Live MCP boot probe
  //
  // Spawns a real `tracebase serve --mcp --selftest` process to
  // confirm the exact boot path Claude Code will take actually works:
  // SDK loads, SQLite opens, every tool registers, no crash. A clean
  // exit 0 with READY on stdout is the contract for "MCP server will
  // connect on next Claude Code restart". Any failure is surfaced
  // with the captured stderr so users can fix it before restart —
  // rather than seeing "✗ Failed to connect" in `/mcp` and having to
  // guess why.
  //
  // Only run when the SDK resolves; otherwise the probe would FAIL
  // redundantly with the mcp-sdk check.
  if (mcpSdkAvailable) {
    checks.push(runMcpBootProbe(projectRoot));
  }

  // --- store content summary (informational)
  //
  // Wrapped in try/catch because a corrupted SQLite file will throw
  // on the first prepare() call. Doctor's job is to report such a
  // failure — not crash out and hide every check below it. The
  // earlier `storage` check catches most file-level corruption, but
  // some SQLITE_NOTADB cases only surface once a statement runs.
  if (existsSync(cfg.storagePath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(cfg.storagePath, { readonly: true });
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.push({
        name: "store-content",
        level: "fail",
        message: `store read failed: ${msg.split("\n")[0]}`,
        fix: "The store file is corrupted. Back it up, remove `.tracebase/memory.db`, and let the next MCP call recreate it.",
      });
    } finally {
      if (db) db.close();
    }
  }

  return finalize(projectRoot, checks);
}

/**
 * Spawn the *canonical registered* MCP command with `--selftest`
 * appended, and wait for READY\n + exit 0. This is the live boot
 * probe that catches the exact pre-restart failure mode: the npm-
 * published `tracebase-ai` runtime Claude Code will actually spawn
 * is broken, stale, or unreachable, even though the local dev
 * checkout is fine.
 *
 * The probe deliberately does NOT use `process.argv[1]` (the local
 * CLI): a PASS against the local checkout could hide a broken
 * published runtime, which is the whole thing this check exists to
 * surface.
 *
 * Test seam: `TRACEBASE_MCP_PROBE_COMMAND` lets tests redirect the
 * probe to a local CLI so CI doesn't hit the real npm registry. Set
 * it to a JSON array (`["node","/path/to/cli.js","serve","--mcp"]`);
 * the probe appends `--selftest`. Set it to the string `"skip"` to
 * suppress the probe entirely with an informational WARN.
 *
 * Bounded to 60 seconds because a cold `npx` invocation can download
 * the package; subsequent runs hit the npm cache and complete in
 * well under a second. Timing out returns FAIL — a user who restarts
 * Claude Code against a runtime this slow will also wait >60s before
 * seeing "Failed to connect".
 */
function runMcpBootProbe(_projectRoot: string): DoctorCheck {
  const override = process.env.TRACEBASE_MCP_PROBE_COMMAND?.trim();

  if (override === "skip") {
    return {
      name: "mcp-boot",
      level: "warn",
      message: "boot probe skipped via TRACEBASE_MCP_PROBE_COMMAND=skip",
    };
  }

  let executable: string;
  let args: string[];
  let displayCommand: string;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((x) => typeof x !== "string")) {
        throw new Error("expected a non-empty JSON array of strings");
      }
      const cmd = parsed as string[];
      executable = cmd[0]!;
      args = [...cmd.slice(1), "--selftest"];
      displayCommand = [executable, ...args].join(" ");
    } catch (e) {
      return {
        name: "mcp-boot",
        level: "warn",
        message: `boot probe skipped — TRACEBASE_MCP_PROBE_COMMAND is not valid JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  } else {
    executable = MCP_ENTRY.command;
    args = [...MCP_ENTRY.args, "--selftest"];
    displayCommand = [executable, ...args].join(" ");
  }

  const result = spawnSync(executable, args, {
    cwd: _projectRoot,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      name: "mcp-boot",
      level: "fail",
      message: `MCP server command not found: \`${executable}\``,
      fix:
        `Install the binary (${executable === "npx" ? "Node.js is required" : executable}) ` +
        "or re-run `npx tracebase init` to re-register a working command.",
    };
  }

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return {
      name: "mcp-boot",
      level: "fail",
      message: "MCP server selftest exceeded 60s — published runtime is stuck or unreachable",
      fix: `Run \`${displayCommand}\` manually to see where it stalls (cold npx fetch, blocked network, etc.).`,
    };
  }

  // Tracebase versions published before `--selftest` existed will
  // reject the flag via commander with an "unknown option" error.
  // That alone does NOT prove Claude Code will connect — the
  // registered command runs without `--selftest`, and the published
  // runtime could still crash on bare `serve --mcp` (e.g. a missing
  // @modelcontextprotocol/sdk in the shipped tarball). Do a second
  // probe WITHOUT the flag to distinguish:
  //   - bare command exits non-zero → FAIL, published runtime broken
  //   - bare command exits 0 within 3s → WARN (unusual but not broken)
  //   - bare command still running after 3s → WARN, healthy-looking
  //       stdio server, unverified but Claude Code will connect
  const unknownOptionSelftest =
    /unknown option.*--selftest|unknown command.*--selftest|unknown option '--selftest'/i.test(
      stderr + stdout,
    );
  if (unknownOptionSelftest) {
    return probeWithoutSelftest(executable, args, _projectRoot, displayCommand);
  }

  if (result.status !== 0 || !stdout.includes("READY")) {
    const detail = stderr || stdout || `exit ${result.status ?? "unknown"}`;
    return {
      name: "mcp-boot",
      level: "fail",
      message: `MCP server failed to boot: ${detail.split("\n").slice(-1)[0] || detail}`,
      fix:
        `Run \`${displayCommand}\` to see the full error. ` +
        "If it's an SDK resolve error, the published runtime is broken — " +
        "try `npx -y tracebase-ai@latest serve --mcp`.",
    };
  }

  return {
    name: "mcp-boot",
    level: "pass",
    message:
      override && override !== "skip"
        ? "MCP server boots cleanly via test-override command"
        : `MCP server boots cleanly via \`${displayCommand}\` (SDK loads, SQLite opens, every tool registers)`,
  };
}

/**
 * Fallback probe used when the canonical `--selftest` command is
 * rejected with "unknown option" (i.e. the registered runtime predates
 * this flag). Spawns the same command WITHOUT `--selftest`, so we can
 * observe whether the published runtime is actually bootable — the
 * "unknown option" signal alone does NOT prove Claude Code will
 * connect. A real example this branch catches: the published tarball
 * is missing @modelcontextprotocol/sdk and crashes with
 * ERR_MODULE_NOT_FOUND before the MCP server even starts listening.
 *
 * Bounded at 3 seconds — a healthy stdio MCP server stays alive
 * indefinitely waiting for input; any crash on boot fires fast.
 * spawnSync's timeout path kills with SIGTERM; we use that as the
 * "stayed alive" signal.
 */
function probeWithoutSelftest(
  executable: string,
  argsWithSelftest: string[],
  projectRoot: string,
  selftestDisplayCommand: string,
): DoctorCheck {
  const bareArgs = argsWithSelftest.filter((a) => a !== "--selftest");
  const bareDisplay = [executable, ...bareArgs].join(" ");
  const result = spawnSync(executable, bareArgs, {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 3_000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  // spawnSync hit our timeout → it SIGTERM'd a still-running process.
  // For an MCP stdio server, "still running" is the healthy state:
  // it's waiting for JSON-RPC requests on stdin. We can't verify
  // tools registered (that's what --selftest is for), but we can at
  // least say the boot reached the listening state.
  const stayedAlive =
    result.signal === "SIGTERM" ||
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";

  if (stayedAlive) {
    return {
      name: "mcp-boot",
      level: "warn",
      message:
        "live boot probe unavailable (--selftest predates installed runtime), " +
        "but bare `serve --mcp` stays alive like a healthy stdio server",
      fix:
        `Update to get the full probe: \`${selftestDisplayCommand}\` will succeed once the latest ` +
        "tracebase-ai version is published to npm. Claude Code's MCP connect path appears functional now.",
    };
  }

  if (result.status === 0) {
    // Unusual: an MCP stdio server shouldn't exit on its own. Not a
    // crash, but worth flagging.
    return {
      name: "mcp-boot",
      level: "warn",
      message:
        "live boot probe unavailable; bare `serve --mcp` exited 0 unexpectedly (stdio MCP servers normally keep listening)",
      fix:
        `Run \`${bareDisplay}\` manually to see what the process printed; ` +
        `or wait for the latest tracebase-ai to publish and re-run doctor (\`${selftestDisplayCommand}\`).`,
    };
  }

  // Non-zero exit within 3 seconds — published runtime is genuinely
  // broken. This is the regression we explicitly guard against: the
  // "--selftest unknown" path must NOT falsely reassure the user.
  const detail = stderr || stdout || `exit ${result.status ?? "unknown"}`;
  // Prefer the human-readable error line ("Error: Cannot find package X")
  // over the `throw new ERR_MODULE_NOT_FOUND(...)` stack frame that precedes
  // it. Node ESM loader crashes dump both; the second one is what users need.
  const lines = detail.split("\n").map((l) => l.trim()).filter(Boolean);
  const keyLine =
    lines.find((l) => /^(error|Cannot find)/i.test(l)) ??
    lines.find((l) => /cannot find|not found|ERR_[A-Z_]+/i.test(l) && !/^\s*throw /.test(l)) ??
    lines[lines.length - 1] ??
    detail;
  return {
    name: "mcp-boot",
    level: "fail",
    message: `published tracebase-ai runtime fails to boot: ${keyLine}`,
    fix:
      `Run \`${bareDisplay}\` to see the full error. ` +
      "If it's a missing-dependency error (e.g. @modelcontextprotocol/sdk), the published tarball is broken and needs a re-publish.",
  };
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

  if (agent === "claude-code" && mcp.cliMissing) {
    // No `claude` CLI → the runtime registry is unreachable, which is
    // a hard failure: `init` won't be able to register, and any entry
    // still in `.claude/settings.json` would be a false-positive "PASS"
    // against a path Claude Code no longer reads.
    checks.push({
      name: mcpCheckName,
      level: "fail",
      message: "claude CLI is not available in PATH",
      fix:
        "Install Claude Code (https://claude.com/claude-code) or add `claude` to PATH, then re-run " +
        `\`${initCommand}\`.`,
    });
  } else if (mcp.parseError) {
    checks.push({
      name: mcpCheckName,
      level: "fail",
      message:
        agent === "codex"
          ? `codex MCP inspection failed: ${mcp.parseError}`
          : agent === "claude-code"
            ? `claude mcp inspection failed: ${mcp.parseError}`
            : `${getAgentTargetMeta(agent).mcpLocationLabel} is not valid JSON`,
      fix:
        agent === "codex"
          ? "Ensure the `codex` CLI is installed and re-run `npx tracebase init --agent codex --force`."
          : agent === "claude-code"
            ? `Ensure the \`claude\` CLI is healthy and re-run \`${initCommand} --agent claude-code --force\`.`
            : `Fix the file manually, or re-run \`${initCommand} --force\`.`,
    });
  } else if (!mcp.present) {
    const missingConfigSurface =
      agent !== "claude-code" && agent !== "codex" && mcp.containerPresent === false;
    checks.push({
      name: mcpCheckName,
      level: missingConfigSurface ? "warn" : "fail",
      message:
        missingConfigSurface
          ? `${getAgentTargetMeta(agent).mcpLocationLabel} is missing`
        : agent === "codex"
          ? "tracebase is not registered under codex mcp"
        : agent === "claude-code"
          ? "tracebase is not registered in the claude mcp runtime registry"
          : `${getAgentTargetMeta(agent).mcpLocationLabel} is missing or has no tracebase entry`,
      fix:
        missingConfigSurface
          ? `Run \`${initCommand}\` (${displayName} will not see TraceBase until then).`
          : agent === "claude-code"
          ? `Run \`${initCommand}\` — it invokes \`claude mcp add tracebase --scope local -- npx -y tracebase-ai@latest serve --mcp\` for you.`
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
      message:
        agent === "claude-code"
          ? "tracebase registered in claude mcp (local scope)"
          : "tracebase MCP entry installed",
    });
  }

  // Claude Code only: flag a stale `.claude/settings.json` entry. It
  // does not affect the runtime check (Claude Code ignores the file)
  // so this stays WARN, but it's the strongest signal that a user
  // upgraded from the pre-runtime-registry era — and we want to push
  // them to clean it up before a future `doctor` run gets noisier.
  if (agent === "claude-code" && mcp.legacySettingsStale) {
    checks.push({
      name: "claude-code-legacy-settings",
      level: "warn",
      message: ".claude/settings.json contains a stale tracebase mcpServers entry (Claude Code ignores it)",
      fix:
        `Run \`${initCommand}\` to sweep the stale entry, or delete it manually from .claude/settings.json.`,
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
