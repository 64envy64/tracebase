/**
 * `tracebase init` — one-command project bootstrap with agent adapters.
 *
 * Core stays the same across agents:
 *   1. .tracebase/config.json — SQLite store path + stable workspaceId.
 *   2. MCP registration        — adapter-specific surface for the active agent.
 *   3. Project instructions    — CLAUDE.md or AGENTS.md depending on target.
 *
 * Default UX is a small arrow-key picker that lets the user confirm or
 * change the adapters to wire up. On a non-interactive terminal (CI,
 * piped stdin) or when `--agent` is passed, `init` skips the prompt.
 */
import { Command } from "commander";
import { basename } from "node:path";
import pc from "picocolors";
import {
  initConfig,
  isInitialized,
  loadConfig,
  normalizeInstallAgents,
  resolveProjectBase,
} from "../../core/config.js";
import {
  bestEffortOpenUrl,
  loadCloudCredential,
  pollCloudDeviceSession,
  registerCloudInstallation,
  resolveCloudApiUrl,
  saveCloudCredential,
  startCloudDeviceSession,
  validateCloudApiKey,
} from "../cloud.js";
import {
  cleanupLegacyClaudeSettings,
  detectAvailableAgents,
  getAgentTargetMeta,
  normalizeInstallAgent,
  writeAgentHookConfig,
  writeAgentInstructionFile,
  writeAgentMcpConfig,
  writeClaudeMarkdown,
  writeClaudeSettings,
  type InstallAgent,
  type StepResult,
} from "../install-targets.js";
import { isInteractive, multiSelect } from "../prompt.js";

const ALL_AGENTS: InstallAgent[] = ["claude-code", "cursor", "codex"];

