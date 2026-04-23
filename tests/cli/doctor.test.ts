import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/cli/commands/doctor.js";
import { initConfig } from "../../src/core/config.js";
import {
  writeClaudeSettings,
  writeClaudeMarkdown,
} from "../../src/cli/commands/init.js";
import {
  writeAgentInstructionFile,
  writeAgentMcpConfig,
} from "../../src/cli/install-targets.js";

let dir: string;
const origClaudeRegistry = process.env.TRACEBASE_CLAUDE_REGISTRY_FILE;
const origMcpProbe = process.env.TRACEBASE_MCP_PROBE_COMMAND;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-doctor-"));
  // Route Claude Code's runtime-registry inspection through the legacy
  // file path. The file-shaped override lets these tests assert on the
  // same on-disk state they used before the runtime switch. The
  // init-e2e.test.ts suite covers the real `claude mcp` invocation via
  // a PATH shim.
  process.env.TRACEBASE_CLAUDE_REGISTRY_FILE = join(dir, ".claude", "settings.json");
  // doctor's live MCP boot probe shells out to `npx -y tracebase-ai
  // serve --mcp --selftest` by default. These in-process unit tests
  // don't need the real probe — we just assert on doctor's check
  // logic — so opt out to keep the suite hermetic and fast.
  process.env.TRACEBASE_MCP_PROBE_COMMAND = "skip";
});
afterEach(() => {
  if (origClaudeRegistry === undefined) delete process.env.TRACEBASE_CLAUDE_REGISTRY_FILE;
  else process.env.TRACEBASE_CLAUDE_REGISTRY_FILE = origClaudeRegistry;
  if (origMcpProbe === undefined) delete process.env.TRACEBASE_MCP_PROBE_COMMAND;
  else process.env.TRACEBASE_MCP_PROBE_COMMAND = origMcpProbe;
  rmSync(dir, { recursive: true, force: true });
});

function byName(checks: ReturnType<typeof runDoctor>["checks"], name: string) {
  return checks.find((c) => c.name === name);
}

describe("runDoctor — uninitialized project", () => {
  it("fails on missing .tracebase/config.json with a fix hint", () => {
    const r = runDoctor(dir);
    const c = byName(r.checks, "tracebase-config")!;
    expect(c.level).toBe("fail");
    expect(c.fix).toMatch(/tracebase init/);
    expect(r.summary.fail).toBeGreaterThan(0);
  });
});

describe("runDoctor — fresh init (no Claude runtime registration, empty store)", () => {
  it("passes tracebase-config, FAILs on missing claude mcp registration, WARNs on CLAUDE.md + store", () => {
    initConfig(dir);
    const r = runDoctor(dir);
    expect(byName(r.checks, "tracebase-config")!.level).toBe("pass");
    // Storage file doesn't exist until first write — warn.
    expect(byName(r.checks, "storage")!.level).toBe("warn");
    // Claude Code can't see TraceBase until it's registered in the
    // runtime `claude mcp` registry — this is a hard failure, not a
    // soft warn, so users don't ship with an inert install. (Prev.
    // regression: settings.json-only path returned a false-positive
    // PASS and a warn-when-missing → both dishonest.)
    expect(byName(r.checks, "claude-code-mcp")!.level).toBe("fail");
    expect(byName(r.checks, "claude-code-mcp")!.fix).toMatch(/claude mcp add|tracebase init/i);
    expect(byName(r.checks, "claude-code-instructions")!.level).toBe("warn");
    // store-content check only runs when the storage file exists.
    expect(byName(r.checks, "store-content")).toBeUndefined();
  });
});

