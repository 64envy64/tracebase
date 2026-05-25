import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { initConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";

/**
 * `tracebase usage sync --dry-run` is a thin pipeline on top of
 * `computeUsageMetrics`, which is already covered in tests/core. We
 * only need to verify the CLI-facing contract here:
 *   - non-TTY / dry-run produces one line per non-empty day bucket
 *   - empty days are skipped (no zero-sample spam)
 *   - without a cloud link the command bails with a clear message
 */

const CLI = join(__dirname, "..", "..", "dist", "cli.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-usage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!existsSync(CLI))("`tracebase usage sync`", () => {
  it("fails cleanly when the project has no cloud link", () => {
    initConfig(dir);
    const res = spawnSync("node", [CLI, "usage", "sync", "--path", dir, "--dry-run"], {
      encoding: "utf-8",
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/No cloud link/);
  });

  it("dry-run skips empty day buckets and reports activity for non-empty ones", async () => {
    const cfg = initConfig(dir, {
      cloud: {
        apiUrl: "https://tracebase.ink",
        workspaceId: "ws-1",
        workspaceSlug: "ws",
        installationId: "inst-primary",
        installationIds: { "claude-code": "inst-primary" },
      },
      install: { agents: ["claude-code"] },
    });

    // Seed one resolved run that lives inside today's UTC bucket.
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const inDay = dayStart + 1_000; // 1s into the day
    store.appendEvent({ ts: inDay, queryId: "q1", event: "retrieval", candidates: [{ blockId: "b1", score: 0.9 }], shadow: false });
    store.appendEvent({ ts: inDay + 10, queryId: "q1", event: "injection", blockId: "b1", score: 0.9 });
    store.appendEvent({ ts: inDay + 20, queryId: "q1", event: "agent_used", blockId: "b1", matchSignal: "jaccard", matchScore: 0.8 });
    store.appendEvent({ ts: inDay + 30, queryId: "q1", event: "outcome", resolved: true, control: false });
    store.close();

    const res = spawnSync("node", [CLI, "usage", "sync", "--path", dir, "--since", "7d", "--dry-run"], {
      encoding: "utf-8",
    });
    expect(res.status).toBe(0);
    // Today bucket fires; other six days are silent.
    expect(res.stdout).toMatch(/eligible=1 injected=1 helpful=1/);
    expect(res.stdout).toMatch(/Dry run 1 bucket/);
    // Phase 1C.1 contract: sync always declares the scope up-front
    // so users reading the output cannot miss that samples are
    // project-level, not per-adapter.
    expect(res.stdout).toMatch(/scope\s+workspace/);
    expect(res.stdout).toMatch(/Per-adapter attribution ships in Phase 2/);
  });

  it("refuses to push when there is no API key and not in dry-run", () => {
    initConfig(dir, {
      cloud: {
        apiUrl: "https://tracebase.ink",
        workspaceId: "ws-1",
        installationId: "inst",
        installationIds: { "claude-code": "inst" },
      },
      install: { agents: ["claude-code"] },
    });

    const res = spawnSync("node", [CLI, "usage", "sync", "--path", dir, "--since", "1d"], {
      encoding: "utf-8",
      env: { ...process.env, TRACEBASE_API_KEY: "" },
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/No API key/);
  });

  it("exits cleanly with a helpful message when memory.db has not been created yet", () => {
    // A fresh install has no memory.db until the first agent turn.
    // Sync should explain that instead of crashing with a SQLite open error.
    initConfig(dir, {
      cloud: {
        apiUrl: "https://tracebase.ink",
        workspaceId: "ws-1",
        installationId: "inst",
        installationIds: { "claude-code": "inst" },
      },
      install: { agents: ["claude-code"] },
    });
    const res = spawnSync("node", [CLI, "usage", "sync", "--path", dir, "--since", "2d", "--dry-run"], {
      encoding: "utf-8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no memory\.db yet/);
    // Never leaks the stored API key or bearer header.
    expect(res.stdout).not.toMatch(/Authorization|Bearer /);
  });

  // Guard: after commit, the config file should never accidentally store raw
  // API keys — they live in ~/.tracebase/credentials.json. This test asserts
  // our test setup did not slip a secret into the on-disk config.
  it("stored config does not leak secrets", () => {
    initConfig(dir, {
      cloud: {
        apiUrl: "https://tracebase.ink",
        workspaceId: "ws-1",
        installationId: "inst",
        installationIds: { "claude-code": "inst" },
      },
      install: { agents: ["claude-code"] },
    });
    const raw = readFileSync(join(dir, ".tracebase", "config.json"), "utf-8");
    expect(raw).not.toMatch(/apiKey/);
    // Also make sure the optional overwrite path works.
    writeFileSync(join(dir, ".tracebase", "touch"), "ok");
  });
});
