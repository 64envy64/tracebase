/**
 * GitHub ingest pipeline.
 *
 * Pulls a small, bounded set of items from a single repo and writes
 * them into the Engineering Brain store. Privacy invariants enforced
 * here, not in the store layer:
 *
 *   - Body fields are summarized + clamped to MAX_BODY_SUMMARY_CHARS
 *     before they reach the store. The raw body never persists.
 *   - Bearer tokens never appear in any record we write.
 *   - Idempotent re-ingest: every item upserts on
 *     (integration_id, kind, external_id) so a re-run does not
 *     create duplicates and does not lose previously-set fields.
 *
 * Failure model:
 *   - GithubAuthError → integration is marked status="error",
 *     ingest returns the partial counts (zero items if failed early).
 *   - GithubRateLimitError → integration is marked status="error"
 *     with `lastError` describing the reset window. Caller can
 *     re-trigger after the window.
 *   - Any other error → status="error", lastError captures the
 *     message but never the token.
 */
import {
  type EngineeringBrainStore,
  summarizeBody,
} from "@/lib/control-plane/engineering-brain";
import {
  GithubAuthError,
  GithubRateLimitError,
  type GithubClient,
} from "@/lib/control-plane/github-client";
import type { IntegrationRecord } from "@/lib/control-plane/types";

export interface IngestRepoInput {
  workspaceId: string;
  integration: IntegrationRecord;
  client: GithubClient;
  store: EngineeringBrainStore;
  /**
   * Maximum number of pull-request file lookups + check-run lookups
   * to spend on this run. Caps secondary calls so a single run never
   * blows up the rate-limit budget. Default 25.
   */
  perPullSecondaryLimit?: number;
}

export interface IngestRepoResult {
  repoFullName: string;
  status: IntegrationRecord["status"];
  counts: {
    issues: number;
    pullRequests: number;
    reviewComments: number;
    commits: number;
    checkRuns: number;
    failedCi: number;
  };
  lastError?: string;
  rateLimited?: boolean;
}

const PULL_FILE_CAP = 64;

