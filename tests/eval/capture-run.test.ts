/**
 * Capture-run safety envelope (Phase 5) — the locked-rule decision logic.
 * Pure; no paid agents. Proves freeze-disjointness + every halt condition +
 * the early health checkpoint + the organic-target accounting.
 */
import { describe, it, expect } from "vitest";
import {
  freezeManifest,
  runState,
  HARD_CAP_USD,
  type CaptureTask,
  type TrajRecord,
} from "../../scripts/reasoning-precision/capture-run.js";

const rec = (over: Partial<TrajRecord>): TrajRecord => ({
  taskId: "t", phase: "capture", costUsd: 0.2, tokens: 1000, exitCode: 0, blockId: "b", attributedResolved: false, empty: false, ...over,
});

describe("freezeManifest", () => {
  it("hashes the manifest and rejects a non-disjoint capture/recall split", () => {
    const ok: CaptureTask[] = [
      { id: "c1", phase: "capture", ref: "repo@aaa", problemClass: "x" },
      { id: "r1", phase: "recall", ref: "repo@bbb", problemClass: "x" },
    ];
    const m = freezeManifest(ok, 1000);
    expect(m.manifestHash).toHaveLength(16);
    expect(m.model).toBe("claude-haiku-4-5");

    const bad: CaptureTask[] = [
      { id: "c1", phase: "capture", ref: "repo@same", problemClass: "x" },
      { id: "r1", phase: "recall", ref: "repo@same", problemClass: "x" }, // reuses capture ref
    ];
    expect(() => freezeManifest(bad, 1000)).toThrow(/not disjoint/);
  });
});

describe("runState halt conditions", () => {
  it("continues while healthy and counts organic evidence correctly", () => {
    const records = [
      rec({ phase: "capture", blockId: "b1" }),
      rec({ phase: "recall", blockId: "b1", attributedResolved: true }),
    ];
    const s = runState(records, {});
    expect(s.halt).toBeNull();
    expect(s.organic.capturedRuntime).toBe(1);
    expect(s.organic.precisionReady).toBe(1);
  });

  it("halts at the hard cap", () => {
    const records = Array.from({ length: 160 }, () => rec({ costUsd: 0.2 }));
    expect(runState(records, {}).spendUsd).toBeGreaterThanOrEqual(HARD_CAP_USD);
    expect(runState(records, {}).halt).toBe("hard-cap");
  });

  it("halts on 3 consecutive empty trajectories", () => {
    const records = [rec({}), rec({ empty: true, blockId: null }), rec({ empty: true, blockId: null }), rec({ empty: true, blockId: null })];
    expect(runState(records, {}).halt).toBe("consecutive-empty");
  });

  it("halts on privacy regression and manifest-leak and pipeline failure", () => {
    expect(runState([rec({})], { privacyRegression: true }).halt).toBe("privacy-regression");
    expect(runState([rec({})], { manifestLeak: true }).halt).toBe("manifest-leak");
    expect(runState([rec({})], { pipelineFailures: 3 }).halt).toBe("pipeline-failure");
  });

  it("halts when the organic target is reached", () => {
    const caps = Array.from({ length: 50 }, (_, i) => rec({ taskId: `c${i}`, phase: "capture", blockId: `b${i}`, costUsd: 0.05 }));
    const recalls = Array.from({ length: 30 }, (_, i) => rec({ taskId: `r${i}`, phase: "recall", blockId: `b${i}`, attributedResolved: true, costUsd: 0.05 }));
    expect(runState([...caps, ...recalls], {}).halt).toBe("organic-target");
  });

  it("flags the early health checkpoint after 10 capture + 10 recall", () => {
    const caps = Array.from({ length: 10 }, (_, i) => rec({ taskId: `c${i}`, phase: "capture", costUsd: 0.05 }));
    const recalls = Array.from({ length: 10 }, (_, i) => rec({ taskId: `r${i}`, phase: "recall", blockId: null, attributedResolved: false, costUsd: 0.05 }));
    const s = runState([...caps, ...recalls], {});
    expect(s.healthDue).toBe(true);
    expect(s.halt).toBeNull();
  });
});
