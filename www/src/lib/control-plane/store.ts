import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Pool, type PoolConfig } from "pg";
import { generateApiKeyMaterial, parseApiKey, verifyApiKeySecret } from "@/lib/control-plane/crypto";
import type {
  ControlPlaneApiKey,
  ControlPlaneDeviceSession,
  ControlPlaneInstallation,
  ControlPlaneUsageSample,
  ControlPlaneWorkspace,
  CreatedApiKey,
  DevicePollApprovedPayload,
  DeviceStartResult,
} from "@/lib/control-plane/types";

export interface ControlPlaneStore {
  ensurePersonalWorkspaceForUser(input: {
    clerkUserId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<ControlPlaneWorkspace>;
  listApiKeys(workspaceId: string): Promise<ControlPlaneApiKey[]>;
  createApiKey(workspaceId: string, label: string): Promise<CreatedApiKey>;
  resolveWorkspaceByApiKey(apiKey: string): Promise<{
    workspace: ControlPlaneWorkspace;
    apiKey: ControlPlaneApiKey;
  } | null>;
  upsertInstallation(input: {
    workspaceId: string;
    localWorkspaceId: string;
    projectName: string;
    agent: string;
    cliVersion?: string;
  }): Promise<ControlPlaneInstallation>;
  listInstallations(workspaceId: string): Promise<ControlPlaneInstallation[]>;
  getInstallationById(input: {
    workspaceId: string;
    installationId: string;
  }): Promise<ControlPlaneInstallation | null>;
  /**
   * Upsert a rolled-up usage sample for one installation in one time
   * window. Idempotent on (installationId, windowStart, windowEnd).
   * Re-pushing the same window overwrites the previous sample; a CLI
   * that retries a failed push therefore cannot double-count.
   */
  upsertUsageSample(input: {
    workspaceId: string;
    installationId: string;
    windowStart: string;
    windowEnd: string;
    metrics: Record<string, unknown>;
    cliVersion?: string;
  }): Promise<ControlPlaneUsageSample>;
  /**
   * List samples for a workspace, optionally bounded by a time
   * window. Ordered by (windowStart DESC, installationId) so the
   * dashboard can render a timeseries without re-sorting.
   */
  listUsageSamples(input: {
    workspaceId: string;
    afterTs?: string;
    beforeTs?: string;
  }): Promise<ControlPlaneUsageSample[]>;
  startDeviceSession(input: {
    localWorkspaceId: string;
    projectName: string;
    agent: string;
    cliVersion?: string;
    verificationUrlBase: string;
  }): Promise<DeviceStartResult>;
  approveDeviceSession(input: {
    deviceCode: string;
    clerkUserId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<DevicePollApprovedPayload | null>;
  pollDeviceSession(deviceCode: string): Promise<
    | { status: "pending"; expiresAt: string }
    | { status: "approved"; payload: DevicePollApprovedPayload }
    | { status: "expired" }
    | { status: "not_found" }
  >;
}

type FileDb = {
  version: 1;
  workspaces: StoredWorkspace[];
  apiKeys: StoredApiKey[];
  installations: ControlPlaneInstallation[];
  deviceSessions: ControlPlaneDeviceSession[];
  usageSamples?: ControlPlaneUsageSample[];
};

type StoredWorkspace = ControlPlaneWorkspace;

type StoredApiKey = ControlPlaneApiKey & {
  secretHash: string;
  salt: string;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tracebase_workspaces (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  clerk_user_id TEXT,
  clerk_org_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tracebase_workspaces_personal_user_idx
  ON tracebase_workspaces (clerk_user_id)
  WHERE scope = 'personal';

CREATE TABLE IF NOT EXISTS tracebase_api_keys (
  id TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  last4 TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tracebase_installations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  local_workspace_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  agent TEXT NOT NULL,
  cli_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, local_workspace_id)
);

-- Per-agent identity: a single project can wire up multiple adapters
-- (Claude Code + Cursor + Codex) and each needs its own installation
-- row so usage samples and the dashboard attribute correctly.
-- The legacy 2-tuple UNIQUE above is dropped below after this index
-- is guaranteed to exist.
CREATE UNIQUE INDEX IF NOT EXISTS tracebase_installations_per_agent_idx
  ON tracebase_installations (workspace_id, local_workspace_id, agent);

ALTER TABLE tracebase_installations
  DROP CONSTRAINT IF EXISTS tracebase_installations_workspace_id_local_workspace_id_key;

CREATE TABLE IF NOT EXISTS tracebase_usage_samples (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES tracebase_installations(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  metrics JSONB NOT NULL,
  cli_version TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (installation_id, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS tracebase_usage_samples_workspace_window_idx
  ON tracebase_usage_samples (workspace_id, window_start DESC);

CREATE TABLE IF NOT EXISTS tracebase_device_sessions (
  id UUID PRIMARY KEY,
  device_code TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL,
  local_workspace_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  agent TEXT NOT NULL,
  cli_version TEXT,
  status TEXT NOT NULL,
  workspace_id UUID REFERENCES tracebase_workspaces(id) ON DELETE SET NULL,
  issued_api_key_id TEXT,
  issued_api_key_value TEXT,
  installation_id UUID REFERENCES tracebase_installations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Engineering Brain (Phase 1 — additive, idempotent migration).
-- All tables CASCADE off tracebase_workspaces so a deleted workspace
-- takes its Engineering Brain reflection with it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tracebase_integrations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account_login TEXT NOT NULL,
  installation_id TEXT,
  repo_full_name TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tracebase_integrations_workspace_provider_account_idx
  ON tracebase_integrations (workspace_id, provider, account_login, COALESCE(repo_full_name, ''));

CREATE TABLE IF NOT EXISTS tracebase_github_items (
  id UUID PRIMARY KEY,
  integration_id UUID NOT NULL REFERENCES tracebase_integrations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  number INTEGER,
  title TEXT,
  state TEXT,
  url TEXT NOT NULL,
  author_login TEXT,
  body_summary TEXT,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at_remote TIMESTAMPTZ,
  updated_at_remote TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Provider-item identity: (integration, kind, external_id) is the natural key.
CREATE UNIQUE INDEX IF NOT EXISTS tracebase_github_items_identity_idx
  ON tracebase_github_items (integration_id, kind, external_id);

CREATE INDEX IF NOT EXISTS tracebase_github_items_workspace_repo_idx
  ON tracebase_github_items (workspace_id, repo_full_name);

CREATE TABLE IF NOT EXISTS tracebase_agents (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  owner_label TEXT,
  host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tracebase_agents_workspace_idx
  ON tracebase_agents (workspace_id);

CREATE UNIQUE INDEX IF NOT EXISTS tracebase_agents_workspace_name_idx
  ON tracebase_agents (workspace_id, display_name);

CREATE TABLE IF NOT EXISTS tracebase_agent_runs (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES tracebase_agents(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL,
  task_title TEXT,
  task_source_kind TEXT NOT NULL DEFAULT 'manual',
  task_source_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  tokens_injected INTEGER NOT NULL DEFAULT 0,
  tokens_saved_estimated INTEGER NOT NULL DEFAULT 0,
  tool_calls_count INTEGER NOT NULL DEFAULT 0,
  blocked_calls_count INTEGER NOT NULL DEFAULT 0,
  recalled_patterns_count INTEGER NOT NULL DEFAULT 0,
  recalled_files_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tracebase_agent_runs_workspace_started_idx
  ON tracebase_agent_runs (workspace_id, started_at DESC);

CREATE INDEX IF NOT EXISTS tracebase_agent_runs_session_idx
  ON tracebase_agent_runs (session_id);

-- memory_status: light catalog of memory IDs and their current status.
-- The full memory body lives in the SDK store (SQLite); this table is the
-- governance/audit reflection that the dashboard reads. Hard delete only
-- nulls bodyPreview/trigSituation; the row itself is kept so audit chains
-- (memory_events, rollback_events) keep referencing a real id.
CREATE TABLE IF NOT EXISTS tracebase_memory_status (
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  trig_situation TEXT,
  body_preview TEXT,
  provenance_kind TEXT,
  provenance_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, memory_id)
);

CREATE INDEX IF NOT EXISTS tracebase_memory_status_workspace_status_idx
  ON tracebase_memory_status (workspace_id, status);

CREATE TABLE IF NOT EXISTS tracebase_memory_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  source_run_id UUID REFERENCES tracebase_agent_runs(id) ON DELETE SET NULL,
  source_github_item_id UUID REFERENCES tracebase_github_items(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tracebase_memory_events_workspace_memory_idx
  ON tracebase_memory_events (workspace_id, memory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tracebase_memory_events_workspace_created_idx
  ON tracebase_memory_events (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tracebase_rollback_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES tracebase_workspaces(id) ON DELETE CASCADE,
  actor_id TEXT,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rollback_to_id TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tracebase_rollback_events_workspace_target_idx
  ON tracebase_rollback_events (workspace_id, target_kind, target_id, created_at DESC);
`;

let cachedStorePromise: Promise<ControlPlaneStore> | null = null;

export function getControlPlaneApiBaseUrl(): string {
  const raw =
    process.env.TRACEBASE_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.TRACEBASE_API_URL ??
    "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

export function getControlPlaneStore(): Promise<ControlPlaneStore> {
  if (!cachedStorePromise) {
    cachedStorePromise = createStore();
  }
  return cachedStorePromise;
}

async function createStore(): Promise<ControlPlaneStore> {
  const postgresConfig = resolvePostgresPoolConfig();
  if (postgresConfig) {
    const store = new PostgresControlPlaneStore(postgresConfig);
    await store.init();
    return store;
  }

  const filePath =
    process.env.TRACEBASE_CONTROL_PLANE_FILE ??
    join(process.cwd(), ".tracebase", "control-plane.dev.json");
  const store = new FileControlPlaneStore(filePath);
  await store.init();
  return store;
}

class PostgresControlPlaneStore implements ControlPlaneStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      ...config,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async ensurePersonalWorkspaceForUser(input: {
    clerkUserId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<ControlPlaneWorkspace> {
    const existing = await this.pool.query(
      `
      SELECT *
      FROM tracebase_workspaces
      WHERE scope = 'personal' AND clerk_user_id = $1
      LIMIT 1
      `,
      [input.clerkUserId],
    );

    if (existing.rowCount) {
      return mapWorkspaceRow(existing.rows[0]);
    }

    const id = randomUUID();
    const displayName = personalWorkspaceName(input.name, input.email);
    const slug = await this.findAvailableSlug(baseWorkspaceSlug(input.name, input.email));

    const inserted = await this.pool.query(
      `
      INSERT INTO tracebase_workspaces (
        id, scope, slug, display_name, clerk_user_id
      ) VALUES ($1, 'personal', $2, $3, $4)
      RETURNING *
      `,
      [id, slug, displayName, input.clerkUserId],
    );

    return mapWorkspaceRow(inserted.rows[0]);
  }

  async listApiKeys(workspaceId: string): Promise<ControlPlaneApiKey[]> {
    const res = await this.pool.query(
      `
      SELECT id, workspace_id, label, prefix, last4, created_at, last_used_at, revoked_at
      FROM tracebase_api_keys
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      `,
      [workspaceId],
    );
    return res.rows.map(mapApiKeyRow);
  }

  async createApiKey(workspaceId: string, label: string): Promise<CreatedApiKey> {
    const material = generateApiKeyMaterial();
    const inserted = await this.pool.query(
      `
      INSERT INTO tracebase_api_keys (
        id, workspace_id, label, prefix, last4, secret_hash, salt
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, workspace_id, label, prefix, last4, created_at, last_used_at, revoked_at
      `,
      [
        material.id,
        workspaceId,
        label,
        material.prefix,
        material.last4,
        material.secretHash,
        material.salt,
      ],
    );

    return {
      ...mapApiKeyRow(inserted.rows[0]),
      value: material.value,
    };
  }

  async resolveWorkspaceByApiKey(apiKey: string): Promise<{
    workspace: ControlPlaneWorkspace;
    apiKey: ControlPlaneApiKey;
  } | null> {
    const parsed = parseApiKey(apiKey);
    if (!parsed) return null;

    const res = await this.pool.query(
      `
      SELECT
        k.id AS api_key_id,
        k.workspace_id AS api_key_workspace_id,
        k.label AS api_key_label,
        k.prefix AS api_key_prefix,
        k.last4 AS api_key_last4,
        k.secret_hash,
        k.salt,
        k.created_at AS api_key_created_at,
        k.last_used_at AS api_key_last_used_at,
        k.revoked_at AS api_key_revoked_at,
        w.id AS workspace_id,
        w.scope AS workspace_scope,
        w.slug AS workspace_slug,
        w.display_name AS workspace_display_name,
        w.clerk_user_id AS workspace_clerk_user_id,
        w.clerk_org_id AS workspace_clerk_org_id,
        w.created_at AS workspace_created_at,
        w.updated_at AS workspace_updated_at
      FROM tracebase_api_keys k
      INNER JOIN tracebase_workspaces w ON w.id = k.workspace_id
      WHERE k.id = $1 AND k.revoked_at IS NULL
      LIMIT 1
      `,
      [parsed.id],
    );

    if (!res.rowCount) return null;
    const row = res.rows[0];
    if (!verifyApiKeySecret(parsed.secret, String(row.salt), String(row.secret_hash))) {
      return null;
    }

    await this.pool.query(
      `UPDATE tracebase_api_keys SET last_used_at = NOW() WHERE id = $1`,
      [parsed.id],
    );

    return {
      workspace: mapJoinedWorkspaceRow(row),
      apiKey: {
        id: String(row.api_key_id),
        workspaceId: String(row.api_key_workspace_id),
        label: String(row.api_key_label),
        prefix: String(row.api_key_prefix),
        last4: String(row.api_key_last4),
        createdAt: toIso(row.api_key_created_at),
        ...(row.api_key_last_used_at ? { lastUsedAt: toIso(row.api_key_last_used_at) } : {}),
        ...(row.api_key_revoked_at ? { revokedAt: toIso(row.api_key_revoked_at) } : {}),
      },
    };
  }

  async upsertInstallation(input: {
    workspaceId: string;
    localWorkspaceId: string;
    projectName: string;
    agent: string;
    cliVersion?: string;
  }): Promise<ControlPlaneInstallation> {
    // Per-agent identity: match the 3-tuple so each adapter in a
    // multi-agent project gets its own row. A pre-migration row that
    // still matches only the 2-tuple is re-keyed to the current agent
    // on first touch, then additional agents insert fresh rows.
    const existing = await this.pool.query(
      `
      SELECT *
      FROM tracebase_installations
      WHERE workspace_id = $1 AND local_workspace_id = $2 AND agent = $3
      LIMIT 1
      `,
      [input.workspaceId, input.localWorkspaceId, input.agent],
    );

    if (existing.rowCount) {
      const updated = await this.pool.query(
        `
        UPDATE tracebase_installations
        SET project_name = $3,
            cli_version = $4,
            updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2
        RETURNING *
        `,
        [
          existing.rows[0].id,
          input.workspaceId,
          input.projectName,
          input.cliVersion ?? null,
        ],
      );
      return mapInstallationRow(updated.rows[0]);
    }

    const inserted = await this.pool.query(
      `
      INSERT INTO tracebase_installations (
        id, workspace_id, local_workspace_id, project_name, agent, cli_version
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        randomUUID(),
        input.workspaceId,
        input.localWorkspaceId,
        input.projectName,
        input.agent,
        input.cliVersion ?? null,
      ],
    );
    return mapInstallationRow(inserted.rows[0]);
  }

  async listInstallations(workspaceId: string): Promise<ControlPlaneInstallation[]> {
    const res = await this.pool.query(
      `
      SELECT *
      FROM tracebase_installations
      WHERE workspace_id = $1
      ORDER BY updated_at DESC
      `,
      [workspaceId],
    );
    return res.rows.map(mapInstallationRow);
  }

  async getInstallationById(input: {
    workspaceId: string;
    installationId: string;
  }): Promise<ControlPlaneInstallation | null> {
    const res = await this.pool.query(
      `
      SELECT *
      FROM tracebase_installations
      WHERE workspace_id = $1 AND id = $2
      LIMIT 1
      `,
      [input.workspaceId, input.installationId],
    );
    if (!res.rowCount) return null;
    return mapInstallationRow(res.rows[0]);
  }

  async upsertUsageSample(input: {
    workspaceId: string;
    installationId: string;
    windowStart: string;
    windowEnd: string;
    metrics: Record<string, unknown>;
    cliVersion?: string;
  }): Promise<ControlPlaneUsageSample> {
    const res = await this.pool.query(
      `
      INSERT INTO tracebase_usage_samples (
        id, workspace_id, installation_id, window_start, window_end, metrics, cli_version
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (installation_id, window_start, window_end)
      DO UPDATE SET
        metrics = EXCLUDED.metrics,
        cli_version = EXCLUDED.cli_version,
        received_at = NOW()
      RETURNING *
      `,
      [
        randomUUID(),
        input.workspaceId,
        input.installationId,
        input.windowStart,
        input.windowEnd,
        JSON.stringify(input.metrics),
        input.cliVersion ?? null,
      ],
    );
    return mapUsageSampleRow(res.rows[0]);
  }

  async listUsageSamples(input: {
    workspaceId: string;
    afterTs?: string;
    beforeTs?: string;
  }): Promise<ControlPlaneUsageSample[]> {
    const params: unknown[] = [input.workspaceId];
    const clauses: string[] = ["workspace_id = $1"];
    if (input.afterTs) {
      params.push(input.afterTs);
      clauses.push(`window_end > $${params.length}`);
    }
    if (input.beforeTs) {
      params.push(input.beforeTs);
      clauses.push(`window_start < $${params.length}`);
    }
    const res = await this.pool.query(
      `
      SELECT *
      FROM tracebase_usage_samples
      WHERE ${clauses.join(" AND ")}
      ORDER BY window_start DESC, installation_id
      `,
      params,
    );
    return res.rows.map(mapUsageSampleRow);
  }

  async startDeviceSession(input: {
    localWorkspaceId: string;
    projectName: string;
    agent: string;
    cliVersion?: string;
    verificationUrlBase: string;
  }): Promise<DeviceStartResult> {
    const deviceCode = randomUUID();
    const userCode = createUserCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await this.pool.query(
      `
      INSERT INTO tracebase_device_sessions (
        id, device_code, user_code, local_workspace_id, project_name, agent, cli_version, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
      `,
      [
        randomUUID(),
        deviceCode,
        userCode,
        input.localWorkspaceId,
        input.projectName,
        input.agent,
        input.cliVersion ?? null,
        expiresAt,
      ],
    );

    return {
      deviceCode,
      userCode,
      verificationUrl: `${input.verificationUrlBase.replace(/\/+$/, "")}/install/cli?device=${encodeURIComponent(deviceCode)}`,
      expiresAt,
      pollIntervalMs: 2000,
    };
  }

  async approveDeviceSession(input: {
    deviceCode: string;
    clerkUserId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<DevicePollApprovedPayload | null> {
    const sessionRes = await this.pool.query(
      `
      SELECT *
      FROM tracebase_device_sessions
      WHERE device_code = $1
      LIMIT 1
      `,
      [input.deviceCode],
    );
    if (!sessionRes.rowCount) return null;

    const session = sessionRes.rows[0];
    if (session.status !== "pending") {
      return session.status === "approved"
        ? await this.readApprovedPayload(input.deviceCode)
        : null;
    }
    if (isExpired(session.expires_at)) {
      await this.pool.query(
        `UPDATE tracebase_device_sessions SET status = 'expired' WHERE device_code = $1`,
        [input.deviceCode],
      );
      return null;
    }

    const workspace = await this.ensurePersonalWorkspaceForUser({
      clerkUserId: input.clerkUserId,
      email: input.email,
      name: input.name,
    });
    const apiKey = await this.createApiKey(workspace.id, `cli install ${session.project_name}`);
    const installation = await this.upsertInstallation({
      workspaceId: workspace.id,
      localWorkspaceId: String(session.local_workspace_id),
      projectName: String(session.project_name),
      agent: String(session.agent),
      ...(session.cli_version ? { cliVersion: String(session.cli_version) } : {}),
    });

    await this.pool.query(
      `
      UPDATE tracebase_device_sessions
      SET status = 'approved',
          workspace_id = $2,
          issued_api_key_id = $3,
          issued_api_key_value = $4,
          installation_id = $5,
          approved_at = NOW()
      WHERE device_code = $1
      `,
      [input.deviceCode, workspace.id, apiKey.id, apiKey.value, installation.id],
    );

    return {
      workspace,
      apiKey: apiKey.value,
      installation,
    };
  }

  async pollDeviceSession(deviceCode: string): Promise<
    | { status: "pending"; expiresAt: string }
    | { status: "approved"; payload: DevicePollApprovedPayload }
    | { status: "expired" }
    | { status: "not_found" }
  > {
    const sessionRes = await this.pool.query(
      `
      SELECT *
      FROM tracebase_device_sessions
      WHERE device_code = $1
      LIMIT 1
      `,
      [deviceCode],
    );
    if (!sessionRes.rowCount) return { status: "not_found" };

    const session = sessionRes.rows[0];
    if (session.status === "pending") {
      if (isExpired(session.expires_at)) {
        await this.pool.query(
          `UPDATE tracebase_device_sessions SET status = 'expired' WHERE device_code = $1`,
          [deviceCode],
        );
        return { status: "expired" };
      }
      return { status: "pending", expiresAt: toIso(session.expires_at) };
    }

    if (session.status === "expired") {
      return { status: "expired" };
    }

    if (session.status === "consumed") {
      return { status: "not_found" };
    }

    const payload = await this.readApprovedPayload(deviceCode);
    if (!payload) return { status: "not_found" };

    await this.pool.query(
      `
      UPDATE tracebase_device_sessions
      SET status = 'consumed',
          issued_api_key_value = NULL,
          consumed_at = NOW()
      WHERE device_code = $1
      `,
      [deviceCode],
    );

    return {
      status: "approved",
      payload,
    };
  }

  private async findAvailableSlug(base: string): Promise<string> {
    const sanitizedBase = base || "workspace";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = attempt === 0 ? sanitizedBase : `${sanitizedBase}-${attempt + 1}`;
      const res = await this.pool.query(
        `SELECT 1 FROM tracebase_workspaces WHERE slug = $1 LIMIT 1`,
        [candidate],
      );
      if (!res.rowCount) return candidate;
    }

    return `${sanitizedBase}-${randomUUID().slice(0, 8)}`;
  }

  private async readApprovedPayload(deviceCode: string): Promise<DevicePollApprovedPayload | null> {
    const res = await this.pool.query(
      `
      SELECT
        s.issued_api_key_value,
        i.id AS installation_id,
        i.workspace_id AS installation_workspace_id,
        i.local_workspace_id AS installation_local_workspace_id,
        i.project_name AS installation_project_name,
        i.agent AS installation_agent,
        i.cli_version AS installation_cli_version,
        i.created_at AS installation_created_at,
        i.updated_at AS installation_updated_at,
        w.id AS workspace_id,
        w.scope AS workspace_scope,
        w.slug AS workspace_slug,
        w.display_name AS workspace_display_name,
        w.clerk_user_id AS workspace_clerk_user_id,
        w.clerk_org_id AS workspace_clerk_org_id,
        w.created_at AS workspace_created_at,
        w.updated_at AS workspace_updated_at
      FROM tracebase_device_sessions s
      INNER JOIN tracebase_installations i ON i.id = s.installation_id
      INNER JOIN tracebase_workspaces w ON w.id = s.workspace_id
      WHERE s.device_code = $1 AND s.status = 'approved'
      LIMIT 1
      `,
      [deviceCode],
    );

    if (!res.rowCount) return null;
    const row = res.rows[0];
    if (!row.issued_api_key_value) return null;

    return {
      workspace: mapJoinedWorkspaceRow(row),
      apiKey: String(row.issued_api_key_value),
      installation: {
        id: String(row.installation_id),
        workspaceId: String(row.installation_workspace_id),
        localWorkspaceId: String(row.installation_local_workspace_id),
        projectName: String(row.installation_project_name),
        agent: String(row.installation_agent),
        ...(row.installation_cli_version ? { cliVersion: String(row.installation_cli_version) } : {}),
        createdAt: toIso(row.installation_created_at),
        updatedAt: toIso(row.installation_updated_at),
      },
    };
  }
}

function resolvePostgresPoolConfig(): PoolConfig | null {
  const max = Number(process.env.TRACEBASE_DATABASE_POOL_MAX ?? 5);
  const connectionString = process.env.TRACEBASE_DATABASE_URL ?? process.env.DATABASE_URL;

  if (connectionString) {
    return {
      connectionString,
      max,
      application_name: "tracebase-control-plane",
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
    application_name: "tracebase-control-plane",
  };
}

class FileControlPlaneStore implements ControlPlaneStore {
  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf-8");
    } catch {
      await this.writeDb({
        version: 1,
        workspaces: [],
        apiKeys: [],
        installations: [],
        deviceSessions: [],
        usageSamples: [],
      });
    }
  }

  async ensurePersonalWorkspaceForUser(input: {
    clerkUserId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<ControlPlaneWorkspace> {
    const db = await this.readDb();
    const existing = db.workspaces.find(
      (workspace) => workspace.scope === "personal" && workspace.clerkUserId === input.clerkUserId,
    );
    if (existing) return existing;

    const workspace: ControlPlaneWorkspace = {
      id: randomUUID(),
      scope: "personal",
      slug: this.findAvailableSlug(db, baseWorkspaceSlug(input.name, input.email)),
      displayName: personalWorkspaceName(input.name, input.email),
      clerkUserId: input.clerkUserId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.workspaces.unshift(workspace);
    await this.writeDb(db);
    return workspace;
  }

  async listApiKeys(workspaceId: string): Promise<ControlPlaneApiKey[]> {
    const db = await this.readDb();
    return db.apiKeys
      .filter((key) => key.workspaceId === workspaceId)
      .map(stripStoredApiKey)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createApiKey(workspaceId: string, label: string): Promise<CreatedApiKey> {
    const db = await this.readDb();
    const material = generateApiKeyMaterial();
    const stored: StoredApiKey = {
      id: material.id,
      workspaceId,
      label,
      prefix: material.prefix,
      last4: material.last4,
      secretHash: material.secretHash,
      salt: material.salt,
      createdAt: nowIso(),
    };
    db.apiKeys.unshift(stored);
    await this.writeDb(db);
    return {
      ...stripStoredApiKey(stored),
      value: material.value,
    };
  }

  async resolveWorkspaceByApiKey(apiKey: string): Promise<{
    workspace: ControlPlaneWorkspace;
    apiKey: ControlPlaneApiKey;
  } | null> {
    const parsed = parseApiKey(apiKey);
    if (!parsed) return null;

    const db = await this.readDb();
    const key = db.apiKeys.find((row) => row.id === parsed.id && !row.revokedAt);
    if (!key) return null;
    if (!verifyApiKeySecret(parsed.secret, key.salt, key.secretHash)) {
      return null;
    }

    key.lastUsedAt = nowIso();
    await this.writeDb(db);

    const workspace = db.workspaces.find((row) => row.id === key.workspaceId);
    if (!workspace) return null;

    return {
      workspace,
      apiKey: stripStoredApiKey(key),
    };
  }

  async upsertInstallation(input: {
    workspaceId: string;
    localWorkspaceId: string;
    projectName: string;
    agent: string;
    cliVersion?: string;
  }): Promise<ControlPlaneInstallation> {
    const db = await this.readDb();
    // Per-agent identity: match on the (workspace, local, agent)
    // triple so each adapter in a multi-agent project gets its own
    // row. Pre-migration file stores with no `agent` on some rows
    // fall back to the 2-tuple once for migration convenience.
    const existing =
      db.installations.find(
        (row) =>
          row.workspaceId === input.workspaceId &&
          row.localWorkspaceId === input.localWorkspaceId &&
          row.agent === input.agent,
      ) ??
      db.installations.find(
        (row) =>
          row.workspaceId === input.workspaceId &&
          row.localWorkspaceId === input.localWorkspaceId &&
          !row.agent,
      );
    if (existing) {
      existing.projectName = input.projectName;
      existing.agent = input.agent;
      existing.cliVersion = input.cliVersion;
      existing.updatedAt = nowIso();
      await this.writeDb(db);
      return existing;
    }

    const installation: ControlPlaneInstallation = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      localWorkspaceId: input.localWorkspaceId,
      projectName: input.projectName,
      agent: input.agent,
      ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.installations.unshift(installation);
    await this.writeDb(db);
    return installation;
  }

  async listInstallations(workspaceId: string): Promise<ControlPlaneInstallation[]> {
    const db = await this.readDb();
    return db.installations
      .filter((row) => row.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getInstallationById(input: {
    workspaceId: string;
    installationId: string;
  }): Promise<ControlPlaneInstallation | null> {
    const db = await this.readDb();
    const found = db.installations.find(
      (row) => row.workspaceId === input.workspaceId && row.id === input.installationId,
    );
    return found ?? null;
  }

  async upsertUsageSample(input: {
    workspaceId: string;
    installationId: string;
    windowStart: string;
    windowEnd: string;
    metrics: Record<string, unknown>;
    cliVersion?: string;
  }): Promise<ControlPlaneUsageSample> {
    const db = await this.readDb();
    const samples = db.usageSamples ?? [];
    const key = (s: ControlPlaneUsageSample) =>
      s.installationId === input.installationId &&
      s.windowStart === input.windowStart &&
      s.windowEnd === input.windowEnd;
    const existing = samples.find(key);
    const now = nowIso();
    const row: ControlPlaneUsageSample = existing
      ? {
          ...existing,
          metrics: input.metrics,
          ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
          receivedAt: now,
        }
      : {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          installationId: input.installationId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          metrics: input.metrics,
          ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
          receivedAt: now,
        };
    const next = existing ? samples.map((s) => (key(s) ? row : s)) : [row, ...samples];
    db.usageSamples = next;
    await this.writeDb(db);
    return row;
  }

  async listUsageSamples(input: {
    workspaceId: string;
    afterTs?: string;
    beforeTs?: string;
  }): Promise<ControlPlaneUsageSample[]> {
    const db = await this.readDb();
    const samples = db.usageSamples ?? [];
    return samples
      .filter((s) => s.workspaceId === input.workspaceId)
      .filter((s) => (input.afterTs ? s.windowEnd > input.afterTs : true))
      .filter((s) => (input.beforeTs ? s.windowStart < input.beforeTs : true))
      .sort((a, b) => {
        if (a.windowStart !== b.windowStart) return b.windowStart.localeCompare(a.windowStart);
        return a.installationId.localeCompare(b.installationId);
      });
  }

  async startDeviceSession(input: {
    localWorkspaceId: string;
    projectName: string;
    agent: string;
    cliVersion?: string;
    verificationUrlBase: string;
  }): Promise<DeviceStartResult> {
    const db = await this.readDb();
    const deviceCode = randomUUID();
    const userCode = createUserCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.deviceSessions.unshift({
      id: randomUUID(),
      deviceCode,
      userCode,
      localWorkspaceId: input.localWorkspaceId,
      projectName: input.projectName,
      agent: input.agent,
      ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
      status: "pending",
      createdAt: nowIso(),
      expiresAt,
    });
    await this.writeDb(db);
    return {
      deviceCode,
      userCode,
      verificationUrl: `${input.verificationUrlBase.replace(/\/+$/, "")}/install/cli?device=${encodeURIComponent(deviceCode)}`,
      expiresAt,
      pollIntervalMs: 2000,
    };
  }

  async approveDeviceSession(input: {
    deviceCode: string;
    clerkUserId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<DevicePollApprovedPayload | null> {
    const db = await this.readDb();
    const session = db.deviceSessions.find((row) => row.deviceCode === input.deviceCode);
    if (!session) return null;
    if (session.status !== "pending") {
      return session.status === "approved" ? this.readApprovedPayload(db, session.deviceCode) : null;
    }
    if (isExpired(session.expiresAt)) {
      session.status = "expired";
      await this.writeDb(db);
      return null;
    }

    const workspace = await this.ensurePersonalWorkspaceForUser({
      clerkUserId: input.clerkUserId,
      email: input.email,
      name: input.name,
    });
    const apiKey = await this.createApiKey(workspace.id, `cli install ${session.projectName}`);
    const installation = await this.upsertInstallation({
      workspaceId: workspace.id,
      localWorkspaceId: session.localWorkspaceId,
      projectName: session.projectName,
      agent: session.agent,
      ...(session.cliVersion ? { cliVersion: session.cliVersion } : {}),
    });

    const refreshed = await this.readDb();
    const target = refreshed.deviceSessions.find((row) => row.deviceCode === input.deviceCode);
    if (!target) return null;
    target.status = "approved";
    target.workspaceId = workspace.id;
    target.issuedApiKeyId = apiKey.id;
    target.issuedApiKeyValue = apiKey.value;
    target.installationId = installation.id;
    target.approvedAt = nowIso();
    await this.writeDb(refreshed);

    return {
      workspace,
      apiKey: apiKey.value,
      installation,
    };
  }

  async pollDeviceSession(deviceCode: string): Promise<
    | { status: "pending"; expiresAt: string }
    | { status: "approved"; payload: DevicePollApprovedPayload }
    | { status: "expired" }
    | { status: "not_found" }
  > {
    const db = await this.readDb();
    const session = db.deviceSessions.find((row) => row.deviceCode === deviceCode);
    if (!session) return { status: "not_found" };

    if (session.status === "pending") {
      if (isExpired(session.expiresAt)) {
        session.status = "expired";
        await this.writeDb(db);
        return { status: "expired" };
      }
      return { status: "pending", expiresAt: session.expiresAt };
    }

    if (session.status === "expired") return { status: "expired" };
    if (session.status === "consumed") return { status: "not_found" };

    const payload = this.readApprovedPayload(db, deviceCode);
    if (!payload) return { status: "not_found" };

    session.status = "consumed";
    session.issuedApiKeyValue = undefined;
    session.consumedAt = nowIso();
    await this.writeDb(db);

    return { status: "approved", payload };
  }

  private async readDb(): Promise<FileDb> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<FileDb>;
      return {
        version: 1,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        apiKeys: Array.isArray(parsed.apiKeys) ? parsed.apiKeys : [],
        installations: Array.isArray(parsed.installations) ? parsed.installations : [],
        deviceSessions: Array.isArray(parsed.deviceSessions) ? parsed.deviceSessions : [],
      };
    } catch {
      return {
        version: 1,
        workspaces: [],
        apiKeys: [],
        installations: [],
        deviceSessions: [],
      };
    }
  }

  private async writeDb(db: FileDb): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(db, null, 2) + "\n");
  }

  private findAvailableSlug(db: FileDb, base: string): string {
    const sanitizedBase = base || "workspace";
    const slugs = new Set(db.workspaces.map((workspace) => workspace.slug));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = attempt === 0 ? sanitizedBase : `${sanitizedBase}-${attempt + 1}`;
      if (!slugs.has(candidate)) return candidate;
    }
    return `${sanitizedBase}-${randomUUID().slice(0, 8)}`;
  }

  private readApprovedPayload(db: FileDb, deviceCode: string): DevicePollApprovedPayload | null {
    const session = db.deviceSessions.find((row) => row.deviceCode === deviceCode && row.status === "approved");
    if (!session?.issuedApiKeyValue || !session.workspaceId || !session.installationId) {
      return null;
    }
    const workspace = db.workspaces.find((row) => row.id === session.workspaceId);
    const installation = db.installations.find((row) => row.id === session.installationId);
    if (!workspace || !installation) return null;
    return {
      workspace,
      apiKey: session.issuedApiKeyValue,
      installation,
    };
  }
}

function mapWorkspaceRow(row: Record<string, unknown>): ControlPlaneWorkspace {
  return {
    id: String(row.id),
    scope: row.scope === "org" ? "org" : "personal",
    slug: String(row.slug),
    displayName: String(row.display_name),
    ...(row.clerk_user_id ? { clerkUserId: String(row.clerk_user_id) } : {}),
    ...(row.clerk_org_id ? { clerkOrgId: String(row.clerk_org_id) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapJoinedWorkspaceRow(row: Record<string, unknown>): ControlPlaneWorkspace {
  return {
    id: String(row.workspace_id),
    scope: row.workspace_scope === "org" ? "org" : "personal",
    slug: String(row.workspace_slug),
    displayName: String(row.workspace_display_name),
    ...(row.workspace_clerk_user_id ? { clerkUserId: String(row.workspace_clerk_user_id) } : {}),
    ...(row.workspace_clerk_org_id ? { clerkOrgId: String(row.workspace_clerk_org_id) } : {}),
    createdAt: toIso(row.workspace_created_at),
    updatedAt: toIso(row.workspace_updated_at),
  };
}

function mapApiKeyRow(row: Record<string, unknown>): ControlPlaneApiKey {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    label: String(row.label),
    prefix: String(row.prefix),
    last4: String(row.last4),
    createdAt: toIso(row.created_at),
    ...(row.last_used_at ? { lastUsedAt: toIso(row.last_used_at) } : {}),
    ...(row.revoked_at ? { revokedAt: toIso(row.revoked_at) } : {}),
  };
}

function mapInstallationRow(row: Record<string, unknown>): ControlPlaneInstallation {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    localWorkspaceId: String(row.local_workspace_id),
    projectName: String(row.project_name),
    agent: String(row.agent),
    ...(row.cli_version ? { cliVersion: String(row.cli_version) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapUsageSampleRow(row: Record<string, unknown>): ControlPlaneUsageSample {
  // metrics column is JSONB. pg returns parsed JSON objects directly; if
  // the driver ever returns a raw string we parse it defensively.
  let metrics: Record<string, unknown>;
  const raw = row.metrics;
  if (raw && typeof raw === "object") {
    metrics = raw as Record<string, unknown>;
  } else if (typeof raw === "string") {
    try {
      metrics = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      metrics = {};
    }
  } else {
    metrics = {};
  }
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    installationId: String(row.installation_id),
    windowStart: toIso(row.window_start),
    windowEnd: toIso(row.window_end),
    metrics,
    ...(row.cli_version ? { cliVersion: String(row.cli_version) } : {}),
    receivedAt: toIso(row.received_at),
  };
}

function stripStoredApiKey(row: StoredApiKey): ControlPlaneApiKey {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    prefix: row.prefix,
    last4: row.last4,
    createdAt: row.createdAt,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

function personalWorkspaceName(name?: string | null, email?: string | null): string {
  const basis = (name && name.trim()) || (email && email.split("@")[0]) || "Personal";
  return `${basis} workspace`;
}

function baseWorkspaceSlug(name?: string | null, email?: string | null): string {
  const basis = (name && name.trim()) || (email && email.split("@")[0]) || "workspace";
  const slug = basis
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "workspace";
}

function toIso(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function createUserCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

function isExpired(value: unknown): boolean {
  return Date.now() >= new Date(String(value)).getTime();
}
