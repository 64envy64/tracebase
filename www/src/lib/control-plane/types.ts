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
