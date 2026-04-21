/**
 * `tracebase init` — project-local one-command bootstrap for Claude Code
 * (Phase 6.0).
 *
 * Three independent idempotent steps:
 *   1. .tracebase/config.json — SQLite store path + stable workspaceId.
 *   2. .claude/settings.json — MCP server entry, merged into existing file.
 *   3. CLAUDE.md             — managed-section instruction block
 *                               (re-init-safe; only the marked block is
 *                               rewritten, user content around it is kept).
 *
 * Each step reports one of {created | updated | already-up-to-date | skipped}
 * so re-running init is boring and safe.
 */
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import pc from "picocolors";
import { initConfig, isInitialized } from "../../core/config.js";
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

// ---------------------------------------------------------------------------
// MCP entry we install into .claude/settings.json
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME = "tracebase";

const MCP_ENTRY = {
  command: "npx",
  args: ["-y", "tracebase-ai", "serve", "--mcp"],
};

// ---------------------------------------------------------------------------
// Managed-section markers for CLAUDE.md
// ---------------------------------------------------------------------------

const CLAUDE_MD_BEGIN = "<!-- tracebase:begin (managed section — do not edit between markers) -->";
const CLAUDE_MD_END = "<!-- tracebase:end -->";
const CLAUDE_MD_CONTENT = `## TraceBase reasoning layer

When you start a debugging, bug-fixing, or problem-solving task in this project:

1. Call \`get_reasoning_patterns\` first, with a short description of the problem you're about to work on.
2. The response is a *hypothesis* drawn from prior cases — it may or may not apply. Verify the mechanism against the current task before acting on it. Discard if it does not fit.
3. If no patterns come back, proceed normally.

When you finish the task (whether by solving it or giving up):

1. Call \`record_reasoning_outcome\` with the \`queryId\` you received from \`get_reasoning_patterns\`.
2. Report whether you actually used the suggested pattern (\`usedPattern\`) and whether the task resolved (\`resolved\`).
3. This closes the self-correction loop — future retrievals get calibrated from real outcomes.

Additional tools available: \`recall\`, \`store\`, \`search\`, \`explain\`, \`stats\`.`;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const initCommand = new Command("init")
  .description("Initialize TraceBase in this project — configures Claude Code and creates CLAUDE.md")
  .option("-p, --path <path>", "project root", process.cwd())
  .option("--api-url <url>", "TraceBase hosted control-plane origin (or use TRACEBASE_API_URL)")
  .option("--api-key <key>", "TraceBase workspace API key (or use TRACEBASE_API_KEY)")
  .option("--force", "overwrite an existing tracebase MCP entry with a different shape")
  .option("--skip-claude-settings", "do not touch .claude/settings.json")
  .option("--skip-claude-md", "do not touch CLAUDE.md")
  .action(async (opts: {
    path: string;
    cloud?: boolean;
    apiUrl?: string;
    apiKey?: string;
    force?: boolean;
    skipClaudeSettings?: boolean;
    skipClaudeMd?: boolean;
  }) => {
    const basePath = opts.path;
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
          }
        : undefined,
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
    console.log();

    if (wasInit) {
      renderStep("  =", ".tracebase/config.json", "already initialized (workspaceId preserved)");
    } else {
      renderStep(pc.green("  +"), ".tracebase/config.json", "");
      renderStep(pc.dim("    "), "storage", config.storagePath, true);
    }

    if (!opts.skipClaudeSettings) {
      const res = writeClaudeSettings(basePath, !!opts.force);
      renderStepResult(".claude/settings.json", res);
    }

    if (!opts.skipClaudeMd) {
      const res = writeClaudeMarkdown(basePath);
      renderStepResult("CLAUDE.md", res);
    }

    if (cloudLink && cloudApiKey) {
      saveCloudCredential({
        apiUrl: cloudLink.apiBaseUrl,
        workspaceId: cloudLink.workspace.id,
        apiKey: cloudApiKey,
      });

      renderStep(pc.green("  +"), "cloud workspace", `${cloudLink.workspace.displayName} (${cloudLink.workspace.slug})`);

      const installation = await registerCloudInstallation(cloudLink.apiBaseUrl, cloudApiKey, {
        localWorkspaceId: config.workspaceId ?? "unknown",
        projectName: basename(basePath),
        agent: "claude-code",
      });

      config = initConfig(basePath, {
        cloud: {
          apiUrl: cloudLink.apiBaseUrl,
          workspaceId: cloudLink.workspace.id,
          workspaceSlug: cloudLink.workspace.slug,
          installationId: installation.id,
        },
      });

      renderStep(pc.cyan("  ~"), "cloud install", `${installation.projectName} linked`);
    } else if (!existingCloudCredential && cloudApiUrl && process.stdin.isTTY && process.stdout.isTTY) {
      const linked = await tryInteractiveCloudLink(basePath, config, cloudApiUrl);
      if (linked) {
        config = initConfig(basePath, {
          cloud: {
            apiUrl: linked.apiBaseUrl,
            workspaceId: linked.workspace.id,
            workspaceSlug: linked.workspace.slug,
            installationId: linked.installation.id,
          },
        });

        saveCloudCredential({
          apiUrl: linked.apiBaseUrl,
          workspaceId: linked.workspace.id,
          apiKey: linked.apiKey,
        });

        renderStep(pc.green("  +"), "cloud workspace", `${linked.workspace.displayName} (${linked.workspace.slug})`);
        renderStep(pc.cyan("  ~"), "cloud install", `${linked.installation.projectName} linked`);
      }
    }

    console.log();
    console.log(pc.bold("Next:"));
    console.log("  1. Restart Claude Code");
    console.log(
      "  2. In Claude Code run " +
        pc.cyan("/tools") +
        " and confirm " +
        pc.cyan("get_reasoning_patterns") +
        " is listed",
    );
    console.log("  3. Verify install: " + pc.cyan("npx tracebase status"));
    console.log();
    console.log(pc.dim("Add to .gitignore:"));
    console.log(pc.dim("  .tracebase/memory.db"));
    console.log(pc.dim("  .tracebase/memory.db-wal"));
    console.log(pc.dim("  .tracebase/memory.db-shm"));
    console.log();
  });

