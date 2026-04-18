import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusReport } from "../../src/cli/commands/status.js";
import { initConfig } from "../../src/core/config.js";
import {
  writeClaudeSettings,
  writeClaudeMarkdown,
} from "../../src/cli/commands/init.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-status-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildStatusReport — uninitialized", () => {
  it("reports initialized=false with zeroed fields", () => {
    const r = buildStatusReport(dir);
    expect(r.initialized).toBe(false);
    expect(r.workspaceId).toBeNull();
    expect(r.storagePath).toBeNull();
    expect(r.blocks.active).toBe(0);
    expect(r.events.total).toBe(0);
    expect(r.lastActivityTs).toBeNull();
  });
});

describe("buildStatusReport — fresh init", () => {
  it("surfaces workspaceId + storage path and notes missing Claude files", () => {
    const cfg = initConfig(dir);
    const r = buildStatusReport(dir);
    expect(r.initialized).toBe(true);
    expect(r.workspaceId).toBe(cfg.workspaceId);
    expect(r.storagePath).toBe(cfg.storagePath);
    expect(r.claudeSettingsPresent).toBe(false);
    expect(r.claudeMdPresent).toBe(false);
    // Store file doesn't exist until first write.
    expect(r.storageBytes).toBeNull();
    expect(r.events.total).toBe(0);
    expect(r.blocks.active).toBe(0);
  });

  it("claudeSettingsPresent + claudeMdPresent flip true after full init", () => {
    initConfig(dir);
    writeClaudeSettings(dir, false);
    writeClaudeMarkdown(dir);
    const r = buildStatusReport(dir);
    expect(r.claudeSettingsPresent).toBe(true);
    expect(r.claudeMdPresent).toBe(true);
  });
});

describe("buildStatusReport — populated store", () => {
  it("counts blocks by status and events by type from the SQLite store", async () => {
    initConfig(dir);
    // Open the same store the status command will read from, seed it.
    const Database = (await import("better-sqlite3")).default;
    const { BlockStore } = await import("../../src/core/block-store.js");
    const { createBlock } = await import("../../src/core/block.js");
    const cfg = await import("../../src/core/config.js").then((m) => m.loadConfig(dir));
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    // One active block with an origin ref.
    const b = createBlock({
      trigger: { situation: "sample situation unique-token", invariants: { language: "python" } },
      body: { mechanism: "m", deadEnds: [], unlock: "u", verification: "v" },
      provenance: { sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "llm" },
    });
    b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id, traceId: "trace-1", role: "origin", evidenceQuality: "strong",
    });
    store.updateBlockStatus(b.id, "active");
    // A fact.
    store.storeFact({
      scope: "global", factType: "preference", statement: "fact-stmt",
      invariants: {}, source: { origin: "declared" },
    });
    // Events.
    store.appendEvent({
      ts: 1000, queryId: "q1", event: "retrieval",
      candidates: [{ blockId: b.id, score: 0.9 }], shadow: false,
    });
    store.appendEvent({
      ts: 1500, queryId: "q1", event: "injection", blockId: b.id, score: 0.9,
    });
    store.appendEvent({
      ts: 1800, queryId: "q1", event: "outcome", resolved: true, control: false,
    });
    store.close();

    const r = buildStatusReport(dir);
    expect(r.blocks.active).toBe(1);
    expect(r.blocks.candidate).toBe(0);
    expect(r.factsActive).toBe(1);
    expect(r.events.total).toBe(3);
    expect(r.events.retrieval).toBe(1);
    expect(r.events.injection).toBe(1);
    expect(r.events.outcome).toBe(1);
    expect(r.lastActivityTs).toBe(1800);
    expect(r.storageBytes).toBeGreaterThan(0);
  });
});

describe("buildStatusReport — config-dir search from subdir", () => {
  it("walks up from a nested subdirectory to find .tracebase/", () => {
    initConfig(dir);
    const nested = join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });
    // Drop a sentinel so we know we're looking from the nested path.
    writeFileSync(join(nested, "file.txt"), "x");
    const r = buildStatusReport(nested);
    expect(r.initialized).toBe(true);
  });
});
