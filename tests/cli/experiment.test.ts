import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initConfig } from "../../src/core/config.js";

const CLI = join(__dirname, "..", "..", "dist", "cli.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-cli-experiment-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf-8" });
}

function readHoldoutJson(): {
  experiment: { holdout: Record<string, unknown> | null };
} {
  const res = run(["experiment", "status", "--path", dir, "--json"]);
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout) as {
    experiment: { holdout: Record<string, unknown> | null };
  };
}

describe("`tracebase experiment …` CLI", () => {
  it("refuses every subcommand cleanly when the project is not initialized", () => {
    for (const sub of ["enable", "disable", "status"]) {
      const res = run(["experiment", sub, "--path", dir]);
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}${res.stderr}`).toMatch(/Not initialized/);
    }
  });

  it("status on an initialized project without experiment shows 'not configured'", () => {
    initConfig(dir);
    const res = run(["experiment", "status", "--path", dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/not configured/);
  });

  it("enable generates a salt, persists it, and status reflects it", () => {
    initConfig(dir);
    const enableRes = run(["experiment", "enable", "--path", dir]);
    expect(enableRes.status).toBe(0);
    expect(enableRes.stdout).toMatch(/Holdout experiment enabled/);
    expect(enableRes.stdout).toMatch(/rate=10%/);
    const after = readHoldoutJson();
    expect(after.experiment.holdout?.enabled).toBe(true);
    expect(typeof after.experiment.holdout?.salt).toBe("string");
    expect((after.experiment.holdout?.salt as string).length).toBeGreaterThan(0);
  });

  it("enable --rate validates the range", () => {
    initConfig(dir);
    const bad = run(["experiment", "enable", "--path", dir, "--rate", "1.5"]);
    expect(bad.status).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/must be in/);
  });

  it("enable → enable is idempotent and preserves salt + createdAt", () => {
    initConfig(dir);
    run(["experiment", "enable", "--path", dir, "--rate", "0.1"]);
    const a = readHoldoutJson().experiment.holdout!;
    run(["experiment", "enable", "--path", dir, "--rate", "0.25"]);
    const b = readHoldoutJson().experiment.holdout!;
    expect(b.salt).toBe(a.salt);
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.rate).toBe(0.25);
    expect(b.enabled).toBe(true);
  });

  it("disable preserves salt + rate for future re-enables", () => {
    initConfig(dir);
    run(["experiment", "enable", "--path", dir, "--rate", "0.2"]);
    const enabled = readHoldoutJson().experiment.holdout!;
    const disRes = run(["experiment", "disable", "--path", dir]);
    expect(disRes.status).toBe(0);
    expect(disRes.stdout).toMatch(/Holdout experiment disabled/);
    const disabled = readHoldoutJson().experiment.holdout!;
    expect(disabled.enabled).toBe(false);
    expect(disabled.salt).toBe(enabled.salt);
    expect(disabled.rate).toBe(enabled.rate);
    expect(disabled.createdAt).toBe(enabled.createdAt);
  });

  it("disable on a never-configured project prints a soft no-op message", () => {
    initConfig(dir);
    const res = run(["experiment", "disable", "--path", dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/No holdout experiment configured/);
  });

  it("enable → disable → enable preserves the original salt", () => {
    initConfig(dir);
    run(["experiment", "enable", "--path", dir]);
    const first = readHoldoutJson().experiment.holdout!;
    run(["experiment", "disable", "--path", dir]);
    run(["experiment", "enable", "--path", dir]);
    const third = readHoldoutJson().experiment.holdout!;
    expect(third.salt).toBe(first.salt);
    expect(third.createdAt).toBe(first.createdAt);
    expect(third.enabled).toBe(true);
  });

  it("preserves unrelated config fields (workspaceId, install) across enable + disable", () => {
    initConfig(dir, {
      workspaceId: "ws-stable-cli",
      install: { agents: ["claude-code"] },
    });
    run(["experiment", "enable", "--path", dir]);
    run(["experiment", "disable", "--path", dir]);
    run(["experiment", "enable", "--path", dir]);
    const raw = JSON.parse(
      readFileSync(join(dir, ".tracebase", "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(raw.workspaceId).toBe("ws-stable-cli");
    expect((raw.install as Record<string, unknown>).agents).toEqual(["claude-code"]);
    expect(raw.experiment).toBeDefined();
  });

  it("status --json emits a machine-readable payload (null when unconfigured)", () => {
    initConfig(dir);
    const res = run(["experiment", "status", "--path", dir, "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      experiment: { holdout: unknown };
    };
    expect(parsed.experiment.holdout).toBeNull();
  });

  it("never logs the full raw salt in the human-readable output", () => {
    initConfig(dir);
    run(["experiment", "enable", "--path", dir]);
    const { experiment } = readHoldoutJson();
    const salt = experiment.holdout?.salt as string;
    const statusRes = run(["experiment", "status", "--path", dir]);
    // Status prints a truncated form like `salt=<prefix>…<suffix>`.
    expect(statusRes.stdout).not.toContain(salt);
  });

  // Guard for stray garbage: writing a malformed experiment block on
  // disk must not break `status` — it should simply report
  // 'not configured' so a user can recover without hand-editing JSON.
  it("tolerates a malformed experiment block on disk", () => {
    initConfig(dir);
    const file = join(dir, ".tracebase", "config.json");
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    raw.experiment = { holdout: { enabled: "yes" } };
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const res = run(["experiment", "status", "--path", dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/not configured/);
  });
});
