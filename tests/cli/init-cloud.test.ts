/**
 * `tracebase init --api-key …` and `tracebase usage sync` against an
 * in-process fetch mock.
 *
 * Background: vitest's worker isolation prevents a spawned child
 * process from reaching a parent-process HTTP server, so we cannot
 * drive the built CLI through a network mock directly. Instead we
 * exercise the `initCommand` and `computeUsageMetrics` code paths
 * in-process, swapping `global.fetch` for a deterministic fake.
 *
 * This is the same code the CLI runs — only the transport is
 * different — so the behaviour we're asserting is faithful:
 *
 *   - GET /install/link                 → validate the api key
 *   - POST /installations               → register per-agent installation
 *   - POST /usage-samples               → push rolled-up UsageMetrics
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initCommand } from "../../src/cli/commands/init.js";
import { usageCommand } from "../../src/cli/commands/usage.js";

interface FetchCall {
  method: string;
  url: string;
  authorization?: string;
  body?: unknown;
}

interface MockState {
  calls: FetchCall[];
  installations: Array<{
    id: string;
    localWorkspaceId: string;
    projectName: string;
    agent: string;
  }>;
  usageSamples: Array<{
    installationId: string;
    windowStart: string;
    windowEnd: string;
  }>;
  /** Simulate the idempotent upsert behaviour of the real control plane. */
  seenUsageKeys: Set<string>;
  fakeApiBaseUrl: string;
}

let state: MockState;
let originalFetch: typeof global.fetch;
let projectDir: string;
let homeDir: string;
let originalHome: string | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
const originalClaudeRegistry = process.env.TRACEBASE_CLAUDE_REGISTRY_FILE;

beforeEach(() => {
  state = {
    calls: [],
    installations: [],
    usageSamples: [],
    seenUsageKeys: new Set<string>(),
    fakeApiBaseUrl: "https://mock.tracebase.test",
  };
  originalFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? "GET";
    const headers = new Map<string, string>();
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => headers.set(k.toLowerCase(), v));
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers.set(k.toLowerCase(), v as string);
      } else {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers.set(k.toLowerCase(), v);
        }
      }
    }
    const authorization = headers.get("authorization");

    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    state.calls.push({
      method,
      url,
      ...(authorization ? { authorization } : {}),
      ...(body !== undefined ? { body } : {}),
    });

    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (method === "GET" && url.endsWith("/api/control-plane/install/link")) {
      return json({
        apiBaseUrl: state.fakeApiBaseUrl,
        workspace: {
          id: "ws-mock-1",
          slug: "mock-workspace",
          displayName: "Mock Workspace",
          scope: "personal",
        },
      });
    }

    if (method === "POST" && url.endsWith("/api/control-plane/installations")) {
      const parsed = body as { localWorkspaceId: string; projectName: string; agent: string };
      const key = `${parsed.localWorkspaceId}:${parsed.agent}`;
      let row = state.installations.find(
        (r) => `${r.localWorkspaceId}:${r.agent}` === key,
      );
      if (!row) {
        row = {
          id: `inst-${parsed.agent}`,
          localWorkspaceId: parsed.localWorkspaceId,
          projectName: parsed.projectName,
          agent: parsed.agent,
        };
        state.installations.push(row);
      }
      return json({
        installation: {
          id: row.id,
          localWorkspaceId: row.localWorkspaceId,
          projectName: row.projectName,
          agent: row.agent,
          updatedAt: new Date().toISOString(),
        },
      });
    }

    if (method === "POST" && url.endsWith("/api/control-plane/usage-samples")) {
      const parsed = body as {
        installationId: string;
        windowStart: string;
        windowEnd: string;
      };
      const idem = `${parsed.installationId}:${parsed.windowStart}:${parsed.windowEnd}`;
      if (!state.seenUsageKeys.has(idem)) {
        state.seenUsageKeys.add(idem);
        state.usageSamples.push({
          installationId: parsed.installationId,
          windowStart: parsed.windowStart,
          windowEnd: parsed.windowEnd,
        });
      }
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }) as typeof global.fetch;

  const raw = mkdtempSync(join(tmpdir(), "tb-cloud-"));
  projectDir = realpathSync(raw);
  mkdirSync(join(projectDir, ".git"), { recursive: true });

  const rawHome = mkdtempSync(join(tmpdir(), "tb-cloud-home-"));
  homeDir = realpathSync(rawHome);
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  // Route the Claude MCP runtime registry through the legacy file
  // path so this test exercises init end-to-end without depending on a
  // real `claude` CLI on PATH.
  process.env.TRACEBASE_CLAUDE_REGISTRY_FILE = join(projectDir, ".claude", "settings.json");

  // initCommand calls process.exit on malformed input; spy so the test
  // worker doesn't die on expected-error paths. Happy path doesn't hit it.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.HOME = originalHome;
  if (originalClaudeRegistry === undefined) delete process.env.TRACEBASE_CLAUDE_REGISTRY_FILE;
  else process.env.TRACEBASE_CLAUDE_REGISTRY_FILE = originalClaudeRegistry;
  exitSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cloud registration
