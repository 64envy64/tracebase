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
}

export interface InstructionInspection {
  present: boolean;
  managed: boolean;
}

const MCP_SERVER_NAME = "tracebase";
const MCP_ENTRY = {
  command: "npx",
  args: ["-y", "tracebase-ai", "serve", "--mcp"],
};

const TRACEBASE_BEGIN = "<!-- tracebase:begin (managed section — do not edit between markers) -->";
const TRACEBASE_END = "<!-- tracebase:end -->";
const TRACEBASE_CONTENT = `## TraceBase reasoning layer

When you start a debugging, bug-fixing, or problem-solving task in this project:

1. Call \`get_reasoning_patterns\` first, with a short description of the problem you're about to work on.
2. The response is a *hypothesis* drawn from prior cases — it may or may not apply. Verify the mechanism against the current task before acting on it. Discard if it does not fit.
3. If no patterns come back, proceed normally.

When you finish the task (whether by solving it or giving up):

1. Call \`record_reasoning_outcome\` with the \`queryId\` you received from \`get_reasoning_patterns\`.
2. Report whether you actually used the suggested pattern (\`usedPattern\`) and whether the task resolved (\`resolved\`).
3. This closes the self-correction loop — future retrievals get calibrated from real outcomes.

Additional tools available: \`recall\`, \`store\`, \`search\`, \`explain\`, \`stats\`.`;

const AGENT_TARGETS: Record<InstallAgent, AgentTargetMeta> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    instructionFile: "CLAUDE.md",
    cloudAgent: "claude-code",
    mcpLocationLabel: ".claude/settings.json",
    verificationTitle: "Restart Claude Code",
    verificationCommand: "/tools → confirm get_reasoning_patterns is listed",
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
      return writeJsonMcpConfig(join(basePath, ".claude", "settings.json"), force);
    case "cursor":
      return writeJsonMcpConfig(join(getUserHomeDir(), ".cursor", "mcp.json"), force);
    case "codex":
      return writeCodexMcpConfig(force);
  }
}

export function inspectAgentMcpConfig(basePath: string, agent: InstallAgent): MpcInspection {
  switch (agent) {
    case "claude-code":
      return inspectJsonMcpConfig(join(basePath, ".claude", "settings.json"));
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
      return removeJsonMcpConfig(join(basePath, ".claude", "settings.json"));
    case "cursor":
      return removeJsonMcpConfig(join(getUserHomeDir(), ".cursor", "mcp.json"));
    case "codex":
      return removeCodexMcpConfig();
  }
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
