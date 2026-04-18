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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-doctor-"));
});
afterEach(() => {
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

describe("runDoctor — fresh init (no Claude files, empty store)", () => {
  it("passes tracebase-config, warns about claude-settings / claude-md / store-content", () => {
    initConfig(dir);
    const r = runDoctor(dir);
    expect(byName(r.checks, "tracebase-config")!.level).toBe("pass");
    // Storage file doesn't exist until first write — warn.
    expect(byName(r.checks, "storage")!.level).toBe("warn");
    expect(byName(r.checks, "claude-settings")!.level).toBe("warn");
    expect(byName(r.checks, "claude-md")!.level).toBe("warn");
    // store-content check only runs when the storage file exists.
    expect(byName(r.checks, "store-content")).toBeUndefined();
    // No FAIL at this point.
    expect(r.summary.fail).toBe(0);
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
    expect(byName(r.checks, "claude-settings")!.level).toBe("pass");
    expect(byName(r.checks, "claude-md")!.level).toBe("pass");
    expect(byName(r.checks, "store-content")!.level).toBe("pass");
    expect(r.summary.fail).toBe(0);
  });
});

describe("runDoctor — specific broken configurations", () => {
  it("fails on malformed .claude/settings.json", () => {
    initConfig(dir);
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(file, "{ not valid json");
    const r = runDoctor(dir);
    const c = byName(r.checks, "claude-settings")!;
    expect(c.level).toBe("fail");
    expect(c.message).toMatch(/not valid JSON/i);
    expect(r.summary.fail).toBeGreaterThan(0);
  });

  it("fails when mcpServers is present but tracebase entry is absent", () => {
    initConfig(dir);
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));
    const r = runDoctor(dir);
    const c = byName(r.checks, "claude-settings")!;
    expect(c.level).toBe("fail");
    expect(c.message).toMatch(/no tracebase entry/i);
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
    const c = byName(r.checks, "claude-settings")!;
    expect(c.level).toBe("warn");
    expect(c.fix).toMatch(/--force/);
  });

  it("warns when CLAUDE.md exists but has no managed section", () => {
    initConfig(dir);
    writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nPlain notes.\n");
    const r = runDoctor(dir);
    const c = byName(r.checks, "claude-md")!;
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
    expect(byName(r.checks, "claude-settings")!.level).toBe("pass");
    expect(byName(r.checks, "claude-md")!.level).toBe("pass");
    expect(r.projectPath).toBe(dir);
  });
});
