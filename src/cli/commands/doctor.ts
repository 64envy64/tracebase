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
import { delimiter as PATH_DELIM, join } from "node:path";
import pc from "picocolors";
import Database from "better-sqlite3";
import {
  findProjectRoot,
  loadConfig,
  normalizeInstallAgents,
  readCascadeConfig,
  readHoldoutConfig,
} from "../../core/config.js";
import { BlockStore } from "../../core/block-store.js";
import type { CascadeConfig, TraceBaseConfig } from "../../types.js";
import { MiniLMReranker } from "../../core/rerankers/minilm.js";
import {
  getAgentTargetMeta,
  hookEventsForAgent,
  // 0.5.6 — auto-heal hook-health marker
  inspectAgentHookConfig,
  inspectAgentInstructionFile,
  inspectAgentMcpConfig,
  MCP_ENTRY,
  resolveInstallAgent,
  type HookEventState,
  type InstallAgent,
} from "../install-targets.js";
import { readHookHealth } from "../hook-self-heal.js";
import { resolveReasoningRouterMode, REASONING_ROUTER_ENV } from "../../experiments/reasoning-router-rollout.js";

/**
 * 0.6.0 — `info` added for purely diagnostic state that's
 * neither passing nor warning. Doctor exit-code logic still
 * keys on `fail` only; `info` rows show with a cyan badge.
 */
export type DoctorLevel = "pass" | "info" | "warn" | "fail";

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
  summary: { pass: number; info: number; warn: number; fail: number };
}

