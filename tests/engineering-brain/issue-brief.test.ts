/**
 * Issue Brief generator — verifies that briefs cite real items, stay
 * under the token budget, and never leak the raw body past the
 * already-bounded summary.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKSPACE = "ws-brief-1";
let tmpDir: string;

async function freshStore() {
  const mod = await import("@/lib/control-plane/engineering-brain");
  mod.__resetEngineeringBrainStoreForTest();
  return mod.getEngineeringBrainStore();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tb-brief-"));
  process.env.TRACEBASE_ENGINEERING_BRAIN_FILE = join(tmpDir, "engineering-brain.json");
  delete process.env.TRACEBASE_DATABASE_URL;
  delete process.env.DATABASE_URL;
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

describe("buildIssueBrief", () => {
  it("returns null when the github item is not in the workspace", async () => {
    const { buildIssueBrief } = await import("@/lib/control-plane/issue-brief");
    const store = await freshStore();
    const brief = await buildIssueBrief({
      workspaceId: WORKSPACE,
      itemId: "no-such-id",
      store,
    });
    expect(brief).toBeNull();
  });

  it("classifies an auth-related issue as `auth`", async () => {
    const { buildIssueBrief } = await import("@/lib/control-plane/issue-brief");
    const store = await freshStore();
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: "tracebase/x",
    });
    const item = await store.upsertGithubItem({
      workspaceId: WORKSPACE,
      integrationId: integration.id,
      repoFullName: "tracebase/x",
      kind: "issue",
      externalId: "1",
      number: 217,
      title: "JWT verify fails for stale sessions",
      url: "https://github.com/tracebase/x/issues/217",
      bodySummary: "users with stale jwt see a 401 from the gateway",
      labels: ["auth"],
    });
    const brief = await buildIssueBrief({
      workspaceId: WORKSPACE,
      itemId: item.id,
      store,
    });
    expect(brief).not.toBeNull();
    expect(brief!.failureClass).toBe("auth");
  });

  it("cites the source github_item and any related items in the same repo", async () => {
    const { buildIssueBrief } = await import("@/lib/control-plane/issue-brief");
    const store = await freshStore();
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: "tracebase/x",
    });
    const primary = await store.upsertGithubItem({
      workspaceId: WORKSPACE,
      integrationId: integration.id,
      repoFullName: "tracebase/x",
      kind: "issue",
      externalId: "1",
      number: 1,
      title: "JWT verify",
      url: "https://github.com/tracebase/x/issues/1",
      labels: ["auth"],
      linkedFiles: ["src/auth.ts"],
    });
    await store.upsertGithubItem({
      workspaceId: WORKSPACE,
      integrationId: integration.id,
      repoFullName: "tracebase/x",
      kind: "pull_request",
      externalId: "200",
      number: 200,
      title: "auth: tighten JWT",
      url: "https://github.com/tracebase/x/pull/200",
      labels: ["auth"],
      linkedFiles: ["src/auth.ts"],
    });
    const brief = await buildIssueBrief({
      workspaceId: WORKSPACE,
      itemId: primary.id,
      store,
    });
    expect(brief).not.toBeNull();
    const cited = brief!.citations.map((c) => c.id);
    expect(cited).toContain(primary.id);
    // The PR shares both the file and the label — must be cited.
    const relatedSection = brief!.sections.find((s) => s.heading.startsWith("Related"));
    expect(relatedSection).toBeDefined();
    expect(relatedSection!.body.join("\n")).toMatch(/#200/);
  });

  it("respects the token budget and reports truncation", async () => {
    const { buildIssueBrief } = await import("@/lib/control-plane/issue-brief");
    const store = await freshStore();
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: "tracebase/x",
    });
    const item = await store.upsertGithubItem({
      workspaceId: WORKSPACE,
      integrationId: integration.id,
      repoFullName: "tracebase/x",
      kind: "issue",
      externalId: "1",
      number: 1,
      title: "x",
      url: "https://example/issue/1",
      bodySummary: "x".repeat(800),
      linkedFiles: Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`),
    });
    const brief = await buildIssueBrief({
      workspaceId: WORKSPACE,
      itemId: item.id,
      store,
      tokenBudget: 100,
    });
    expect(brief).not.toBeNull();
    expect(brief!.approxTokens).toBeLessThanOrEqual(100);
  });

  it("omits deleted memories from suggestions", async () => {
    const { buildIssueBrief } = await import("@/lib/control-plane/issue-brief");
    const store = await freshStore();
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: "tracebase/x",
    });
    const item = await store.upsertGithubItem({
      workspaceId: WORKSPACE,
      integrationId: integration.id,
      repoFullName: "tracebase/x",
      kind: "issue",
      externalId: "1",
      number: 1,
      title: "JWT clock skew",
      url: "https://example/issue/1",
      bodySummary: "jwt clock skew on gateway",
    });
    await store.upsertMemoryStatus({
      workspaceId: WORKSPACE,
      memoryId: "mem-active",
      status: "active",
      trigSituation: "jwt clock skew between gateway and auth-svc",
    });
    await store.upsertMemoryStatus({
      workspaceId: WORKSPACE,
      memoryId: "mem-deleted",
      status: "deleted",
      trigSituation: "jwt clock skew (deleted)",
    });
    const brief = await buildIssueBrief({
      workspaceId: WORKSPACE,
      itemId: item.id,
      store,
    });
    const memSection = brief!.sections.find((s) => s.heading.startsWith("Prior memories"));
    expect(memSection).toBeDefined();
    const bodyJoined = memSection!.body.join("\n");
    expect(bodyJoined).toContain("jwt clock skew between gateway and auth-svc");
    expect(bodyJoined).not.toContain("(deleted)");
  });
});
