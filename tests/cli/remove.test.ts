import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRemove } from "../../src/cli/commands/remove.js";
import { initConfig } from "../../src/core/config.js";
import { writeClaudeMarkdown, writeClaudeSettings } from "../../src/cli/commands/init.js";
import { writeAgentInstructionFile, writeAgentMcpConfig } from "../../src/cli/install-targets.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-remove-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runRemove", () => {
  it("removes the default Claude install artifacts end-to-end", () => {
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeClaudeMarkdown(dir);

    const report = runRemove({ path: dir });
    expect(report.failed).toBe(false);
    expect(existsSync(join(dir, ".tracebase"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("walks up from a nested path and removes the real project install", () => {
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeClaudeMarkdown(dir);
    const nested = join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });

    const report = runRemove({ path: nested });
    expect(report.projectPath).toBe(dir);
    expect(report.failed).toBe(false);
    expect(existsSync(join(dir, ".tracebase"))).toBe(false);
  });

  it("cleans every adapter listed in install.agents, not just the primary", () => {
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "tb-remove-multi-home-"));
    process.env.HOME = home;
    try {
      initConfig(dir, { install: { agents: ["claude-code", "cursor"] } });
      writeClaudeSettings(dir, false);
      writeClaudeMarkdown(dir);
      writeAgentMcpConfig(dir, "cursor", false);
      writeAgentInstructionFile(dir, "cursor");

      const report = runRemove({ path: dir });
      expect(report.failed).toBe(false);
      expect(report.agents).toEqual(["claude-code", "cursor"]);
      // Claude artifacts removed.
      expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
      // Cursor artifacts removed — this is the regression the
      // single-primary remove used to leak on multi-agent installs.
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
      // Local store gone.
      expect(existsSync(join(dir, ".tracebase"))).toBe(false);
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("semantically detaches cleanly-removed agents from config.json when --keep-store", () => {
    // Regression: `remove --keep-store` used to strip the MCP/instruction
    // surfaces but leave `install.agents` untouched. Status + doctor kept
    // reporting the project as "configured for Claude/Cursor/Codex, but
    // broken", which is a dishonest uninstall report.
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "tb-remove-detach-home-"));
    process.env.HOME = home;
    try {
      initConfig(dir, { install: { agents: ["claude-code", "cursor"] } });
      writeClaudeSettings(dir, false);
      writeClaudeMarkdown(dir);
      writeAgentMcpConfig(dir, "cursor", false);
      writeAgentInstructionFile(dir, "cursor");

      const report = runRemove({ path: dir, keepStore: true });
      expect(report.failed).toBe(false);

      // Local store survives.
      expect(existsSync(join(dir, ".tracebase", "config.json"))).toBe(true);

      // Config records the detach with an empty-agents sentinel so
      // status / doctor can distinguish "cleared" from "legacy config
      // with no install field" and stop reinventing a phantom agent.
      const cfg = JSON.parse(readFileSync(join(dir, ".tracebase", "config.json"), "utf-8")) as {
        install?: { agents?: string[]; agent?: string };
        workspaceId?: string;
      };
      expect(cfg.install?.agents).toEqual([]);
      // workspaceId is stable across the detach — uninstall doesn't
      // rotate the project identity.
      expect(typeof cfg.workspaceId).toBe("string");
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detaches only the targeted agent when --agent is passed with --keep-store", () => {
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "tb-remove-detach-one-home-"));
    process.env.HOME = home;
    try {
      initConfig(dir, { install: { agents: ["claude-code", "cursor"] } });
      writeClaudeSettings(dir, false);
      writeClaudeMarkdown(dir);
      writeAgentMcpConfig(dir, "cursor", false);
      writeAgentInstructionFile(dir, "cursor");

      runRemove({ path: dir, agent: "cursor", keepStore: true });

      // Claude artifacts untouched.
      expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
      // Cursor artifacts cleared.
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);

      const cfg = JSON.parse(readFileSync(join(dir, ".tracebase", "config.json"), "utf-8")) as {
        install?: { agents?: string[]; agent?: string };
      };
      expect(cfg.install?.agents).toEqual(["claude-code"]);
      expect(cfg.install?.agent).toBe("claude-code");
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the stored cursor target and preserves user content around AGENTS.md", () => {
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "tb-remove-home-"));
    process.env.HOME = home;
    try {
      initConfig(dir, { install: { agent: "cursor" } });
      writeAgentMcpConfig(dir, "cursor", false);
      writeAgentInstructionFile(dir, "cursor");
      const agentsPath = join(dir, "AGENTS.md");
      rmSync(agentsPath, { force: true });
      writeAgentInstructionFile(dir, "cursor");
      const current = readFileSync(agentsPath, "utf-8");
      rmSync(agentsPath, { force: true });
      // Preserve surrounding user content after cleanup.
      const content = `# Local notes\n\n${current}\n\nKeep this.\n`;
      writeFileSync(agentsPath, content);

      const report = runRemove({ path: dir, keepStore: true });
      expect(report.agent).toBe("cursor");
      expect(report.failed).toBe(false);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
      expect(readFileSync(agentsPath, "utf-8")).toContain("Keep this.");
      expect(readFileSync(agentsPath, "utf-8")).not.toContain("tracebase:begin");
      expect(existsSync(join(dir, ".tracebase"))).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
