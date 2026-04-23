import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type InstallAgent = "claude-code" | "cursor" | "codex";

export type StepResult =
  | { ok: true; kind: "created" | "updated" | "already-up-to-date"; path: string }
  | { ok: false; reason: string; path: string };

export type CleanupResult =
  | { ok: true; kind: "removed" | "updated" | "already-absent"; path: string }
  | { ok: false; reason: string; path: string };

export interface AgentTargetMeta {
  id: InstallAgent;
  displayName: string;
  instructionFile: "CLAUDE.md" | "AGENTS.md";
  cloudAgent: InstallAgent;
  mcpLocationLabel: string;
  verificationTitle: string;
  verificationCommand: string;
}

export interface MpcInspection {
  present: boolean;
  canonical: boolean;
  containerPresent?: boolean;
  parseError?: string;
  cliMissing?: boolean;
  /**
   * Claude Code only: set when a stale `tracebase` entry lingers in the
   * legacy `.claude/settings.json` file. The runtime registry
   * (`claude mcp`) is the source of truth now; settings.json entries are
   * ignored by Claude Code and must be cleaned up by `init --force` or
   * `remove`.
   */
  legacySettingsStale?: boolean;
}

export interface InstructionInspection {
  present: boolean;
  managed: boolean;
}

const MCP_SERVER_NAME = "tracebase";
/**
 * Canonical MCP server command written into every agent's runtime
 * registry (claude mcp, codex mcp, cursor). Exported so `tracebase
 * doctor` can derive its live boot probe from the same literal — the
 * probe must spawn exactly what Claude Code will spawn, otherwise a
 * PASS against the local dev CLI can hide a broken npm-published
 * runtime.
 *
 * The `@latest` pin is load-bearing: without it, `npx -y tracebase-ai`
 * executed from inside the tracebase-ai repo (or any workspace/
 * monorepo that happens to have a `tracebase-ai` package locally)
 * resolves against that local package and fails with `sh: tracebase:
 * command not found` because the local workspace doesn't expose the
 * bin on PATH the way an npx-installed copy does. Pinning the
 * registry spec to `@latest` forces npx through the npm registry,
 * bypassing the local workspace shadow and making `tracebase init`
 * inside the repo produce a registration Claude Code can actually
 * run.
 *
 * Any change here must keep the command/args order stable, since
 * `--selftest` (or similar) gets appended by callers.
 */
export const MCP_ENTRY = {
  command: "npx",
  args: ["-y", "tracebase-ai@latest", "serve", "--mcp"],
} as const;

const TRACEBASE_BEGIN = "<!-- tracebase:begin (managed section — do not edit between markers) -->";
const TRACEBASE_END = "<!-- tracebase:end -->";
const TRACEBASE_CONTENT = `## TraceBase reasoning layer

When you start a debugging, bug-fixing, or problem-solving task in this project:

1. Call \`get_reasoning_patterns\` first, with a short description of the problem you're about to work on.
2. The response is a *hypothesis* drawn from prior cases — it may or may not apply. Verify the mechanism against the current task before acting on it. Discard if it does not fit.
3. If no patterns come back, proceed normally.

When you finish the task (whether by solving it or giving up):

1. Call \`record_reasoning_outcome\` with the \`queryId\` you received from \`get_reasoning_patterns\`. Report whether you actually used the suggested pattern (\`usedPattern\`) and whether the task resolved (\`resolved\`).
2. **If \`resolved\` is true and no prior pattern applied** — i.e. you solved a novel case from scratch — also call \`store_reasoning_pattern\` with a short \`situation\`, the \`mechanism\` that explains why the fix works, the concrete \`unlock\`, and a \`verification\` step. This is how institutional memory grows. Without this call, the next agent facing the same problem will re-derive the solution from scratch.

Together these close the self-correction loop: retrievals become hypotheses, outcomes calibrate them, and captured patterns turn one-off solves into compounding knowledge.

Additional tools available: \`recall\`, \`store\`, \`search\`, \`explain\`, \`stats\`.`;

