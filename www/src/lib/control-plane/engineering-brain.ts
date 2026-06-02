/**
 * Engineering Brain — persistence + governance for the GitHub × agent
 * × memory graph.
 *
 * This module is the dashboard's reflection of work. The SDK store
 * (SQLite, src/core/block-store.ts) remains the source of truth for
 * the actual memory bodies. Here we only persist:
 *   - integrations + ingested GitHub items (with bounded summaries)
 *   - agent registry + per-run rollups (counts, never tool I/O)
 *   - memory_status as a thin governance catalog
 *   - memory_events + rollback_events as an append-only audit trail
 *
 * Two implementations live behind a single interface, mirroring the
 * pattern in `store.ts`:
 *   - PostgresEngineeringBrainStore — production (Cloud SQL via pg)
 *   - FileEngineeringBrainStore     — dev fallback (single JSON file)
 *
 * Hard delete on a memory only nulls the snapshot fields
 * (trig_situation, body_preview). The row keeps its primary key so
 * memory_events keeps a referential anchor — that is the audit trail.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Pool, PoolConfig } from "pg";
import { getControlPlaneStore } from "@/lib/control-plane/store";
import type {
  AgentHost,
  AgentRecord,
  AgentRunRecord,
  AgentRunSourceKind,
  AgentRunStatus,
  GithubItemKind,
  GithubItemRecord,
  IntegrationProvider,
  IntegrationRecord,
  IntegrationStatus,
  MemoryEventAction,
  MemoryEventActorKind,
  MemoryEventRecord,
  MemoryStatusRecord,
  MemoryStatusValue,
  RollbackEventRecord,
  RollbackTargetKind,
} from "@/lib/control-plane/types";

// Maximum length of any persisted GitHub body summary. Tighter than
// the GitHub API limit so a malicious / accidentally huge body never
// reaches Postgres or the file store unbounded.
const MAX_BODY_SUMMARY_CHARS = 1200;
const MAX_LABELS = 32;
const MAX_LINKED_FILES = 64;

export interface UpsertIntegrationInput {
  workspaceId: string;
  provider: IntegrationProvider;
  accountLogin: string;
  installationId?: string;
  repoFullName?: string;
  status?: IntegrationStatus;
  lastSyncAt?: string;
  lastError?: string | null;
}

export interface UpsertGithubItemInput {
  workspaceId: string;
  integrationId: string;
  repoFullName: string;
  kind: GithubItemKind;
  externalId: string;
  number?: number;
  title?: string;
  state?: string;
  url: string;
  authorLogin?: string;
  bodySummary?: string;
  labels?: string[];
  linkedFiles?: string[];
  createdAtRemote?: string;
  updatedAtRemote?: string;
}

export interface UpsertAgentInput {
  workspaceId: string;
  displayName: string;
  ownerLabel?: string;
  host: AgentHost;
  status?: "active" | "idle" | "disabled";
}

export interface CreateAgentRunInput {
  workspaceId: string;
  agentId?: string;
  sessionId: string;
  taskTitle?: string;
  taskSourceKind: AgentRunSourceKind;
  taskSourceId?: string;
  startedAt?: string;
  status?: AgentRunStatus;
  tokensInjected?: number;
  tokensSavedEstimated?: number;
  toolCallsCount?: number;
  blockedCallsCount?: number;
  recalledPatternsCount?: number;
  recalledFilesCount?: number;
}

export interface UpdateAgentRunInput {
  workspaceId: string;
  id: string;
  endedAt?: string;
  status?: AgentRunStatus;
  tokensInjected?: number;
  tokensSavedEstimated?: number;
  toolCallsCount?: number;
  blockedCallsCount?: number;
  recalledPatternsCount?: number;
  recalledFilesCount?: number;
}

export interface UpsertMemoryStatusInput {
  workspaceId: string;
  memoryId: string;
  status?: MemoryStatusValue;
  trigSituation?: string;
  bodyPreview?: string;
  provenanceKind?: "agent_run" | "github_item" | "manual" | "imported";
  provenanceId?: string;
}

export interface ChangeMemoryStatusInput {
  workspaceId: string;
  memoryId: string;
  toStatus: MemoryStatusValue;
  actorKind: MemoryEventActorKind;
  actorId?: string;
  reason?: string;
  sourceRunId?: string;
  sourceGithubItemId?: string;
}

export interface RollbackMemoryStatusInput {
  workspaceId: string;
  memoryId: string;
  actorKind: MemoryEventActorKind;
  actorId?: string;
  reason: string;
}

export interface CreateMemoryEventInput {
  workspaceId: string;
  memoryId: string;
  actorKind: MemoryEventActorKind;
  actorId?: string;
  action: MemoryEventAction;
  sourceRunId?: string;
  sourceGithubItemId?: string;
  reason?: string;
}

export interface CreateRollbackEventInput {
  workspaceId: string;
  actorId?: string;
  targetKind: RollbackTargetKind;
  targetId: string;
  rollbackToId?: string;
  reason: string;
}

export interface ListGithubItemsOptions {
  repoFullName?: string;
  kind?: GithubItemKind;
  limit?: number;
}

export interface ListAgentRunsOptions {
  agentId?: string;
  ownerLabel?: string;
  status?: AgentRunStatus;
  taskSourceKind?: AgentRunSourceKind;
  limit?: number;
}

export interface ListMemoryEventsOptions {
  memoryId?: string;
  action?: MemoryEventAction;
  limit?: number;
}

export interface EngineeringBrainStore {
  // integrations
  listIntegrations(workspaceId: string): Promise<IntegrationRecord[]>;
  upsertIntegration(input: UpsertIntegrationInput): Promise<IntegrationRecord>;
  setIntegrationStatus(input: {
    workspaceId: string;
    id: string;
    status: IntegrationStatus;
    lastError?: string | null;
    lastSyncAt?: string;
  }): Promise<IntegrationRecord | null>;

  // github_items
  listGithubItems(
    workspaceId: string,
    opts?: ListGithubItemsOptions,
  ): Promise<GithubItemRecord[]>;
  getGithubItemById(
    workspaceId: string,
    id: string,
  ): Promise<GithubItemRecord | null>;
  upsertGithubItem(input: UpsertGithubItemInput): Promise<GithubItemRecord>;

  // agents
  listAgents(workspaceId: string): Promise<AgentRecord[]>;
  upsertAgent(input: UpsertAgentInput): Promise<AgentRecord>;

  // agent_runs
  listAgentRuns(
    workspaceId: string,
    opts?: ListAgentRunsOptions,
  ): Promise<AgentRunRecord[]>;
  getAgentRun(workspaceId: string, id: string): Promise<AgentRunRecord | null>;
  createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRecord>;
  updateAgentRun(input: UpdateAgentRunInput): Promise<AgentRunRecord | null>;

  // memory governance
  listMemoryStatuses(
    workspaceId: string,
    opts?: { status?: MemoryStatusValue },
  ): Promise<MemoryStatusRecord[]>;
  getMemoryStatus(
    workspaceId: string,
    memoryId: string,
  ): Promise<MemoryStatusRecord | null>;
  upsertMemoryStatus(input: UpsertMemoryStatusInput): Promise<MemoryStatusRecord>;
  /**
   * Change a memory's status and append a memory_event in one shot.
   * If the action is `deleted`, also nulls trig_situation/body_preview
   * (audit metadata only — the body is gone, the row stays for chaining).
   */
  changeMemoryStatus(
    input: ChangeMemoryStatusInput,
  ): Promise<{ status: MemoryStatusRecord; event: MemoryEventRecord }>;
  /**
   * Roll back the most recent status transition for a memory: read the
   * latest action, write a new memory_event with action="rollback",
   * write a rollback_event, and restore the prior status. Idempotent
   * for the case where there is no prior transition (status remains).
   */
  rollbackMemoryStatus(
    input: RollbackMemoryStatusInput,
  ): Promise<{
    status: MemoryStatusRecord;
    memoryEvent: MemoryEventRecord;
    rollbackEvent: RollbackEventRecord;
  } | null>;

  // events
  listMemoryEvents(
    workspaceId: string,
    opts?: ListMemoryEventsOptions,
  ): Promise<MemoryEventRecord[]>;
  createMemoryEvent(input: CreateMemoryEventInput): Promise<MemoryEventRecord>;
  listRollbackEvents(workspaceId: string): Promise<RollbackEventRecord[]>;
  createRollbackEvent(
    input: CreateRollbackEventInput,
  ): Promise<RollbackEventRecord>;
}

