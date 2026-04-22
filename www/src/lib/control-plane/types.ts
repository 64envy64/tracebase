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