const AGENT_TARGETS: Record<InstallAgent, AgentTargetMeta> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    instructionFile: "CLAUDE.md",
    cloudAgent: "claude-code",
    // Claude Code stores MCP servers in its runtime registry
    // (`claude mcp`), *not* in `.claude/settings.json`. Writing to the
    // settings.json file was a no-op at runtime — the source of truth
    // is now the local scope of the `claude` CLI.
    mcpLocationLabel: "claude mcp registry (local)",
    verificationTitle: "Restart Claude Code",
    verificationCommand: "/mcp → confirm tracebase appears, then /tools → get_reasoning_patterns",
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    instructionFile: "AGENTS.md",
    cloudAgent: "cursor",
    mcpLocationLabel: "~/.cursor/mcp.json",
    verificationTitle: "Restart Cursor",
    verificationCommand: "Cursor Settings → MCP → confirm tracebase is healthy",
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    instructionFile: "AGENTS.md",
    cloudAgent: "codex",
    mcpLocationLabel: "codex mcp registry",
    verificationTitle: "Refresh Codex MCP state",
    verificationCommand: "codex mcp list → confirm tracebase is listed",
  },
};

export function getAgentTargetMeta(agent: InstallAgent): AgentTargetMeta {
  return AGENT_TARGETS[agent];
}

export function normalizeInstallAgent(value?: string | null): InstallAgent | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "cursor":
      return "cursor";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

export function resolveInstallAgent(input: {
  explicit?: string | null;
  basePath: string;
  stored?: string | null;
  preferEnvironment?: boolean;
}): InstallAgent {
  const explicit = normalizeInstallAgent(input.explicit);
  if (explicit) return explicit;

  const stored = normalizeInstallAgent(input.stored);
  if (stored) return stored;

  if (input.preferEnvironment !== false) {
    const fromEnv = detectAgentFromEnvironment();
    if (fromEnv) return fromEnv;
  }

  const fromProject = detectAgentFromProject(input.basePath);
  if (fromProject) return fromProject;

  return "claude-code";
}

/**
 * All agents we should install adapters for on a cold `init` with no
 * explicit `--agent` flag.
 *
 * Rules, in priority order:
 *   1. If the current environment clearly belongs to one agent
 *      (running inside Claude Code, Cursor, or Codex), install only
 *      that one — we know what the user is using right now.
 *   2. Otherwise, include every agent whose integration surface is
 *      physically available on this machine:
 *        • Claude Code — always included (cheap project-local file).
 *        • Cursor      — included if `~/.cursor/` exists.
 *        • Codex       — included if the `codex` CLI is in PATH.
 *
 * Callers that want a single-agent install (CI, explicit override) go
 * through `resolveInstallAgent` instead.
 */
export function detectAvailableAgents(basePath: string): InstallAgent[] {
  const fromEnv = detectAgentFromEnvironment();
  if (fromEnv) return [fromEnv];

  const fromProject = detectAgentFromProject(basePath);
  const agents: InstallAgent[] = [];

  // Claude Code is always a candidate: its surface is project-local,
  // and writing `.claude/settings.json` + `CLAUDE.md` costs nothing.
  agents.push("claude-code");

  if (existsSync(join(getUserHomeDir(), ".cursor"))) {
    agents.push("cursor");
  }

  if (isCommandAvailable("codex", ["--version"])) {
    agents.push("codex");
  }

  // If detection from project hints at a specific agent we didn't
  // already pick up (e.g. AGENTS.md present but no cursor dir), make
  // sure it's included too.
  if (fromProject && !agents.includes(fromProject)) agents.push(fromProject);

  return agents;
}

export function installCommandForAgent(_agent: InstallAgent): string {
  // The install command is the same across adapters now. `init`
  // auto-detects the active agent or configures every locally-available
  // one — there is no reason to differentiate the command in UI copy.
  return "npx tracebase init";
}

export function writeAgentMcpConfig(basePath: string, agent: InstallAgent, force: boolean): StepResult {
  switch (agent) {
    case "claude-code":
      return writeClaudeMcpRegistration(basePath, force);
    case "cursor":
      return writeJsonMcpConfig(join(getUserHomeDir(), ".cursor", "mcp.json"), force);
    case "codex":
      return writeCodexMcpConfig(force);
  }
}