// ---------------------------------------------------------------------------
// Singleton resolution
// ---------------------------------------------------------------------------

let cachedStorePromise: Promise<EngineeringBrainStore> | null = null;

export function getEngineeringBrainStore(): Promise<EngineeringBrainStore> {
  if (!cachedStorePromise) {
    cachedStorePromise = createStore().catch((err) => {
      cachedStorePromise = null;
      throw err;
    });
  }
  return cachedStorePromise;
}

export function __resetEngineeringBrainStoreForTest(): void {
  cachedStorePromise = null;
}

async function createStore(): Promise<EngineeringBrainStore> {
  // Schema bootstrap lives in store.ts SCHEMA_SQL. Awaiting the
  // control-plane store guarantees the engineering_brain tables exist
  // before any pg query runs through this module — this matters for
  // routes that touch the brain without going through the dashboard
  // layout's bootstrap.
  await getControlPlaneStore().catch(() => null);
  const config = resolvePoolConfig();
  if (config) {
    // Keep the file-mode fallback genuinely dependency-light. The dashboard
    // owns `pg`, but root-package tests intentionally exercise file mode
    // without installing dashboard dependencies.
    const pgModuleName = "pg";
    const { Pool: PgPool } = await import(pgModuleName) as typeof import("pg");
    return new PostgresEngineeringBrainStore(new PgPool(config));
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Engineering Brain storage requires Postgres in production.");
  }
  const filePath =
    process.env.TRACEBASE_ENGINEERING_BRAIN_FILE ??
    join(process.cwd(), ".tracebase", "engineering-brain.dev.json");
  const store = new FileEngineeringBrainStore(filePath);
  await store.init();
  return store;
}

function resolvePoolConfig(): PoolConfig | null {
  const max = Number(process.env.TRACEBASE_DATABASE_POOL_MAX ?? 5);
  const connectionString =
    process.env.TRACEBASE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (connectionString) {
    return {
      connectionString,
      max,
      application_name: "tracebase-engineering-brain",
    };
  }
  const user = process.env.TRACEBASE_DB_USER ?? process.env.DB_USER;
  const password = process.env.TRACEBASE_DB_PASSWORD ?? process.env.DB_PASS;
  const database = process.env.TRACEBASE_DB_NAME ?? process.env.DB_NAME;
  const socketHost =
    process.env.TRACEBASE_INSTANCE_UNIX_SOCKET ??
    process.env.INSTANCE_UNIX_SOCKET ??
    (process.env.TRACEBASE_CLOUDSQL_INSTANCE
      ? `/cloudsql/${process.env.TRACEBASE_CLOUDSQL_INSTANCE}`
      : undefined);
  if (!user || !password || !database || !socketHost) {
    return null;
  }
  return {
    user,
    password,
    database,
    host: socketHost,
    max,
    application_name: "tracebase-engineering-brain",
  };
}

// ---------------------------------------------------------------------------
// Helpers shared between impls
// ---------------------------------------------------------------------------