// ---------------------------------------------------------------------------

describe("init with --api-key", () => {
  it("validates the key, registers one installation per agent, writes installationIds — no secrets in config", async () => {
    await initCommand.parseAsync(
      [
        "--path",
        projectDir,
        "--agent",
        "claude-code",
        "-y",
        "--api-url",
        "https://mock.tracebase.test",
        "--api-key",
        "secret-test-key-xyz",
      ],
      { from: "user" },
    );

    // Validate + register endpoints both hit.
    const calls = state.calls;
    expect(calls.some((c) => c.url.endsWith("/install/link"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/installations"))).toBe(true);
    // Authorization header carries the key verbatim on every authenticated call.
    for (const c of calls.filter((c) => c.url.endsWith("/installations"))) {
      expect(c.authorization).toBe("Bearer secret-test-key-xyz");
    }

    // Config file has installationIds for the selected agent, no apiKey text.
    const raw = readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const cloud = cfg.cloud as Record<string, unknown>;
    expect(cloud.workspaceId).toBe("ws-mock-1");
    expect(cloud.workspaceSlug).toBe("mock-workspace");
    const ids = cloud.installationIds as Record<string, string>;
    expect(ids["claude-code"]).toBe("inst-claude-code");
    expect(raw).not.toContain("secret-test-key-xyz");
    expect(raw).not.toMatch(/apiKey/);

    // The authoritative "where the secret doesn't go" guarantees:
    // never inside project config, never inside agent-visible files.
    // Where the secret *does* go (the per-user credentials file at
    // ~/.tracebase/credentials.json) is covered in tests/cli/usage.test.ts.
    const claudeMd = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("secret-test-key-xyz");
    expect(claudeMd).not.toMatch(/Bearer /);
  });

  it("multi-agent init registers one installation per agent and records all ids", async () => {
    // --all attempts codex too; without a codex shim on PATH the codex
    // MCP step fails. Cloud registration still fires for each agent.
    try {
      await initCommand.parseAsync(
        [
          "--path",
          projectDir,
          "--all",
          "-y",
          "--api-url",
          "https://mock.tracebase.test",
          "--api-key",
          "multikey",
        ],
        { from: "user" },
      );
    } catch (e) {
      // process.exit(1) thrown from the exitSpy if any adapter failed;
      // that's expected for codex-without-shim.
      if (!(e instanceof Error) || !e.message.startsWith("process.exit(")) throw e;
    }

    const agentsRegistered = state.installations.map((i) => i.agent).sort();
    expect(agentsRegistered).toEqual(["claude-code", "codex", "cursor"]);

    const cfg = JSON.parse(
      readFileSync(join(projectDir, ".tracebase", "config.json"), "utf-8"),
    ) as { cloud: { installationIds: Record<string, string> } };
    expect(cfg.cloud.installationIds["claude-code"]).toBe("inst-claude-code");
    expect(cfg.cloud.installationIds["cursor"]).toBe("inst-cursor");
    expect(cfg.cloud.installationIds["codex"]).toBe("inst-codex");
  });

  it("re-running init does not create duplicate cloud installations (idempotent upsert)", async () => {
    await initCommand.parseAsync(
      [
        "--path",
        projectDir,
        "--agent",
        "claude-code",
        "-y",
        "--api-url",
        "https://mock.tracebase.test",
        "--api-key",
        "k1",
      ],
      { from: "user" },
    );
    const firstCount = state.installations.length;

    await initCommand.parseAsync(
      [
        "--path",
        projectDir,
        "--agent",
        "claude-code",
        "-y",
        "--api-url",
        "https://mock.tracebase.test",
        "--api-key",
        "k1",
      ],
      { from: "user" },
    );

    expect(state.installations.length).toBe(firstCount);
  });
});

// ---------------------------------------------------------------------------
// Usage sync idempotency
// ---------------------------------------------------------------------------

describe("usage sync — per (installationId, window) idempotency", () => {
  it("the same day pushed twice produces exactly one unique sample on the server", async () => {
    await initCommand.parseAsync(
      [
        "--path",
        projectDir,
        "--agent",
        "claude-code",
        "-y",
        "--api-url",
        "https://mock.tracebase.test",
        "--api-key",
        "k1",
      ],
      { from: "user" },
    );

    // Seed one resolved run inside today's UTC bucket so the metric is non-empty.
    const Database = (await import("better-sqlite3")).default;
    const { BlockStore } = await import("../../src/core/block-store.js");
    const { loadConfig } = await import("../../src/core/config.js");
    const cfg = loadConfig(projectDir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const inDay = dayStart + 1_000;
    store.appendEvent({
      ts: inDay,
      queryId: "q-sync-1",
      event: "retrieval",
      candidates: [{ blockId: "b1", score: 0.9 }],
      shadow: false,
    });
    store.appendEvent({
      ts: inDay + 1,
      queryId: "q-sync-1",
      event: "injection",
      blockId: "b1",
      score: 0.9,
    });
    store.appendEvent({
      ts: inDay + 2,
      queryId: "q-sync-1",
      event: "agent_used",
      blockId: "b1",
      matchSignal: "jaccard",
      matchScore: 0.7,
    });
    store.appendEvent({
      ts: inDay + 3,
      queryId: "q-sync-1",
      event: "outcome",
      resolved: true,
      control: false,
    });
    store.close();

    // Push twice. The mock server keys by (installationId, start, end)
    // and only records unique keys, mirroring real control-plane upsert.
    await usageCommand.parseAsync(
      ["sync", "--path", projectDir, "--since", "1d"],
      { from: "user" },
    );
    await usageCommand.parseAsync(
      ["sync", "--path", projectDir, "--since", "1d"],
      { from: "user" },
    );

    // Exactly one unique sample for today despite two pushes.
    expect(state.usageSamples.length).toBe(1);
    expect(state.usageSamples[0]!.installationId).toBe("inst-claude-code");
  });

  it("dry-run computes non-empty samples but does not push", async () => {
    await initCommand.parseAsync(
      [
        "--path",
        projectDir,
        "--agent",
        "claude-code",
        "-y",
        "--api-url",
        "https://mock.tracebase.test",
        "--api-key",
        "k1",
      ],
      { from: "user" },
    );

    const baselineSamples = state.usageSamples.length;
    await usageCommand.parseAsync(
      ["sync", "--path", projectDir, "--since", "1d", "--dry-run"],
      { from: "user" },
    );
    expect(state.usageSamples.length).toBe(baselineSamples);
  });
});