export function inspectAgentMcpConfig(basePath: string, agent: InstallAgent): MpcInspection {
  switch (agent) {
    case "claude-code":
      return inspectClaudeMcpRegistration(basePath);
    case "cursor":
      return inspectJsonMcpConfig(join(getUserHomeDir(), ".cursor", "mcp.json"));
    case "codex":
      return inspectCodexMcpConfig();
  }
}

export function writeAgentInstructionFile(basePath: string, agent: InstallAgent): StepResult {
  return writeManagedInstructionFile(join(basePath, getAgentTargetMeta(agent).instructionFile));
}

export function inspectAgentInstructionFile(basePath: string, agent: InstallAgent): InstructionInspection {
  return inspectManagedInstructionFile(join(basePath, getAgentTargetMeta(agent).instructionFile));
}

export function removeAgentMcpConfig(basePath: string, agent: InstallAgent): CleanupResult {
  switch (agent) {
    case "claude-code":
      return removeClaudeMcpRegistration(basePath);
    case "cursor":
      return removeJsonMcpConfig(join(getUserHomeDir(), ".cursor", "mcp.json"));
    case "codex":
      return removeCodexMcpConfig();
  }
}

/**
 * True iff a stale `tracebase` entry is still living in the legacy
 * `.claude/settings.json` container. Claude Code no longer reads MCP
 * servers from that file — the entry is inert — but users who ran old
 * versions of `init` will have one lying around. doctor warns on it,
 * and both `init` and `remove` clean it up as a best-effort migration.
 *
 * Returns false when the `TRACEBASE_CLAUDE_REGISTRY_FILE` test seam is
 * pointing at the same file — in that mode settings.json IS the
 * runtime registry for test purposes, so there's no "stale" state to
 * warn about.
 */
