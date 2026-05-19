/**
 * Cascade write-helper tests — May-2026 B1.4.
 *
 * These tests pin three contracts:
 *   1. enableCascade / disableCascade / setCascadeRate / setCascadeKind
 *      round-trip through .tracebase/config.json.
 *   2. They're idempotent and field-preserving (rate change doesn't
 *      reset mmrLambda; disable preserves salt; etc.).
 *   3. They coexist with the holdout experiment under the same
 *      `experiment.*` namespace — writing one MUST NOT wipe the other.
 *      Pre-B1.4 writeExperimentField replaced the whole object,
 *      which silently dropped sibling fields. The merge fix is the
 *      most load-bearing change here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CASCADE_RATE,
  disableCascade,
  disableHoldoutExperiment,
  enableCascade,
  enableHoldoutExperiment,
  initConfig,
  readCascadeConfig,
  readHoldoutConfig,
  setCascadeKind,
  setCascadeRate,
} from "../../src/core/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-cascade-write-"));
  initConfig(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("enableCascade", () => {
  it("writes a fresh cascade config with defaults", () => {
    const cfg = enableCascade(dir);
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.rollout.rate).toBe(DEFAULT_CASCADE_RATE);
    expect(cfg!.reranker.kind).toBe("noop");
    expect(cfg!.rollout.salt).toMatch(/^[0-9a-f]+$/);
    expect(cfg!.createdAt).toBeTruthy();
    expect(cfg!.updatedAt).toBe(cfg!.createdAt);

    // Round-trips through the file
    const reloaded = readCascadeConfig(dir);
    expect(reloaded).toEqual(cfg);
  });

  it("preserves salt + createdAt across disable/enable cycles", () => {
    const first = enableCascade(dir);
    const off = disableCascade(dir);
    expect(off?.rollout.salt).toBe(first!.rollout.salt);

    const second = enableCascade(dir, { rate: 0.5 });
    expect(second!.rollout.salt).toBe(first!.rollout.salt);
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.rollout.rate).toBe(0.5);
    expect(second!.enabled).toBe(true);
  });

  it("rejects out-of-band rates", () => {
    expect(() => enableCascade(dir, { rate: 0 })).toThrow(/rate must be in/);
    expect(() => enableCascade(dir, { rate: -0.1 })).toThrow(/rate must be in/);
    expect(() => enableCascade(dir, { rate: 1.5 })).toThrow(/rate must be in/);
    expect(() => enableCascade(dir, { rate: Number.NaN })).toThrow(/rate must be in/);
  });

  it("returns null when project is not initialised", () => {
    const empty = mkdtempSync(join(tmpdir(), "tb-empty-"));
    try {
      expect(enableCascade(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("accepts kind + endpoint + apiKey + model + tunables", () => {
    const cfg = enableCascade(dir, {
      rate: 0.1,
      kind: "cloud",
      endpoint: "https://example.test/rerank",
      apiKey: "secret",
      model: "test-model",
      timeoutMs: 500,
      mmrLambda: 0.5,
      fetchMultiplier: 6,
    });
    expect(cfg!.reranker.kind).toBe("cloud");
    expect(cfg!.reranker.endpoint).toBe("https://example.test/rerank");
    expect(cfg!.reranker.apiKey).toBe("secret");
    expect(cfg!.reranker.model).toBe("test-model");
    expect(cfg!.timeoutMs).toBe(500);
    expect(cfg!.mmrLambda).toBe(0.5);
    expect(cfg!.fetchMultiplier).toBe(6);
  });

  it("preserves tunables across rate-only enable calls", () => {
    enableCascade(dir, { rate: 0.1, mmrLambda: 0.8, timeoutMs: 500 });
    const second = enableCascade(dir, { rate: 0.25 });
    expect(second!.rollout.rate).toBe(0.25);
    expect(second!.mmrLambda).toBe(0.8);
    expect(second!.timeoutMs).toBe(500);
  });
});

describe("disableCascade", () => {
  it("flips enabled to false, preserves everything else", () => {
    enableCascade(dir, { rate: 0.3, kind: "minilm", mmrLambda: 0.6 });
    const off = disableCascade(dir);
    expect(off!.enabled).toBe(false);
    expect(off!.rollout.rate).toBe(0.3);
    expect(off!.reranker.kind).toBe("minilm");
    expect(off!.mmrLambda).toBe(0.6);
  });

  it("returns null when cascade was never configured", () => {
    expect(disableCascade(dir)).toBeNull();
  });

  it("returns null on uninitialised project", () => {
    const empty = mkdtempSync(join(tmpdir(), "tb-empty-"));
    try {
      expect(disableCascade(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("setCascadeRate", () => {
  it("changes only the rate", () => {
    enableCascade(dir, { rate: 0.1, kind: "noop", mmrLambda: 0.7 });
    const updated = setCascadeRate(dir, 0.42);
    expect(updated!.rollout.rate).toBe(0.42);
    expect(updated!.reranker.kind).toBe("noop");
    expect(updated!.mmrLambda).toBe(0.7);
  });

  it("rejects out-of-band rates", () => {
    enableCascade(dir);
    expect(() => setCascadeRate(dir, -0.1)).toThrow(/rate must be in/);
    expect(() => setCascadeRate(dir, 1.5)).toThrow(/rate must be in/);
    expect(() => setCascadeRate(dir, Number.NaN)).toThrow(/rate must be in/);
  });

  it("accepts 0 (effective off, without flipping the master switch)", () => {
    enableCascade(dir);
    const off = setCascadeRate(dir, 0);
    expect(off!.rollout.rate).toBe(0);
    expect(off!.enabled).toBe(true); // master switch unchanged
  });

  it("returns null when cascade was never enabled", () => {
    expect(setCascadeRate(dir, 0.5)).toBeNull();
  });
});

describe("setCascadeKind", () => {
  it("changes only the kind", () => {
    enableCascade(dir, { rate: 0.1, kind: "noop" });
    const updated = setCascadeKind(dir, "minilm");
    expect(updated!.reranker.kind).toBe("minilm");
    expect(updated!.rollout.rate).toBe(0.1);
  });

  it("returns null when cascade was never enabled", () => {
    expect(setCascadeKind(dir, "minilm")).toBeNull();
  });
});

describe("coexistence with holdout (B1.4 merge fix)", () => {
  // PRE-B1.4 BUG: writeExperimentField overwrote raw.experiment
  // entirely. Writing cascade silently wiped holdout — these tests
  // pin the contract that both knobs can be configured side by side.

  it("enabling cascade does NOT wipe an existing holdout config", () => {
    enableHoldoutExperiment(dir, { rate: 0.05 });
    const holdoutBefore = readHoldoutConfig(dir);
    expect(holdoutBefore?.enabled).toBe(true);

    enableCascade(dir, { rate: 0.1 });
    const holdoutAfter = readHoldoutConfig(dir);
    expect(holdoutAfter?.enabled).toBe(true);
    expect(holdoutAfter?.rate).toBe(0.05);
    expect(holdoutAfter?.salt).toBe(holdoutBefore?.salt);
  });

  it("enabling holdout does NOT wipe an existing cascade config", () => {
    enableCascade(dir, { rate: 0.2, kind: "minilm", mmrLambda: 0.5 });
    const cascadeBefore = readCascadeConfig(dir);

    enableHoldoutExperiment(dir, { rate: 0.05 });
    const cascadeAfter = readCascadeConfig(dir);
    expect(cascadeAfter?.enabled).toBe(true);
    expect(cascadeAfter?.rollout.rate).toBe(0.2);
    expect(cascadeAfter?.reranker.kind).toBe("minilm");
    expect(cascadeAfter?.mmrLambda).toBe(0.5);
    expect(cascadeAfter?.rollout.salt).toBe(cascadeBefore?.rollout.salt);
  });

  it("disabling one knob preserves the other", () => {
    enableHoldoutExperiment(dir, { rate: 0.05 });
    enableCascade(dir, { rate: 0.1 });
    disableHoldoutExperiment(dir);

    // Cascade still on, holdout disabled.
    const cascade = readCascadeConfig(dir);
    const holdout = readHoldoutConfig(dir);
    expect(cascade?.enabled).toBe(true);
    expect(holdout?.enabled).toBe(false);
    // And the salts on both haven't rotated.
    expect(cascade?.rollout.salt).toBeTruthy();
    expect(holdout?.salt).toBeTruthy();
  });

  it("the on-disk JSON has both objects under experiment", () => {
    enableHoldoutExperiment(dir, { rate: 0.05 });
    enableCascade(dir, { rate: 0.1, kind: "minilm" });

    const raw = JSON.parse(
      readFileSync(join(dir, ".tracebase", "config.json"), "utf8"),
    ) as { experiment?: Record<string, unknown> };
    expect(raw.experiment).toBeDefined();
    expect(raw.experiment!.holdout).toBeDefined();
    expect(raw.experiment!.cascade).toBeDefined();
  });
});
