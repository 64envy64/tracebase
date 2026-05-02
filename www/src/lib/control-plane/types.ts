export type WorkspaceScope = "personal" | "org";

export interface ControlPlaneWorkspace {
  id: string;
  scope: WorkspaceScope;
  slug: string;
  displayName: string;
  clerkUserId?: string;
  clerkOrgId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlPlaneApiKey {
  id: string;
  workspaceId: string;
  label: string;
  prefix: string;
  last4: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface ControlPlaneInstallation {
  id: string;
  workspaceId: string;
  localWorkspaceId: string;
  projectName: string;
  agent: string;
  cliVersion?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedApiKey extends ControlPlaneApiKey {
  value: string;
}

export interface DashboardBootstrap {
  apiBaseUrl: string;
  workspace: ControlPlaneWorkspace;
  apiKeys: ControlPlaneApiKey[];
  installations: ControlPlaneInstallation[];
}

/**
 * A rolled-up usage-metrics sample pushed by the CLI for a given
 * installation and time window. The cloud never recomputes §L6
 * helpfulness or the funnel — it accepts the aggregate the local
 * CLI computed with `computeUsageMetrics` and stores it verbatim.
 *
 * Idempotent on (installationId, windowStart, windowEnd). Re-pushing
 * the same window overwrites the previous sample — safer than
 * double-counting when a daemon retries.
 */
export interface ControlPlaneUsageSample {
  id: string;
  workspaceId: string;
  installationId: string;
  windowStart: string;
  windowEnd: string;
  /**
   * Serialized UsageMetrics from the shared `src/analytics/usage-metrics.ts`
   * module. Treated as an opaque JSONB payload here; typed consumers
   * read it through the CLI SDK.
   */
  metrics: Record<string, unknown>;
  cliVersion?: string;
  receivedAt: string;
}

export interface ControlPlaneDeviceSession {
  id: string;
  deviceCode: string;
  userCode: string;
  localWorkspaceId: string;
  projectName: string;
  agent: string;
  cliVersion?: string;
  status: "pending" | "approved" | "consumed" | "expired";
  workspaceId?: string;
  issuedApiKeyId?: string;
  issuedApiKeyValue?: string;
  installationId?: string;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  consumedAt?: string;
}

export interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  pollIntervalMs: number;
}

export interface DevicePollApprovedPayload {
  workspace: ControlPlaneWorkspace;
  apiKey: string;
  installation: ControlPlaneInstallation;
}

// ---------------------------------------------------------------------------
// Engineering Brain (Phase 1 — data model)
//
// The Engineering Brain surface stitches together GitHub work and agent runs
// into a citable graph. Privacy posture, baked into types:
//   - GitHub bodies persist as bounded summaries, never as raw unbounded text.
//   - Tool-call I/O is never persisted. agent_runs records counts, not content.
//   - Memory hard-deletes leave behind audit metadata (the memory_event row),
//     not the deleted body.
//   - GitHub PATs are read from env vars; never persisted in this store.
// ---------------------------------------------------------------------------

export type IntegrationProvider = "github";
export type IntegrationStatus = "connected" | "error" | "disabled";

export interface IntegrationRecord {
  id: string;
  workspaceId: string;
  provider: IntegrationProvider;
  accountLogin: string;
  installationId?: string;
  repoFullName?: string;
  status: IntegrationStatus;
  lastSyncAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type GithubItemKind =
  | "issue"
  | "pull_request"
  | "commit"
  | "check_run"
  | "review_comment";

export interface GithubItemRecord {
  id: string;
  integrationId: string;
  workspaceId: string;
  repoFullName: string;
  kind: GithubItemKind;
  externalId: string;
  number?: number;
  title?: string;
  state?: string;
  url: string;
  authorLogin?: string;
  bodySummary?: string;
  labels: string[];
  linkedFiles: string[];
  createdAtRemote?: string;
  updatedAtRemote?: string;
  ingestedAt: string;
}

export type AgentHost =
  | "claude-code"
  | "codex"
  | "cursor"
  | "openai"
  | "anthropic"
  | "generic";

export interface AgentRecord {
  id: string;
  workspaceId: string;
  displayName: string;
  ownerLabel?: string;
  host: AgentHost;
  status: "active" | "idle" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export type AgentRunStatus = "running" | "resolved" | "failed" | "abandoned";
export type AgentRunSourceKind =
  | "manual"
  | "github_issue"
  | "pull_request"
  | "ci_failure";

export interface AgentRunRecord {
  id: string;
  workspaceId: string;
  agentId?: string;
  sessionId: string;
  taskTitle?: string;
  taskSourceKind: AgentRunSourceKind;
  taskSourceId?: string;
  startedAt: string;
  endedAt?: string;
  status: AgentRunStatus;
  tokensInjected: number;
  tokensSavedEstimated: number;
  toolCallsCount: number;
  blockedCallsCount: number;
  recalledPatternsCount: number;
  recalledFilesCount: number;
}

export type MemoryStatusValue =
  | "active"
  | "candidate"
  | "retired"
  | "superseded"
  | "deleted";

export interface MemoryStatusRecord {
  workspaceId: string;
  memoryId: string;
  status: MemoryStatusValue;
  trigSituation?: string;
  bodyPreview?: string;
  provenanceKind?: "agent_run" | "github_item" | "manual" | "imported";
  provenanceId?: string;
  createdAt: string;
  updatedAt: string;
}

export type MemoryEventActorKind = "agent" | "human" | "system";
export type MemoryEventAction =
  | "created"
  | "used"
  | "retired"
  | "deleted"
  | "superseded"
  | "rollback";

export interface MemoryEventRecord {
  id: string;
  workspaceId: string;
  memoryId: string;
  actorKind: MemoryEventActorKind;
  actorId?: string;
  action: MemoryEventAction;
  sourceRunId?: string;
  sourceGithubItemId?: string;
  reason?: string;
  createdAt: string;
}

export type RollbackTargetKind = "memory" | "agent_run" | "github_item";

export interface RollbackEventRecord {
  id: string;
  workspaceId: string;
  actorId?: string;
  targetKind: RollbackTargetKind;
  targetId: string;
  rollbackToId?: string;
  reason: string;
  createdAt: string;
}

/**
 * Aggregated bootstrap for the Engineering Brain dashboard. Everything
 * the surface needs in a single round-trip — the dashboard never reads
 * the SDK store directly, only its Postgres-backed reflection here.
 */
export interface EngineeringBrainBootstrap {
  integrations: IntegrationRecord[];
  githubItems: GithubItemRecord[];
  agents: AgentRecord[];
  agentRuns: AgentRunRecord[];
  memoryStatuses: MemoryStatusRecord[];
  memoryEvents: MemoryEventRecord[];
  rollbackEvents: RollbackEventRecord[];
}