export function inspectLegacyClaudeSettings(basePath: string): boolean {
  const filePath = join(basePath, ".claude", "settings.json");
  if (!existsSync(filePath)) return false;
  const override = process.env.TRACEBASE_CLAUDE_REGISTRY_FILE?.trim();
  if (override && resolvePathsEqual(override, filePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown> | undefined;
    return Boolean(servers && MCP_SERVER_NAME in servers);
  } catch {
    return false;
  }
}

/**
 * Silently drop the stale tracebase entry from `.claude/settings.json`
 * if one exists. Returns true when a cleanup was performed. Never
 * throws — a missing or malformed file is treated as "nothing to do".
 *
 * When the `TRACEBASE_CLAUDE_REGISTRY_FILE` test seam points at the
 * same path this sweep would operate on, we no-op so the test path
 * doesn't race with init's own writes. That seam is the entire runtime
 * registry under test — it's not "legacy" in that world.
 */
export function cleanupLegacyClaudeSettings(basePath: string): boolean {
  const filePath = join(basePath, ".claude", "settings.json");
  if (!existsSync(filePath)) return false;
  const override = process.env.TRACEBASE_CLAUDE_REGISTRY_FILE?.trim();
  if (override && resolvePathsEqual(override, filePath)) return false;
  const res = removeJsonMcpConfig(filePath);
  return res.ok && res.kind !== "already-absent";
}

function resolvePathsEqual(a: string, b: string): boolean {
  // Simple normalisation — both paths are expected to be absolute and
  // produced by `join`, so string-compare after re-joining is enough.
  return join(a) === join(b);
}

export function removeAgentInstructionFile(basePath: string, agent: InstallAgent): CleanupResult {
  return removeManagedInstructionFile(join(basePath, getAgentTargetMeta(agent).instructionFile));
}

export function writeClaudeSettings(basePath: string, force: boolean): StepResult {
  return writeAgentMcpConfig(basePath, "claude-code", force);
}

export function writeCursorSettings(basePath: string, force: boolean): StepResult {
  return writeAgentMcpConfig(basePath, "cursor", force);
}

export function writeClaudeMarkdown(basePath: string): StepResult {
  return writeAgentInstructionFile(basePath, "claude-code");
}

export function writeAgentsMarkdown(basePath: string): StepResult {
  return writeAgentInstructionFile(basePath, "cursor");
}

function detectAgentFromEnvironment(): InstallAgent | null {
  if (
    (process.env.CODEX_SHELL === "1" || process.env.CODEX_CI === "1" || process.env.CODEX_THREAD_ID) &&
    isCommandAvailable("codex", ["--version"])
  ) {
    return "codex";
  }
  if (
    process.env.CURSOR_TRACE_ID ||
    process.env.CURSOR_AGENT ||
    process.env.TERM_PROGRAM?.toLowerCase() === "cursor"
  ) {
    return "cursor";
  }
  if (
    process.env.CLAUDECODE ||
    process.env.CLAUDE_CODE ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CLAUDE_DESKTOP
  ) {
    return "claude-code";
  }
  return null;
}

function detectAgentFromProject(basePath: string): InstallAgent | null {
  if (existsSync(join(basePath, ".claude", "settings.json")) || existsSync(join(basePath, "CLAUDE.md"))) {
    return "claude-code";
  }
  return null;
}

function writeJsonMcpConfig(filePath: string, force: boolean): StepResult {
  let settings: Record<string, unknown> = {};
  let existedBefore = false;

  if (existsSync(filePath)) {
    existedBefore = true;
    try {
      settings = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        reason: "existing config is not valid JSON — fix it manually or pass --force",
        path: filePath,
      };
    }
  }

  const servers = (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existingEntry = servers[MCP_SERVER_NAME];

  if (existingEntry !== undefined) {
    if (deepEqual(existingEntry, MCP_ENTRY)) {
      return { ok: true, kind: "already-up-to-date", path: filePath };
    }
    if (!force) {
      return {
        ok: false,
        reason: `existing "${MCP_SERVER_NAME}" mcpServers entry differs — pass --force to overwrite`,
        path: filePath,
      };
    }
  }

  servers[MCP_SERVER_NAME] = MCP_ENTRY;
  settings.mcpServers = servers;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n");
  return { ok: true, kind: existedBefore ? "updated" : "created", path: filePath };
}

function removeJsonMcpConfig(filePath: string): CleanupResult {
  if (!existsSync(filePath)) {
    return { ok: true, kind: "already-absent", path: filePath };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      reason: "existing config is not valid JSON — fix it manually before uninstall",
      path: filePath,
    };
  }

  const servers = (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (!(MCP_SERVER_NAME in servers)) {
    return { ok: true, kind: "already-absent", path: filePath };
  }

  delete servers[MCP_SERVER_NAME];

  if (Object.keys(servers).length > 0) {
    settings.mcpServers = servers;
  } else {
    delete settings.mcpServers;
  }

  if (Object.keys(settings).length === 0) {
    rmSync(filePath, { force: true });
    return { ok: true, kind: "removed", path: filePath };
  }

  writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n");
  return { ok: true, kind: "updated", path: filePath };
}

function inspectJsonMcpConfig(filePath: string): MpcInspection {
  if (!existsSync(filePath)) {
    return { present: false, canonical: false, containerPresent: false };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
    const entry = servers[MCP_SERVER_NAME];
    if (!entry) return { present: false, canonical: false, containerPresent: true };
    return {
      present: true,
      canonical: deepEqual(entry, MCP_ENTRY),
      containerPresent: true,
    };
  } catch (error) {
    return {
      present: false,
      canonical: false,
      containerPresent: true,
      parseError: error instanceof Error ? error.message : "invalid JSON",
    };
  }
}

// ---------------------------------------------------------------------------
// Claude Code runtime registry (`claude mcp …`)
//
// Claude Code's MCP servers live in `~/.claude.json` under
// `projects["<cwd>"].mcpServers` when scoped local, not in
// `.claude/settings.json`. The only officially supported way to mutate
// that registry is through `claude mcp {add,get,remove}`, and local
// scope binds the registration to the current working directory — so
// we spawn the CLI with `cwd: basePath`.
//
// Test seam: if `TRACEBASE_CLAUDE_REGISTRY_FILE` is set, read/write it
// as a JSON file instead of spawning the CLI. This lets the unit tests
// exercise the full write/inspect/remove code path without requiring a
// real `claude` binary on PATH or a shell shim. Production never sets
// this variable; the e2e suite uses a PATH shim for a real-CLI check.
// ---------------------------------------------------------------------------

const CLAUDE_MCP_LABEL = "claude mcp registry (local)";

function getClaudeRegistryOverride(): string | null {
  return process.env.TRACEBASE_CLAUDE_REGISTRY_FILE?.trim() || null;
}

function isClaudeCliAvailable(): boolean {
  return isCommandAvailable("claude", ["--version"]);
}

export function writeClaudeMcpRegistration(basePath: string, force: boolean): StepResult {
  const override = getClaudeRegistryOverride();
  if (override) return writeJsonMcpConfig(override, force);

  if (!isClaudeCliAvailable()) {
    return {
      ok: false,
      reason:
        "claude CLI is not available in PATH — install Claude Code " +
        "(https://claude.com/claude-code) or add `claude` to PATH, then re-run",
      path: CLAUDE_MCP_LABEL,
    };
  }

  const current = inspectClaudeMcpRegistration(basePath);
  if (current.cliMissing) {
    return {
      ok: false,
      reason: "claude CLI not reachable (failed to spawn)",
      path: CLAUDE_MCP_LABEL,
    };
  }

  if (current.present && current.canonical) {
    return { ok: true, kind: "already-up-to-date", path: CLAUDE_MCP_LABEL };
  }

  if (current.present && !force) {
    return {
      ok: false,
      reason: `existing "${MCP_SERVER_NAME}" claude mcp entry differs — pass --force to overwrite`,
      path: CLAUDE_MCP_LABEL,
    };
  }

  if (current.present && force) {
    const removed = spawnSync("claude", ["mcp", "remove", MCP_SERVER_NAME, "-s", "local"], {
      encoding: "utf-8",
      cwd: basePath,
    });
    if (removed.status !== 0 && !readSpawnFailure(removed).includes("No MCP server found")) {
      return {
        ok: false,
        reason: readSpawnFailure(removed),
        path: CLAUDE_MCP_LABEL,
      };
    }
  }

  const added = spawnSync(
    "claude",
    [
      "mcp",
      "add",
      MCP_SERVER_NAME,
      "--scope",
      "local",
      "--",
      MCP_ENTRY.command,
      ...MCP_ENTRY.args,
    ],
    { encoding: "utf-8", cwd: basePath },
  );
  if (added.status !== 0) {
    return {
      ok: false,
      reason: readSpawnFailure(added),
      path: CLAUDE_MCP_LABEL,
    };
  }

  return {
    ok: true,
    kind: current.present ? "updated" : "created",
    path: CLAUDE_MCP_LABEL,
  };
}

export function inspectClaudeMcpRegistration(basePath: string): MpcInspection {
  const override = getClaudeRegistryOverride();
  if (override) {
    const base = inspectJsonMcpConfig(override);
    return {
      ...base,
      legacySettingsStale: inspectLegacyClaudeSettings(basePath),
    };
  }

  if (!isClaudeCliAvailable()) {
    return {
      present: false,
      canonical: false,
      containerPresent: false,
      cliMissing: true,
      legacySettingsStale: inspectLegacyClaudeSettings(basePath),
    };
  }

  const result = spawnSync("claude", ["mcp", "get", MCP_SERVER_NAME], {
    encoding: "utf-8",
    cwd: basePath,
  });

  if (result.error) {
    return {
      present: false,
      canonical: false,
      containerPresent: false,
      cliMissing: true,
      parseError: result.error.message,
      legacySettingsStale: inspectLegacyClaudeSettings(basePath),
    };
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  const notFound = /No MCP server found with name/i.test(combined);

  if (result.status !== 0 || notFound) {
    return {
      present: false,
      canonical: false,
      containerPresent: true,
      legacySettingsStale: inspectLegacyClaudeSettings(basePath),
    };
  }

  // `claude mcp get <name>` prints a plain-text block:
  //   tracebase:
  //     Scope: Local config (private to you in this project)
  //     Status: ...
  //     Type: stdio
  //     Command: npx
  //     Args: -y tracebase-ai@latest serve --mcp
  //     Environment: ...
  // Parse Type/Command/Args to decide canonicality.
  const type = /^\s*Type:\s*(\S+)/m.exec(stdout)?.[1];
  const command = /^\s*Command:\s*(.+?)\s*$/m.exec(stdout)?.[1];
  const rawArgs = /^\s*Args:\s*(.*)$/m.exec(stdout)?.[1] ?? "";
  const args = rawArgs.length === 0 ? [] : rawArgs.split(/\s+/);

  const canonical =
    type === "stdio" &&
    command === MCP_ENTRY.command &&
    deepEqual(args, MCP_ENTRY.args);

  return {
    present: true,
    canonical,
    containerPresent: true,
    legacySettingsStale: inspectLegacyClaudeSettings(basePath),
  };
}

export function removeClaudeMcpRegistration(basePath: string): CleanupResult {
  const override = getClaudeRegistryOverride();
  let registryResult: CleanupResult;

  if (override) {
    registryResult = removeJsonMcpConfig(override);
  } else if (!isClaudeCliAvailable()) {
    // No CLI → nothing we can do about the runtime registry. This is
    // not fatal for `remove`: if Claude Code is uninstalled, the
    // registry is already unreachable from the user's perspective, so
    // we just note "already-absent" and move on to clean up legacy
    // surfaces.
    registryResult = { ok: true, kind: "already-absent", path: CLAUDE_MCP_LABEL };
  } else {
    const current = inspectClaudeMcpRegistration(basePath);
    if (!current.present) {
      registryResult = { ok: true, kind: "already-absent", path: CLAUDE_MCP_LABEL };
    } else {
      const removed = spawnSync(
        "claude",
        ["mcp", "remove", MCP_SERVER_NAME, "-s", "local"],
        { encoding: "utf-8", cwd: basePath },
      );
      if (removed.status !== 0 && !readSpawnFailure(removed).includes("No MCP server found")) {
        registryResult = {
          ok: false,
          reason: readSpawnFailure(removed),
          path: CLAUDE_MCP_LABEL,
        };
      } else {
        registryResult = { ok: true, kind: "removed", path: CLAUDE_MCP_LABEL };
      }
    }
  }

  // Best-effort sweep of the legacy settings.json entry, so stale
  // installs don't leave a misleading container behind after the user
  // has uninstalled TraceBase. We don't escalate failures here — a
  // malformed settings.json is the user's file to fix.
  cleanupLegacyClaudeSettings(basePath);

  return registryResult;
}

function writeCodexMcpConfig(force: boolean): StepResult {
  const path = "codex mcp registry";
  const current = inspectCodexMcpConfig();

  if (current.cliMissing) {
    return {
      ok: false,
      reason: "codex CLI is not available in PATH",
      path,
    };
  }

  if (current.present && current.canonical) {
    return { ok: true, kind: "already-up-to-date", path };
  }

  if (current.present && !force) {
    return {
      ok: false,
      reason: `existing "${MCP_SERVER_NAME}" codex mcp entry differs — pass --force to overwrite`,
      path,
    };
  }

  if (current.present && force) {
    const removed = spawnSync("codex", ["mcp", "remove", MCP_SERVER_NAME], {
      encoding: "utf-8",
    });
    if (removed.status !== 0) {
      return {
        ok: false,
        reason: readSpawnFailure(removed),
        path,
      };
    }
  }

  const added = spawnSync(
    "codex",
    ["mcp", "add", MCP_SERVER_NAME, "--", MCP_ENTRY.command, ...MCP_ENTRY.args],
    { encoding: "utf-8" },
  );
  if (added.status !== 0) {
    return {
      ok: false,
      reason: readSpawnFailure(added),
      path,
    };
  }

  return {
    ok: true,
    kind: current.present ? "updated" : "created",
    path,
  };
}

function removeCodexMcpConfig(): CleanupResult {
  const path = "codex mcp registry";
  const current = inspectCodexMcpConfig();

  if (current.cliMissing) {
    return {
      ok: false,
      reason: "codex CLI is not available in PATH",
      path,
    };
  }

  if (!current.present) {
    return { ok: true, kind: "already-absent", path };
  }

  const removed = spawnSync("codex", ["mcp", "remove", MCP_SERVER_NAME], {
    encoding: "utf-8",
  });
  if (removed.status !== 0) {
    return {
      ok: false,
      reason: readSpawnFailure(removed),
      path,
    };
  }

  return { ok: true, kind: "removed", path };
}

function inspectCodexMcpConfig(): MpcInspection {
  const result = spawnSync("codex", ["mcp", "get", MCP_SERVER_NAME, "--json"], {
    encoding: "utf-8",
  });

  if (result.error) {
    return {
      present: false,
      canonical: false,
      containerPresent: false,
      cliMissing: true,
      parseError: result.error.message,
    };
  }

  if (result.status !== 0) {
    return { present: false, canonical: false, containerPresent: true };
  }

  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const transport = parsed.transport as Record<string, unknown> | undefined;
    const command = transport?.command;
    const args = transport?.args;
    return {
      present: true,
      canonical:
        parsed.name === MCP_SERVER_NAME &&
        transport?.type === "stdio" &&
        command === MCP_ENTRY.command &&
        Array.isArray(args) &&
        deepEqual(args, MCP_ENTRY.args),
      containerPresent: true,
    };
  } catch (error) {
    return {
      present: true,
      canonical: false,
      containerPresent: true,
      parseError: error instanceof Error ? error.message : "invalid codex mcp json",
    };
  }
}

function writeManagedInstructionFile(filePath: string): StepResult {
  const managedBlock = `${TRACEBASE_BEGIN}\n${TRACEBASE_CONTENT}\n${TRACEBASE_END}`;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, managedBlock + "\n");
    return { ok: true, kind: "created", path: filePath };
  }

  const current = readFileSync(filePath, "utf-8");
  const beginIdx = current.indexOf(TRACEBASE_BEGIN);
  const endIdx = current.indexOf(TRACEBASE_END);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = current.slice(0, beginIdx);
    const after = current.slice(endIdx + TRACEBASE_END.length);
    const rewritten = before + managedBlock + after;
    if (rewritten === current) {
      return { ok: true, kind: "already-up-to-date", path: filePath };
    }
    writeFileSync(filePath, rewritten);
    return { ok: true, kind: "updated", path: filePath };
  }

  const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(filePath, current + sep + managedBlock + "\n");
  return { ok: true, kind: "updated", path: filePath };
}

