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
  it("flags HIGH-confidence noise WITHOUT mutating status", () => {
    const noiseId = seedActiveBlock(NOISE_BLOCK);
    const bugId = seedActiveBlock(REAL_BUG_BLOCK);

    const result = runMemoryPrune({ path: projectDir });
    expect(result.scanned).toBe(2);
    expect(result.applied).toBe(false);
    expect(result.candidates.map((c) => c.blockId)).toEqual([noiseId]);
    expect(result.candidates[0]!.reason).toBe("project-management-lead");
    expect(result.candidates[0]!.confidence).toBe("high");
    expect(result.lowConfidenceCandidates).toEqual([]);
    expect(result.retired).toEqual([]);

    expect(readBlockStatus(noiseId)).toBe("active");
    expect(readBlockStatus(bugId)).toBe("active");
  });

  it("classifies meta-wrap leaks as `meta-wrap-lead` (HIGH)", () => {
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
    expect(result.candidates[0]!.confidence).toBe("high");
    expect(result.lowConfidenceCandidates).toEqual([]);
  });

  it("0.5.8 — `no-problem-signal` blocks land in LOW-confidence, not HIGH", () => {
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
    expect(result.candidates).toEqual([]);
    expect(result.lowConfidenceCandidates.map((c) => c.blockId)).toEqual([id]);
    expect(result.lowConfidenceCandidates[0]!.confidence).toBe("low");
    expect(result.lowConfidenceCandidates[0]!.reason).toBe("no-problem-signal");
  });
});

// ---------------------------------------------------------------------------
// 0.5.8 — regression: known-useful patterns must NOT be HIGH candidates.
// These are real entries from the local DB that the 0.5.7 prune over-flagged.
// ---------------------------------------------------------------------------

describe("runMemoryPrune — known-useful patterns are NOT default candidates (0.5.8 regression)", () => {
  it("installer multi-field entry pattern (no `?`, no error word) → LOW only", () => {
    // 4490c4ab-style situation from the local DB — legitimate
    // reusable pattern about installer canonical-shape upgrades.
    const id = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "installer-pattern" },
      trigger: {
        situation:
          "Installer owns a multi-field entry in a user-facing config file (e.g. .claude/settings.json, .cursor/mcp.json) and the canonical shape evolves across releases.",
        invariants: { language: "typescript" },
      },
    });
    const result = runMemoryPrune({ path: projectDir });
    // MUST NOT be a default candidate — false retire of this is
    // exactly the regression 0.5.8 is fixing.
    expect(result.candidates.map((c) => c.blockId)).not.toContain(id);
    // Lands in LOW-confidence so the user can review with
    // --include-low-confidence if they want.
    expect(result.lowConfidenceCandidates.map((c) => c.blockId)).toContain(id);
  });

  it("optional array map/filter/reduce pattern → LOW only", () => {
    // 3195e06e-style situation: the pattern is about TS optional
    // array params hitting `undefined.map`. No literal `?`, but
    // a real reusable bug pattern.
    const id = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "opt-array-map" },
      trigger: {
        situation:
          "A function takes an optional array parameter and calls Array.prototype method (map/filter/reduce/forEach) on it without guarding for undefined.",
        invariants: { language: "typescript" },
      },
    });
    const result = runMemoryPrune({ path: projectDir });
    expect(result.candidates.map((c) => c.blockId)).not.toContain(id);
    expect(result.lowConfidenceCandidates.map((c) => c.blockId)).toContain(id);
  });

  it("project-management leads (Plan approved / Schedule / Start 0.5.x) STILL HIGH", () => {
    const planId = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "pm-plan" },
      trigger: {
        situation:
          "Plan approved with required amendments before implementation — start §1 today and re-review on Tuesday.",
        invariants: { language: "typescript" },
      },
    });
    const scheduleId = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "pm-schedule" },
      trigger: {
        situation:
          "Yes, schedule a follow-up smoke for ~24h after 0.5.5 publish. The smoke covers fresh init + doctor + bench:sdk.",
        invariants: { language: "typescript" },
      },
    });
    const result = runMemoryPrune({ path: projectDir });
    const highIds = result.candidates.map((c) => c.blockId);
    expect(highIds).toContain(planId);
    expect(highIds).toContain(scheduleId);
  });
});

describe("runMemoryPrune — --apply", () => {
  it("retires HIGH candidates only (default); leaves LOW + real bugs alone", () => {
    const noiseId = seedActiveBlock(NOISE_BLOCK);
    const lowId = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "low-1" },
      trigger: {
        situation:
          "Installer owns a multi-field entry in a user-facing config file and the canonical shape evolves across releases.",
        invariants: { language: "typescript" },
      },
    });
    const bugId = seedActiveBlock(REAL_BUG_BLOCK);

    const result = runMemoryPrune({ path: projectDir, apply: true });
    expect(result.applied).toBe(true);
    expect(result.includedLowConfidence).toBe(false);
    expect(result.retired).toEqual([noiseId]);

    expect(readBlockStatus(noiseId)).toBe("retired");
    expect(readBlockStatus(lowId)).toBe("active"); // PRESERVED
    expect(readBlockStatus(bugId)).toBe("active");
  });

  it("--include-low-confidence + --apply ALSO retires LOW candidates", () => {
    const noiseId = seedActiveBlock(NOISE_BLOCK);
    const lowId = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "low-2" },
      trigger: {
        situation:
          "Refactor the authentication middleware so it can mount cleanly on multiple routes.",
        invariants: { language: "typescript" },
      },
    });

    const result = runMemoryPrune({
      path: projectDir,
      apply: true,
      includeLowConfidence: true,
    });
    expect(result.applied).toBe(true);
    expect(result.includedLowConfidence).toBe(true);
    expect(result.retired.sort()).toEqual([lowId, noiseId].sort());

    expect(readBlockStatus(noiseId)).toBe("retired");
    expect(readBlockStatus(lowId)).toBe("retired");
  });

  it("--include-low-confidence WITHOUT --apply still surfaces LOW (dry-run with widened scope)", () => {
    const lowId = seedActiveBlock({
      ...NOISE_BLOCK,
      provenance: { ...NOISE_BLOCK.provenance, sourceTaskId: "low-3" },
      trigger: {
        situation:
          "Refactor the authentication middleware so it can mount cleanly on multiple routes.",
        invariants: { language: "typescript" },
      },
    });
    const result = runMemoryPrune({
      path: projectDir,
      includeLowConfidence: true,
    });
    expect(result.applied).toBe(false);
    expect(result.includedLowConfidence).toBe(true);
    expect(result.retired).toEqual([]);
    expect(readBlockStatus(lowId)).toBe("active");
    expect(result.lowConfidenceCandidates.map((c) => c.blockId)).toContain(lowId);
  });

  it("a clean store is a clean no-op", () => {
    seedActiveBlock(REAL_BUG_BLOCK);
    const result = runMemoryPrune({ path: projectDir, apply: true });
    expect(result.candidates).toEqual([]);
    expect(result.lowConfidenceCandidates).toEqual([]);
    expect(result.retired).toEqual([]);
  });

  it("empty store (no memory.db yet) returns scanned=0, no error", () => {
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