// ---------------------------------------------------------------------------
// Step: .claude/settings.json
// ---------------------------------------------------------------------------

export type StepResult =
  | { ok: true; kind: "created" | "updated" | "already-up-to-date"; path: string }
  | { ok: false; reason: string; path: string };

export function writeClaudeSettings(basePath: string, force: boolean): StepResult {
  const dir = join(basePath, ".claude");
  const file = join(dir, "settings.json");

  let settings: Record<string, unknown> = {};
  let existedBefore = false;
  if (existsSync(file)) {
    existedBefore = true;
    try {
      const raw = readFileSync(file, "utf-8");
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        reason: "existing settings.json is not valid JSON — fix it manually or pass --force",
        path: file,
      };
    }
  }

  const servers = (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existingEntry = servers[MCP_SERVER_NAME];

  if (existingEntry !== undefined) {
    if (deepEqual(existingEntry, MCP_ENTRY)) {
      return { ok: true, kind: "already-up-to-date", path: file };
    }
    if (!force) {
      return {
        ok: false,
        reason: `existing "${MCP_SERVER_NAME}" mcpServers entry differs — pass --force to overwrite`,
        path: file,
      };
    }
  }

  servers[MCP_SERVER_NAME] = MCP_ENTRY;
  settings.mcpServers = servers;

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { ok: true, kind: existedBefore ? "updated" : "created", path: file };
}

// ---------------------------------------------------------------------------
// Step: CLAUDE.md (managed section)
// ---------------------------------------------------------------------------

export function writeClaudeMarkdown(basePath: string): StepResult {
  const file = join(basePath, "CLAUDE.md");
  const managedBlock = `${CLAUDE_MD_BEGIN}\n${CLAUDE_MD_CONTENT}\n${CLAUDE_MD_END}`;

  if (!existsSync(file)) {
    writeFileSync(file, managedBlock + "\n");
    return { ok: true, kind: "created", path: file };
  }

  const current = readFileSync(file, "utf-8");
  const beginIdx = current.indexOf(CLAUDE_MD_BEGIN);
  const endIdx = current.indexOf(CLAUDE_MD_END);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    // Managed section already present — rewrite the block contents in
    // place; anything before / after the markers is user content and
    // must be preserved verbatim.
    const before = current.slice(0, beginIdx);
    const after = current.slice(endIdx + CLAUDE_MD_END.length);
    const rewritten = before + managedBlock + after;
    if (rewritten === current) {
      return { ok: true, kind: "already-up-to-date", path: file };
    }
    writeFileSync(file, rewritten);
    return { ok: true, kind: "updated", path: file };
  }

  // No managed section — append it, preserving user content.
  const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(file, current + sep + managedBlock + "\n");
  return { ok: true, kind: "updated", path: file };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderStep(sigil: string, label: string, tail: string, indent = false): void {
  const body = tail ? (indent ? tail : " " + pc.dim(`(${tail})`)) : "";
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

function deepEqual(a: unknown, b: unknown): boolean {
  // Sufficient for our small config objects; same semantics as JSON
  // ser/deser. We don't deal with cyclic structures here.
  return JSON.stringify(a) === JSON.stringify(b);
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
) {
  try {
    const device = await startCloudDeviceSession(apiUrl, {
      localWorkspaceId: config.workspaceId ?? "unknown",
      projectName: basename(basePath),
      agent: "claude-code",
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