function removeManagedInstructionFile(filePath: string): CleanupResult {
  if (!existsSync(filePath)) {
    return { ok: true, kind: "already-absent", path: filePath };
  }

  const current = readFileSync(filePath, "utf-8");
  const beginIdx = current.indexOf(TRACEBASE_BEGIN);
  const endIdx = current.indexOf(TRACEBASE_END);

  if (beginIdx < 0 || endIdx <= beginIdx) {
    return { ok: true, kind: "already-absent", path: filePath };
  }

  const before = current.slice(0, beginIdx);
  const after = current.slice(endIdx + TRACEBASE_END.length);
  const normalized = normalizeInstructionFileContent(before + after);

  if (!normalized) {
    rmSync(filePath, { force: true });
    return { ok: true, kind: "removed", path: filePath };
  }

  writeFileSync(filePath, normalized + "\n");
  return { ok: true, kind: "updated", path: filePath };
}

function inspectManagedInstructionFile(filePath: string): InstructionInspection {
  if (!existsSync(filePath)) {
    return { present: false, managed: false };
  }
  const content = readFileSync(filePath, "utf-8");
  return {
    present: true,
    managed: content.includes(TRACEBASE_BEGIN) && content.includes(TRACEBASE_END),
  };
}

function getUserHomeDir(): string {
  return process.env.HOME || homedir();
}

function normalizeInstructionFileContent(value: string): string {
  return value
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
}

function isCommandAvailable(command: string, args: string[] = ["--version"]): boolean {
  const result = spawnSync(command, args, {
    stdio: "ignore",
  });
  return !result.error;
}

function readSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  if (result.error) return result.error.message;
  const stderr = result.stderr?.toString().trim();
  const stdout = result.stdout?.toString().trim();
  return stderr || stdout || "command failed";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
