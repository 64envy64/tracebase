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