export function summarizeBody(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= MAX_BODY_SUMMARY_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_BODY_SUMMARY_CHARS - 1)}…`;
}

export function clampLabels(labels?: string[] | null): string[] {
  if (!labels) return [];
  return labels
    .filter((l): l is string => typeof l === "string" && l.length > 0)
    .slice(0, MAX_LABELS);
}

export function clampLinkedFiles(files?: string[] | null): string[] {
  if (!files) return [];
  return Array.from(new Set(files.filter((f): f is string => typeof f === "string" && f.length > 0))).slice(
    0,
    MAX_LINKED_FILES,
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return new Date().toISOString();
  return new Date(String(value)).toISOString();
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return toIso(value);
}

// ---------------------------------------------------------------------------
// Postgres impl
// ---------------------------------------------------------------------------

class PostgresEngineeringBrainStore implements EngineeringBrainStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async listIntegrations(workspaceId: string): Promise<IntegrationRecord[]> {
    const res = await this.pool.query(
      `
      SELECT *
      FROM tracebase_integrations
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      `,
      [workspaceId],
    );
    return res.rows.map(mapIntegrationRow);
  }

  async upsertIntegration(input: UpsertIntegrationInput): Promise<IntegrationRecord> {
    const status = input.status ?? "connected";
    const repoKey = input.repoFullName ?? "";
    const existing = await this.pool.query(
      `
      SELECT *
      FROM tracebase_integrations
      WHERE workspace_id = $1
        AND provider = $2
        AND account_login = $3
        AND COALESCE(repo_full_name, '') = $4
      LIMIT 1
      `,
      [input.workspaceId, input.provider, input.accountLogin, repoKey],
    );
    if (existing.rowCount) {
      const updated = await this.pool.query(
        `
        UPDATE tracebase_integrations
        SET installation_id = COALESCE($2, installation_id),
            status = $3,
            last_sync_at = COALESCE($4, last_sync_at),
            last_error = $5,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [
          existing.rows[0].id,
          input.installationId ?? null,
          status,
          input.lastSyncAt ?? null,
          input.lastError ?? null,
        ],
      );
      return mapIntegrationRow(updated.rows[0]);
    }
    const inserted = await this.pool.query(
      `
      INSERT INTO tracebase_integrations (
        id, workspace_id, provider, account_login, installation_id,
        repo_full_name, status, last_sync_at, last_error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        randomUUID(),
        input.workspaceId,
        input.provider,
        input.accountLogin,
        input.installationId ?? null,
        input.repoFullName ?? null,
        status,
        input.lastSyncAt ?? null,
        input.lastError ?? null,
      ],
    );
    return mapIntegrationRow(inserted.rows[0]);
  }

  async setIntegrationStatus(input: {
    workspaceId: string;
    id: string;
    status: IntegrationStatus;
    lastError?: string | null;
    lastSyncAt?: string;
  }): Promise<IntegrationRecord | null> {
    const res = await this.pool.query(
      `
      UPDATE tracebase_integrations
      SET status = $3,
          last_error = $4,
          last_sync_at = COALESCE($5, last_sync_at),
          updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2
      RETURNING *
      `,
      [
        input.id,
        input.workspaceId,
        input.status,
        input.lastError ?? null,
        input.lastSyncAt ?? null,
      ],
    );
    if (!res.rowCount) return null;
    return mapIntegrationRow(res.rows[0]);
  }

  async listGithubItems(
    workspaceId: string,
    opts: ListGithubItemsOptions = {},
  ): Promise<GithubItemRecord[]> {
    const params: unknown[] = [workspaceId];
    const where: string[] = ["workspace_id = $1"];
    if (opts.repoFullName) {
      params.push(opts.repoFullName);
      where.push(`repo_full_name = $${params.length}`);
    }
    if (opts.kind) {
      params.push(opts.kind);
      where.push(`kind = $${params.length}`);
    }
    const limit = Math.min(Math.max(opts.limit ?? 250, 1), 1000);
    const res = await this.pool.query(
      `
      SELECT *
      FROM tracebase_github_items
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(updated_at_remote, ingested_at) DESC
      LIMIT ${limit}
      `,
      params,
    );
    return res.rows.map(mapGithubItemRow);
  }

  async getGithubItemById(
    workspaceId: string,
    id: string,
  ): Promise<GithubItemRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM tracebase_github_items WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
      [workspaceId, id],
    );
    if (!res.rowCount) return null;
    return mapGithubItemRow(res.rows[0]);
  }

  async upsertGithubItem(input: UpsertGithubItemInput): Promise<GithubItemRecord> {
    const summary = summarizeBody(input.bodySummary ?? "");
    const labels = clampLabels(input.labels);
    const linkedFiles = clampLinkedFiles(input.linkedFiles);
    const existing = await this.pool.query(
      `
      SELECT id FROM tracebase_github_items
      WHERE integration_id = $1 AND kind = $2 AND external_id = $3
      LIMIT 1
      `,
      [input.integrationId, input.kind, input.externalId],
    );
    if (existing.rowCount) {
      const updated = await this.pool.query(
        `
        UPDATE tracebase_github_items
        SET title = $2,
            state = $3,
            url = $4,
            author_login = $5,
            body_summary = $6,
            labels = $7::jsonb,
            linked_files = $8::jsonb,
            number = $9,
            created_at_remote = COALESCE($10, created_at_remote),
            updated_at_remote = COALESCE($11, updated_at_remote),
            ingested_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [
          existing.rows[0].id,
          input.title ?? null,
          input.state ?? null,
          input.url,
          input.authorLogin ?? null,
          summary ?? null,
          JSON.stringify(labels),
          JSON.stringify(linkedFiles),
          input.number ?? null,
          input.createdAtRemote ?? null,
          input.updatedAtRemote ?? null,
        ],
      );
      return mapGithubItemRow(updated.rows[0]);
    }
    const inserted = await this.pool.query(
      `
      INSERT INTO tracebase_github_items (
        id, integration_id, workspace_id, repo_full_name, kind, external_id,
        number, title, state, url, author_login, body_summary,
        labels, linked_files, created_at_remote, updated_at_remote
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16)
      RETURNING *
      `,
      [
        randomUUID(),
        input.integrationId,
        input.workspaceId,
        input.repoFullName,
        input.kind,
        input.externalId,
        input.number ?? null,
        input.title ?? null,
        input.state ?? null,
        input.url,
        input.authorLogin ?? null,
        summary ?? null,
        JSON.stringify(labels),
        JSON.stringify(linkedFiles),
        input.createdAtRemote ?? null,
        input.updatedAtRemote ?? null,
      ],
    );
    return mapGithubItemRow(inserted.rows[0]);
  }

  async listAgents(workspaceId: string): Promise<AgentRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM tracebase_agents WHERE workspace_id = $1 ORDER BY updated_at DESC`,
      [workspaceId],
    );
    return res.rows.map(mapAgentRow);
  }

  async upsertAgent(input: UpsertAgentInput): Promise<AgentRecord> {
    const status = input.status ?? "active";
    const existing = await this.pool.query(
      `SELECT * FROM tracebase_agents WHERE workspace_id = $1 AND display_name = $2 LIMIT 1`,
      [input.workspaceId, input.displayName],
    );
    if (existing.rowCount) {
      const updated = await this.pool.query(
        `
        UPDATE tracebase_agents
        SET host = $2, owner_label = $3, status = $4, updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [existing.rows[0].id, input.host, input.ownerLabel ?? null, status],
      );
      return mapAgentRow(updated.rows[0]);
    }
    const inserted = await this.pool.query(
      `
      INSERT INTO tracebase_agents (
        id, workspace_id, display_name, owner_label, host, status
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        randomUUID(),
        input.workspaceId,
        input.displayName,
        input.ownerLabel ?? null,
        input.host,
        status,
      ],
    );
    return mapAgentRow(inserted.rows[0]);
  }

  async listAgentRuns(
    workspaceId: string,
    opts: ListAgentRunsOptions = {},
  ): Promise<AgentRunRecord[]> {
    const params: unknown[] = [workspaceId];
    const where: string[] = ["r.workspace_id = $1"];
    if (opts.agentId) {
      params.push(opts.agentId);
      where.push(`r.agent_id = $${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      where.push(`r.status = $${params.length}`);
    }
    if (opts.taskSourceKind) {
      params.push(opts.taskSourceKind);
      where.push(`r.task_source_kind = $${params.length}`);
    }
    if (opts.ownerLabel) {
      params.push(opts.ownerLabel);
      where.push(`a.owner_label = $${params.length}`);
    }
    const limit = Math.min(Math.max(opts.limit ?? 250, 1), 1000);
    const res = await this.pool.query(
      `
      SELECT r.*
      FROM tracebase_agent_runs r
      LEFT JOIN tracebase_agents a ON a.id = r.agent_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.started_at DESC
      LIMIT ${limit}
      `,
      params,
    );
    return res.rows.map(mapAgentRunRow);
  }

  async getAgentRun(workspaceId: string, id: string): Promise<AgentRunRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM tracebase_agent_runs WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
      [workspaceId, id],
    );
    if (!res.rowCount) return null;
    return mapAgentRunRow(res.rows[0]);
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    const inserted = await this.pool.query(
      `
      INSERT INTO tracebase_agent_runs (
        id, workspace_id, agent_id, session_id, task_title,
        task_source_kind, task_source_id, started_at, status,
        tokens_injected, tokens_saved_estimated, tool_calls_count,
        blocked_calls_count, recalled_patterns_count, recalled_files_count
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9,
        $10, $11, $12, $13, $14, $15
      )
      RETURNING *
      `,
      [
        randomUUID(),
        input.workspaceId,
        input.agentId ?? null,
        input.sessionId,
        input.taskTitle ?? null,
        input.taskSourceKind,
        input.taskSourceId ?? null,
        input.startedAt ?? null,
        input.status ?? "running",
        input.tokensInjected ?? 0,
        input.tokensSavedEstimated ?? 0,
        input.toolCallsCount ?? 0,
        input.blockedCallsCount ?? 0,
        input.recalledPatternsCount ?? 0,
        input.recalledFilesCount ?? 0,
      ],
    );
    return mapAgentRunRow(inserted.rows[0]);
  }

  async updateAgentRun(input: UpdateAgentRunInput): Promise<AgentRunRecord | null> {
    const set: string[] = [];
    const params: unknown[] = [input.id, input.workspaceId];
    const push = (col: string, val: unknown) => {
      if (val === undefined) return;
      params.push(val);
      set.push(`${col} = $${params.length}`);
    };
    push("ended_at", input.endedAt ?? null);
    push("status", input.status);
    push("tokens_injected", input.tokensInjected);
    push("tokens_saved_estimated", input.tokensSavedEstimated);
    push("tool_calls_count", input.toolCallsCount);
    push("blocked_calls_count", input.blockedCallsCount);
    push("recalled_patterns_count", input.recalledPatternsCount);
    push("recalled_files_count", input.recalledFilesCount);
    if (set.length === 0) {
      return this.getAgentRun(input.workspaceId, input.id);
    }
    const res = await this.pool.query(
      `
      UPDATE tracebase_agent_runs
      SET ${set.join(", ")}
      WHERE id = $1 AND workspace_id = $2
      RETURNING *
      `,
      params,
    );
    if (!res.rowCount) return null;
    return mapAgentRunRow(res.rows[0]);
  }

  async listMemoryStatuses(
    workspaceId: string,
    opts: { status?: MemoryStatusValue } = {},
  ): Promise<MemoryStatusRecord[]> {
    const params: unknown[] = [workspaceId];
    const where = ["workspace_id = $1"];
    if (opts.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    const res = await this.pool.query(
      `
      SELECT * FROM tracebase_memory_status
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      `,
      params,
    );
    return res.rows.map(mapMemoryStatusRow);
  }

  async getMemoryStatus(
    workspaceId: string,
    memoryId: string,
  ): Promise<MemoryStatusRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM tracebase_memory_status WHERE workspace_id = $1 AND memory_id = $2 LIMIT 1`,
      [workspaceId, memoryId],
    );
    if (!res.rowCount) return null;
    return mapMemoryStatusRow(res.rows[0]);
  }

  async upsertMemoryStatus(
    input: UpsertMemoryStatusInput,
  ): Promise<MemoryStatusRecord> {
    const status = input.status ?? "active";
    const res = await this.pool.query(
      `
      INSERT INTO tracebase_memory_status (
        workspace_id, memory_id, status, trig_situation, body_preview,
        provenance_kind, provenance_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (workspace_id, memory_id) DO UPDATE SET
        status = EXCLUDED.status,
        trig_situation = COALESCE(EXCLUDED.trig_situation, tracebase_memory_status.trig_situation),
        body_preview = COALESCE(EXCLUDED.body_preview, tracebase_memory_status.body_preview),
        provenance_kind = COALESCE(EXCLUDED.provenance_kind, tracebase_memory_status.provenance_kind),
        provenance_id = COALESCE(EXCLUDED.provenance_id, tracebase_memory_status.provenance_id),
        updated_at = NOW()
      RETURNING *
      `,
      [
        input.workspaceId,
        input.memoryId,
        status,
        input.trigSituation ?? null,
        input.bodyPreview ?? null,
        input.provenanceKind ?? null,
        input.provenanceId ?? null,
      ],
    );
    return mapMemoryStatusRow(res.rows[0]);
  }

  async changeMemoryStatus(
    input: ChangeMemoryStatusInput,
  ): Promise<{ status: MemoryStatusRecord; event: MemoryEventRecord }> {
    const isDelete = input.toStatus === "deleted";
    const updated = await this.pool.query(
      `
      INSERT INTO tracebase_memory_status (
        workspace_id, memory_id, status, trig_situation, body_preview
      ) VALUES ($1, $2, $3, NULL, NULL)
      ON CONFLICT (workspace_id, memory_id) DO UPDATE SET
        status = EXCLUDED.status,
        trig_situation = CASE WHEN $4::boolean THEN NULL ELSE tracebase_memory_status.trig_situation END,
        body_preview = CASE WHEN $4::boolean THEN NULL ELSE tracebase_memory_status.body_preview END,
        updated_at = NOW()
      RETURNING *
      `,
      [input.workspaceId, input.memoryId, input.toStatus, isDelete],
    );
    const event = await this.createMemoryEvent({
      workspaceId: input.workspaceId,
      memoryId: input.memoryId,
      actorKind: input.actorKind,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      action: input.toStatus === "deleted" ? "deleted" : (input.toStatus as MemoryEventAction),
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.sourceGithubItemId ? { sourceGithubItemId: input.sourceGithubItemId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return { status: mapMemoryStatusRow(updated.rows[0]), event };
  }

  async rollbackMemoryStatus(
    input: RollbackMemoryStatusInput,
  ): Promise<{
    status: MemoryStatusRecord;
    memoryEvent: MemoryEventRecord;
    rollbackEvent: RollbackEventRecord;
  } | null> {
    // Find the most recent transition for this memory (excluding rollbacks
    // themselves — we never roll back a rollback).
    const recent = await this.pool.query(
      `
      SELECT *
      FROM tracebase_memory_events
      WHERE workspace_id = $1 AND memory_id = $2 AND action <> 'rollback'
      ORDER BY created_at DESC
      LIMIT 2
      `,
      [input.workspaceId, input.memoryId],
    );
    if (!recent.rowCount) return null;
    // recent.rows[0] is the most recent non-rollback transition. The
    // "prior status" is whatever existed *before* it — given by
    // recent.rows[1] when present, else `active` (the assumed default
    // before any transition).
    const previous = recent.rows[1];
    const priorStatus: MemoryStatusValue = previous
      ? eventActionToStatus(previous.action)
      : "active";

    const updated = await this.pool.query(
      `
      UPDATE tracebase_memory_status
      SET status = $3, updated_at = NOW()
      WHERE workspace_id = $1 AND memory_id = $2
      RETURNING *
      `,
      [input.workspaceId, input.memoryId, priorStatus],
    );
    if (!updated.rowCount) return null;

    const memoryEvent = await this.createMemoryEvent({
      workspaceId: input.workspaceId,
      memoryId: input.memoryId,
      actorKind: input.actorKind,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      action: "rollback",
      reason: input.reason,
    });
    const rollbackEvent = await this.createRollbackEvent({
      workspaceId: input.workspaceId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      targetKind: "memory",
      targetId: input.memoryId,
      rollbackToId: priorStatus,
      reason: input.reason,
    });
    return {
      status: mapMemoryStatusRow(updated.rows[0]),
      memoryEvent,
      rollbackEvent,
    };
  }

  async listMemoryEvents(
    workspaceId: string,
    opts: ListMemoryEventsOptions = {},
  ): Promise<MemoryEventRecord[]> {
    const params: unknown[] = [workspaceId];
    const where = ["workspace_id = $1"];
    if (opts.memoryId) {
      params.push(opts.memoryId);
      where.push(`memory_id = $${params.length}`);
    }
    if (opts.action) {
      params.push(opts.action);
      where.push(`action = $${params.length}`);
    }
    const limit = Math.min(Math.max(opts.limit ?? 250, 1), 1000);
    const res = await this.pool.query(
      `
      SELECT * FROM tracebase_memory_events
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ${limit}
      `,
      params,
    );
    return res.rows.map(mapMemoryEventRow);
  }

  async createMemoryEvent(
    input: CreateMemoryEventInput,
  ): Promise<MemoryEventRecord> {
    const res = await this.pool.query(
      `
      INSERT INTO tracebase_memory_events (
        id, workspace_id, memory_id, actor_kind, actor_id, action,
        source_run_id, source_github_item_id, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        randomUUID(),
        input.workspaceId,
        input.memoryId,
        input.actorKind,
        input.actorId ?? null,
        input.action,
        input.sourceRunId ?? null,
        input.sourceGithubItemId ?? null,
        input.reason ?? null,
      ],
    );
    return mapMemoryEventRow(res.rows[0]);
  }

  async listRollbackEvents(workspaceId: string): Promise<RollbackEventRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM tracebase_rollback_events WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [workspaceId],
    );
    return res.rows.map(mapRollbackEventRow);
  }

  async createRollbackEvent(
    input: CreateRollbackEventInput,
  ): Promise<RollbackEventRecord> {
    const res = await this.pool.query(
      `
      INSERT INTO tracebase_rollback_events (
        id, workspace_id, actor_id, target_kind, target_id, rollback_to_id, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        randomUUID(),
        input.workspaceId,
        input.actorId ?? null,
        input.targetKind,
        input.targetId,
        input.rollbackToId ?? null,
        input.reason,
      ],
    );
    return mapRollbackEventRow(res.rows[0]);
  }
}

function eventActionToStatus(action: string): MemoryStatusValue {
  if (action === "retired") return "retired";
  if (action === "deleted") return "deleted";
  if (action === "superseded") return "superseded";
  if (action === "created") return "active";
  if (action === "used") return "active";
  return "active";
}

// ---------------------------------------------------------------------------
// File impl (dev fallback)
// ---------------------------------------------------------------------------

interface FileShape {
  version: 1;
  integrations: IntegrationRecord[];
  githubItems: GithubItemRecord[];
  agents: AgentRecord[];
  agentRuns: AgentRunRecord[];
  memoryStatuses: MemoryStatusRecord[];
  memoryEvents: MemoryEventRecord[];
  rollbackEvents: RollbackEventRecord[];
}

class FileEngineeringBrainStore implements EngineeringBrainStore {
  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf-8");
      JSON.parse(raw);
    } catch {
      await this.write(emptyDb());
    }
  }

  async listIntegrations(workspaceId: string): Promise<IntegrationRecord[]> {
    const db = await this.read();
    return db.integrations
      .filter((row) => row.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async upsertIntegration(input: UpsertIntegrationInput): Promise<IntegrationRecord> {
    const db = await this.read();
    const status = input.status ?? "connected";
    const existing = db.integrations.find(
      (row) =>
        row.workspaceId === input.workspaceId &&
        row.provider === input.provider &&
        row.accountLogin === input.accountLogin &&
        (row.repoFullName ?? "") === (input.repoFullName ?? ""),
    );
    if (existing) {
      const updatedRecord: IntegrationRecord = {
        ...existing,
        ...(input.installationId ? { installationId: input.installationId } : {}),
        status,
        ...(input.lastSyncAt ? { lastSyncAt: input.lastSyncAt } : {}),
        ...(input.lastError ? { lastError: input.lastError } : { lastError: existing.lastError }),
        updatedAt: nowIso(),
      };
      db.integrations = db.integrations.map((row) => (row.id === existing.id ? updatedRecord : row));
      await this.write(db);
      return updatedRecord;
    }
    const created: IntegrationRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      provider: input.provider,
      accountLogin: input.accountLogin,
      ...(input.installationId ? { installationId: input.installationId } : {}),
      ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}),
      status,
      ...(input.lastSyncAt ? { lastSyncAt: input.lastSyncAt } : {}),
      ...(input.lastError ? { lastError: input.lastError } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.integrations.unshift(created);
    await this.write(db);
    return created;
  }

  async setIntegrationStatus(input: {
    workspaceId: string;
    id: string;
    status: IntegrationStatus;
    lastError?: string | null;
    lastSyncAt?: string;
  }): Promise<IntegrationRecord | null> {
    const db = await this.read();
    const target = db.integrations.find(
      (row) => row.id === input.id && row.workspaceId === input.workspaceId,
    );
    if (!target) return null;
    const updatedRecord: IntegrationRecord = {
      ...target,
      status: input.status,
      ...(input.lastError ? { lastError: input.lastError } : { lastError: undefined }),
      ...(input.lastSyncAt ? { lastSyncAt: input.lastSyncAt } : {}),
      updatedAt: nowIso(),
    };
    db.integrations = db.integrations.map((row) => (row.id === target.id ? updatedRecord : row));
    await this.write(db);
    return updatedRecord;
  }

  async listGithubItems(
    workspaceId: string,
    opts: ListGithubItemsOptions = {},
  ): Promise<GithubItemRecord[]> {
    const db = await this.read();
    const limit = Math.min(Math.max(opts.limit ?? 250, 1), 1000);
    return db.githubItems
      .filter((row) => row.workspaceId === workspaceId)
      .filter((row) => (opts.repoFullName ? row.repoFullName === opts.repoFullName : true))
      .filter((row) => (opts.kind ? row.kind === opts.kind : true))
      .sort((a, b) => {
        const aTs = a.updatedAtRemote ?? a.ingestedAt;
        const bTs = b.updatedAtRemote ?? b.ingestedAt;
        return bTs.localeCompare(aTs);
      })
      .slice(0, limit);
  }

  async getGithubItemById(
    workspaceId: string,
    id: string,
  ): Promise<GithubItemRecord | null> {
    const db = await this.read();
    return (
      db.githubItems.find((row) => row.workspaceId === workspaceId && row.id === id) ?? null
    );
  }

  async upsertGithubItem(input: UpsertGithubItemInput): Promise<GithubItemRecord> {
    const db = await this.read();
    const summary = summarizeBody(input.bodySummary ?? "");
    const labels = clampLabels(input.labels);
    const linkedFiles = clampLinkedFiles(input.linkedFiles);
    const existing = db.githubItems.find(
      (row) =>
        row.integrationId === input.integrationId &&
        row.kind === input.kind &&
        row.externalId === input.externalId,
    );
    if (existing) {
      const updatedRecord: GithubItemRecord = {
        ...existing,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        url: input.url,
        ...(input.authorLogin !== undefined ? { authorLogin: input.authorLogin } : {}),
        ...(summary !== undefined ? { bodySummary: summary } : {}),
        labels,
        linkedFiles,
        ...(input.number !== undefined ? { number: input.number } : {}),
        ...(input.createdAtRemote ? { createdAtRemote: input.createdAtRemote } : {}),
        ...(input.updatedAtRemote ? { updatedAtRemote: input.updatedAtRemote } : {}),
        ingestedAt: nowIso(),
      };
      db.githubItems = db.githubItems.map((row) => (row.id === existing.id ? updatedRecord : row));
      await this.write(db);
      return updatedRecord;
    }
    const created: GithubItemRecord = {
      id: randomUUID(),
      integrationId: input.integrationId,
      workspaceId: input.workspaceId,
      repoFullName: input.repoFullName,
      kind: input.kind,
      externalId: input.externalId,
      ...(input.number !== undefined ? { number: input.number } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      url: input.url,
      ...(input.authorLogin !== undefined ? { authorLogin: input.authorLogin } : {}),
      ...(summary !== undefined ? { bodySummary: summary } : {}),
      labels,
      linkedFiles,
      ...(input.createdAtRemote ? { createdAtRemote: input.createdAtRemote } : {}),
      ...(input.updatedAtRemote ? { updatedAtRemote: input.updatedAtRemote } : {}),
      ingestedAt: nowIso(),
    };
    db.githubItems.unshift(created);
    await this.write(db);
    return created;
  }

  async listAgents(workspaceId: string): Promise<AgentRecord[]> {
    const db = await this.read();
    return db.agents
      .filter((row) => row.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async upsertAgent(input: UpsertAgentInput): Promise<AgentRecord> {
    const db = await this.read();
    const status = input.status ?? "active";
    const existing = db.agents.find(
      (row) => row.workspaceId === input.workspaceId && row.displayName === input.displayName,
    );
    if (existing) {
      const updatedRecord: AgentRecord = {
        ...existing,
        host: input.host,
        ...(input.ownerLabel ? { ownerLabel: input.ownerLabel } : { ownerLabel: existing.ownerLabel }),
        status,
        updatedAt: nowIso(),
      };
      db.agents = db.agents.map((row) => (row.id === existing.id ? updatedRecord : row));
      await this.write(db);
      return updatedRecord;
    }
    const created: AgentRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      displayName: input.displayName,
      ...(input.ownerLabel ? { ownerLabel: input.ownerLabel } : {}),
      host: input.host,
      status,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.agents.unshift(created);
    await this.write(db);
    return created;
  }

  async listAgentRuns(
    workspaceId: string,
    opts: ListAgentRunsOptions = {},
  ): Promise<AgentRunRecord[]> {
    const db = await this.read();
    const limit = Math.min(Math.max(opts.limit ?? 250, 1), 1000);
    const ownerAgentIds = opts.ownerLabel
      ? new Set(
          db.agents
            .filter((a) => a.workspaceId === workspaceId && a.ownerLabel === opts.ownerLabel)
            .map((a) => a.id),
        )
      : null;
    return db.agentRuns
      .filter((row) => row.workspaceId === workspaceId)
      .filter((row) => (opts.agentId ? row.agentId === opts.agentId : true))
      .filter((row) => (opts.status ? row.status === opts.status : true))
      .filter((row) => (opts.taskSourceKind ? row.taskSourceKind === opts.taskSourceKind : true))
      .filter((row) => (ownerAgentIds ? row.agentId !== undefined && ownerAgentIds.has(row.agentId) : true))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  async getAgentRun(workspaceId: string, id: string): Promise<AgentRunRecord | null> {
    const db = await this.read();
    return (
      db.agentRuns.find((row) => row.workspaceId === workspaceId && row.id === id) ?? null
    );
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    const db = await this.read();
    const created: AgentRunRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      sessionId: input.sessionId,
      ...(input.taskTitle ? { taskTitle: input.taskTitle } : {}),
      taskSourceKind: input.taskSourceKind,
      ...(input.taskSourceId ? { taskSourceId: input.taskSourceId } : {}),
      startedAt: input.startedAt ?? nowIso(),
      status: input.status ?? "running",
      tokensInjected: input.tokensInjected ?? 0,
      tokensSavedEstimated: input.tokensSavedEstimated ?? 0,
      toolCallsCount: input.toolCallsCount ?? 0,
      blockedCallsCount: input.blockedCallsCount ?? 0,
      recalledPatternsCount: input.recalledPatternsCount ?? 0,
      recalledFilesCount: input.recalledFilesCount ?? 0,
    };
    db.agentRuns.unshift(created);
    await this.write(db);
    return created;
  }

  async updateAgentRun(input: UpdateAgentRunInput): Promise<AgentRunRecord | null> {
    const db = await this.read();
    const target = db.agentRuns.find(
      (row) => row.workspaceId === input.workspaceId && row.id === input.id,
    );
    if (!target) return null;
    const next: AgentRunRecord = {
      ...target,
      ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tokensInjected !== undefined ? { tokensInjected: input.tokensInjected } : {}),
      ...(input.tokensSavedEstimated !== undefined
        ? { tokensSavedEstimated: input.tokensSavedEstimated }
        : {}),
      ...(input.toolCallsCount !== undefined ? { toolCallsCount: input.toolCallsCount } : {}),
      ...(input.blockedCallsCount !== undefined
        ? { blockedCallsCount: input.blockedCallsCount }
        : {}),
      ...(input.recalledPatternsCount !== undefined
        ? { recalledPatternsCount: input.recalledPatternsCount }
        : {}),
      ...(input.recalledFilesCount !== undefined
        ? { recalledFilesCount: input.recalledFilesCount }
        : {}),
    };
    db.agentRuns = db.agentRuns.map((row) => (row.id === target.id ? next : row));
    await this.write(db);
    return next;
  }

  async listMemoryStatuses(
    workspaceId: string,
    opts: { status?: MemoryStatusValue } = {},
  ): Promise<MemoryStatusRecord[]> {
    const db = await this.read();
    return db.memoryStatuses
      .filter((row) => row.workspaceId === workspaceId)
      .filter((row) => (opts.status ? row.status === opts.status : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getMemoryStatus(
    workspaceId: string,
    memoryId: string,
  ): Promise<MemoryStatusRecord | null> {
    const db = await this.read();
    return (
      db.memoryStatuses.find(
        (row) => row.workspaceId === workspaceId && row.memoryId === memoryId,
      ) ?? null
    );
  }

  async upsertMemoryStatus(
    input: UpsertMemoryStatusInput,
  ): Promise<MemoryStatusRecord> {
    const db = await this.read();
    const status = input.status ?? "active";
    const existing = db.memoryStatuses.find(
      (row) => row.workspaceId === input.workspaceId && row.memoryId === input.memoryId,
    );
    if (existing) {
      const updatedRecord: MemoryStatusRecord = {
        ...existing,
        status,
        ...(input.trigSituation !== undefined ? { trigSituation: input.trigSituation } : {}),
        ...(input.bodyPreview !== undefined ? { bodyPreview: input.bodyPreview } : {}),
        ...(input.provenanceKind !== undefined ? { provenanceKind: input.provenanceKind } : {}),
        ...(input.provenanceId !== undefined ? { provenanceId: input.provenanceId } : {}),
        updatedAt: nowIso(),
      };
      db.memoryStatuses = db.memoryStatuses.map((row) =>
        row.workspaceId === existing.workspaceId && row.memoryId === existing.memoryId
          ? updatedRecord
          : row,
      );
      await this.write(db);
      return updatedRecord;
    }
    const created: MemoryStatusRecord = {
      workspaceId: input.workspaceId,
      memoryId: input.memoryId,
      status,
      ...(input.trigSituation ? { trigSituation: input.trigSituation } : {}),
      ...(input.bodyPreview ? { bodyPreview: input.bodyPreview } : {}),
      ...(input.provenanceKind ? { provenanceKind: input.provenanceKind } : {}),
      ...(input.provenanceId ? { provenanceId: input.provenanceId } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.memoryStatuses.unshift(created);
    await this.write(db);
    return created;
  }

  async changeMemoryStatus(
    input: ChangeMemoryStatusInput,
  ): Promise<{ status: MemoryStatusRecord; event: MemoryEventRecord }> {
    const db = await this.read();
    const isDelete = input.toStatus === "deleted";
    const existing = db.memoryStatuses.find(
      (row) => row.workspaceId === input.workspaceId && row.memoryId === input.memoryId,
    );
    let updatedRecord: MemoryStatusRecord;
    if (existing) {
      updatedRecord = {
        ...existing,
        status: input.toStatus,
        ...(isDelete ? { trigSituation: undefined, bodyPreview: undefined } : {}),
        updatedAt: nowIso(),
      };
      db.memoryStatuses = db.memoryStatuses.map((row) =>
        row.workspaceId === existing.workspaceId && row.memoryId === existing.memoryId
          ? updatedRecord
          : row,
      );
    } else {
      updatedRecord = {
        workspaceId: input.workspaceId,
        memoryId: input.memoryId,
        status: input.toStatus,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.memoryStatuses.unshift(updatedRecord);
    }
    const event: MemoryEventRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      memoryId: input.memoryId,
      actorKind: input.actorKind,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      action: input.toStatus === "deleted" ? "deleted" : (input.toStatus as MemoryEventAction),
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.sourceGithubItemId ? { sourceGithubItemId: input.sourceGithubItemId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: nowIso(),
    };
    db.memoryEvents.unshift(event);
    await this.write(db);
    return { status: updatedRecord, event };
  }

  async rollbackMemoryStatus(
    input: RollbackMemoryStatusInput,
  ): Promise<{
    status: MemoryStatusRecord;
    memoryEvent: MemoryEventRecord;
    rollbackEvent: RollbackEventRecord;
  } | null> {
    const db = await this.read();
    const events = db.memoryEvents
      .filter(
        (row) =>
          row.workspaceId === input.workspaceId &&
          row.memoryId === input.memoryId &&
          row.action !== "rollback",
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (events.length === 0) return null;
    const previous = events[1];
    const priorStatus: MemoryStatusValue = previous
      ? eventActionToStatus(previous.action)
      : "active";
    const target = db.memoryStatuses.find(
      (row) => row.workspaceId === input.workspaceId && row.memoryId === input.memoryId,
    );
    if (!target) return null;
    const updatedRecord: MemoryStatusRecord = {
      ...target,
      status: priorStatus,
      updatedAt: nowIso(),
    };
    db.memoryStatuses = db.memoryStatuses.map((row) =>
      row.workspaceId === target.workspaceId && row.memoryId === target.memoryId
        ? updatedRecord
        : row,
    );
    const memoryEvent: MemoryEventRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      memoryId: input.memoryId,
      actorKind: input.actorKind,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      action: "rollback",
      reason: input.reason,
      createdAt: nowIso(),
    };
    db.memoryEvents.unshift(memoryEvent);
    const rollbackEvent: RollbackEventRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      targetKind: "memory",
      targetId: input.memoryId,
      rollbackToId: priorStatus,
      reason: input.reason,
      createdAt: nowIso(),
    };
    db.rollbackEvents.unshift(rollbackEvent);
    await this.write(db);
    return { status: updatedRecord, memoryEvent, rollbackEvent };
  }

  async listMemoryEvents(
    workspaceId: string,
    opts: ListMemoryEventsOptions = {},
  ): Promise<MemoryEventRecord[]> {
    const db = await this.read();
    const limit = Math.min(Math.max(opts.limit ?? 250, 1), 1000);
    return db.memoryEvents
      .filter((row) => row.workspaceId === workspaceId)
      .filter((row) => (opts.memoryId ? row.memoryId === opts.memoryId : true))
      .filter((row) => (opts.action ? row.action === opts.action : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async createMemoryEvent(
    input: CreateMemoryEventInput,
  ): Promise<MemoryEventRecord> {
    const db = await this.read();
    const event: MemoryEventRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      memoryId: input.memoryId,
      actorKind: input.actorKind,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      action: input.action,
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.sourceGithubItemId ? { sourceGithubItemId: input.sourceGithubItemId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: nowIso(),
    };
    db.memoryEvents.unshift(event);
    await this.write(db);
    return event;
  }

  async listRollbackEvents(workspaceId: string): Promise<RollbackEventRecord[]> {
    const db = await this.read();
    return db.rollbackEvents
      .filter((row) => row.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 500);
  }

  async createRollbackEvent(
    input: CreateRollbackEventInput,
  ): Promise<RollbackEventRecord> {
    const db = await this.read();
    const event: RollbackEventRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      targetKind: input.targetKind,
      targetId: input.targetId,
      ...(input.rollbackToId ? { rollbackToId: input.rollbackToId } : {}),
      reason: input.reason,
      createdAt: nowIso(),
    };
    db.rollbackEvents.unshift(event);
    await this.write(db);
    return event;
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return {
        version: 1,
        integrations: Array.isArray(parsed.integrations) ? parsed.integrations : [],
        githubItems: Array.isArray(parsed.githubItems) ? parsed.githubItems : [],
        agents: Array.isArray(parsed.agents) ? parsed.agents : [],
        agentRuns: Array.isArray(parsed.agentRuns) ? parsed.agentRuns : [],
        memoryStatuses: Array.isArray(parsed.memoryStatuses) ? parsed.memoryStatuses : [],
        memoryEvents: Array.isArray(parsed.memoryEvents) ? parsed.memoryEvents : [],
        rollbackEvents: Array.isArray(parsed.rollbackEvents) ? parsed.rollbackEvents : [],
      };
    } catch {
      return emptyDb();
    }
  }

  private async write(db: FileShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(db, null, 2) + "\n");
  }
}

function emptyDb(): FileShape {
  return {
    version: 1,
    integrations: [],
    githubItems: [],
    agents: [],
    agentRuns: [],
    memoryStatuses: [],
    memoryEvents: [],
    rollbackEvents: [],
  };
}

// ---------------------------------------------------------------------------
// Row mappers (Postgres → record)
// ---------------------------------------------------------------------------

function mapIntegrationRow(row: Record<string, unknown>): IntegrationRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider: row.provider === "github" ? "github" : "github",
    accountLogin: String(row.account_login),
    ...(row.installation_id ? { installationId: String(row.installation_id) } : {}),
    ...(row.repo_full_name ? { repoFullName: String(row.repo_full_name) } : {}),
    status: normalizeIntegrationStatus(row.status),
    ...(row.last_sync_at ? { lastSyncAt: toIso(row.last_sync_at) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeIntegrationStatus(value: unknown): IntegrationStatus {
  if (value === "error" || value === "disabled" || value === "connected") return value;
  return "connected";
}

function mapGithubItemRow(row: Record<string, unknown>): GithubItemRecord {
  return {
    id: String(row.id),
    integrationId: String(row.integration_id),
    workspaceId: String(row.workspace_id),
    repoFullName: String(row.repo_full_name),
    kind: normalizeGithubItemKind(row.kind),
    externalId: String(row.external_id),
    ...(row.number !== null && row.number !== undefined ? { number: Number(row.number) } : {}),
    ...(row.title ? { title: String(row.title) } : {}),
    ...(row.state ? { state: String(row.state) } : {}),
    url: String(row.url),
    ...(row.author_login ? { authorLogin: String(row.author_login) } : {}),
    ...(row.body_summary ? { bodySummary: String(row.body_summary) } : {}),
    labels: parseJsonStringArray(row.labels),
    linkedFiles: parseJsonStringArray(row.linked_files),
    ...(row.created_at_remote ? { createdAtRemote: toIso(row.created_at_remote) } : {}),
    ...(row.updated_at_remote ? { updatedAtRemote: toIso(row.updated_at_remote) } : {}),
    ingestedAt: toIso(row.ingested_at),
  };
}

function normalizeGithubItemKind(value: unknown): GithubItemKind {
  const allowed: GithubItemKind[] = [
    "issue",
    "pull_request",
    "commit",
    "check_run",
    "review_comment",
  ];
  if (typeof value === "string" && (allowed as string[]).includes(value)) return value as GithubItemKind;
  return "issue";
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((v: unknown): v is string => typeof v === "string");
    } catch {
      return [];
    }
  }
  return [];
}

function mapAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    displayName: String(row.display_name),
    ...(row.owner_label ? { ownerLabel: String(row.owner_label) } : {}),
    host: normalizeAgentHost(row.host),
    status: normalizeAgentStatus(row.status),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeAgentHost(value: unknown): AgentHost {
  const allowed: AgentHost[] = [
    "claude-code",
    "codex",
    "cursor",
    "openai",
    "anthropic",
    "generic",
  ];
  if (typeof value === "string" && (allowed as string[]).includes(value)) return value as AgentHost;
  return "generic";
}

function normalizeAgentStatus(value: unknown): "active" | "idle" | "disabled" {
  if (value === "active" || value === "idle" || value === "disabled") return value;
  return "active";
}

function mapAgentRunRow(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ...(row.agent_id ? { agentId: String(row.agent_id) } : {}),
    sessionId: String(row.session_id),
    ...(row.task_title ? { taskTitle: String(row.task_title) } : {}),
    taskSourceKind: normalizeTaskSourceKind(row.task_source_kind),
    ...(row.task_source_id ? { taskSourceId: String(row.task_source_id) } : {}),
    startedAt: toIso(row.started_at),
    ...(row.ended_at ? { endedAt: toIso(row.ended_at) } : {}),
    status: normalizeAgentRunStatus(row.status),
    tokensInjected: Number(row.tokens_injected ?? 0),
    tokensSavedEstimated: Number(row.tokens_saved_estimated ?? 0),
    toolCallsCount: Number(row.tool_calls_count ?? 0),
    blockedCallsCount: Number(row.blocked_calls_count ?? 0),
    recalledPatternsCount: Number(row.recalled_patterns_count ?? 0),
    recalledFilesCount: Number(row.recalled_files_count ?? 0),
  };
}

function normalizeTaskSourceKind(value: unknown): AgentRunSourceKind {
  if (value === "github_issue" || value === "pull_request" || value === "ci_failure" || value === "manual") {
    return value;
  }
  return "manual";
}

function normalizeAgentRunStatus(value: unknown): AgentRunStatus {
  if (value === "running" || value === "resolved" || value === "failed" || value === "abandoned") {
    return value;
  }
  return "running";
}

function mapMemoryStatusRow(row: Record<string, unknown>): MemoryStatusRecord {
  return {
    workspaceId: String(row.workspace_id),
    memoryId: String(row.memory_id),
    status: normalizeMemoryStatusValue(row.status),
    ...(row.trig_situation ? { trigSituation: String(row.trig_situation) } : {}),
    ...(row.body_preview ? { bodyPreview: String(row.body_preview) } : {}),
    ...(row.provenance_kind ? { provenanceKind: normalizeProvenanceKind(row.provenance_kind) } : {}),
    ...(row.provenance_id ? { provenanceId: String(row.provenance_id) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeMemoryStatusValue(value: unknown): MemoryStatusValue {
  const allowed: MemoryStatusValue[] = ["active", "candidate", "retired", "superseded", "deleted"];
  if (typeof value === "string" && (allowed as string[]).includes(value)) return value as MemoryStatusValue;
  return "active";
}

function normalizeProvenanceKind(
  value: unknown,
): "agent_run" | "github_item" | "manual" | "imported" {
  if (
    value === "agent_run" ||
    value === "github_item" ||
    value === "manual" ||
    value === "imported"
  ) {
    return value;
  }
  return "manual";
}

function mapMemoryEventRow(row: Record<string, unknown>): MemoryEventRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    memoryId: String(row.memory_id),
    actorKind: normalizeActorKind(row.actor_kind),
    ...(row.actor_id ? { actorId: String(row.actor_id) } : {}),
    action: normalizeMemoryEventAction(row.action),
    ...(row.source_run_id ? { sourceRunId: String(row.source_run_id) } : {}),
    ...(row.source_github_item_id
      ? { sourceGithubItemId: String(row.source_github_item_id) }
      : {}),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    createdAt: toIso(row.created_at),
  };
}

function normalizeActorKind(value: unknown): MemoryEventActorKind {
  if (value === "agent" || value === "human" || value === "system") return value;
  return "system";
}

function normalizeMemoryEventAction(value: unknown): MemoryEventAction {
  const allowed: MemoryEventAction[] = [
    "created",
    "used",
    "retired",
    "deleted",
    "superseded",
    "rollback",
  ];
  if (typeof value === "string" && (allowed as string[]).includes(value)) return value as MemoryEventAction;
  return "used";
}

function mapRollbackEventRow(row: Record<string, unknown>): RollbackEventRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ...(row.actor_id ? { actorId: String(row.actor_id) } : {}),
    targetKind: normalizeRollbackTargetKind(row.target_kind),
    targetId: String(row.target_id),
    ...(row.rollback_to_id ? { rollbackToId: String(row.rollback_to_id) } : {}),
    reason: String(row.reason ?? ""),
    createdAt: toIso(row.created_at),
  };
}

function normalizeRollbackTargetKind(value: unknown): RollbackTargetKind {
  if (value === "memory" || value === "agent_run" || value === "github_item") return value;
  return "memory";
}

// Re-exported only so test code that imports this module can verify
// the helper without re-importing internals.
export const _internals = {
  optionalIso,
  eventActionToStatus,
};
