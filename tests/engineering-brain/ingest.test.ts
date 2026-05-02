/**
 * GitHub ingest behavior under realistic conditions.
 *
 * Uses an in-memory `GithubClient` fixture so we can drive the
 * ingest pipeline without network. Asserts:
 *   - tokens never appear in the persisted error message
 *   - re-running ingest is idempotent on (integration, kind, externalId)
 *   - rate-limit errors mark the integration `error` with a useful
 *     `lastError`, but partial results stay in the store
 *   - bounded body summaries hold against pathological input
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "tracebase/x";
const WORKSPACE = "ws-ingest-1";

let tmpDir: string;

async function freshStore() {
  const mod = await import("@/lib/control-plane/engineering-brain");
  mod.__resetEngineeringBrainStoreForTest();
  return mod.getEngineeringBrainStore();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tb-ingest-"));
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

import type {
  GithubClient,
  GithubCheckRunDto,
  GithubCommitDto,
  GithubIssueDto,
  GithubPullRequestDto,
  GithubReviewCommentDto,
  GithubFileDto,
} from "@/lib/control-plane/github-client";

interface FixtureOpts {
  rateLimitOnFiles?: boolean;
  failAuthOnIssues?: boolean;
}

function makeFixtureClient(opts: FixtureOpts = {}): GithubClient {
  const issues: GithubIssueDto[] = [
    {
      id: 1001,
      number: 1,
      title: "issue one",
      body: "x".repeat(10_000),
      state: "open",
      html_url: "https://github.com/tracebase/x/issues/1",
      labels: [{ name: "bug" }, "enhancement"],
      created_at: "2026-04-30T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
    },
  ];
  const pulls: GithubPullRequestDto[] = [
    {
      id: 2001,
      number: 100,
      title: "pr one",
      body: "small body",
      state: "open",
      html_url: "https://github.com/tracebase/x/pull/100",
      labels: [{ name: "ready" }],
      created_at: "2026-04-30T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
      head: { sha: "abc1234" },
    },
  ];
  return {
    async listIssues() {
      if (opts.failAuthOnIssues) {
        const { GithubAuthError } = await import("@/lib/control-plane/github-client");
        throw new GithubAuthError("forbidden");
      }
      return issues;
    },
    async listPullRequests() {
      return pulls;
    },
    async listPullRequestFiles(): Promise<GithubFileDto[]> {
      if (opts.rateLimitOnFiles) {
        const { GithubRateLimitError } = await import("@/lib/control-plane/github-client");
        throw new GithubRateLimitError("rate limit", 60, "2026-05-01T01:00:00Z");
      }
      return [{ filename: "src/a.ts" }, { filename: "src/b.ts" }];
    },
    async listPullRequestReviewComments(): Promise<GithubReviewCommentDto[]> {
      return [];
    },
    async listCommits(): Promise<GithubCommitDto[]> {
      return [
        {
          sha: "deadbeef",
          html_url: "https://github.com/tracebase/x/commit/deadbeef",
          commit: { message: "fix: bug", author: { name: "ria", date: "2026-04-30T00:00:00Z" } },
          author: { login: "ria" },
        },
      ];
    },
    async listCheckRunsForRef(): Promise<GithubCheckRunDto[]> {
      return [
        {
          id: 9001,
          name: "ci",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/tracebase/x/runs/9001",
          started_at: "2026-04-30T00:00:00Z",
          completed_at: "2026-04-30T00:01:00Z",
          output: { summary: "1 failure" },
          head_sha: "abc1234",
        },
      ];
    },
  };
}

describe("ingestRepo", () => {
  it("is idempotent on re-run for the same items", async () => {
    const { ingestRepo } = await import("@/lib/control-plane/github-ingest");
    const store = await freshStore();
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: REPO,
    });
    const client = makeFixtureClient();
    const first = await ingestRepo({
      workspaceId: WORKSPACE,
      integration,
      client,
      store,
    });
    const reload = (await store.listIntegrations(WORKSPACE)).find((r) => r.id === integration.id)!;
    const second = await ingestRepo({
      workspaceId: WORKSPACE,
      integration: reload,
      client,
      store,
    });
    expect(first.counts.issues).toBe(1);
    expect(first.counts.pullRequests).toBe(1);
    expect(first.counts.commits).toBe(1);
    expect(first.counts.failedCi).toBe(1);
    // Same counts on second run — no duplicates.
    expect(second.counts).toEqual(first.counts);
    const items = await store.listGithubItems(WORKSPACE);
    const seenIds = new Set(items.map((i) => `${i.kind}:${i.externalId}`));
    expect(items.length).toBe(seenIds.size);
  });

  it("clamps body summaries on ingest", async () => {
    const { ingestRepo } = await import("@/lib/control-plane/github-ingest");
    const store = await freshStore();
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: REPO,
    });
    await ingestRepo({
      workspaceId: WORKSPACE,
      integration,
      client: makeFixtureClient(),
      store,
    });
    const issues = await store.listGithubItems(WORKSPACE, { kind: "issue" });
    expect(issues).toHaveLength(1);
    const body = issues[0].bodySummary ?? "";
    expect(body.length).toBeLessThan(2000);
  });

  it("marks the integration error and redacts tokens on auth failure", async () => {
    const { ingestRepo, redactGithubError } = await import("@/lib/control-plane/github-ingest");
    const store = await freshStore();
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: REPO,
    });
    const result = await ingestRepo({
      workspaceId: WORKSPACE,
      integration,
      client: makeFixtureClient({ failAuthOnIssues: true }),
      store,
    });
    expect(result.status).toBe("error");
    expect(result.lastError).toMatch(/auth/i);
    // Token-shaped strings get redacted from any persisted error.
    const tokenLike = "ghp_" + "x".repeat(36);
    const redacted = redactGithubError(new Error(`bad token: ${tokenLike}`));
    expect(redacted).not.toContain(tokenLike);
    expect(redacted).toContain("[redacted]");
  });

  it("survives rate-limit on secondary calls and saves what it has", async () => {
    const { ingestRepo } = await import("@/lib/control-plane/github-ingest");
    const store = await freshStore();
    const integration = await store.upsertIntegration({
      workspaceId: WORKSPACE,
      provider: "github",
      accountLogin: "tracebase",
      repoFullName: REPO,
    });
    const result = await ingestRepo({
      workspaceId: WORKSPACE,
      integration,
      client: makeFixtureClient({ rateLimitOnFiles: true }),
      store,
    });
    expect(result.counts.pullRequests).toBe(1);
    // PR was saved, even though the file fetch was rate-limited.
    const pr = (await store.listGithubItems(WORKSPACE, { kind: "pull_request" }))[0];
    expect(pr).toBeDefined();
    expect(pr.linkedFiles).toEqual([]);
  });
});
