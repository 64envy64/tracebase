import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
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
    expect(c.fix).toMatch(/tracebase-ai init/);
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
    expect(byName(r.checks, "claude-code-mcp")!.fix).toMatch(/claude mcp add|tracebase-ai init/i);
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
    db.close();

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
    expect(c.fix).toMatch(/tracebase-ai init/);
  });
});

describe("runDoctor — summary", () => {
  it("summary counts match the levels across all checks", () => {
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeClaudeMarkdown(dir);
    const r = runDoctor(dir);
    // 0.6.0 — `info` joined the level enum; counts must include it.
    const totals = { pass: 0, info: 0, warn: 0, fail: 0 };
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

describe("runDoctor — Claude Code hook health", () => {
  // Regression: before this, doctor reported the install as fully OK
  // whenever MCP + CLAUDE.md were canonical, even if
  // `.claude/settings.json` had no Stop hook. That silently degraded
  // capture UX (users went back to the MCP permission-prompt flow).
  // Doctor must WARN specifically on a missing Stop hook.
  it("WARNs on missing Stop hook even when MCP + CLAUDE.md are canonical", async () => {
    const { writeAgentHookConfig, removeAgentHookConfig, writeAgentInstructionFile } = await import(
      "../../src/cli/install-targets.js"
    );
    initConfig(dir);
    writeClaudeSettings(dir, false); // MCP registered (runtime registry override file)
    writeAgentInstructionFile(dir, "claude-code"); // CLAUDE.md written

    // Install hooks, then strip the Stop hook to simulate the
    // half-configured state a user lands in if they upgraded from
    // 0.4.1 but somehow missed the 0.4.2 hook init.
    writeAgentHookConfig(dir, "claude-code", false);
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf-8"),
    ) as { hooks: { UserPromptSubmit: unknown[]; Stop?: unknown[] } };
    delete settings.hooks.Stop;
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings, null, 2));

    const r = runDoctor(dir);
    expect(byName(r.checks, "claude-code-mcp")!.level).toBe("pass");
    expect(byName(r.checks, "claude-code-instructions")!.level).toBe("pass");
    const hookCheck = byName(r.checks, "claude-code-hooks")!;
    expect(hookCheck).toBeDefined();
    expect(hookCheck.level).toBe("warn");
    expect(hookCheck.message).toMatch(/Stop/);
    expect(hookCheck.fix).toMatch(/tracebase-ai init/);

    // Cleanup not strictly needed (tmp dir torn down), but silence
    // the linter about an unused import in this fallthrough.
    void removeAgentHookConfig;
  });

  it("WARNs when no hooks are installed at all (fresh MCP-only project)", async () => {
    const { writeAgentInstructionFile } = await import("../../src/cli/install-targets.js");
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeAgentInstructionFile(dir, "claude-code");
    // No hook config written.

    const r = runDoctor(dir);
    const hookCheck = byName(r.checks, "claude-code-hooks")!;
    expect(hookCheck.level).toBe("warn");
    expect(hookCheck.message).toMatch(/not installed/);
  });

  it("PASSes when all four managed hooks (UserPromptSubmit + Stop + PreCompact + PostToolBatch) are canonical", async () => {
    const { writeAgentHookConfig, writeAgentInstructionFile } = await import(
      "../../src/cli/install-targets.js"
    );
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeAgentInstructionFile(dir, "claude-code");
    writeAgentHookConfig(dir, "claude-code", false);

    const r = runDoctor(dir);
    const hookCheck = byName(r.checks, "claude-code-hooks")!;
    expect(hookCheck.level).toBe("pass");
    expect(hookCheck.message).toMatch(/hooks canonical/);
    expect(hookCheck.message).toMatch(/UserPromptSubmit:ok/);
    expect(hookCheck.message).toMatch(/Stop:ok/);
    expect(hookCheck.message).toMatch(/PreCompact:ok/);
    expect(hookCheck.message).toMatch(/PostToolBatch:ok/);
  });
});

describe("runDoctor — hook-health (0.5.6 self-heal)", () => {
  it("PASSes idle when no hook-health.json exists", async () => {
    const { writeAgentHookConfig, writeAgentInstructionFile } = await import(
      "../../src/cli/install-targets.js"
    );
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeAgentInstructionFile(dir, "claude-code");
    writeAgentHookConfig(dir, "claude-code", false);

    const r = runDoctor(dir);
    const c = byName(r.checks, "hook-health")!;
    expect(c).toBeDefined();
    expect(c.level).toBe("pass");
    expect(c.message).toMatch(/auto-heal idle/);
  });

  it("WARNs when hook-health.json reports a customised entry", async () => {
    const { writeAgentHookConfig, writeAgentInstructionFile } = await import(
      "../../src/cli/install-targets.js"
    );
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeAgentInstructionFile(dir, "claude-code");
    writeAgentHookConfig(dir, "claude-code", false);

    // Seed the marker as if self-heal already ran and skipped a custom entry.
    writeFileSync(
      join(dir, ".tracebase", "hook-health.json"),
      JSON.stringify({
        lastSelfHealAt: Date.now(),
        lastSeenPackageVersion: "0.5.6",
        lastSkippedCustom: ["UserPromptSubmit"],
      }),
    );

    const r = runDoctor(dir);
    const c = byName(r.checks, "hook-health")!;
    expect(c.level).toBe("warn");
    expect(c.message).toMatch(/UserPromptSubmit/);
    expect(c.fix).toMatch(/--force/);
  });

  it("PASSes with a recent-update note when hook-health.json reports a recent write", async () => {
    const { writeAgentHookConfig, writeAgentInstructionFile } = await import(
      "../../src/cli/install-targets.js"
    );
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeAgentInstructionFile(dir, "claude-code");
    writeAgentHookConfig(dir, "claude-code", false);

    writeFileSync(
      join(dir, ".tracebase", "hook-health.json"),
      JSON.stringify({
        lastSelfHealAt: Date.now() - 1_000,
        lastSeenPackageVersion: "0.5.6",
        lastSkippedCustom: [],
        lastWrittenAt: Date.now() - 1_000,
        lastUpdated: ["PostToolBatch"],
      }),
    );

    const r = runDoctor(dir);
    const c = byName(r.checks, "hook-health")!;
    expect(c.level).toBe("pass");
    expect(c.message).toMatch(/recently/);
    expect(c.message).toMatch(/PostToolBatch/);
  });
});

describe("runDoctor — impact measurement (0.6.0)", () => {
  it("PASS when holdout is enabled", async () => {
    const { enableHoldoutExperiment } = await import("../../src/core/config.js");
    initConfig(dir);
    enableHoldoutExperiment(dir, { rate: 0.1 });
    const r = runDoctor(dir);
    const c = byName(r.checks, "impact-measurement")!;
    expect(c).toBeDefined();
    expect(c.level).toBe("pass");
    expect(c.message).toMatch(/enabled \(10% holdout\)/);
  });

  it("INFO when holdout is missing — surfaces the enable command", () => {
    initConfig(dir);
    const r = runDoctor(dir);
    const c = byName(r.checks, "impact-measurement")!;
    expect(c.level).toBe("info");
    expect(c.message).toMatch(/disabled/);
    expect(c.message).toMatch(/tracebase-ai init --holdout-rate 0\.1/);
  });

  it("INFO when holdout is explicitly disabled", async () => {
    const { enableHoldoutExperiment, disableHoldoutExperiment } = await import(
      "../../src/core/config.js"
    );
    initConfig(dir);
    enableHoldoutExperiment(dir, { rate: 0.2 });
    disableHoldoutExperiment(dir);
    const r = runDoctor(dir);
    const c = byName(r.checks, "impact-measurement")!;
    expect(c.level).toBe("info");
    expect(c.message).toMatch(/disabled \(rate 0\.2\)/);
  });

  it("WARN when experiment.holdout block is malformed", () => {
    initConfig(dir);
    // Hand-corrupt the experiment block to look present-but-bad.
    const cfgFile = join(dir, ".tracebase", "config.json");
    const raw = JSON.parse(readFileSync(cfgFile, "utf-8")) as Record<string, unknown>;
    raw.experiment = { holdout: { not: "valid" } };
    writeFileSync(cfgFile, JSON.stringify(raw, null, 2));
    const r = runDoctor(dir);
    const c = byName(r.checks, "impact-measurement")!;
    expect(c.level).toBe("warn");
    expect(c.message).toMatch(/holdout block is malformed/);
    expect(c.fix).toMatch(/tracebase-ai init --holdout-rate/);
  });

  it("WARN when rate is out of range", async () => {
    const { enableHoldoutExperiment } = await import("../../src/core/config.js");
    initConfig(dir);
    enableHoldoutExperiment(dir, { rate: 0.5 });
    // Hand-edit the rate to an invalid value, simulating a user
    // who edited config.json directly.
    const cfgFile = join(dir, ".tracebase", "config.json");
    const raw = JSON.parse(readFileSync(cfgFile, "utf-8")) as Record<string, unknown>;
    const exp = raw.experiment as Record<string, unknown>;
    const holdout = exp.holdout as Record<string, unknown>;
    holdout.rate = 5;
    writeFileSync(cfgFile, JSON.stringify(raw, null, 2));
    const r = runDoctor(dir);
    const c = byName(r.checks, "impact-measurement")!;
    expect(c.level).toBe("warn");
    expect(c.message).toMatch(/rate out of range/);
  });

  it("INFO does not increment fail count (exit code stays 0)", async () => {
    const { writeAgentHookConfig, writeAgentInstructionFile } = await import(
      "../../src/cli/install-targets.js"
    );
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeAgentInstructionFile(dir, "claude-code");
    writeAgentHookConfig(dir, "claude-code", false);
    const r = runDoctor(dir);
    const impact = byName(r.checks, "impact-measurement")!;
    expect(impact.level).toBe("info"); // missing holdout
    expect(r.summary.fail).toBe(0);
    // INFO is counted in the new summary slot.
    expect(r.summary.info).toBeGreaterThanOrEqual(1);
  });
});

describe("runDoctor — workspace salt", () => {
  it("PASSes after a fresh init (initConfig mints the salt eagerly)", () => {
    initConfig(dir);
    const r = runDoctor(dir);
    const c = byName(r.checks, "workspace-salt")!;
    expect(c).toBeDefined();
    expect(c.level).toBe("pass");
    expect(c.message).toMatch(/HMAC key/);
  });

  it("WARNs (not FAIL) on a legacy config that lacks workspaceSalt", () => {
    // Simulate a 0.5.2-or-earlier install: write a config without
    // `workspaceSalt`. Doctor must surface this so users know the
    // salt will lazy-mint, but it's never a FAIL — the runtime
    // recovers automatically on the next PostToolBatch fire.
    mkdirSync(join(dir, ".tracebase"), { recursive: true });
    writeFileSync(
      join(dir, ".tracebase", "config.json"),
      JSON.stringify({
        workspaceId: "11111111-2222-3333-4444-555555555555",
        storagePath: join(dir, ".tracebase", "memory.db"),
      }),
    );
    const r = runDoctor(dir);
    const c = byName(r.checks, "workspace-salt")!;
    expect(c.level).toBe("warn");
    expect(c.fix).toMatch(/lazily generated|tracebase-ai init/);
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

// ---------------------------------------------------------------------------
// 0.7.0-rc.2 §rc.2 — file indexer health surface
// ---------------------------------------------------------------------------

describe("runDoctor — file indexer (0.7.0-rc.2)", () => {
  it("INFO when storage file is absent (uninitialized)", () => {
    initConfig(dir);
    const r = runDoctor(dir);
    const c = byName(r.checks, "file-indexer")!;
    expect(c.level).toBe("info");
    expect(c.message).toMatch(/storage not initialized/);
  });

  it("WARN when storage exists but indexer never ran", async () => {
    initConfig(dir);
    // Open + close the store so storage file exists, but no indexer
    // pass has fired (no indexed_files rows, no completion events).
    const Database = (await import("better-sqlite3")).default;
    const { BlockStore } = await import("../../src/core/block-store.js");
    const db = new Database(join(dir, ".tracebase", "memory.db"));
    const store = new BlockStore(db);
    store.close();
    db.close();

    const r = runDoctor(dir);
    const c = byName(r.checks, "file-indexer")!;
    expect(c.level).toBe("warn");
    expect(c.message).toMatch(/no files indexed/);
    expect(c.fix).toMatch(/tracebase-ai init/);
  });

  it("PASS when indexer has indexed files and pending queue is empty", async () => {
    initConfig(dir);
    const Database = (await import("better-sqlite3")).default;
    const { BlockStore } = await import("../../src/core/block-store.js");
    const { indexWorkspace } = await import("../../src/core/file-indexer.js");

    // Plant a tiny TS file so the indexer has something to do.
    const fs = await import("node:fs");
    fs.mkdirSync(join(dir, "src"), { recursive: true });
    fs.writeFileSync(join(dir, "src", "hello.ts"), "/** docs */\nexport const x = 1;\n");

    const db = new Database(join(dir, ".tracebase", "memory.db"));
    const store = new BlockStore(db);
    indexWorkspace(store, { root: dir });
    store.close();
    db.close();

    const r = runDoctor(dir);
    const c = byName(r.checks, "file-indexer")!;
    expect(c.level).toBe("pass");
    expect(c.message).toMatch(/indexed.*heuristic/);
  });

  it("INFO when pending queue has rows (indexer mid-walk)", async () => {
    initConfig(dir);
    const Database = (await import("better-sqlite3")).default;
    const { BlockStore } = await import("../../src/core/block-store.js");
    const { enqueuePending } = await import("../../src/core/file-indexer.js");

    const db = new Database(join(dir, ".tracebase", "memory.db"));
    const store = new BlockStore(db);
    // Plant a fake completion event so the WARN ("never ran") path
    // doesn't fire — we want INFO ("pending work").
    store.appendEvent({
      ts: 1,
      queryId: "fake-completion",
      event: "file_index.completed",
      fileCount: 0,
      bytesSummarized: 0,
      durationMs: 0,
      summarizer: "heuristic",
      pending: 2,
    });
    enqueuePending(store, "src/foo.ts", "file", 1);
    enqueuePending(store, "src/", "dir", 1);
    store.close();
    db.close();

    const r = runDoctor(dir);
    const c = byName(r.checks, "file-indexer")!;
    expect(c.level).toBe("info");
    expect(c.message).toMatch(/1 pending file\(s\)/);
    expect(c.message).toMatch(/1 pending dir\(s\)/);
  });
});