describe("runDoctor — full init + populated store", () => {
  it("all critical checks pass when init completed and store has an active block", async () => {
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeClaudeMarkdown(dir);

    // Seed a block so the store file exists and store-content passes.
    const Database = (await import("better-sqlite3")).default;
    const { BlockStore } = await import("../../src/core/block-store.js");
    const { createBlock } = await import("../../src/core/block.js");
    const cfg = await import("../../src/core/config.js").then((m) => m.loadConfig(dir));
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    const b = createBlock({
      trigger: { situation: "doctor seed", invariants: { language: "python" } },
      body: { mechanism: "m", deadEnds: [], unlock: "u", verification: "v" },
      provenance: { sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id, traceId: "tr-1", role: "origin", evidenceQuality: "strong",
    });
    store.updateBlockStatus(b.id, "active");
    store.close();

    const r = runDoctor(dir);
    expect(byName(r.checks, "tracebase-config")!.level).toBe("pass");
    expect(byName(r.checks, "storage")!.level).toBe("pass");
    expect(byName(r.checks, "claude-code-mcp")!.level).toBe("pass");
    expect(byName(r.checks, "claude-code-instructions")!.level).toBe("pass");
    expect(byName(r.checks, "store-content")!.level).toBe("pass");
    expect(r.summary.fail).toBe(0);
  });
});

describe("runDoctor — specific broken configurations", () => {
  it("fails when the claude mcp runtime-registry source is malformed JSON", () => {
    // The test seam (TRACEBASE_CLAUDE_REGISTRY_FILE) points at
    // `.claude/settings.json`, so corrupting that file simulates a
    // broken runtime-registry read.
    initConfig(dir);
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(file, "{ not valid json");
    const r = runDoctor(dir);
    const c = byName(r.checks, "claude-code-mcp")!;
    expect(c.level).toBe("fail");
    expect(c.message).toMatch(/claude mcp inspection failed/i);
    expect(r.summary.fail).toBeGreaterThan(0);
  });

  it("fails when the runtime registry has other servers but no tracebase entry", () => {
    initConfig(dir);
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));
    const r = runDoctor(dir);
    const c = byName(r.checks, "claude-code-mcp")!;
    expect(c.level).toBe("fail");
    expect(c.message).toMatch(/not registered in the claude mcp runtime registry/i);
  });

  it("warns when tracebase MCP entry has a non-canonical shape", () => {
    initConfig(dir);
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          tracebase: { command: "somethingElse", notArgs: true },
        },
      }),
    );
    const r = runDoctor(dir);
    const c = byName(r.checks, "claude-code-mcp")!;
    expect(c.level).toBe("warn");
    expect(c.fix).toMatch(/--force/);
  });

  it("warns when CLAUDE.md exists but has no managed section", () => {
    initConfig(dir);
    writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nPlain notes.\n");
    const r = runDoctor(dir);
    const c = byName(r.checks, "claude-code-instructions")!;
    expect(c.level).toBe("warn");
    expect(c.fix).toMatch(/tracebase init/);
  });
});

describe("runDoctor — summary", () => {
  it("summary counts match the levels across all checks", () => {
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeClaudeMarkdown(dir);
    const r = runDoctor(dir);
    const totals = { pass: 0, warn: 0, fail: 0 };
    for (const c of r.checks) totals[c.level]++;
    expect(r.summary).toEqual(totals);
  });
});

describe("runDoctor — regressions", () => {
  it("malformed .tracebase/config.json is a hard FAIL, not a soft WARN", async () => {
    // Regression: runDoctor used to call loadConfig() which silently
    // swallows JSON parse errors, so a corrupted config.json was only
    // reported as WARN (missing workspaceId). It must be a FAIL.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, ".tracebase"), { recursive: true });
    writeFileSync(join(dir, ".tracebase", "config.json"), "{ not valid json");

    const r = runDoctor(dir);
    const c = byName(r.checks, "tracebase-config")!;
    expect(c.level).toBe("fail");
    expect(c.message).toMatch(/not valid JSON/i);
    expect(r.summary.fail).toBeGreaterThan(0);
  });

  it("from a nested subdirectory: checks key off the discovered project root", async () => {
    // Regression: runDoctor used the invocation path for
    // .claude/settings.json and CLAUDE.md checks, so running doctor
    // from a subdir reported them missing even when healthy.
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeClaudeMarkdown(dir);

    const { mkdirSync } = await import("node:fs");
    const nested = join(dir, "packages", "a", "src");
    mkdirSync(nested, { recursive: true });

    const r = runDoctor(nested);
    expect(byName(r.checks, "tracebase-config")!.level).toBe("pass");
    expect(byName(r.checks, "claude-code-mcp")!.level).toBe("pass");
    expect(byName(r.checks, "claude-code-instructions")!.level).toBe("pass");
    expect(r.projectPath).toBe(dir);
  });

  it("does not bind to an unrelated parent .tracebase above the repository root", () => {
    const outer = mkdtempSync(join(tmpdir(), "tb-doctor-outer-"));
    const repo = join(outer, "workspace", "app");
    const nested = join(repo, "src");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    initConfig(outer);

    try {
      const r = runDoctor(nested);
      expect(byName(r.checks, "tracebase-config")!.level).toBe("fail");
      expect(r.projectPath).toBe(nested);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe("runDoctor — cursor adapter", () => {
  it("checks cursor-mcp and AGENTS.md instead of Claude-specific files when target=cursor", () => {
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "tb-doctor-home-"));
    process.env.HOME = home;
    try {
      initConfig(dir, { install: { agent: "cursor" } });
      writeAgentMcpConfig(dir, "cursor", false);
      writeAgentInstructionFile(dir, "cursor");

      const r = runDoctor(dir);
      expect(byName(r.checks, "cursor-mcp")!.level).toBe("pass");
      expect(byName(r.checks, "cursor-instructions")!.level).toBe("pass");
      expect(byName(r.checks, "claude-code-mcp")).toBeUndefined();
      expect(byName(r.checks, "claude-code-instructions")).toBeUndefined();
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
