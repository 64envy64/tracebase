/**
 * `src/sdk/usage-payload.ts` — shared aggregate-sync payload
 * builder. Pins down the discriminated readiness check both
 * surfaces (CLI + coordinator) rely on, plus the per-window
 * payload assembly that goes through `sanitizeForCloud`.
 *
 * 0.5.5 §1 verification surface — these tests prove the
 * coordinator can call into the same machinery the CLI uses
 * without divergence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig, loadConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import {
  buildSendInputForWindow,
  buildWindowPayload,
  checkSyncReadiness,
  pushSampleToCloud,
} from "../../src/sdk/usage-payload.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let projectDir: string;
const ORIGINAL_API_KEY = process.env.TRACEBASE_API_KEY;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-usage-payload-"));
  delete process.env.TRACEBASE_API_KEY;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  if (ORIGINAL_API_KEY === undefined) delete process.env.TRACEBASE_API_KEY;
  else process.env.TRACEBASE_API_KEY = ORIGINAL_API_KEY;
});

function writeCloudConfig(opts: {
  workspaceId?: string;
  installationId?: string;
  apiUrl?: string;
}): void {
  const cfg = loadConfig(projectDir);
  const merged: Record<string, unknown> = {
    workspaceId: cfg.workspaceId,
    workspaceSalt: cfg.workspaceSalt,
    storagePath: cfg.storagePath,
    maxTraces: cfg.maxTraces,
    pruneThreshold: cfg.pruneThreshold,
    verbose: cfg.verbose,
  };
  if (opts.workspaceId) {
    merged.cloud = {
      workspaceId: opts.workspaceId,
      apiUrl: opts.apiUrl ?? "https://api.example.com",
      ...(opts.installationId ? { installationId: opts.installationId } : {}),
    };
  }
  writeFileSync(
    join(projectDir, ".tracebase", "config.json"),
    JSON.stringify(merged, null, 2),
  );
}

// ---------------------------------------------------------------------------
// checkSyncReadiness — discriminated reasons
// ---------------------------------------------------------------------------

describe("checkSyncReadiness — failure cases", () => {
  it("not-initialized when no .tracebase/ exists", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "tb-usage-noinit-"));
    try {
      const r = checkSyncReadiness(elsewhere);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not-initialized");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("no-cloud-link when initialised but no cloud.workspaceId", () => {
    initConfig(projectDir);
    const r = checkSyncReadiness(projectDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-cloud-link");
  });

  it("no-installation-id when cloud.workspaceId set but no installationId", () => {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1" });
    const r = checkSyncReadiness(projectDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-installation-id");
  });

  it("no-api-key when no env / stored / override key", () => {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1", installationId: "inst-1" });
    const r = checkSyncReadiness(projectDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-api-key");
  });

  it("allowMissingApiKey lets the readiness pass without a key (CLI dry-run)", () => {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1", installationId: "inst-1" });
    // Storage doesn't exist yet, so we expect no-storage instead.
    const r = checkSyncReadiness(projectDir, { allowMissingApiKey: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-storage");
  });

  it("no-storage when key is set but memory.db doesn't exist yet", () => {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1", installationId: "inst-1" });
    process.env.TRACEBASE_API_KEY = "tb-secret";
    const r = checkSyncReadiness(projectDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-storage");
  });
});

describe("checkSyncReadiness — success", () => {
  function setupReady(): void {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1", installationId: "inst-1" });
    process.env.TRACEBASE_API_KEY = "tb-secret";
    // Initialise the SQLite schema so empty-window aggregation
    // doesn't trip on a missing analytics_events table. Production
    // stores always have a schema once any runtime call has fired;
    // the test mirrors that.
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    new BlockStore(db).close();
  }

  it("returns the resolved readiness when everything is present", () => {
    setupReady();
    const r = checkSyncReadiness(projectDir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.readiness.installationId).toBe("inst-1");
      expect(r.readiness.workspaceId).toBe("ws-1");
      expect(r.readiness.apiKey).toBe("tb-secret");
      expect(r.readiness.apiUrl).toBe("https://api.example.com");
      expect(r.readiness.cliVersion).not.toBe("");
    }
  });

  it("apiKey override (CLI flag) wins over env", () => {
    setupReady();
    process.env.TRACEBASE_API_KEY = "env-key";
    const r = checkSyncReadiness(projectDir, { apiKeyOverride: "flag-key" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.readiness.apiKey).toBe("flag-key");
  });
});

// ---------------------------------------------------------------------------
// buildWindowPayload — empty window vs populated
// ---------------------------------------------------------------------------

describe("buildWindowPayload", () => {
  it("returns empty-window when no eligible runs exist in the window", () => {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1", installationId: "inst-1" });
    process.env.TRACEBASE_API_KEY = "tb-secret";
    const cfg = loadConfig(projectDir);
    const db0 = new Database(cfg.storagePath);
    new BlockStore(db0).close();

    const r = checkSyncReadiness(projectDir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const db = new Database(r.readiness.storagePath, { readonly: true });
    const store = new BlockStore(db, { skipMigrate: true });
    try {
      const out = buildWindowPayload(r.readiness, store, 0, Date.now());
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("empty-window");
    } finally {
      store.close();
    }
  });

  it("assembles a payload when retrieval events exist in the window", () => {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1", installationId: "inst-1" });
    process.env.TRACEBASE_API_KEY = "tb-secret";
    // Seed a retrieval event so observed.eligibleRuns > 0.
    const cfg = loadConfig(projectDir);
    const writeDb = new Database(cfg.storagePath);
    const writeStore = new BlockStore(writeDb);
    writeStore.appendEvent({
      ts: Date.now(),
      queryId: "q-1",
      event: "retrieval",
      candidates: [],
      shadow: false,
    });
    writeStore.close();

    const r = checkSyncReadiness(projectDir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const readDb = new Database(r.readiness.storagePath, { readonly: true });
    const readStore = new BlockStore(readDb, { skipMigrate: true });
    try {
      const out = buildWindowPayload(r.readiness, readStore, 0, Date.now() + 1000);
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.input.installationId).toBe("inst-1");
        expect(out.input.metrics.observed.eligibleRuns).toBeGreaterThan(0);
        // Window stamps are the literal ms params formatted as ISO.
        expect(out.input.windowStart).toMatch(/^1970/); // afterTs=0
      }
    } finally {
      readStore.close();
    }
  });
});

// ---------------------------------------------------------------------------
// buildSendInputForWindow — coordinator's hot path
// ---------------------------------------------------------------------------

describe("buildSendInputForWindow — coordinator path", () => {
  it("returns null silently when cloud is unlinked (no warnings, no throws)", async () => {
    initConfig(projectDir);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = await buildSendInputForWindow(projectDir, 0, Date.now());
    expect(out).toBeNull();
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("returns null when cloud is linked but the window is empty", async () => {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1", installationId: "inst-1" });
    process.env.TRACEBASE_API_KEY = "tb-secret";
    const cfg = loadConfig(projectDir);
    const db0 = new Database(cfg.storagePath);
    new BlockStore(db0).close();
    const out = await buildSendInputForWindow(projectDir, 0, Date.now());
    expect(out).toBeNull();
  });

  it("returns a SyncSendInput when cloud is linked + window has activity", async () => {
    initConfig(projectDir);
    writeCloudConfig({ workspaceId: "ws-1", installationId: "inst-1" });
    process.env.TRACEBASE_API_KEY = "tb-secret";
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    store.appendEvent({
      ts: Date.now(),
      queryId: "q-1",
      event: "retrieval",
      candidates: [],
      shadow: false,
    });
    store.close();

    const out = await buildSendInputForWindow(projectDir, 0, Date.now() + 1000);
    expect(out).not.toBeNull();
    if (out) {
      expect(out.installationId).toBe("inst-1");
      expect(out.apiKey).toBe("tb-secret");
      expect(out.metrics.observed.eligibleRuns).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// pushSampleToCloud — sanitiser before fetch
// ---------------------------------------------------------------------------

describe("pushSampleToCloud — privacy gate", () => {
  it("runs sanitizeForCloud BEFORE the fetch — forbidden fields never leave the machine", async () => {
    let captured: { url?: string; body?: unknown } = {};
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        captured = {
          url: String(url),
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        };
        return new Response(null, { status: 200 });
      });
    try {
      await pushSampleToCloud({
        apiUrl: "https://api.example.com",
        apiKey: "secret",
        installationId: "inst-1",
        windowStart: "2026-04-25T00:00:00.000Z",
        windowEnd: "2026-04-26T00:00:00.000Z",
        // Intentionally inject a forbidden field nested in metrics
        // to prove the sanitiser strips it before the wire.
        metrics: {
          scope: "workspace",
          window: { afterTs: 0, beforeTs: 0 },
          observed: {
            eligibleRuns: 1,
            recalledRuns: 1,
            injectedRuns: 1,
            usedRuns: 0,
            helpfulRuns: 0,
            resolvedRateWithMemory: null,
          },
          estimated: {
            tokensSaved: { value: 0, sampleSize: 0, formula: "noop" },
            latencySavedMs: { value: 0, sampleSize: 0, formula: "noop" },
          },
          integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
          // @ts-expect-error — intentionally forbidden field for assertion
          rawObservations: [{ argSummary: "Read(secret.ts)", argKey: "abc" }],
        },
        cliVersion: "test",
      });
      const sent = JSON.stringify(captured.body);
      expect(sent).not.toContain("rawObservations");
      expect(sent).not.toContain("argSummary");
      expect(sent).not.toContain("argKey");
      expect(sent).not.toContain("secret.ts");
      expect(captured.url).toBe("https://api.example.com/api/control-plane/usage-samples");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("network failure resolves to ok:false with a reason; never throws", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("simulated network failure");
    });
    try {
      const result = await pushSampleToCloud({
        apiUrl: "https://api.example.com",
        apiKey: "k",
        installationId: "i",
        windowStart: "2026-04-25T00:00:00.000Z",
        windowEnd: "2026-04-26T00:00:00.000Z",
        metrics: {
          scope: "workspace",
          window: { afterTs: 0, beforeTs: 0 },
          observed: {
            eligibleRuns: 1,
            recalledRuns: 0,
            injectedRuns: 0,
            usedRuns: 0,
            helpfulRuns: 0,
            resolvedRateWithMemory: null,
          },
          estimated: {
            tokensSaved: { value: 0, sampleSize: 0, formula: "noop" },
            latencySavedMs: { value: 0, sampleSize: 0, formula: "noop" },
          },
          integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
        },
        cliVersion: "test",
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
      expect(result.reason).toMatch(/simulated network failure/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