export const doctorCommand = new Command("doctor")
  .description("Verify install integrity and surface broken config with fix hints")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--json", "machine-readable JSON output")
  .option(
    "--fix",
    "apply safe auto-fixes (e.g. pre-warm the configured reranker). Never installs native deps — those are printed as actionable npm commands instead.",
  )
  .action(async (opts: { path: string; json?: boolean; fix?: boolean }) => {
    const report = runDoctor(opts.path);
    if (opts.fix) {
      // applyDoctorFixes runs the safe-side actions (model pre-warm,
      // pending-embedding drain, FTS rebuild — landed incrementally
      // across B1.3+). It mutates `report` in place so the rendered
      // output reflects post-fix state.
      await applyDoctorFixes(report, opts.path);
    }
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
      fix: "Run `npx tracebase-ai init` in this project directory.",
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
      fix: "Run `npx tracebase-ai init` in this project directory.",
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
      fix: "Check file permissions; re-run `npx tracebase-ai init --force` if necessary.",
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
      fix: "Fix the JSON by hand or re-run `npx tracebase-ai init --force` (this rewrites the file).",
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
      fix: "Re-run `npx tracebase-ai init` to generate one.",
    });
  } else {
    checks.push({
      name: "tracebase-config",
      level: "pass",
      message: `parseable, workspaceId ${cfg.workspaceId.slice(0, 8)}…`,
    });
  }

  // 0.5.3 — workspaceSalt is the HMAC key for `tool_observations.arg_key`.
  // Missing on legacy installs created before 0.5.3; the runtime
  // lazy-mints on first read, so this is informational, never a FAIL.
  if (!cfg.workspaceSalt) {
    checks.push({
      name: "workspace-salt",
      level: "warn",
      message: "config.json parseable but workspaceSalt is missing",
      fix:
        "Will be lazily generated on the first PostToolBatch hook fire. " +
        "Re-run `npx tracebase-ai init` to mint one eagerly.",
    });
  } else {
    checks.push({
      name: "workspace-salt",
      level: "pass",
      message: "present (local-only HMAC key for tool-observation buckets)",
    });
  }
  cfg = resolvedCfg;

  // 0.6.0 — Impact measurement check. PASS when holdout is
  // enabled at a sane rate; INFO when disabled / missing (the
  // state is intentional but we surface the next-step command);
  // WARN when the experiment block is malformed / partial.
  appendImpactMeasurementCheck(checks, projectRoot);

  // 0.7.0-rc.2 §rc.2 — file indexer health surface. Reports
  // indexed count, pending sizes, summarizer in use, last drain
  // duration, and aggregated skip reasons. WARN when nothing is
  // indexed AND no completion event ever fired (indexer never ran).
  appendFileIndexerCheck(checks, cfg.storagePath);

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
      fix: "Run `npx tracebase-ai init` to attach Claude Code, Cursor, or Codex.",
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
        fix: "Re-run `npx tracebase-ai init` with a valid --api-key to complete registration.",
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

  // --- Cascade reranker (May-2026 B1.3)
  //
  // When cascade.enabled is true and reranker.kind is non-noop, the
  // cascade path will eventually try to spawn a worker. Surface any
  // missing-deps / unknown-kind state HERE so users discover it
  // during `doctor` rather than mid-traffic. The check is purely
  // diagnostic — `doctor --fix` runs the safe-side pre-warm (model
  // download via @xenova/transformers cache). We NEVER auto-`npm
  // install` native deps; missing-dep FAIL emits the exact command.
  appendCascadeRerankerCheck(checks, projectRoot);

  // --- Router V2 rollout (TRACEBASE_REASONING_ROUTER) — diagnostic surface.
  //
  // resolveReasoningRouterMode() returns diagnostics that the runtime
  // construction path (routerServingOptions) intentionally does not log on the
  // hot path; doctor is the operator-facing surface for them. A typo'd env value
  // fails safe to `off`, and is reported here as a WARN so it isn't silent.
  checks.push(reasoningRouterDoctorCheck());

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
/**
 * Resolve an executable name to the absolute path that `spawn` should
 * actually run. POSIX shells (and Node's POSIX spawn) handle PATH
 * lookup natively, but Windows is broken in two specific ways the
 * probe used to hit:
 *
 *   1. `spawnSync("npx", ...)` does NOT apply PATHEXT — it looks for
 *      a literal file named `npx` (no extension) and fails ENOENT
 *      even though `npx.cmd` is right next to `node.exe` on PATH.
 *
 *   2. Even if we resolve to `npx.cmd`, post-CVE-2024-27980 Node
 *      refuses to spawn `.cmd` / `.bat` files unless `shell: true`
 *      is passed, because the underlying CreateProcessW shim does
 *      not safely quote arbitrary args inside cmd.exe parsing.
 *
 * So on Windows: walk PATH × PATHEXT once, return the full resolved
 * path (or `null` if nothing matches), and let the caller decide
 * whether to set `shell: true` based on the extension. On POSIX:
 * fast-path return the original name and let Node handle it.
 */
