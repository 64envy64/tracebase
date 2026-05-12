/**
 * Unit coverage for the Claude Code runtime-registry integration.
 *
 * These tests exercise the new `writeClaudeMcpRegistration /
 * inspectClaudeMcpRegistration / removeClaudeMcpRegistration` code path
 * through the `TRACEBASE_CLAUDE_REGISTRY_FILE` test seam, so they run
 * without requiring a real `claude` CLI on PATH. The end-to-end suite
 * in `init-e2e.test.ts` covers the real-CLI case with a shell shim.
 *
 * Focus areas here:
 *   - the legacy `.claude/settings.json` entry is detected as stale
 *     when the runtime registry is empty,
 *   - `init` sweeps the stale entry after a successful registration,
 *   - `remove` sweeps the stale entry too,
 *   - doctor's `claude-code-legacy-settings` WARN fires when expected,
 *   - `claude` CLI missing is a hard FAIL in doctor (not a false PASS),
 *   - status reflects runtime registration state, not settings.json.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initConfig } from "../../src/core/config.js";
import { runDoctor } from "../../src/cli/commands/doctor.js";
import { buildStatusReport } from "../../src/cli/commands/status.js";
import { runRemove } from "../../src/cli/commands/remove.js";
import {
  cleanupLegacyClaudeSettings,
  inspectAgentMcpConfig,
  inspectLegacyClaudeSettings,
  removeAgentMcpConfig,
  writeAgentInstructionFile,
  writeAgentMcpConfig,
  writeClaudeMcpRegistration,
} from "../../src/cli/install-targets.js";

let dir: string;
const origRegistry = process.env.TRACEBASE_CLAUDE_REGISTRY_FILE;
const origPath = process.env.PATH;
const origMcpProbe = process.env.TRACEBASE_MCP_PROBE_COMMAND;

function registryFile(): string {
  // Deliberately NOT `.claude/settings.json` — using a separate path
  // ensures legacy detection and runtime state are independent.
  return join(dir, ".tracebase", "claude-mcp-registry.json");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-claude-mcp-"));
  process.env.TRACEBASE_CLAUDE_REGISTRY_FILE = registryFile();
  // Same rationale as doctor.test.ts — suppress the live MCP boot
  // probe in in-process unit tests. These suites assert on doctor's
  // check logic, not on the real `npx -y tracebase-ai` spawn.
  process.env.TRACEBASE_MCP_PROBE_COMMAND = "skip";
});

afterEach(() => {
  if (origRegistry === undefined) delete process.env.TRACEBASE_CLAUDE_REGISTRY_FILE;
  else process.env.TRACEBASE_CLAUDE_REGISTRY_FILE = origRegistry;
  if (origMcpProbe === undefined) delete process.env.TRACEBASE_MCP_PROBE_COMMAND;
  else process.env.TRACEBASE_MCP_PROBE_COMMAND = origMcpProbe;
  process.env.PATH = origPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("writeClaudeMcpRegistration — runtime registry writes", () => {
  it("creates the registration with the canonical stdio command", () => {
    const res = writeClaudeMcpRegistration(dir, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("created");
    // In override mode `res.path` points at the shim file; the
    // production-mode label is asserted by the e2e suite.
    // Content written to the overridden file.
    const content = JSON.parse(readFileSync(registryFile(), "utf-8")) as Record<string, unknown>;
    const servers = content.mcpServers as Record<string, unknown>;
    expect(servers.tracebase).toEqual({
      command: "npx",
      args: ["-y", "tracebase-ai@latest", "serve", "--mcp"],
    });
  });

  it("is idempotent on a second call — no duplicate registrations", () => {
    writeClaudeMcpRegistration(dir, false);
    const second = writeClaudeMcpRegistration(dir, false);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.kind).toBe("already-up-to-date");
  });

  it("refuses to overwrite a non-canonical entry without --force", () => {
    mkdirSync(join(dir, ".tracebase"), { recursive: true });
    writeFileSync(
      registryFile(),
      JSON.stringify({
        mcpServers: { tracebase: { command: "legacy", args: [] } },
      }),
    );
    const res = writeClaudeMcpRegistration(dir, false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/differs.*--force/i);
  });
});

describe("inspectLegacyClaudeSettings + cleanup", () => {
  it("detects a stale tracebase entry in .claude/settings.json and reports it", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
          other: { command: "x", args: [] },
        },
        permissions: { allow: ["npm run build"] },
      }),
    );

    expect(inspectLegacyClaudeSettings(dir)).toBe(true);
  });

  it("returns false when .claude/settings.json exists but has no tracebase entry", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }),
    );
    expect(inspectLegacyClaudeSettings(dir)).toBe(false);
  });

  it("cleanupLegacyClaudeSettings removes only the tracebase entry, preserving other keys", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
          other: { command: "x", args: [] },
        },
        permissions: { allow: ["npm run build"] },
      }),
    );

    const swept = cleanupLegacyClaudeSettings(dir);
    expect(swept).toBe(true);
    expect(inspectLegacyClaudeSettings(dir)).toBe(false);

    const after = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    // Other entries preserved.
    expect((after.mcpServers as Record<string, unknown>).other).toBeDefined();
    expect((after.permissions as Record<string, unknown>).allow).toEqual(["npm run build"]);
  });

  it("cleanupLegacyClaudeSettings is a no-op when .claude/settings.json does not exist", () => {
    expect(cleanupLegacyClaudeSettings(dir)).toBe(false);
  });
});

describe("doctor — legacy-settings WARN fires when runtime is healthy but settings.json is stale", () => {
  it("warns about a stale .claude/settings.json entry even after a proper runtime install", () => {
    initConfig(dir);
    writeAgentMcpConfig(dir, "claude-code", false); // healthy runtime
    writeAgentInstructionFile(dir, "claude-code");

    // Seed a stale legacy entry after the clean install.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
        },
      }),
    );

    const r = runDoctor(dir);
    const mcp = r.checks.find((c) => c.name === "claude-code-mcp");
    const legacy = r.checks.find((c) => c.name === "claude-code-legacy-settings");
    expect(mcp?.level).toBe("pass");
    expect(legacy).toBeDefined();
    expect(legacy!.level).toBe("warn");
    expect(legacy!.message).toMatch(/\.claude\/settings\.json/);
    expect(legacy!.fix).toMatch(/tracebase-ai init/);
  });

  it("does not emit the legacy-settings WARN when .claude/settings.json is clean", () => {
    initConfig(dir);
    writeAgentMcpConfig(dir, "claude-code", false);
    writeAgentInstructionFile(dir, "claude-code");

    const r = runDoctor(dir);
    const legacy = r.checks.find((c) => c.name === "claude-code-legacy-settings");
    expect(legacy).toBeUndefined();
  });
});

describe("init — sweeps stale .claude/settings.json after a successful runtime install", () => {
  it("writeAgentMcpConfig + cleanupLegacyClaudeSettings together detach the legacy entry", () => {
    // Pre-existing legacy install.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
          other: { command: "x", args: [] },
        },
      }),
    );
    initConfig(dir);

    const res = writeAgentMcpConfig(dir, "claude-code", false);
    expect(res.ok).toBe(true);
    // The caller (init) sweeps — mirror that here.
    cleanupLegacyClaudeSettings(dir);

    expect(inspectLegacyClaudeSettings(dir)).toBe(false);
    // Other server entries preserved.
    const after = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect((after.mcpServers as Record<string, unknown>).other).toBeDefined();
  });
});

describe("remove — cleans runtime registration AND legacy .claude/settings.json", () => {
  it("runRemove sweeps both surfaces for a fresh install", () => {
    initConfig(dir);
    writeAgentMcpConfig(dir, "claude-code", false); // runtime registration
    writeAgentInstructionFile(dir, "claude-code");

    // Simulate a user upgrading from the old CLI — stale entry in
    // settings.json too.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
        },
      }),
    );

    const report = runRemove({ path: dir });
    expect(report.failed).toBe(false);

    // Runtime registry wiped.
    expect(inspectAgentMcpConfig(dir, "claude-code").present).toBe(false);
    // Legacy file entry wiped.
    expect(inspectLegacyClaudeSettings(dir)).toBe(false);
    // CLAUDE.md wiped.
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("removeAgentMcpConfig('claude-code') sweeps .claude/settings.json as a side effect", () => {
    // Seed legacy entry, no runtime registration.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
        },
      }),
    );

    removeAgentMcpConfig(dir, "claude-code");
    expect(inspectLegacyClaudeSettings(dir)).toBe(false);
  });
});

describe("status — reflects runtime registration, not .claude/settings.json", () => {
  it("claudeSettingsPresent becomes true only when the runtime registry has the canonical entry", () => {
    initConfig(dir);
    // Only seed .claude/settings.json (legacy state) → runtime registry is still empty.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          tracebase: { command: "npx", args: ["-y", "tracebase-ai@latest", "serve", "--mcp"] },
        },
      }),
    );

    const r1 = buildStatusReport(dir);
    expect(r1.claudeSettingsPresent).toBe(false); // runtime is source of truth
    expect(r1.mcpConfigured).toBe(false);

    // Add the real runtime registration.
    writeAgentMcpConfig(dir, "claude-code", false);
    const r2 = buildStatusReport(dir);
    expect(r2.claudeSettingsPresent).toBe(true);
    expect(r2.mcpConfigured).toBe(true);
  });
});

describe("doctor — claude CLI missing surfaces as a hard FAIL (no false positives)", () => {
  it("FAILs when TRACEBASE_CLAUDE_REGISTRY_FILE is unset and claude is not on PATH", () => {
    // Disable the override so the real CLI-detection code path runs.
    delete process.env.TRACEBASE_CLAUDE_REGISTRY_FILE;
    // Minimal PATH: only the node binary's directory, no claude CLI.
    const nodeDir = require("node:path").dirname(process.execPath);
    process.env.PATH = nodeDir;

    initConfig(dir);

    const r = runDoctor(dir);
    const mcp = r.checks.find((c) => c.name === "claude-code-mcp");
    expect(mcp?.level).toBe("fail");
    expect(mcp?.message).toMatch(/claude cli.*not available|not available in path/i);
    expect(mcp?.fix).toMatch(/install.*claude code|add.*claude.*to path/i);
  });
});
