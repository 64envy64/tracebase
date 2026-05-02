/**
 * File-mode round-trip tests for the Engineering Brain store.
 *
 * Postgres isn't available in CI; the file fallback IS the dev
 * default and is the implementation tested here. Asserts:
 *   - upserts on (integration, kind, external_id) are idempotent
 *   - bounded body summaries hold under absurdly long input
 *   - changeMemoryStatus + rollback round-trip leaves the audit
 *     trail in the right shape (created → retired → rollback to
 *     active)
 *   - hard-delete keeps audit metadata, drops the snapshot fields
 *
 * The dev fallback path is configurable via TRACEBASE_ENGINEERING_BRAIN_FILE,
 * so each test scopes itself to a fresh tmp file before importing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKSPACE = "ws-test-1";

let tmpDir: string;
let storePromise: Promise<unknown>;

async function freshStore() {
  // Reset the singleton each test so the env var is honored.
  const mod = await import("@/lib/control-plane/engineering-brain");
  mod.__resetEngineeringBrainStoreForTest();
  return mod.getEngineeringBrainStore();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tb-eng-"));
  process.env.TRACEBASE_ENGINEERING_BRAIN_FILE = join(tmpDir, "engineering-brain.json");
  // Force file mode by clearing any pg env that might be set by a parent shell.
  delete process.env.TRACEBASE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.TRACEBASE_DB_USER;
  delete process.env.TRACEBASE_DB_PASSWORD;
  delete process.env.TRACEBASE_DB_NAME;
  delete process.env.TRACEBASE_INSTANCE_UNIX_SOCKET;
  delete process.env.INSTANCE_UNIX_SOCKET;
  delete process.env.TRACEBASE_CLOUDSQL_INSTANCE;
  storePromise = freshStore();
});

afterEach(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("FileEngineeringBrainStore", () => {
  it("upserts a github item idempotently on (integration, kind, external_id)", async () => {
    const store = await storePromise as Awaited<ReturnType<typeof freshStore>>;
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: "tracebase/x",
      status: "connected",
    });
    const seed = {
      workspaceId: WORKSPACE,
      integrationId: integration.id,
      repoFullName: "tracebase/x",
      kind: "issue" as const,
      externalId: "100",
      number: 42,
      title: "first",
      url: "https://github.com/tracebase/x/issues/42",
      labels: ["bug"],
    };
    const a = await store.upsertGithubItem(seed);
    const b = await store.upsertGithubItem({ ...seed, title: "second" });
    expect(a.id).toBe(b.id);
    const all = await store.listGithubItems(WORKSPACE);
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("second");
  });

  it("bounds long bodies before persisting", async () => {
    const store = await storePromise as Awaited<ReturnType<typeof freshStore>>;
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "x",
      repoFullName: "x/y",
    });
    const huge = "x".repeat(50_000);
    const item = await store.upsertGithubItem({
      workspaceId: WORKSPACE,
      integrationId: integration.id,
      repoFullName: "x/y",
      kind: "issue",
      externalId: "1",
      url: "https://github.com/x/y/issues/1",
      bodySummary: huge,
    });
    expect(item.bodySummary).toBeDefined();
    expect((item.bodySummary ?? "").length).toBeLessThan(2000);
  });

  it("supports retire → rollback round-trip and writes the right events", async () => {
    const store = await storePromise as Awaited<ReturnType<typeof freshStore>>;
    await store.upsertMemoryStatus({
      workspaceId: WORKSPACE,
      memoryId: "mem-1",
      status: "active",
      trigSituation: "JWT clock skew",
    });
    // Seed a created event so rollback has prior context.
    await store.createMemoryEvent({
      workspaceId: WORKSPACE,
      memoryId: "mem-1",
      actorKind: "agent",
      actorId: "agent-1",
      action: "created",
    });
    const retire = await store.changeMemoryStatus({
      workspaceId: WORKSPACE,
      memoryId: "mem-1",
      toStatus: "retired",
      actorKind: "human",
      actorId: "tester",
      reason: "stale",
    });
    expect(retire.status.status).toBe("retired");
    expect(retire.event.action).toBe("retired");

    const rolled = await store.rollbackMemoryStatus({
      workspaceId: WORKSPACE,
      memoryId: "mem-1",
      actorKind: "human",
      actorId: "tester",
      reason: "rollback test",
    });
    expect(rolled).not.toBeNull();
    expect(rolled!.status.status).toBe("active");
    expect(rolled!.memoryEvent.action).toBe("rollback");
    expect(rolled!.rollbackEvent.targetKind).toBe("memory");

    const events = await store.listMemoryEvents(WORKSPACE, { memoryId: "mem-1" });
    // Order: most recent first → rollback, retired, created.
    expect(events[0].action).toBe("rollback");
    expect(events[1].action).toBe("retired");
    expect(events[2].action).toBe("created");
  });

  it("hard delete preserves the row id but nulls trig_situation/body_preview", async () => {
    const store = await storePromise as Awaited<ReturnType<typeof freshStore>>;
    await store.upsertMemoryStatus({
      workspaceId: WORKSPACE,
      memoryId: "mem-d",
      status: "active",
      trigSituation: "secret guidance",
      bodyPreview: "secret body",
    });
    const before = await store.getMemoryStatus(WORKSPACE, "mem-d");
    expect(before?.trigSituation).toBe("secret guidance");
    const result = await store.changeMemoryStatus({
      workspaceId: WORKSPACE,
      memoryId: "mem-d",
      toStatus: "deleted",
      actorKind: "human",
      actorId: "tester",
      reason: "policy",
    });
    expect(result.status.status).toBe("deleted");
    expect(result.status.trigSituation).toBeUndefined();
    expect(result.status.bodyPreview).toBeUndefined();
    // Audit trail still names the same memory id.
    expect(result.event.memoryId).toBe("mem-d");
  });
});

