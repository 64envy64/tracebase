import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOLDOUT_RATE,
  disableHoldoutExperiment,
  enableHoldoutExperiment,
  initConfig,
  readHoldoutConfig,
} from "../../src/core/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-experiment-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readRawConfig(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dir, ".tracebase", "config.json"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("readHoldoutConfig", () => {
  it("returns null before `tracebase init` has ever run", () => {
    expect(readHoldoutConfig(dir)).toBeNull();
  });

  it("returns null when the project is initialized but no experiment configured", () => {
    initConfig(dir);
    expect(readHoldoutConfig(dir)).toBeNull();
  });

  it("returns the stored config once enabled", () => {
    initConfig(dir);
    enableHoldoutExperiment(dir, {
      rate: 0.2,
      saltFactory: () => "fixed-salt",
      now: () => new Date("2026-04-22T00:00:00.000Z"),
    });
    expect(readHoldoutConfig(dir)).toEqual({
      enabled: true,
      rate: 0.2,
      salt: "fixed-salt",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    });
  });
});

describe("enableHoldoutExperiment", () => {
  it("refuses to write when no config exists yet (init must run first)", () => {
    // No initConfig call.
    const result = enableHoldoutExperiment(dir, { rate: 0.1 });
    expect(result).toBeNull();
  });

  it("generates a fresh salt on first-ever enable, uses default rate if none passed", () => {
    initConfig(dir);
    const result = enableHoldoutExperiment(dir, {
      saltFactory: () => "initial-salt",
      now: () => new Date("2026-04-22T01:00:00.000Z"),
    });
    expect(result?.enabled).toBe(true);
    expect(result?.rate).toBe(DEFAULT_HOLDOUT_RATE);
    expect(result?.salt).toBe("initial-salt");
    expect(result?.createdAt).toBe("2026-04-22T01:00:00.000Z");
  });

  it("rejects non-finite / out-of-range rates", () => {
    initConfig(dir);
    expect(() => enableHoldoutExperiment(dir, { rate: 0 })).toThrow(/must be in/);
    expect(() => enableHoldoutExperiment(dir, { rate: -0.1 })).toThrow();
    expect(() => enableHoldoutExperiment(dir, { rate: 1.5 })).toThrow();
    expect(() => enableHoldoutExperiment(dir, { rate: Number.NaN })).toThrow();
  });

  it("preserves salt + createdAt across re-enables; only rate + updatedAt refresh", () => {
    initConfig(dir);
    enableHoldoutExperiment(dir, {
      saltFactory: () => "first-salt",
      now: () => new Date("2026-04-22T01:00:00.000Z"),
      rate: 0.1,
    });
    const second = enableHoldoutExperiment(dir, {
      // A second saltFactory must NOT be invoked because the salt
      // already exists — we pass a tripwire that would fail the
      // test if it were called.
      saltFactory: () => {
        throw new Error("salt factory must not fire on re-enable");
      },
      now: () => new Date("2026-04-23T05:00:00.000Z"),
      rate: 0.25,
    });
    expect(second?.salt).toBe("first-salt");
    expect(second?.createdAt).toBe("2026-04-22T01:00:00.000Z");
    expect(second?.rate).toBe(0.25);
    expect(second?.updatedAt).toBe("2026-04-23T05:00:00.000Z");
    expect(second?.enabled).toBe(true);
  });

  it("is idempotent: re-enable with the same rate yields the same persisted rate + salt", () => {
    initConfig(dir);
    const first = enableHoldoutExperiment(dir, {
      saltFactory: () => "idempotent-salt",
      now: () => new Date("2026-04-22T01:00:00.000Z"),
      rate: 0.15,
    });
    const second = enableHoldoutExperiment(dir, {
      saltFactory: () => {
        throw new Error("salt factory must not fire");
      },
      now: () => new Date("2026-04-22T02:00:00.000Z"),
      rate: 0.15,
    });
    expect(first?.salt).toBe(second?.salt);
    expect(first?.rate).toBe(second?.rate);
    expect(first?.createdAt).toBe(second?.createdAt);
    // updatedAt is allowed (and expected) to advance.
    expect(second?.updatedAt).not.toBe(first?.updatedAt);
  });

  it("preserves every other config field (workspaceId, install, cloud) on enable", () => {
    initConfig(dir, {
      workspaceId: "ws-stable",
      install: { agents: ["claude-code", "cursor"] },
      cloud: { apiUrl: "https://tracebase.ink", workspaceId: "cloud-ws-1" },
    });
    enableHoldoutExperiment(dir, {
      rate: 0.1,
      saltFactory: () => "salt",
      now: () => new Date("2026-04-22T01:00:00.000Z"),
    });
    const raw = readRawConfig();
    expect(raw.workspaceId).toBe("ws-stable");
    expect((raw.install as Record<string, unknown>).agents).toEqual(["claude-code", "cursor"]);
    expect((raw.cloud as Record<string, unknown>).workspaceId).toBe("cloud-ws-1");
    expect(raw.experiment).toBeDefined();
  });
});

