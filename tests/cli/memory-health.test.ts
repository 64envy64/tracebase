/**
 * `tracebase memory health` — C3 scoring + C4 demotion CLI tests.
 *
 * Five guarantees pinned here:
 *   1. Default (no flags) is dry-run: nothing in the store changes.
 *   2. `--apply` transitions every block on `wouldDemote` from
 *      `active` → `demoted`. Reversible — never deletes.
 *   3. Demotion is routed STRICTLY through `report.wouldDemote`,
 *      which already requires composite health ≤ threshold AND
 *      ≥1 reason code. A block with sub-threshold health but no
 *      reason (cold-start) MUST NOT be touched.
 *   4. Every demotion emits a `block_demoted` analytics event
 *      carrying the reason codes + components (no raw triggers,
 *      no transcripts, no paths).
 *   5. `--apply` is idempotent: a second run finds nothing to do
 *      (demoted blocks aren't in the active list any more).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import { runMemoryHealth } from "../../src/cli/commands/memory.js";
import { emitAgentUsed, emitOutcome } from "../../src/core/analytics.js";
import type { StoreBlockInput } from "../../src/types.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-mem-health-"));
  initConfig(projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const SAMPLE: StoreBlockInput = {
  trigger: {
    situation: "asyncio event loop blocks on deadlock with shared lock",
    invariants: { language: "python", framework: "asyncio" },
  },
  body: {
    mechanism: "two tasks acquire locks in opposite order",
    deadEnds: [],
    unlock: "always acquire locks in the same global order",
    verification: "stress test never deadlocks under 1000 runs",
  },
  provenance: { sourceTaskId: "t-sample", extractedFrom: "trajectory", distilledBy: "llm" },
};

function makeSample(overrides: Partial<StoreBlockInput> = {}): StoreBlockInput {
  return {
    ...SAMPLE,
    ...overrides,
    trigger: { ...SAMPLE.trigger, ...(overrides.trigger ?? {}) },
    provenance: { ...SAMPLE.provenance, ...(overrides.provenance ?? {}) },
  };
}

function seedActiveBlock(input: StoreBlockInput): string {
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);
  const b = createBlock(input);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  store.updateBlockStatus(b.id, "active");
  store.close();
  return b.id;
}

function readBlockStatus(blockId: string): string | null {
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  const block = store.getBlock(blockId);
  store.close();
  return block?.status ?? null;
}

function seedCounterproductiveExposures(blockId: string, n: number): void {
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath);
  const store = new BlockStore(db);
  for (let i = 0; i < n; i++) {
    const queryId = `q-${blockId.slice(0, 6)}-${i}`;
    store.appendEvent({
      ts: Date.now(),
      queryId,
      event: "retrieval",
      candidates: [{ blockId, score: 0.5 }],
      shadow: false,
    });
    store.appendEvent({
      ts: Date.now(),
      queryId,
      event: "injection",
      blockId,
      score: 0.5,
      calibratedProb: 0.5,
    });
    emitAgentUsed(store, {
      queryId,
      blockId,
      matchSignal: "explicit",
      matchScore: 1,
      evidenceStrength: "explicit",
    });
    emitOutcome(store, { queryId, resolved: false, control: false });
  }
  store.close();
}

function readDemotedEvents(): Array<Record<string, unknown>> {
  const cfg = loadConfig(projectDir);
  const db = new Database(cfg.storagePath, { readonly: true });
  const store = new BlockStore(db, { skipMigrate: true });
  const all = store.readEvents({ limit: 10_000 });
  store.close();
  return all.filter((e) => e.event === "block_demoted") as never;
}

// ---------------------------------------------------------------------------
// Dry-run path (default)
// ---------------------------------------------------------------------------

describe("runMemoryHealth — default (dry-run)", () => {
  it("does not mutate the store, even when wouldDemote is non-empty", () => {
    const sickId = seedActiveBlock(makeSample({
      trigger: { ...SAMPLE.trigger, situation: "bad block with many failures" },
      provenance: { ...SAMPLE.provenance, sourceTaskId: "sick" },
    }));
    seedCounterproductiveExposures(sickId, 10);

    const result = runMemoryHealth({ path: projectDir });
    expect(result.applied).toBe(false);
    expect(result.wouldDemote.length).toBeGreaterThanOrEqual(1);
    expect(result.demoted).toEqual([]);
    // Status untouched.
    expect(readBlockStatus(sickId)).toBe("active");
    expect(readDemotedEvents()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Apply path — the C4 demotion gate
// ---------------------------------------------------------------------------

describe("runMemoryHealth --apply — demotion routed through wouldDemote", () => {
  it("transitions every block on wouldDemote to status=demoted", () => {
    const healthyId = seedActiveBlock(makeSample({
      trigger: { ...SAMPLE.trigger, situation: "healthy block with reasonable triggers" },
      provenance: { ...SAMPLE.provenance, sourceTaskId: "healthy" },
    }));
    const sickId = seedActiveBlock(makeSample({
      trigger: { ...SAMPLE.trigger, situation: "sick block guaranteed to flunk every run" },
      provenance: { ...SAMPLE.provenance, sourceTaskId: "sick" },
    }));
    seedCounterproductiveExposures(sickId, 10);

    const result = runMemoryHealth({ path: projectDir, apply: true });
    expect(result.applied).toBe(true);
    expect(result.demoteFailures).toEqual([]);
    expect(result.demoted).toEqual([sickId]);
    expect(readBlockStatus(sickId)).toBe("demoted");
    expect(readBlockStatus(healthyId)).toBe("active");
  });

  it("emits a block_demoted event with reasons + components per transition", () => {
    const sickId = seedActiveBlock(makeSample({
      trigger: { ...SAMPLE.trigger, situation: "another sick block" },
      provenance: { ...SAMPLE.provenance, sourceTaskId: "sick-event" },
    }));
    seedCounterproductiveExposures(sickId, 10);

    runMemoryHealth({ path: projectDir, apply: true });
    const events = readDemotedEvents();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("block_demoted");
    expect(ev.blockId).toBe(sickId);
    expect(ev.queryId).toBe("lifecycle:memory-health");
    expect(Array.isArray(ev.reasons)).toBe(true);
    expect((ev.reasons as string[]).length).toBeGreaterThan(0);
    expect(typeof (ev as { health: number }).health).toBe("number");
    expect(typeof (ev as { labeledTrials: number }).labeledTrials).toBe("number");
    // Payload-privacy check: NO raw trigger/transcript/path fields.
    expect(ev).not.toHaveProperty("situation");
    expect(ev).not.toHaveProperty("trigger");
    expect(ev).not.toHaveProperty("body");
  });

  it("idempotent: a second --apply run finds nothing to do (demoted blocks left active list)", () => {
    const sickId = seedActiveBlock(makeSample({
      trigger: { ...SAMPLE.trigger, situation: "block to demote twice over" },
      provenance: { ...SAMPLE.provenance, sourceTaskId: "sick-idem" },
    }));
    seedCounterproductiveExposures(sickId, 10);

    const first = runMemoryHealth({ path: projectDir, apply: true });
    expect(first.demoted).toEqual([sickId]);
    const second = runMemoryHealth({ path: projectDir, apply: true });
    // No active blocks scored → nothing to demote.
    expect(second.scanned).toBe(0);
    expect(second.demoted).toEqual([]);
    expect(second.wouldDemote).toEqual([]);
  });

  it("C4 named contract — sub-threshold cold-start block is NOT demoted (reason gate intercepts)", () => {
    // Single failed labeled trial: counterproductive_rate=1,
    // wilson_lb=0, but labeledTrials=1 is below the cold-start
    // floor → no evidence-based reason fires → wouldDemote
    // excludes the block → --apply does NOT touch it. This is
    // the exact contract the reviewer pinned: demotion follows
    // `wouldDemote`/`reasons`, never raw `health <= threshold`.
    const coldStartId = seedActiveBlock(makeSample({
      trigger: { ...SAMPLE.trigger, situation: "cold-start block with one failed exposure" },
      provenance: { ...SAMPLE.provenance, sourceTaskId: "cold-start" },
    }));
    seedCounterproductiveExposures(coldStartId, 1);

    const result = runMemoryHealth({ path: projectDir, apply: true });
    // The block IS scored; its health is sub-threshold; but no
    // reason code fires so it is NOT in wouldDemote.
    const scored = result.scored.find((s) => s.blockId === coldStartId)!;
    expect(scored.health).toBeLessThanOrEqual(0); // sub-threshold
    expect(scored.reasons).toEqual([]);            // no reason → safe
    expect(result.wouldDemote.map((s) => s.blockId)).not.toContain(coldStartId);
    expect(result.demoted).not.toContain(coldStartId);
    expect(readBlockStatus(coldStartId)).toBe("active");
    expect(readDemotedEvents()).toEqual([]);
  });

  it("--apply --dry-run together prefers dry-run (safer)", () => {
    const sickId = seedActiveBlock(makeSample({
      trigger: { ...SAMPLE.trigger, situation: "block we shouldn't demote because both flags set" },
      provenance: { ...SAMPLE.provenance, sourceTaskId: "sick-both" },
    }));
    seedCounterproductiveExposures(sickId, 10);

    const result = runMemoryHealth({ path: projectDir, apply: true, dryRun: true });
    expect(result.applied).toBe(false);
    expect(result.demoted).toEqual([]);
    expect(readBlockStatus(sickId)).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// `block_demoted` analytics event — JSONL validator round-trip
// ---------------------------------------------------------------------------

describe("block_demoted event validator round-trip", () => {
  it("accepts a complete event with valid reasons + components", () => {
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    try {
      const ts = Date.now();
      store.appendEvent({
        ts,
        queryId: "lifecycle:memory-health",
        event: "block_demoted",
        blockId: "b-valid",
        health: -0.4,
        demotionThreshold: 0,
        labeledTrials: 10,
        reasons: ["low_wilson_lb", "high_counterproductive"],
        components: {
          wilsonLb: 0.05,
          counterproductiveRate: 0.4,
          stalePenalty: 0.0,
          duplicationPenalty: 0.0,
          genericnessPenalty: 0.0,
          negativeRoiPenalty: 0.0,
        },
      });
      const events = store.readEvents({ limit: 100 });
      const ev = events.find((e) => e.event === "block_demoted") as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev.blockId).toBe("b-valid");
      expect(Array.isArray(ev.reasons)).toBe(true);
    } finally {
      store.close();
    }
  });
});
