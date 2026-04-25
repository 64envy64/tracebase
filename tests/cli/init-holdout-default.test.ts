/**
 * `applyHoldoutDefault` — 0.6.0 init-time impact-measurement
 * default policy (PLAN-0.6.0 §1).
 *
 * Truth table:
 *   1. fresh init, no opt-out      → enabled-fresh @ 0.1
 *   2. fresh init, --no-holdout    → disabled-by-flag
 *   3. fresh init, env=off         → disabled-by-flag
 *   4. fresh init, --holdout-rate  → enabled-fresh @ override
 *   5. existing enabled config     → preserved-existing-enabled (rate kept)
 *   6. existing disabled config    → preserved-existing-disabled (kept off)
 *   7. existing salt               → never rotated on re-run
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initConfig,
  enableHoldoutExperiment,
  disableHoldoutExperiment,
  readHoldoutConfig,
} from "../../src/core/config.js";
import { applyHoldoutDefault } from "../../src/cli/commands/init.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-init-holdout-"));
  initConfig(projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("applyHoldoutDefault — fresh init", () => {
  it("enables holdout @ 0.1 when nothing exists and no opt-out is set", () => {
    const result = applyHoldoutDefault(projectDir, {});
    expect(result.state).toBe("enabled-fresh");
    expect(result.rate).toBe(0.1);
    expect(result.message).toMatch(/Impact measurement enabled/);
    expect(result.message).toMatch(/10%/);

    const onDisk = readHoldoutConfig(projectDir)!;
    expect(onDisk.enabled).toBe(true);
    expect(onDisk.rate).toBe(0.1);
    expect(typeof onDisk.salt).toBe("string");
    expect(onDisk.salt.length).toBeGreaterThan(0);
  });

  it("--holdout-rate <rate> writes the override", () => {
    const result = applyHoldoutDefault(projectDir, { holdoutRateOverride: 0.25 });
    expect(result.state).toBe("enabled-fresh");
    expect(result.rate).toBe(0.25);
    expect(result.message).toMatch(/25%/);

    const onDisk = readHoldoutConfig(projectDir)!;
    expect(onDisk.rate).toBe(0.25);
  });

  it("--no-holdout skips enabling and surfaces the enable hint", () => {
    const result = applyHoldoutDefault(projectDir, { noHoldout: true });
    expect(result.state).toBe("disabled-by-flag");
    expect(result.rate).toBeUndefined();
    expect(result.message).toMatch(/Impact measurement: disabled/);
    expect(result.message).toMatch(/tracebase experiment enable/);

    expect(readHoldoutConfig(projectDir)).toBeNull();
  });

  it("TRACEBASE_HOLDOUT=off env skips enabling", () => {
    const result = applyHoldoutDefault(projectDir, { env: "off" });
    expect(result.state).toBe("disabled-by-flag");
    expect(readHoldoutConfig(projectDir)).toBeNull();
  });

  it("TRACEBASE_HOLDOUT=OFF (case-insensitive) skips enabling", () => {
    const result = applyHoldoutDefault(projectDir, { env: "OFF" });
    expect(result.state).toBe("disabled-by-flag");
  });

  it("env values other than 'off' fall through to default-enable", () => {
    const result = applyHoldoutDefault(projectDir, { env: "yes" });
    expect(result.state).toBe("enabled-fresh");
  });
});

describe("applyHoldoutDefault — existing config preserved", () => {
  it("existing enabled config is left exactly alone (rate + salt)", () => {
    enableHoldoutExperiment(projectDir, { rate: 0.4 });
    const before = readHoldoutConfig(projectDir)!;

    const result = applyHoldoutDefault(projectDir, {});
    expect(result.state).toBe("preserved-existing-enabled");
    expect(result.rate).toBe(0.4);

    const after = readHoldoutConfig(projectDir)!;
    expect(after.rate).toBe(0.4);
    expect(after.salt).toBe(before.salt);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.enabled).toBe(true);
  });

  it("existing disabled config stays disabled — re-running init does NOT re-enable", () => {
    enableHoldoutExperiment(projectDir, { rate: 0.1 });
    disableHoldoutExperiment(projectDir);
    const beforeDisable = readHoldoutConfig(projectDir)!;
    expect(beforeDisable.enabled).toBe(false);

    const result = applyHoldoutDefault(projectDir, {});
    expect(result.state).toBe("preserved-existing-disabled");

    const after = readHoldoutConfig(projectDir)!;
    expect(after.enabled).toBe(false);
    expect(after.salt).toBe(beforeDisable.salt);
  });

  it("existing config + --no-holdout still preserves existing (existing wins)", () => {
    enableHoldoutExperiment(projectDir, { rate: 0.2 });
    const before = readHoldoutConfig(projectDir)!;

    // The user might pass --no-holdout out of habit; existing
    // config should win to avoid a silent salt rotation.
    const result = applyHoldoutDefault(projectDir, { noHoldout: true });
    expect(result.state).toBe("preserved-existing-enabled");
    expect(result.rate).toBe(0.2);

    const after = readHoldoutConfig(projectDir)!;
    expect(after.salt).toBe(before.salt);
  });
});
