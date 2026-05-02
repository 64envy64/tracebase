/**
 * Minimal GitHub REST client for Engineering Brain ingest.
 *
 * Designed for swappability: the `GithubClient` interface is what the
 * ingest pipeline depends on, and tests provide a fixture impl. The
 * production impl uses fetch + bearer PAT and:
 *
 *   - never logs the bearer token
 *   - paginates politely (page-size 100, max 10 pages by default)
 *   - degrades to a typed RateLimitError on 403 with rate-limit headers
 *     instead of throwing or hanging
 *   - returns parsed payloads as plain JSON; the ingest layer is
 *     responsible for summarization + bounding before persistence
 */

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;

export interface GithubIssueDto {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user?: { login: string } | null;
  labels?: Array<{ name: string } | string>;
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
}

export interface GithubPullRequestDto {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user?: { login: string } | null;
  labels?: Array<{ name: string } | string>;
  created_at: string;
  updated_at: string;
  head?: { sha?: string } | null;
}

export interface GithubReviewCommentDto {
  id: number;
  body: string | null;
  user?: { login: string } | null;
  pull_request_url?: string;
  html_url: string;
  path?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GithubFileDto {
  filename: string;
}

export interface GithubCheckRunDto {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
  output?: { title?: string | null; summary?: string | null } | null;
  head_sha: string;
}

export interface GithubCommitDto {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string } | null;
  };
  author?: { login?: string } | null;
}

export interface GithubClient {
  listIssues(repo: string, opts?: { state?: "open" | "closed" | "all" }): Promise<GithubIssueDto[]>;
  listPullRequests(repo: string, opts?: { state?: "open" | "closed" | "all" }): Promise<GithubPullRequestDto[]>;
  listPullRequestFiles(repo: string, pullNumber: number): Promise<GithubFileDto[]>;
  listPullRequestReviewComments(repo: string, pullNumber: number): Promise<GithubReviewCommentDto[]>;
  listCommits(repo: string, opts?: { perPage?: number }): Promise<GithubCommitDto[]>;
  listCheckRunsForRef(repo: string, ref: string): Promise<GithubCheckRunDto[]>;
}

export class GithubAuthError extends Error {
  constructor(message = "github auth failed") {
    super(message);
    this.name = "GithubAuthError";
  }
}

export class GithubRateLimitError extends Error {
  readonly retryAfterSec: number | null;
  readonly resetAtIso: string | null;
  constructor(message: string, retryAfterSec: number | null, resetAtIso: string | null) {
    super(message);
    this.name = "GithubRateLimitError";
    this.retryAfterSec = retryAfterSec;
    this.resetAtIso = resetAtIso;
  }
}

export interface GithubClientOptions {
  token: string;
  baseUrl?: string;
  pageSize?: number;
  maxPages?: number;
  fetch?: typeof fetch;
}

class HttpGithubClient implements GithubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GithubClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async listIssues(repo: string, opts: { state?: "open" | "closed" | "all" } = {}): Promise<GithubIssueDto[]> {
    const state = opts.state ?? "all";
    return this.paginate<GithubIssueDto>(`/repos/${repo}/issues`, {
      state,
      sort: "updated",
      direction: "desc",
    });
  }

  async listPullRequests(
    repo: string,
    opts: { state?: "open" | "closed" | "all" } = {},
  ): Promise<GithubPullRequestDto[]> {
    const state = opts.state ?? "all";
    return this.paginate<GithubPullRequestDto>(`/repos/${repo}/pulls`, {
      state,
      sort: "updated",
      direction: "desc",
    });
  }

  async listPullRequestFiles(repo: string, pullNumber: number): Promise<GithubFileDto[]> {
    return this.paginate<GithubFileDto>(`/repos/${repo}/pulls/${pullNumber}/files`, {});
  }

  async listPullRequestReviewComments(
    repo: string,
    pullNumber: number,
  ): Promise<GithubReviewCommentDto[]> {
    return this.paginate<GithubReviewCommentDto>(
      `/repos/${repo}/pulls/${pullNumber}/comments`,
      {},
    );
  }

  async listCommits(repo: string, opts: { perPage?: number } = {}): Promise<GithubCommitDto[]> {
    return this.paginate<GithubCommitDto>(`/repos/${repo}/commits`, {}, {
      pageSize: opts.perPage,
      maxPages: 1,
    });
  }

  async listCheckRunsForRef(repo: string, ref: string): Promise<GithubCheckRunDto[]> {
    const all: GithubCheckRunDto[] = [];
    for (let page = 1; page <= this.maxPages; page += 1) {
      const url = this.buildUrl(`/repos/${repo}/commits/${ref}/check-runs`, {
        page,
        per_page: this.pageSize,
      });
      const res = await this.request(url);
      const body = (await res.json()) as { check_runs?: GithubCheckRunDto[] };
      const items = body.check_runs ?? [];
      all.push(...items);
      if (items.length < this.pageSize) return all;
    }
    return all;
  }

  private async paginate<T>(
    path: string,
    query: Record<string, string | undefined>,
    overrides: { pageSize?: number; maxPages?: number } = {},
  ): Promise<T[]> {
    const pageSize = overrides.pageSize ?? this.pageSize;
    const maxPages = overrides.maxPages ?? this.maxPages;
    const all: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const url = this.buildUrl(path, { ...query, page, per_page: pageSize });
      const res = await this.request(url);
      const body = (await res.json()) as T[];
      if (!Array.isArray(body)) return all;
      all.push(...body);
      if (body.length < pageSize) return all;
    }
    return all;
  }

  private buildUrl(path: string, query: Record<string, string | number | undefined>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  private async request(url: string): Promise<Response> {
    const res = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tracebase-engineering-brain",
      },
    });
    if (res.status === 401) {
      throw new GithubAuthError();
    }
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        const resetEpoch = Number(res.headers.get("x-ratelimit-reset"));
        const resetAt = Number.isFinite(resetEpoch)
          ? new Date(resetEpoch * 1000).toISOString()
          : null;
        const retryAfterSec = Number.isFinite(resetEpoch)
          ? Math.max(0, Math.ceil((resetEpoch * 1000 - Date.now()) / 1000))
          : null;
        throw new GithubRateLimitError(
          "github rate limit exceeded",
          retryAfterSec,
          resetAt,
        );
      }
      throw new Error(`github 403: ${res.statusText}`);
    }
    if (!res.ok) {
      throw new Error(`github ${res.status}: ${res.statusText}`);
    }
    return res;
  }
}

export function createGithubClient(opts: GithubClientOptions): GithubClient {
  if (!opts.token) {
    throw new GithubAuthError("missing github token");
  }
  return new HttpGithubClient(opts);
}

/**
 * Resolve a GitHub PAT for ingest. We deliberately do not persist
 * tokens in the control-plane store — env vars only, in this order:
 *
 *   TRACEBASE_GITHUB_TOKEN  → preferred, scoped to the engineering brain
 *   GITHUB_TOKEN            → fallback for local CLI use
 *
 * Returns null if neither is set; callers surface a UI hint to the
 * user. A token discovered here is *never* returned to the browser
 * or stored in any record — only used to authorize a single ingest.
 */
export function resolveGithubTokenFromEnv(): string | null {
  const raw = process.env.TRACEBASE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}
