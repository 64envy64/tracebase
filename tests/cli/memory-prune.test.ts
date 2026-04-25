/**
 * `tracebase memory prune` — reversible cleanup against the
 * 0.5.7 quality gate (PLAN-0.5.7 §B).
 *
 * Three guarantees pinned here:
 *   1. `--dry-run` (default) does NOT mutate the store —
 *      candidates are listed, but every block stays `active`.
 *   2. `--apply` flips matching blocks from `active` → `retired`
 *      (status update, NOT delete — reversible).
 *   3. `isPatternShapedSituation` from capture-turn.ts is the
 *      single source of truth for the gate. The prune classifier
 *      cannot drift away from the live capture path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import { runMemoryPrune } from "../../src/cli/commands/memory.js";
import type { StoreBlockInput } from "../../src/types.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-mem-prune-"));
  initConfig(projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

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

const NOISE_BLOCK: StoreBlockInput = {
  trigger: {
    // Real noisy entry from the local DB survey: a project-management
    // approval that cleared the old 80-char gate.
    situation:
      "Plan approved with required amendments before implementation — start §1 today and re-review on Tuesday.",
    invariants: { language: "typescript" },
  },
  body: {
    mechanism:
      "the agent is being told to begin implementation, not to debug a problem",
    deadEnds: [],
    unlock: "begin §1 today and re-review on Tuesday after the cohort warms",
    verification: "ship the §1 commit and observe metrics",
  },
  provenance: {
    sourceTaskId: "noise-1",
    extractedFrom: "trajectory",
    distilledBy: "rule",
  },
};

const REAL_BUG_BLOCK: StoreBlockInput = {
  trigger: {
    situation:
      "pytest is picking up the wrong package on a fresh clone — sys.path shadow is the root cause but I don't see how to confirm",
    invariants: { language: "python", framework: "pytest" },
  },
  body: {
    mechanism: "shadow helper sits earlier in sys.path than the intended package",
    deadEnds: [],
    unlock: "remove the shadow directory or rename the helper module",
    verification: "pytest --collect-only lists only the intended package",
  },
  provenance: {
    sourceTaskId: "real-bug-1",
    extractedFrom: "trajectory",
    distilledBy: "rule",
  },
};

describe("runMemoryPrune — dry-run (default)", () => {
  it("flags noisy blocks WITHOUT mutating their status", () => {
    const noiseId = seedActiveBlock(NOISE_BLOCK);
    const bugId = seedActiveBlock(REAL_BUG_BLOCK);

    const result = runMemoryPrune({ path: projectDir });
    expect(result.scanned).toBe(2);
    expect(result.applied).toBe(false);
    expect(result.candidates.map((c) => c.blockId)).toEqual([noiseId]);
    expect(result.candidates[0]!.reason).toBe("project-management-lead");
    expect(result.retired).toEqual([]);

    // Status check — both still active (dry-run never writes).
    expect(readBlockStatus(noiseId)).toBe("active");
    expect(readBlockStatus(bugId)).toBe("active");
  });

  it("classifies meta-wrap leaks as `meta-wrap-lead`", () => {
    const id = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "meta-1" },
      trigger: {
        situation:
          "This session is being continued from a previous conversation that ran out of context. The summary covers...",
        invariants: { language: "typescript" },
      },
    });
    const result = runMemoryPrune({ path: projectDir });
    expect(result.candidates.map((c) => c.blockId)).toEqual([id]);
    expect(result.candidates[0]!.reason).toBe("meta-wrap-lead");
  });

  it("classifies non-problem prompts as `no-problem-signal`", () => {
    const id = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "feat-1" },
      trigger: {
        situation:
          "Refactor the authentication middleware so it can be mounted on multiple routes without redundant setup boilerplate.",
        invariants: { language: "typescript" },
      },
    });
    const result = runMemoryPrune({ path: projectDir });
    expect(result.candidates.map((c) => c.blockId)).toEqual([id]);
    expect(result.candidates[0]!.reason).toBe("no-problem-signal");
  });
});

describe("runMemoryPrune — --apply", () => {
  it("retires candidates (status: active → retired); leaves real bugs alone", () => {
    const noiseId = seedActiveBlock(NOISE_BLOCK);
    const bugId = seedActiveBlock(REAL_BUG_BLOCK);

    const result = runMemoryPrune({ path: projectDir, apply: true });
    expect(result.applied).toBe(true);
    expect(result.retired).toEqual([noiseId]);
    expect(result.candidates).toHaveLength(1);

    expect(readBlockStatus(noiseId)).toBe("retired");
    expect(readBlockStatus(bugId)).toBe("active");
  });

  it("a clean store is a clean no-op", () => {
    seedActiveBlock(REAL_BUG_BLOCK);
    const result = runMemoryPrune({ path: projectDir, apply: true });
    expect(result.candidates).toEqual([]);
    expect(result.retired).toEqual([]);
  });

  it("empty store (no memory.db yet) returns scanned=0, no error", () => {
    // initConfig but no blocks → memory.db doesn't exist yet.
    const result = runMemoryPrune({ path: projectDir, apply: true });
    expect(result.scanned).toBe(0);
    expect(result.applied).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("uninitialised project returns an error", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "tb-mem-noinit-"));
    try {
      const result = runMemoryPrune({ path: elsewhere });
      expect(result.error).toMatch(/not initialized/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("--apply + --dry-run together → safer dry-run wins", () => {
    seedActiveBlock(NOISE_BLOCK);
    const result = runMemoryPrune({ path: projectDir, apply: true, dryRun: true });
    expect(result.applied).toBe(false);
    expect(result.retired).toEqual([]);
  });
});
