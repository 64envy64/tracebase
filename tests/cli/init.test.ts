import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClaudeSettings, writeClaudeMarkdown } from "../../src/cli/commands/init.js";
import { initConfig, loadConfig, isInitialized } from "../../src/core/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// initConfig — workspaceId lifecycle
// ---------------------------------------------------------------------------

describe("initConfig — workspaceId", () => {
  it("generates a workspaceId on first init", () => {
    const cfg = initConfig(dir);
    expect(cfg.workspaceId).toBeTypeOf("string");
    expect(cfg.workspaceId!.length).toBeGreaterThan(0);
  });

  it("persists the workspaceId to config.json", () => {
    initConfig(dir);
    const raw = readFileSync(join(dir, ".tracebase", "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof parsed.workspaceId).toBe("string");
  });

  it("preserves the workspaceId across re-inits", () => {
    const first = initConfig(dir);
    const firstId = first.workspaceId;
    const second = initConfig(dir);
    expect(second.workspaceId).toBe(firstId);
  });

  it("loadConfig reads workspaceId back", () => {
    const first = initConfig(dir);
    const loaded = loadConfig(dir);
    expect(loaded.workspaceId).toBe(first.workspaceId);
  });

  it("isInitialized flips after init", () => {
    expect(isInitialized(dir)).toBe(false);
    initConfig(dir);
    expect(isInitialized(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeClaudeSettings
// ---------------------------------------------------------------------------

describe("writeClaudeSettings", () => {
  it("creates .claude/settings.json from scratch with the tracebase entry", () => {
    const res = writeClaudeSettings(dir, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("created");
    const file = join(dir, ".claude", "settings.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, unknown>;
    expect(servers.tracebase).toBeDefined();
    const entry = servers.tracebase as Record<string, unknown>;
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "tracebase-ai", "serve", "--mcp"]);
  });

  it("merges into an existing settings.json without clobbering other keys", () => {
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({
      permissions: { allow: ["npm run build"] },
      mcpServers: { other: { command: "other-cmd", args: [] } },
    }, null, 2));

    const res = writeClaudeSettings(dir, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("updated");

    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    // Original keys preserved.
    expect((parsed.permissions as Record<string, unknown>).allow).toEqual(["npm run build"]);
    const servers = parsed.mcpServers as Record<string, unknown>;
    expect(servers.other).toBeDefined();
    // tracebase added.
    expect(servers.tracebase).toBeDefined();
  });

  it("is idempotent when the existing tracebase entry already matches", () => {
    writeClaudeSettings(dir, false);
    const res = writeClaudeSettings(dir, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("already-up-to-date");
  });

  it("refuses to overwrite a differing tracebase entry without --force", () => {
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({
      mcpServers: { tracebase: { command: "legacy", args: [] } },
    }, null, 2));

    const res = writeClaudeSettings(dir, false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/differs/);
    // File untouched.
    const after = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect((after.mcpServers as Record<string, unknown>).tracebase).toMatchObject({ command: "legacy" });
  });

  it("overwrites a differing tracebase entry when force=true", () => {
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({
      mcpServers: { tracebase: { command: "legacy", args: [] } },
    }, null, 2));

    const res = writeClaudeSettings(dir, true);
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const entry = (parsed.mcpServers as Record<string, unknown>).tracebase as Record<string, unknown>;
    expect(entry.command).toBe("npx");
  });

  it("returns an error on malformed existing settings.json", () => {
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(file, "{ not valid json");
    const res = writeClaudeSettings(dir, false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/not valid JSON/i);
  });
});

// ---------------------------------------------------------------------------
// writeClaudeMarkdown
// ---------------------------------------------------------------------------

describe("writeClaudeMarkdown", () => {
  const BEGIN = "<!-- tracebase:begin";
  const END = "<!-- tracebase:end -->";

  it("creates CLAUDE.md with the managed block on a fresh project", () => {
    const res = writeClaudeMarkdown(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("created");
    const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    expect(content).toContain(BEGIN);
    expect(content).toContain(END);
    expect(content).toContain("get_reasoning_patterns");
    expect(content).toContain("record_reasoning_outcome");
  });

  it("appends the managed block to an existing CLAUDE.md without markers", () => {
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, "# My project\n\nExisting content.\n");
    const res = writeClaudeMarkdown(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("updated");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("My project");
    expect(content).toContain("Existing content.");
    expect(content).toContain(BEGIN);
    expect(content.indexOf("Existing content.")).toBeLessThan(content.indexOf(BEGIN));
  });

  it("rewrites only the managed section, preserving surrounding user content", () => {
    const file = join(dir, "CLAUDE.md");
    // First pass creates the block at end of file.
    writeFileSync(file, "# Project\n\nCustom notes.\n");
    writeClaudeMarkdown(dir);
    // Simulate a stale version of the managed content by editing between
    // the markers (emulates an older CLI).
    let content = readFileSync(file, "utf-8");
    content = content.replace(
      /<!-- tracebase:begin[^]*?<!-- tracebase:end -->/,
      "<!-- tracebase:begin (managed section — do not edit between markers) -->\nOLD MANAGED CONTENT\n<!-- tracebase:end -->",
    );
    writeFileSync(file, content);
    // User also appended content AFTER the managed block.
    writeFileSync(file, content + "\nAppended by user later.\n");

    const res = writeClaudeMarkdown(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("updated");

    const after = readFileSync(file, "utf-8");
    expect(after).toContain("Project");
    expect(after).toContain("Custom notes.");
    expect(after).toContain("Appended by user later.");
    expect(after).not.toContain("OLD MANAGED CONTENT");
    // Canonical content restored:
    expect(after).toContain("get_reasoning_patterns");
    expect(after).toContain("record_reasoning_outcome");
  });

  it("is idempotent when the managed block already matches", () => {
    writeClaudeMarkdown(dir);
    const res = writeClaudeMarkdown(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("already-up-to-date");
  });
});
