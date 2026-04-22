import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeAgentInstructionFile,
  removeAgentMcpConfig,
  resolveInstallAgent,
  writeAgentInstructionFile,
  writeAgentMcpConfig,
} from "../../src/cli/install-targets.js";

let dir: string;
let homeDir: string;
const originalHome = process.env.HOME;
const originalCodexShell = process.env.CODEX_SHELL;
const originalPath = process.env.PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-agent-targets-"));
  homeDir = mkdtempSync(join(tmpdir(), "tb-agent-home-"));
  process.env.HOME = homeDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.CODEX_SHELL = originalCodexShell;
  process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("resolveInstallAgent", () => {
  it("respects stored target when environment detection is disabled", () => {
    process.env.CODEX_SHELL = "1";
    const agent = resolveInstallAgent({
      basePath: dir,
      stored: "cursor",
      preferEnvironment: false,
    });
    expect(agent).toBe("cursor");
  });

  it("does not auto-select codex when the shell env is present but the codex CLI is unavailable", () => {
    process.env.CODEX_SHELL = "1";
    process.env.PATH = "";
    const agent = resolveInstallAgent({
      basePath: dir,
      preferEnvironment: true,
    });
    expect(agent).toBe("claude-code");
  });
});

describe("writeAgentMcpConfig", () => {
  it("creates the Cursor MCP entry in ~/.cursor/mcp.json", () => {
    const res = writeAgentMcpConfig(dir, "cursor", false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const file = join(homeDir, ".cursor", "mcp.json");
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown>;
    expect(servers.tracebase).toBeDefined();
  });
});

describe("writeAgentInstructionFile", () => {
  it("creates AGENTS.md for non-Claude adapters", () => {
    const res = writeAgentInstructionFile(dir, "cursor");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const content = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(content).toContain("tracebase:begin");
    expect(content).toContain("get_reasoning_patterns");
  });
});

describe("removeAgentMcpConfig", () => {
  it("removes the TraceBase entry from Cursor MCP config without clobbering other entries", () => {
    writeAgentMcpConfig(dir, "cursor", false);
    const file = join(homeDir, ".cursor", "mcp.json");
    writeFileSync(
      file,
      JSON.stringify(
        {
          mcpServers: {
            tracebase: { command: "npx", args: ["-y", "tracebase-ai", "serve", "--mcp"] },
            other: { command: "other", args: [] },
          },
          telemetry: false,
        },
        null,
        2,
      ),
    );

    const res = removeAgentMcpConfig(dir, "cursor");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("updated");

    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown>;
    expect(servers.tracebase).toBeUndefined();
    expect(servers.other).toBeDefined();
    expect(parsed.telemetry).toBe(false);
  });
});

describe("removeAgentInstructionFile", () => {
  it("removes the managed block and preserves surrounding user content", () => {
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, "# Project notes\n\nUser section.\n\n");
    writeAgentInstructionFile(dir, "cursor");
    writeFileSync(file, readFileSync(file, "utf-8") + "\nCustom footer.\n");

    const res = removeAgentInstructionFile(dir, "cursor");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("updated");

    const content = readFileSync(file, "utf-8");
    expect(content).toContain("# Project notes");
    expect(content).toContain("User section.");
    expect(content).toContain("Custom footer.");
    expect(content).not.toContain("tracebase:begin");
  });

  it("deletes the instruction file when it only contains the managed block", () => {
    writeAgentInstructionFile(dir, "cursor");
    const file = join(dir, "AGENTS.md");

    const res = removeAgentInstructionFile(dir, "cursor");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("removed");
    expect(existsSync(file)).toBe(false);
  });
});