export async function ingestRepo(input: IngestRepoInput): Promise<IngestRepoResult> {
  const { client, store, integration, workspaceId } = input;
  if (!integration.repoFullName) {
    return finalize(store, integration, {
      counts: emptyCounts(),
      status: "error",
      lastError: "integration is missing repoFullName",
    });
  }
  const repo = integration.repoFullName;
  const counts = emptyCounts();
  const secondaryBudget = Math.max(1, input.perPullSecondaryLimit ?? 25);
  let secondarySpent = 0;
  let rateLimited = false;

  try {
    const issues = await client.listIssues(repo, { state: "all" });
    for (const issue of issues) {
      // GitHub returns PRs in the issues endpoint with a pull_request key.
      // Skip those — we'll get them from the pulls endpoint with proper fields.
      if (issue.pull_request) continue;
      await store.upsertGithubItem({
        workspaceId,
        integrationId: integration.id,
        repoFullName: repo,
        kind: "issue",
        externalId: String(issue.id),
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
        ...(issue.user?.login ? { authorLogin: issue.user.login } : {}),
        ...(issue.body ? { bodySummary: summarizeBody(issue.body) ?? "" } : {}),
        labels: extractLabelNames(issue.labels),
        createdAtRemote: issue.created_at,
        updatedAtRemote: issue.updated_at,
      });
      counts.issues += 1;
    }

    const pulls = await client.listPullRequests(repo, { state: "all" });
    for (const pr of pulls) {
      let linkedFiles: string[] = [];
      let prCheckRuns: number = 0;
      let prFailedCi: number = 0;

      // Secondary calls (files + checks). Skip when budget is spent.
      if (secondarySpent < secondaryBudget) {
        try {
          const files = await client.listPullRequestFiles(repo, pr.number);
          linkedFiles = files.slice(0, PULL_FILE_CAP).map((f) => f.filename).filter(Boolean);
          secondarySpent += 1;
        } catch (err) {
          if (err instanceof GithubRateLimitError) {
            rateLimited = true;
          }
          // non-fatal — keep going on the rest of ingest
        }
      }

      await store.upsertGithubItem({
        workspaceId,
        integrationId: integration.id,
        repoFullName: repo,
        kind: "pull_request",
        externalId: String(pr.id),
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        ...(pr.user?.login ? { authorLogin: pr.user.login } : {}),
        ...(pr.body ? { bodySummary: summarizeBody(pr.body) ?? "" } : {}),
        labels: extractLabelNames(pr.labels),
        linkedFiles,
        createdAtRemote: pr.created_at,
        updatedAtRemote: pr.updated_at,
      });
      counts.pullRequests += 1;

      // Review comments (small, not paginated heavily here)
      if (secondarySpent < secondaryBudget) {
        try {
          const comments = await client.listPullRequestReviewComments(repo, pr.number);
          for (const c of comments) {
            await store.upsertGithubItem({
              workspaceId,
              integrationId: integration.id,
              repoFullName: repo,
              kind: "review_comment",
              externalId: String(c.id),
              url: c.html_url,
              ...(c.user?.login ? { authorLogin: c.user.login } : {}),
              ...(c.body ? { bodySummary: summarizeBody(c.body) ?? "" } : {}),
              labels: [],
              ...(c.path ? { linkedFiles: [c.path] } : {}),
              createdAtRemote: c.created_at,
              updatedAtRemote: c.updated_at,
            });
            counts.reviewComments += 1;
          }
          secondarySpent += 1;
        } catch (err) {
          if (err instanceof GithubRateLimitError) rateLimited = true;
        }
      }

      // CI / check runs against PR head SHA
      if (secondarySpent < secondaryBudget && pr.head?.sha) {
        try {
          const checks = await client.listCheckRunsForRef(repo, pr.head.sha);
          for (const c of checks) {
            const failed = c.conclusion === "failure" || c.conclusion === "timed_out";
            const titlePieces = [c.name, c.status, c.conclusion ?? "in_progress"];
            const summary = c.output?.summary ?? c.output?.title ?? null;
            await store.upsertGithubItem({
              workspaceId,
              integrationId: integration.id,
              repoFullName: repo,
              kind: "check_run",
              externalId: String(c.id),
              title: titlePieces.filter(Boolean).join(" · "),
              state: c.conclusion ?? c.status,
              url: c.html_url,
              ...(summary ? { bodySummary: summarizeBody(summary) ?? "" } : {}),
              labels: failed ? ["ci-failure"] : [],
              createdAtRemote: c.started_at ?? undefined,
              updatedAtRemote: c.completed_at ?? c.started_at ?? undefined,
            });
            prCheckRuns += 1;
            if (failed) prFailedCi += 1;
          }
          secondarySpent += 1;
        } catch (err) {
          if (err instanceof GithubRateLimitError) rateLimited = true;
        }
      }

      counts.checkRuns += prCheckRuns;
      counts.failedCi += prFailedCi;
    }

    // Recent commits (single page, just metadata)
    try {
      const commits = await client.listCommits(repo, { perPage: 30 });
      for (const c of commits) {
        await store.upsertGithubItem({
          workspaceId,
          integrationId: integration.id,
          repoFullName: repo,
          kind: "commit",
          externalId: c.sha,
          url: c.html_url,
          ...(c.author?.login ? { authorLogin: c.author.login } : {}),
          ...(c.commit.message ? { bodySummary: summarizeBody(c.commit.message) ?? "" } : {}),
          labels: [],
          createdAtRemote: c.commit.author?.date,
          updatedAtRemote: c.commit.author?.date,
        });
        counts.commits += 1;
      }
    } catch (err) {
      if (err instanceof GithubRateLimitError) rateLimited = true;
    }

    return finalize(store, integration, {
      counts,
      status: rateLimited ? "error" : "connected",
      ...(rateLimited ? { lastError: "rate-limited mid-ingest; partial results saved" } : {}),
      rateLimited,
    });
  } catch (err) {
    const message = redactGithubError(err);
    return finalize(store, integration, {
      counts,
      status: "error",
      lastError: message,
      rateLimited: err instanceof GithubRateLimitError,
    });
  }
}

async function finalize(
  store: EngineeringBrainStore,
  integration: IntegrationRecord,
  result: Omit<IngestRepoResult, "repoFullName"> & { rateLimited?: boolean },
): Promise<IngestRepoResult> {
  await store.setIntegrationStatus({
    workspaceId: integration.workspaceId,
    id: integration.id,
    status: result.status,
    ...(result.lastError ? { lastError: result.lastError } : { lastError: null }),
    lastSyncAt: new Date().toISOString(),
  });
  return {
    repoFullName: integration.repoFullName ?? "",
    status: result.status,
    counts: result.counts,
    ...(result.lastError ? { lastError: result.lastError } : {}),
    ...(result.rateLimited ? { rateLimited: true } : {}),
  };
}

function emptyCounts(): IngestRepoResult["counts"] {
  return {
    issues: 0,
    pullRequests: 0,
    reviewComments: 0,
    commits: 0,
    checkRuns: 0,
    failedCi: 0,
  };
}

function extractLabelNames(labels: Array<{ name: string } | string> | undefined): string[] {
  if (!labels) return [];
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((l): l is string => typeof l === "string" && l.length > 0);
}

/**
 * Strip any header/token-shaped substrings from an error message
 * before persisting it as `lastError`. We never log or persist the
 * bearer token, but defensive scrubbing makes regressions visible
 * during code review (any future code path that surfaces tokens
 * here will trip the test).
 */
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b/g;

export function redactGithubError(err: unknown): string {
  const known = err instanceof GithubAuthError
    ? "github auth failed"
    : err instanceof GithubRateLimitError
      ? `github rate limit (${err.retryAfterSec ?? "unknown"}s until reset)`
      : err instanceof Error
        ? err.message
        : "unknown error";
  return known.replace(TOKEN_PATTERN, "[redacted]");
}

export const _internals = { extractLabelNames };
