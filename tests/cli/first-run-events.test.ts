/**
 * First-run loop: simulate a fresh user running init → calling
 * `get_reasoning_patterns` on an empty store → calling
 * `record_reasoning_outcome`, then verify that `status`, `events`,
 * and `report` surfaces all reflect the activity and degrade
 * gracefully when there's no data.
 *
 * This test drives the internal helpers the MCP server delegates to
 * (`runReasoningPatternsRecall`, `emitOutcome`) rather than launching
 * a real MCP transport — the public contract is the same, but it
 * runs in-process and is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { EventEmitter, emitOutcome } from "../../src/core/analytics.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import { storeReasoningPattern } from "../../src/server/mcp-v2-helpers.js";
import { buildStatusReport } from "../../src/cli/commands/status.js";
import { computeAggregates } from "../../src/core/analytics.js";

let projectDir: string;

beforeEach(() => {
  const raw = mkdtempSync(join(tmpdir(), "tb-firstrun-"));
  projectDir = realpathSync(raw);
  mkdirSync(join(projectDir, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("first-run loop — empty store, no patterns yet", () => {
  it("status before any MCP call: initialized, zero events, no memory.db on disk yet", () => {
    initConfig(projectDir);
    const r = buildStatusReport(projectDir);
    expect(r.initialized).toBe(true);
    expect(r.events.total).toBe(0);
    expect(r.storageBytes).toBeNull();
    expect(r.lastActivityTs).toBeNull();
  });

  it("simulating get_reasoning_patterns creates memory.db and writes a retrieval event even with zero matches", () => {
    initConfig(projectDir);
    const cfg = loadConfig(projectDir);

    // Opening BlockServer on the configured storage path is exactly
    // what the MCP server does on startup — this is not a shortcut.
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    const server = new BlockServer(store);

    const result = runReasoningPatternsRecall(
      server,
      { problem: "debugging a brand-new kind of issue that has no prior trace" },
      { readHoldoutConfig: () => null },
    );

    // Empty store → no hits, but retrieval event still recorded. This is
    // the "even with no patterns" branch of the first-run spec.
    expect(result.blocks).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.shouldInject).toBe(false);

    const events = store.readEvents({ limit: 10 });
    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe("retrieval");
    expect(events[0]!.queryId).toBe(result.queryId);

    store.close();

    // Physical store file now exists.
    expect(existsSync(cfg.storagePath)).toBe(true);
    expect(statSync(cfg.storagePath).size).toBeGreaterThan(0);

    // status picks it up.
    const r = buildStatusReport(projectDir);
    expect(r.events.total).toBe(1);
    expect(r.events.retrieval).toBe(1);
    expect(r.events.outcome).toBe(0);
    expect(r.storageBytes).toBeGreaterThan(0);
    expect(r.lastActivityTs).not.toBeNull();
  });

  it("simulating record_reasoning_outcome adds an outcome event; status/events/report all reflect it", () => {
    initConfig(projectDir);
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    const server = new BlockServer(store);

    const recall = runReasoningPatternsRecall(
      server,
      { problem: "a new problem the agent is about to solve" },
      { readHoldoutConfig: () => null },
    );

    // Mimic the MCP server's record_reasoning_outcome: usedPattern=false
    // (no match was offered), resolved=true (agent solved it from scratch).
    const emitter = new EventEmitter(store);
    emitOutcome(emitter, {
      queryId: recall.queryId,
      resolved: true,
      control: false,
    });

    const events = store.readEvents({ limit: 10 });
    expect(events.length).toBe(2);
    const types = events.map((e) => e.event).sort();
    expect(types).toEqual(["outcome", "retrieval"]);

    const outcome = events.find((e) => e.event === "outcome")!;
    expect(outcome.queryId).toBe(recall.queryId);

    // Report surfaces from the same substrate. With no injection / no
    // shadow arm, rates collapse to 'no data' shapes rather than NaN.
    const agg = computeAggregates(store, {});
    expect(agg.counts.retrieval).toBe(1);
    expect(agg.counts.outcome).toBe(1);
    // No injection, so helpfulRate is null (n/a) not 0.
    expect(agg.rates.helpfulRate).toBeNull();

    store.close();

    const r = buildStatusReport(projectDir);
    expect(r.events.retrieval).toBe(1);
    expect(r.events.outcome).toBe(1);
  });

  it("capture loop closes end-to-end: get_reasoning_patterns → outcome → store_reasoning_pattern → next retrieval finds the block", () => {
    // This replaces an earlier regression pin that documented the gap
    // in the capture path (managed block told the agent to record
    // outcomes but never to write a recallable pattern). The fix:
    // store_reasoning_pattern is now the explicit capture tool and
    // the managed block directs the agent to call it on resolved
    // novel cases. The end-to-end invariant below is what the fix has
    // to keep true across future refactors.
    initConfig(projectDir);
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    const server = new BlockServer(store);

    // 1. First agent: novel problem, no existing pattern.
    const first = runReasoningPatternsRecall(
      server,
      { problem: "pytest collects wrong package when sys.path has a shadowing module" },
      { readHoldoutConfig: () => null },
    );
    expect(first.blocks.length).toBe(0);

    // 2. Agent records the outcome AND captures the pattern.
    const emitter = new EventEmitter(store);
    emitOutcome(emitter, {
      queryId: first.queryId,
      resolved: true,
      control: false,
    });
    const captured = storeReasoningPattern(store, {
      situation: "pytest collects wrong package when sys.path has a shadowing module",
      mechanism: "sys.path pollution leaves a stale module cached earlier than the package",
      unlock: "prepend the project root to sys.path in conftest.py, or clear sys.modules",
      verification: "pytest collects the intended package on a cold run",
      language: "python",
      queryId: first.queryId,
    });
    expect(captured.isNew).toBe(true);

    // 3. Second agent faces the same class of problem later — now
    //    retrieval surfaces the captured block as a hypothesis.
    const second = runReasoningPatternsRecall(
      server,
      { problem: "pytest collects wrong package due to shadowing sys.path module" },
      { readHoldoutConfig: () => null },
    );
    expect(second.blocks.length).toBeGreaterThan(0);
    expect(second.blocks[0]!.block.id).toBe(captured.blockId);
    expect(second.shouldInject).toBe(true);

    store.close();
  });
});