export const initCommand = new Command("init")
  .description("Initialize TraceBase in this project — pick which agent(s) to wire up")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("-a, --agent <agent>", "restrict install to one agent: claude-code | cursor | codex")
  .option("--all", "install every adapter (claude-code, cursor, codex) without prompting")
  .option("-y, --yes", "skip the interactive picker; use detected defaults")
  .option("--api-url <url>", "TraceBase hosted control-plane origin (or use TRACEBASE_API_URL)")
  .option("--api-key <key>", "TraceBase workspace API key (or use TRACEBASE_API_KEY)")
  .option("--force", "overwrite an existing tracebase MCP entry with a different shape")
  .option("--skip-mcp-config", "do not touch the agent's MCP configuration")
  .option("--skip-agent-instructions", "do not touch the agent instruction file")
  .option("--skip-claude-settings", "back-compat alias for --skip-mcp-config")
  .option("--skip-claude-md", "back-compat alias for --skip-agent-instructions")
  .action(async (opts: {
    path: string;
    agent?: string;
    all?: boolean;
    yes?: boolean;
    apiUrl?: string;
    apiKey?: string;
    force?: boolean;
    skipMcpConfig?: boolean;
    skipAgentInstructions?: boolean;
    skipClaudeSettings?: boolean;
    skipClaudeMd?: boolean;
  }) => {
    const basePath = resolveProjectBase(opts.path);
    if (opts.agent && !normalizeInstallAgent(opts.agent)) {
      console.error(pc.red("Unsupported agent target: ") + opts.agent);
      console.error("Use one of " + pc.cyan("claude-code") + ", " + pc.cyan("cursor") + ", or " + pc.cyan("codex") + ".");
      process.exit(1);
    }

    const existingConfig = isInitialized(basePath) ? loadConfig(basePath) : undefined;
    const storedAgents = normalizeInstallAgents(existingConfig?.install);
    const selectedAgents = await pickAgents({
      explicit: opts.agent,
      all: opts.all,
      yes: opts.yes,
      basePath,
      stored: storedAgents,
    });

    if (selectedAgents.length === 0) {
      console.log();
      console.log(pc.yellow("No agents selected. ") + pc.dim("Run `npx tracebase init` again to pick one."));
      console.log();
      return;
    }
    // The first selected adapter is treated as "primary" for surfaces
    // that are intrinsically single-valued (e.g. the cloud workspace
    // link picks one canonical agent label). All agents still get
    // their own MCP + instruction files written and, when cloud is
    // linked, their own installation record registered.
    const primaryAgent: InstallAgent = selectedAgents[0]!;
    const cloudApiUrl = resolveCloudApiUrl(opts.apiUrl);
    const cloudApiKey = opts.apiKey?.trim() || process.env.TRACEBASE_API_KEY?.trim() || "";
    const cloudLink = cloudApiKey
      ? await resolveCloudLink({
          apiUrl: cloudApiUrl,
          apiKey: cloudApiKey,
        })
      : null;

    const wasInit = isInitialized(basePath);
    let config = initConfig(
      basePath,
      cloudLink
        ? {
            cloud: {
              apiUrl: cloudLink.apiBaseUrl,
              workspaceId: cloudLink.workspace.id,
              workspaceSlug: cloudLink.workspace.slug,
            },
            install: {
              agents: [...selectedAgents],
            },
          }
        : {
            install: {
              agents: [...selectedAgents],
            },
          },
    );
    const existingCloudCredential =
      config.cloud
        ? loadCloudCredential(config.cloud.apiUrl, config.cloud.workspaceId)
        : null;

    console.log();
    const wsTag = config.workspaceId
      ? pc.dim(" — workspace " + config.workspaceId.slice(0, 8) + "…")
      : "";
    console.log(pc.bold("TraceBase initialized") + wsTag);
    const agentSummary = selectedAgents
      .map((a) => getAgentTargetMeta(a).displayName)
      .join(", ");
    console.log(pc.dim(`  agents    ${agentSummary}`));
    console.log();

    let installFailed = false;

    if (wasInit) {
      renderStep("  =", ".tracebase/config.json", "already initialized (workspaceId preserved)");
    } else {
      renderStep(pc.green("  +"), ".tracebase/config.json", "");
      renderStep(pc.dim("    "), "storage", config.storagePath, true);
    }

    for (const agent of selectedAgents) {
      const meta = getAgentTargetMeta(agent);
      if (!opts.skipMcpConfig && !opts.skipClaudeSettings) {
        const res = writeAgentMcpConfig(basePath, agent, !!opts.force);
        if (!res.ok) installFailed = true;
        renderStepResult(formatSurfaceLabel(meta.displayName, meta.mcpLocationLabel), res);
        // Claude Code's source of truth is the runtime `claude mcp`
        // registry; any tracebase entry still sitting in the legacy
        // `.claude/settings.json` is inert and misleading. Drop it
        // once the real registration has succeeded so doctor/status
        // stop nagging about a stale surface the next run.
        if (agent === "claude-code" && res.ok) {
          const swept = cleanupLegacyClaudeSettings(basePath);
          if (swept) {
            renderStep(
              pc.dim("  ~"),
              formatSurfaceLabel("Claude Code", ".claude/settings.json"),
              "legacy entry cleaned up",
            );
          }
        }

        // Silent pre-prompt injection hook. For Claude Code this
        // writes a `UserPromptSubmit` entry into
        // `.claude/settings.json` that runs `tracebase
        // inject-context` before the agent sees the user's turn —
        // turning the formerly-mandatory `get_reasoning_patterns`
        // tool call into a transparent context fetch. The MCP tool
        // path stays as a fallback. Other agents return null and
        // we render nothing.
        const hookRes = writeAgentHookConfig(basePath, agent, !!opts.force);
        if (hookRes) {
          if (!hookRes.ok) installFailed = true;
          renderStepResult(
            formatSurfaceLabel(meta.displayName, ".claude/settings.json (hook)"),
            hookRes,
          );
        }
      }

      if (!opts.skipAgentInstructions && !opts.skipClaudeMd) {
        const res = writeAgentInstructionFile(basePath, agent);
        if (!res.ok) installFailed = true;
        renderStepResult(formatSurfaceLabel(meta.displayName, meta.instructionFile), res);
      }
    }

    if (cloudLink && cloudApiKey) {
      saveCloudCredential({
        apiUrl: cloudLink.apiBaseUrl,
        workspaceId: cloudLink.workspace.id,
        apiKey: cloudApiKey,
      });

      renderStep(pc.green("  +"), "cloud workspace", `${cloudLink.workspace.displayName} (${cloudLink.workspace.slug})`);

      // Register one installation per adapter so the hosted dashboard
      // can attribute usage samples per-agent. The schema enforces
      // uniqueness on (workspace, localWorkspaceId, agent).
      let primaryInstallationId: string | undefined;
      const installationIds: Partial<Record<InstallAgent, string>> = {};
      for (const agent of selectedAgents) {
        const installation = await registerCloudInstallation(cloudLink.apiBaseUrl, cloudApiKey, {
          localWorkspaceId: config.workspaceId ?? "unknown",
          projectName: basename(basePath),
          agent: getAgentTargetMeta(agent).cloudAgent,
        });
        installationIds[agent] = installation.id;
        if (agent === primaryAgent) primaryInstallationId = installation.id;
        renderStep(pc.cyan("  ~"), "cloud install", `${getAgentTargetMeta(agent).displayName} → ${installation.projectName}`);
      }

      config = initConfig(basePath, {
        cloud: {
          apiUrl: cloudLink.apiBaseUrl,
          workspaceId: cloudLink.workspace.id,
          workspaceSlug: cloudLink.workspace.slug,
          installationId: primaryInstallationId,
          installationIds,
        },
        install: {
          agents: [...selectedAgents],
        },
      });
    } else if (!existingCloudCredential && cloudApiUrl && process.stdin.isTTY && process.stdout.isTTY) {
      const linked = await tryInteractiveCloudLink(basePath, config, cloudApiUrl, primaryAgent);
      if (linked) {
        const installationIds: Partial<Record<InstallAgent, string>> = {};
        installationIds[primaryAgent] = linked.installation.id;
        const secondaryAgents = selectedAgents.filter((a) => a !== primaryAgent);
        for (const agent of secondaryAgents) {
          try {
            const extra = await registerCloudInstallation(linked.apiBaseUrl, linked.apiKey, {
              localWorkspaceId: config.workspaceId ?? "unknown",
              projectName: basename(basePath),
              agent: getAgentTargetMeta(agent).cloudAgent,
            });
            installationIds[agent] = extra.id;
            renderStep(pc.cyan("  ~"), "cloud install", `${getAgentTargetMeta(agent).displayName} → ${extra.projectName}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : "registration failed";
            renderStep(pc.yellow("  !"), "cloud install", `${getAgentTargetMeta(agent).displayName} — ${msg}`);
          }
        }

        config = initConfig(basePath, {
          cloud: {
            apiUrl: linked.apiBaseUrl,
            workspaceId: linked.workspace.id,
            workspaceSlug: linked.workspace.slug,
            installationId: linked.installation.id,
            installationIds,
          },
          install: {
            agents: [...selectedAgents],
          },
        });

        saveCloudCredential({
          apiUrl: linked.apiBaseUrl,
          workspaceId: linked.workspace.id,
          apiKey: linked.apiKey,
        });

        renderStep(pc.green("  +"), "cloud workspace", `${linked.workspace.displayName} (${linked.workspace.slug})`);
        renderStep(pc.cyan("  ~"), "cloud install", `${getAgentTargetMeta(primaryAgent).displayName} → ${linked.installation.projectName}`);
      }
    }

    console.log();
    console.log(pc.bold("Next:"));
    if (selectedAgents.length === 1) {
      const meta = getAgentTargetMeta(primaryAgent);
      console.log(`  1. ${meta.verificationTitle}`);
      console.log(`  2. ${meta.verificationCommand}`);
      console.log("  3. Verify: " + pc.cyan("npx tracebase status") + pc.dim(" · ") + pc.cyan("npx tracebase doctor"));
    } else {
      console.log("  1. Restart any of the detected agents you use");
      console.log("  2. Verify: " + pc.cyan("npx tracebase status") + pc.dim(" · ") + pc.cyan("npx tracebase doctor"));
    }
    // Cloud state is load-bearing for the first-run UX: when a new user
    // lands on this screen with no API key, the silent "all good" was
    // historically ambiguous — was linking required, or intentionally
    // deferred? Now we always state the cloud state explicitly so the
    // user can decide whether to re-run with `--api-key`.
    const linkedAfterInit = Boolean(config.cloud?.workspaceId);
    if (!linkedAfterInit) {
      console.log();
      console.log(
        pc.dim("  Cloud: local only ") +
          pc.dim("— dashboard sync disabled. Pass ") +
          pc.cyan("--api-key") +
          pc.dim(" or set ") +
          pc.cyan("TRACEBASE_API_KEY") +
          pc.dim(" and re-run `init` to link."),
      );
    }
    if (installFailed) {
      console.log();
      console.log(pc.red("Install incomplete.") + " Fix the failing step above, then re-run " + pc.cyan("npx tracebase init") + ".");
      process.exitCode = 1;
    }
    console.log();
    console.log(pc.dim("Add to .gitignore:"));
    console.log(pc.dim("  .tracebase/memory.db"));
    console.log(pc.dim("  .tracebase/memory.db-wal"));
    console.log(pc.dim("  .tracebase/memory.db-shm"));
    console.log();
  });

async function pickAgents(input: {
  explicit?: string | null;
  all?: boolean;
  yes?: boolean;
  basePath: string;
  stored: InstallAgent[];
}): Promise<InstallAgent[]> {
  const explicit = normalizeInstallAgent(input.explicit);
  if (explicit) return [explicit];
  if (input.all) return [...ALL_AGENTS];

  const detected = detectAvailableAgents(input.basePath);
  // If the project was previously configured for agents we no longer
  // auto-detect (e.g. user uninstalled the Codex CLI), keep them so
  // the picker can still uncheck them intentionally instead of
  // silently dropping the surface.
  const defaults =
    input.stored.length > 0
      ? Array.from(new Set([...input.stored, ...detected]))
      : detected;

  // Non-interactive environments (CI, piped input) or -y short-circuit
  // the prompt and use the detected/stored defaults.
  if (input.yes || !isInteractive()) {
    return defaults;
  }

  const picked = await multiSelect<InstallAgent>({
    title: "Which agents should TraceBase wire up?",
    options: ALL_AGENTS.map((agent) => {
      const meta = getAgentTargetMeta(agent);
      const isDetected = detected.includes(agent);
      return {
        value: agent,
        label: meta.displayName,
        hint: isDetected ? `${meta.mcpLocationLabel} · detected` : meta.mcpLocationLabel,
      };
    }),
    initial: defaults,
  });

  if (picked === null) {
    console.log();
    console.log(pc.yellow("Install cancelled."));
    console.log();
    process.exit(130);
  }
  return picked;
}

function formatSurfaceLabel(displayName: string, path: string): string {
  return `${displayName.padEnd(12)} ${pc.dim(path)}`;
}

function renderStep(sigil: string, label: string, tail: string, indent = false): void {
  const body = tail ? (indent ? " " + pc.dim(tail) : " " + pc.dim(`(${tail})`)) : "";
  console.log(sigil + " " + label + body);
}

function renderStepResult(label: string, res: StepResult): void {
  if (!res.ok) {
    console.log(pc.yellow("  !") + " " + label + " " + pc.dim(`(${res.reason})`));
    return;
  }
  const sigil =
    res.kind === "created" ? pc.green("  +")
    : res.kind === "updated" ? pc.cyan("  ~")
    : pc.dim("  =");
  const note =
    res.kind === "already-up-to-date" ? pc.dim(" (already up to date)")
    : res.kind === "updated" ? pc.dim(" (updated)")
    : "";
  console.log(sigil + " " + label + note);
}

async function resolveCloudLink(input: {
  apiUrl: string | null;
  apiKey: string;
}) {
  if (!input.apiUrl) {
    console.error(pc.red("Cloud init requires an API URL."));
    console.error("Set " + pc.cyan("--api-url") + " or " + pc.cyan("TRACEBASE_API_URL") + ".");
    process.exit(1);
  }

  if (!input.apiKey) {
    console.error(pc.red("Cloud init requires a workspace API key."));
    console.error("Set " + pc.cyan("--api-key") + " or " + pc.cyan("TRACEBASE_API_KEY") + ".");
    process.exit(1);
  }

  try {
    return await validateCloudApiKey(input.apiUrl, input.apiKey);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown cloud validation error";
    console.error(pc.red("Cloud install failed: ") + msg);
    process.exit(1);
  }
}

async function tryInteractiveCloudLink(
  basePath: string,
  config: ReturnType<typeof initConfig>,
  apiUrl: string,
  primaryAgent: InstallAgent,
) {
  try {
    const device = await startCloudDeviceSession(apiUrl, {
      localWorkspaceId: config.workspaceId ?? "unknown",
      projectName: basename(basePath),
      agent: primaryAgent,
    });

    const opened = await bestEffortOpenUrl(device.verificationUrl);
    renderStep(
      pc.cyan("  ~"),
      "cloud auth",
      opened ? "browser opened for approval" : device.verificationUrl,
    );
    renderStep(pc.dim("    "), "code", device.userCode, true);

    const waitUntil = Math.min(
      new Date(device.expiresAt).getTime(),
      Date.now() + 45_000,
    );

    while (Date.now() < waitUntil) {
      const polled = await pollCloudDeviceSession(apiUrl, device.deviceCode);
      if (polled.status === "approved") {
        return {
          apiBaseUrl: apiUrl,
          workspace: polled.workspace,
          apiKey: polled.apiKey,
          installation: polled.installation,
        };
      }

      if (polled.status === "expired") {
        renderStep(pc.yellow("  !"), "cloud auth", "approval expired — local init kept");
        return null;
      }

      await sleep(device.pollIntervalMs);
    }

    renderStep(pc.yellow("  !"), "cloud auth", "not approved yet — local init kept");
    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "cloud handshake failed";
    renderStep(pc.yellow("  !"), "cloud auth", `${msg} — local init kept`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { writeClaudeSettings, writeClaudeMarkdown };