describe("disableHoldoutExperiment", () => {
  it("is a no-op (returns null) when no experiment has ever been configured", () => {
    initConfig(dir);
    const result = disableHoldoutExperiment(dir);
    expect(result).toBeNull();
    // The write-side must also be a no-op — no experiment field appears.
    const raw = readRawConfig();
    expect(raw.experiment).toBeUndefined();
  });

  it("flips enabled → false while preserving salt, rate, createdAt", () => {
    initConfig(dir);
    enableHoldoutExperiment(dir, {
      saltFactory: () => "kept-salt",
      now: () => new Date("2026-04-22T01:00:00.000Z"),
      rate: 0.3,
    });
    const disabled = disableHoldoutExperiment(dir, {
      now: () => new Date("2026-04-22T02:00:00.000Z"),
    });
    expect(disabled).toEqual({
      enabled: false,
      rate: 0.3,
      salt: "kept-salt",
      createdAt: "2026-04-22T01:00:00.000Z",
      updatedAt: "2026-04-22T02:00:00.000Z",
    });
  });

  it("is idempotent: double-disable only updates updatedAt", () => {
    initConfig(dir);
    enableHoldoutExperiment(dir, {
      saltFactory: () => "salt",
      now: () => new Date("2026-04-22T01:00:00.000Z"),
    });
    const first = disableHoldoutExperiment(dir, {
      now: () => new Date("2026-04-22T02:00:00.000Z"),
    });
    const second = disableHoldoutExperiment(dir, {
      now: () => new Date("2026-04-22T03:00:00.000Z"),
    });
    expect(second?.enabled).toBe(false);
    expect(second?.salt).toBe(first?.salt);
    expect(second?.rate).toBe(first?.rate);
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  it("round-trip: enable → disable → enable preserves the original salt and createdAt", () => {
    initConfig(dir);
    const first = enableHoldoutExperiment(dir, {
      saltFactory: () => "forever-salt",
      now: () => new Date("2026-04-22T01:00:00.000Z"),
      rate: 0.1,
    });
    disableHoldoutExperiment(dir, { now: () => new Date("2026-04-22T02:00:00.000Z") });
    const third = enableHoldoutExperiment(dir, {
      saltFactory: () => {
        throw new Error("salt factory must not fire when disabled config is present");
      },
      now: () => new Date("2026-04-22T03:00:00.000Z"),
      rate: 0.2,
    });
    expect(third?.salt).toBe(first?.salt);
    expect(third?.createdAt).toBe(first?.createdAt);
    expect(third?.enabled).toBe(true);
    expect(third?.rate).toBe(0.2);
  });
});

describe("initConfig — experiment serialization", () => {
  it("round-trips an experiment passed via overrides", () => {
    initConfig(dir, {
      experiment: {
        holdout: {
          enabled: true,
          rate: 0.2,
          salt: "seed-salt",
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
      },
    });
    expect(readHoldoutConfig(dir)?.salt).toBe("seed-salt");
  });
});