export function resolveCommandPath(name: string): string | null {
  // Absolute or relative path that already exists — use as-is.
  if (existsSync(name)) return name;
  if (process.platform !== "win32") {
    // POSIX — Node's PATH lookup will handle it. Returning the bare
    // name lets `spawnSync` resolve as usual; if it actually doesn't
    // exist, spawn will surface ENOENT and the existing FAIL branch
    // explains the fix.
    return name;
  }
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(PATH_DELIM).filter(Boolean);
  const extEnv = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const exts = extEnv
    .split(";")
    .map((e) => e.toLowerCase())
    .filter(Boolean);
  const lower = name.toLowerCase();
  const hasKnownExt = exts.some((e) => lower.endsWith(e));
  for (const dir of dirs) {
    if (hasKnownExt) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

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

  // Resolve the executable upfront so Windows finds `npx.cmd` etc.
  // before spawn touches it; otherwise `spawnSync("npx", ...)` would
  // ENOENT on every Windows install even though npx is on PATH.
  const resolvedExecutable = resolveCommandPath(executable);
  if (resolvedExecutable === null) {
    return {
      name: "mcp-boot",
      level: "fail",
      message: `MCP server command not found: \`${executable}\``,
      fix:
        `Install the binary (${executable === "npx" ? "Node.js is required" : executable}) ` +
        "or re-run `npx tracebase-ai init` to re-register a working command.",
    };
  }

  // CVE-2024-27980 (Node ≥ 18.20 / 20.12 / 21.7): spawning a `.cmd`
  // or `.bat` file requires `shell: true`. Set it on Windows when the
  // resolved binary is one of those — args here are static and known
  // safe (-y, package@latest, serve, --mcp, --selftest), so the shell
  // quoting concern doesn't bite.
  const lowerResolved = resolvedExecutable.toLowerCase();
  const needsShell =
    process.platform === "win32" &&
    (lowerResolved.endsWith(".cmd") || lowerResolved.endsWith(".bat"));

  // When `shell: true` is on, Node assembles `cmd.exe /d /s /c "<exe>
  // <args>"`. Passing the resolved absolute path with spaces (e.g.
  // `C:\Program Files\nodejs\npx.cmd`) would break cmd.exe's quote
  // parsing — it tokenises on the first space. The cleanest fix is to
  // hand cmd.exe the bare name (`npx`) and let it walk PATH + PATHEXT
  // itself. The upfront `resolveCommandPath` call above already
  // confirmed something resolves, so this can't reintroduce the
  // command-not-found ENOENT we just fixed.
  const spawnTarget = needsShell ? executable : resolvedExecutable;

  const result = spawnSync(spawnTarget, args, {
    cwd: _projectRoot,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
    shell: needsShell,
  });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    // Reachable only on POSIX (Windows resolved upfront above), where
    // Node's PATH lookup didn't find the executable at spawn time.
    return {
      name: "mcp-boot",
      level: "fail",
      message: `MCP server command not found: \`${executable}\``,
      fix:
        `Install the binary (${executable === "npx" ? "Node.js is required" : executable}) ` +
        "or re-run `npx tracebase-ai init` to re-register a working command.",
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

/**
 * 0.6.0 — Impact measurement (holdout experiment) doctor check.
 *
 * Reads the on-disk experiment config directly so a malformed
 * file is reported as WARN rather than silently ignored by
 * `readHoldoutConfig`'s tolerant parse. The render copy is
 * actionable: PASS shows the rate; INFO shows the enable
 * command; WARN says how to repair.
 */
function appendImpactMeasurementCheck(
  checks: DoctorCheck[],
  projectRoot: string,
): void {
  const configFile = join(projectRoot, ".tracebase", "config.json");
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf-8")) as unknown;
  } catch {
    // config.json parse error already surfaced by an earlier
    // check — skip the impact check rather than double-reporting.
    return;
  }
  if (!raw || typeof raw !== "object") return;
  const experiment = (raw as { experiment?: unknown }).experiment;
  if (experiment !== undefined && (typeof experiment !== "object" || experiment === null)) {
    checks.push({
      name: "impact-measurement",
      level: "warn",
      message: "experiment block is not an object",
      fix:
        "Edit `.tracebase/config.json` and remove the malformed `experiment` field, " +
        "then re-enable with `npx tracebase-ai init --holdout-rate 0.1`.",
    });
    return;
  }
  const cfg = readHoldoutConfig(projectRoot);
  if (!cfg) {
    // Either no experiment block at all, or the holdout sub-field
    // failed validation (numbers / booleans / dates). The
    // tolerant reader returned null; we can't tell the two apart
    // from here without re-parsing, so the message covers both.
    if (
      experiment !== undefined &&
      typeof experiment === "object" &&
      experiment !== null &&
      "holdout" in (experiment as Record<string, unknown>)
    ) {
      checks.push({
        name: "impact-measurement",
        level: "warn",
        message: "experiment.holdout block is malformed",
        fix:
          "Run `npx tracebase-ai init --holdout-rate 0.1` to rewrite it cleanly. " +
          "The command preserves any salt + createdAt that survives the rewrite.",
      });
      return;
    }
    checks.push({
      name: "impact-measurement",
      level: "info",
      message: "disabled — enable with `npx tracebase-ai init --holdout-rate 0.1`",
    });
    return;
  }
  if (!cfg.enabled) {
    checks.push({
      name: "impact-measurement",
      level: "info",
      message: `disabled (rate ${cfg.rate}) — re-enable with \`npx tracebase-ai init --holdout-rate ${cfg.rate}\``,
    });
    return;
  }
  // Sanity check the rate: outside (0, 1] is malformed even if
  // the JSON parsed cleanly.
  if (!Number.isFinite(cfg.rate) || cfg.rate <= 0 || cfg.rate > 1) {
    checks.push({
      name: "impact-measurement",
      level: "warn",
      message: `rate out of range: ${cfg.rate} (expected 0 < rate ≤ 1)`,
      fix: "Re-run `npx tracebase-ai init --holdout-rate 0.1` to reset to a valid value.",
    });
    return;
  }
  const ratePct = Math.round(cfg.rate * 100);
  checks.push({
    name: "impact-measurement",
    level: "pass",
    message: `enabled (${ratePct}% holdout)`,
  });
}

/**
 * 0.7.0-rc.2 §rc.2 — file indexer health.
 *
 * State machine:
 *   - FAIL: storage path unreadable or schema not at >= v=10.
 *   - WARN: indexed_files is empty AND no file_index.completed
 *           event ever fired (indexer hasn't run, OR every run
 *           failed silently).
 *   - INFO: pending queue non-empty (indexer is mid-walk or has
 *           opportunistic work to do).
 *   - PASS: indexed_files populated AND no pending work.
 *
 * The check opens its own short-lived BlockStore connection. We
 * `skipMigrate: true` because the version check is part of the
 * surfaced report — auto-migrating from inside doctor would mask
 * a corrupted DB rather than report it.
 */
function appendFileIndexerCheck(checks: DoctorCheck[], storagePath: string): void {
  if (!existsSync(storagePath)) {
    // Storage missing is already surfaced by an earlier check;
    // emit info here so the operator sees the section but no
    // duplicate FAIL.
    checks.push({
      name: "file-indexer",
      level: "info",
      message: "storage not initialized — run `npx tracebase-ai init`",
    });
    return;
  }

  let db: Database.Database | null = null;
  let store: BlockStore | null = null;
  try {
    db = new Database(storagePath, { readonly: false });
    store = new BlockStore(db, { skipMigrate: true });

    // Schema gate. If the indexer tables are absent, the doctor's
    // job is to surface the upgrade hint, not silently re-attempt
    // a migration.
    const tables = (
      store.rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    if (!tables.includes("indexed_files") || !tables.includes("indexer_pending")) {
      checks.push({
        name: "file-indexer",
        level: "warn",
        message: "indexer tables missing — re-run `npx tracebase-ai init` to migrate",
      });
      return;
    }

    const indexedCount = (
      store.rawDb.prepare("SELECT COUNT(*) AS c FROM indexed_files").get() as { c: number }
    ).c;
    const pendingFile = (
      store.rawDb
        .prepare("SELECT COUNT(*) AS c FROM indexer_pending WHERE kind = 'file'")
        .get() as { c: number }
    ).c;
    const pendingDir = (
      store.rawDb
        .prepare("SELECT COUNT(*) AS c FROM indexer_pending WHERE kind = 'dir'")
        .get() as { c: number }
    ).c;

    const completionEvents = store.readEvents({
      eventType: "file_index.completed",
      limit: 50,
    });
    const lastEvent =
      completionEvents.length > 0 ? completionEvents[completionEvents.length - 1] : null;
    const summarizer =
      lastEvent && lastEvent.event === "file_index.completed"
        ? lastEvent.summarizer
        : "heuristic";
    const lastDurationMs =
      lastEvent && lastEvent.event === "file_index.completed"
        ? lastEvent.durationMs
        : null;

    const skipReasons = aggregateSkipReasons(store);

    if (indexedCount === 0 && completionEvents.length === 0) {
      checks.push({
        name: "file-indexer",
        level: "warn",
        message:
          "no files indexed and no completion events — indexer has not run yet",
        fix: "Re-run `npx tracebase-ai init` to populate the indexer.",
      });
      return;
    }

    const total = pendingFile + pendingDir;
    const skipsTag = skipReasons.length > 0 ? ` · skips: ${skipReasons.join(", ")}` : "";
    const lastTag = lastDurationMs !== null ? ` · last drain ${lastDurationMs}ms` : "";

    if (total > 0) {
      checks.push({
        name: "file-indexer",
        level: "info",
        message:
          `${indexedCount} indexed (${summarizer}) · ${pendingFile} pending file(s)` +
          ` · ${pendingDir} pending dir(s)${lastTag}${skipsTag}`,
      });
      return;
    }

    checks.push({
      name: "file-indexer",
      level: "pass",
      message:
        `${indexedCount} indexed (${summarizer})${lastTag}${skipsTag}`,
    });
  } catch (err) {
    checks.push({
      name: "file-indexer",
      level: "warn",
      message:
        "indexer health check failed — " +
        (err instanceof Error ? err.message : String(err)),
    });
  } finally {
    if (store) store.close();
    if (db?.open) db.close();
  }
}

/**
 * Walk the recent `file_index.skipped` events and produce a short
 * `reason: count` summary for the doctor line. Bounded so the
 * doctor output stays one line.
 */
function aggregateSkipReasons(store: BlockStore): string[] {
  const events = store.readEvents({ eventType: "file_index.skipped", limit: 200 });
  const counts: Record<string, number> = {};
  for (const ev of events) {
    if (ev.event !== "file_index.skipped") continue;
    counts[ev.reason] = (counts[ev.reason] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, n]) => `${reason}=${n}`);
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
  const initCommand = "npx tracebase-ai init";
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
          ? "Ensure the `codex` CLI is installed and re-run `npx tracebase-ai init --agent codex --force`."
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

  // Hook health — Claude Code only. Surfaced as a separate check
  // from MCP because the two surfaces are independent: MCP can be
  // perfectly configured while `.claude/settings.json` has no hook
  // entries, which silently degrades the default UX (users lose
  // silent injection + background capture and fall back to the
  // foreground MCP permission prompt). Regression that doctor must
  // catch: MCP + CLAUDE.md OK but Stop hook missing — report-level
  // must not be "fully OK".
  const hookInspection = inspectAgentHookConfig(projectRoot, agent);
  if (hookInspection.supported) {
    const hookCheckName = `${agent}-hooks`;
    const managedEvents = hookEventsForAgent(agent);
    const states = managedEvents.map(
      (e) => [e, hookInspection.events[e] ?? "missing"] as const,
    );
    const missing = states.filter(([, s]) => s === "missing").map(([e]) => e);
    const nonCanonical = states.filter(([, s]) => s === "non-canonical").map(([e]) => e);

    if (missing.length === managedEvents.length) {
      checks.push({
        name: hookCheckName,
        level: "warn",
        message:
          `${displayName} hooks not installed (silent injection + background capture disabled)`,
        fix:
          `Run \`${initCommand}\` to install the UserPromptSubmit + Stop hooks. ` +
          "Without them, the agent sees no injected prior patterns and the MCP tool path pops a permission prompt on every capture.",
      });
    } else if (missing.length > 0) {
      checks.push({
        name: hookCheckName,
        level: "warn",
        message: `${displayName} hooks partially installed — missing: ${missing.join(", ")}`,
        fix: `Run \`${initCommand}\` to install the missing hook(s).`,
      });
    } else if (nonCanonical.length > 0) {
      checks.push({
        name: hookCheckName,
        level: "warn",
        message: `${displayName} hooks installed but non-canonical: ${nonCanonical.join(", ")}`,
        fix: `Re-run \`${initCommand}\` to refresh the hook entry (auto-upgrades from known legacy shapes without --force).`,
      });
    } else {
      const stateSummary = states
        .map(([e, s]) => `${e}:${stateAbbrev(s)}`)
        .join(" · ");
      checks.push({
        name: hookCheckName,
        level: "pass",
        message: `${displayName} hooks canonical (${stateSummary})`,
      });
    }

    // 0.5.6 — hook-health surface. Companion to the existing
    // hook check; reports on the self-heal marker without
    // re-walking settings.json. Three states:
    //   PASS — last self-heal saw nothing customised + ran
    //          recently (or hasn't run yet on a fresh canonical
    //          install — no marker, no problem)
    //   WARN — at least one event is user-customised so
    //          self-heal is leaving it alone; user must
    //          decide whether to keep the customisation or
    //          re-init with --force
    //   INFO/PASS — recently wrote → noted in the message
    if (agent === "claude-code") {
      const health = readHookHealth(projectRoot);
      const customised = health.lastSkippedCustom ?? [];
      const lastWritten = health.lastWrittenAt;
      const lastUpdated = health.lastUpdated ?? [];

      if (customised.length > 0) {
        checks.push({
          name: "hook-health",
          level: "warn",
          message:
            `auto-heal skipped customised entries: ${customised.join(", ")}`,
          fix:
            `Self-heal preserves user-customised TraceBase hooks. Re-run ` +
            `\`${initCommand} --force\` to overwrite back to canonical, ` +
            `or keep the customisation and ignore this warning.`,
        });
      } else if (lastWritten && Date.now() - lastWritten < 24 * 60 * 60 * 1000) {
        const updates = lastUpdated.length > 0 ? ` (${lastUpdated.join(", ")})` : "";
        checks.push({
          name: "hook-health",
          level: "pass",
          message: `auto-heal updated recently${updates}; throttle armed`,
        });
      } else {
        checks.push({
          name: "hook-health",
          level: "pass",
          message: "auto-heal idle (no customised entries; throttle armed)",
        });
      }
    }
  }
}

function stateAbbrev(s: HookEventState): string {
  return s === "canonical" ? "ok" : s;
}

/**
 * Router V2 rollout diagnostic check. Reads TRACEBASE_REASONING_ROUTER and
 * reports the effective mode; a typo fails safe to `off` and is surfaced as a
 * WARN (never silent). The message is static operator-facing text — no prompt,
 * path, or the raw (possibly-arbitrary) env value is echoed. Exported for tests.
 */
export function reasoningRouterDoctorCheck(env: NodeJS.ProcessEnv = process.env): DoctorCheck {
  const { mode, diagnostics } = resolveReasoningRouterMode(env);
  const invalid = diagnostics.some((d) => d.includes("ignored"));
  if (invalid) {
    return {
      name: "reasoning-router",
      level: "warn",
      message: `Router V2 rollout: invalid ${REASONING_ROUTER_ENV} value — defaulted to off (serving V1 only)`,
      fix: `Set ${REASONING_ROUTER_ENV} to one of: off | shadow | on.`,
    };
  }
  if (mode === "shadow") {
    return {
      name: "reasoning-router",
      level: "info",
      message: "Router V2 rollout: shadow (serving V1; computing V2 side-by-side for comparison telemetry)",
    };
  }
  if (mode === "on") {
    return {
      name: "reasoning-router",
      level: "pass",
      message: "Router V2 rollout: on (serving V2-family; fails open to V1)",
    };
  }
  return {
    name: "reasoning-router",
    level: "info",
    message: "Router V2 rollout: off (serving V1 only; default)",
  };
}

// ============================================================================
// May-2026 B1.3 — cascade reranker health + safe-side pre-warm.
// ============================================================================

/**
 * Diagnostic check for the cascade reranker. Reads `cascade.json`,
 * decides what state the reranker should be in, and produces one
 * `DoctorCheck` row reflecting reality:
 *
 *   • Cascade disabled / no config       → info row, "cascade off"
 *   • kind: "noop"                       → pass, "cascade on, no-op reranker"
 *   • kind: "cloud" + endpoint           → pass, "cascade on, cloud endpoint"
 *   • kind: "cloud" without endpoint     → fail with fix command
 *   • kind: "minilm" + dep present       → pass, "ready (run --fix to pre-warm)"
 *   • kind: "minilm" without dep         → fail with exact npm install command
 *   • kind: "bge-v2-m3"                  → warn, "deferred to B1.4 (downgrades to noop)"
 *
 * No work happens here beyond reading config + probing whether the
 * @xenova/transformers module is resolvable. Pre-warm (spawning a
 * worker, loading the model) is the job of `applyDoctorFixes` when
 * the user explicitly runs `doctor --fix`.
 */
function appendCascadeRerankerCheck(checks: DoctorCheck[], projectRoot: string): void {
  let cfg: CascadeConfig | null;
  try {
    cfg = readCascadeConfig(projectRoot);
  } catch {
    cfg = null;
  }
  if (!cfg) {
    checks.push({
      name: "cascade-reranker",
      level: "info",
      message: "cascade not configured (sync recall path; default install behaviour)",
    });
    return;
  }
  if (!cfg.enabled) {
    checks.push({
      name: "cascade-reranker",
      level: "info",
      message: `cascade present but disabled (kind="${cfg.reranker.kind}")`,
      fix: "Re-enable with `tracebase cascade enable` once you're ready to ramp the rollout.",
    });
    return;
  }

  const kind = cfg.reranker.kind;
  if (kind === "noop") {
    checks.push({
      name: "cascade-reranker",
      level: "pass",
      message: `cascade on with kind="noop" (architecture exercised, no semantic rerank)`,
    });
    return;
  }
  if (kind === "cloud") {
    if (!cfg.reranker.endpoint) {
      checks.push({
        name: "cascade-reranker",
        level: "fail",
        message: `kind="cloud" but no endpoint configured`,
        fix:
          "Set `experiment.cascade.reranker.endpoint` in .tracebase/config.json to a reranker URL, " +
          "or switch kind to \"noop\" / \"minilm\".",
      });
      return;
    }
    checks.push({
      name: "cascade-reranker",
      level: "pass",
      message: `cascade on with kind="cloud" → ${cfg.reranker.endpoint}`,
    });
    return;
  }
  if (kind === "bge-v2-m3") {
    checks.push({
      name: "cascade-reranker",
      level: "warn",
      message: `kind="bge-v2-m3" is deferred to B1.4 — request silently downgrades to noop until then`,
      fix: "Track B1.4 or switch to kind=\"minilm\" for local reranking today.",
    });
    return;
  }
  // kind === "minilm"
  const depPresent = isModuleResolvable("@xenova/transformers");
  if (!depPresent) {
    checks.push({
      name: "cascade-reranker",
      level: "fail",
      message: `kind="minilm" requires @xenova/transformers (optional peer dep — not installed)`,
      fix:
        "Install in YOUR project (we never auto-install native deps): " +
        "`npm install @xenova/transformers`. " +
        "Or switch to kind=\"cloud\" / \"noop\" if you don't want a local model.",
    });
    return;
  }
  checks.push({
    name: "cascade-reranker",
    level: "pass",
    message: `kind="minilm" ready (@xenova/transformers resolvable). ` +
      `Run \`tracebase doctor --fix\` to pre-warm the worker + model cache.`,
  });
}

/**
 * Whether `name` is resolvable from this install's module graph.
 * Mirrors the @modelcontextprotocol/sdk probe earlier in the file —
 * `require.resolve` survives tsup's CJS/ESM split because tsup emits
 * a CJS shim for the dual-format build.
 */
function isModuleResolvable(name: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the safe-side automatic fixes implied by the current report.
 * Mutates `report` so the rendered output reflects the post-fix
 * state. Two invariants:
 *
 *   1. NEVER installs native deps (no `npm install` shelled out).
 *      Missing deps stay as FAIL with the actionable command —
 *      installing into a foreign project is a side effect we
 *      refuse to take.
 *   2. Idempotent. Running `doctor --fix` twice in a row is safe;
 *      already-warm rerankers re-warm into the same cache.
 *
 * Currently fixes:
 *   • cascade-reranker / kind:"minilm" — spawn the worker, send a
 *     dummy score request, terminate. Forces @xenova/transformers
 *     to download model weights into its cache so the first
 *     production query doesn't pay the latency.
 *
 * Future calls (B1.4+) plug in here: pending_embeddings drain, FTS5
 * rebuild, etc. Same contract: safe-side only, idempotent, never
 * installs deps.
 */
export async function applyDoctorFixes(
  report: DoctorReport,
  projectRoot: string,
): Promise<void> {
  const cfg = readCascadeConfig(projectRoot);
  if (cfg?.enabled && cfg.reranker.kind === "minilm" && isModuleResolvable("@xenova/transformers")) {
    const warmResult = await prewarmMiniLM(cfg);
    // Replace the cascade-reranker check with the post-warm state
    // so users see the result of their `--fix` invocation, not the
    // pre-fix snapshot.
    const idx = report.checks.findIndex((c) => c.name === "cascade-reranker");
    if (idx >= 0) {
      report.checks[idx] = warmResult;
      // Recompute the summary tallies since we replaced a row.
      report.summary = recountSummary(report.checks);
    } else {
      report.checks.push(warmResult);
      report.summary = recountSummary(report.checks);
    }
  }
}

/**
 * Spawn a MiniLMReranker, send a tiny score request, wait for the
 * response (or a generous timeout), terminate. Doesn't propagate
 * the result to anyone — the call is purely a side-effect to
 * populate the @xenova/transformers model cache so the first
 * production query is hot.
 *
 * Timeout is intentionally generous (60s) because the first cold
 * run can pull ~80MB over the network from HF. Test that user wants
 * a faster ceiling, they can interrupt with ^C — runDoctor exits
 * cleanly because the worker is in a separate thread.
 */
async function prewarmMiniLM(cfg: CascadeConfig): Promise<DoctorCheck> {
  const reranker = new MiniLMReranker({
    ...(cfg.reranker.model ? { modelId: cfg.reranker.model } : {}),
  });
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 60_000);
  timeout.unref?.();
  try {
    const start = Date.now();
    const scores = await reranker.score(
      "warm-up query: do not act on this content",
      [{ blockId: "_warm", triggerText: "warm-up candidate trigger text" }],
      { signal: ctrl.signal },
    );
    const ms = Date.now() - start;
    if (scores === null) {
      return {
        name: "cascade-reranker",
        level: "fail",
        message: `kind="minilm" pre-warm failed (scoring returned null after ${ms}ms)`,
        fix:
          "Check the @xenova/transformers install + network access to huggingface.co. " +
          "Or switch to kind=\"cloud\" / \"noop\".",
      };
    }
    return {
      name: "cascade-reranker",
      level: "pass",
      message: `kind="minilm" warm — worker + model loaded in ${ms}ms; first production query will be hot`,
    };
  } finally {
    clearTimeout(timeout);
    reranker.terminate();
  }
}

function recountSummary(checks: DoctorCheck[]): DoctorReport["summary"] {
  const out = { pass: 0, info: 0, warn: 0, fail: 0 };
  for (const c of checks) out[c.level]++;
  return out;
}

function finalize(projectPath: string, checks: DoctorCheck[]): DoctorReport {
  const summary = { pass: 0, info: 0, warn: 0, fail: 0 };
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
      : c.level === "info" ? pc.cyan("INFO")
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
