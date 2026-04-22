import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS_DIR = join(homedir(), ".tracebase");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");

type StoredCredential = {
  apiUrl: string;
  workspaceId: string;
  apiKey: string;
  updatedAt: string;
};

type CredentialFile = {
  version: 1;
  entries: StoredCredential[];
};

export interface CloudWorkspaceDescriptor {
  id: string;
  slug: string;
  displayName: string;
  scope: "personal" | "org";
}

export interface CloudLinkDescriptor {
  workspace: CloudWorkspaceDescriptor;
  apiBaseUrl: string;
}

export interface CloudInstallationDescriptor {
  id: string;
  localWorkspaceId: string;
  projectName: string;
  agent: string;
  cliVersion?: string;
  updatedAt: string;
}

export interface RegisterInstallationInput {
  localWorkspaceId: string;
  projectName: string;
  agent: string;
  cliVersion?: string;
}

export interface CloudDeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  pollIntervalMs: number;
}

export function normalizeApiUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function resolveCloudApiUrl(explicit?: string): string | null {
  const raw = explicit ?? process.env.TRACEBASE_API_URL ?? "https://tracebase.ink";
  if (!raw || !raw.trim()) return null;
  return normalizeApiUrl(raw);
}

export function loadCloudCredential(apiUrl: string, workspaceId: string): string | null {
  const parsed = readCredentialFile();
  const found = parsed.entries.find(
    (entry) => entry.apiUrl === normalizeApiUrl(apiUrl) && entry.workspaceId === workspaceId,
  );
  return found?.apiKey ?? null;
}

export function saveCloudCredential(input: {
  apiUrl: string;
  workspaceId: string;
  apiKey: string;
}): void {
  const parsed = readCredentialFile();
  const apiUrl = normalizeApiUrl(input.apiUrl);
  const next: StoredCredential = {
    apiUrl,
    workspaceId: input.workspaceId,
    apiKey: input.apiKey.trim(),
    updatedAt: new Date().toISOString(),
  };

  const withoutCurrent = parsed.entries.filter(
    (entry) => !(entry.apiUrl === apiUrl && entry.workspaceId === input.workspaceId),
  );

  writeCredentialFile({
    version: 1,
    entries: [...withoutCurrent, next].sort((a, b) => a.apiUrl.localeCompare(b.apiUrl)),
  });
}

export async function validateCloudApiKey(apiUrl: string, apiKey: string): Promise<CloudLinkDescriptor> {
  const res = await fetch(`${normalizeApiUrl(apiUrl)}/api/control-plane/install/link`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
  });

  const body = await readJsonBody(res);
  if (!res.ok) {
    throw new Error(readErrorMessage(body, res.status));
  }

  if (!isCloudLinkDescriptor(body)) {
    throw new Error("cloud API returned an unexpected install-link payload");
  }

  return body;
}

export async function startCloudDeviceSession(
  apiUrl: string,
  input: RegisterInstallationInput,
): Promise<CloudDeviceStartResponse> {
  const res = await fetch(`${normalizeApiUrl(apiUrl)}/api/control-plane/device/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const body = await readJsonBody(res);
  if (!res.ok) {
    throw new Error(readErrorMessage(body, res.status));
  }
  if (!isDeviceStartResponse(body)) {
    throw new Error("cloud API returned an unexpected device-start payload");
  }
  return body;
}

export async function pollCloudDeviceSession(apiUrl: string, deviceCode: string): Promise<
  | { status: "pending"; expiresAt: string }
  | { status: "approved"; workspace: CloudWorkspaceDescriptor; apiKey: string; installation: CloudInstallationDescriptor }
  | { status: "expired" }
> {
  const res = await fetch(`${normalizeApiUrl(apiUrl)}/api/control-plane/device/poll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deviceCode }),
  });

  const body = await readJsonBody(res);
  if (!res.ok) {
    throw new Error(readErrorMessage(body, res.status));
  }

  if (body && typeof body === "object" && (body as Record<string, unknown>).status === "expired") {
    return { status: "expired" };
  }

  if (body && typeof body === "object" && (body as Record<string, unknown>).status === "pending") {
    const expiresAt = (body as Record<string, unknown>).expiresAt;
    if (typeof expiresAt !== "string") {
      throw new Error("cloud API returned a pending payload without expiresAt");
    }
    return { status: "pending", expiresAt };
  }

  if (!isApprovedDevicePoll(body)) {
    throw new Error("cloud API returned an unexpected device-poll payload");
  }

  return body;
}

export async function registerCloudInstallation(
  apiUrl: string,
  apiKey: string,
  input: RegisterInstallationInput,
): Promise<CloudInstallationDescriptor> {
  const res = await fetch(`${normalizeApiUrl(apiUrl)}/api/control-plane/installations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const body = await readJsonBody(res);
  if (!res.ok) {
    throw new Error(readErrorMessage(body, res.status));
  }

  if (!isInstallationResponse(body)) {
    throw new Error("cloud API returned an unexpected installation payload");
  }

  return body.installation;
}

export async function bestEffortOpenUrl(url: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  const executable =
    platform === "darwin" ? "open"
    : platform === "win32" ? "cmd"
    : "xdg-open";
  const args =
    platform === "darwin" ? [url]
    : platform === "win32" ? ["/c", "start", "", url]
    : [url];

  return new Promise((resolve) => {
    try {
      const child = spawn(executable, args, {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

function readCredentialFile(): CredentialFile {
  if (!existsSync(CREDENTIALS_FILE)) {
    return { version: 1, entries: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as Partial<CredentialFile>;
    return {
      version: 1,
      entries: Array.isArray(parsed.entries)
        ? parsed.entries.filter(isStoredCredential)
        : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeCredentialFile(data: CredentialFile): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2) + "\n");
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.apiUrl === "string" &&
    typeof v.workspaceId === "string" &&
    typeof v.apiKey === "string" &&
    typeof v.updatedAt === "string"
  );
}

async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function readErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string") return error;
  }
  return `cloud API responded with HTTP ${status}`;
}

function isCloudLinkDescriptor(value: unknown): value is CloudLinkDescriptor {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const workspace = v.workspace;
  if (!workspace || typeof workspace !== "object") return false;
  const w = workspace as Record<string, unknown>;
  return (
    typeof v.apiBaseUrl === "string" &&
    typeof w.id === "string" &&
    typeof w.slug === "string" &&
    typeof w.displayName === "string" &&
    (w.scope === "personal" || w.scope === "org")
  );
}

function isInstallationResponse(value: unknown): value is { installation: CloudInstallationDescriptor } {
  if (!value || typeof value !== "object") return false;
  const installation = (value as Record<string, unknown>).installation;
  if (!installation || typeof installation !== "object") return false;
  const i = installation as Record<string, unknown>;
  return (
    typeof i.id === "string" &&
    typeof i.localWorkspaceId === "string" &&
    typeof i.projectName === "string" &&
    typeof i.agent === "string" &&
    typeof i.updatedAt === "string"
  );
}

function isDeviceStartResponse(value: unknown): value is CloudDeviceStartResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.deviceCode === "string" &&
    typeof v.userCode === "string" &&
    typeof v.verificationUrl === "string" &&
    typeof v.expiresAt === "string" &&
    typeof v.pollIntervalMs === "number"
  );
}

function isApprovedDevicePoll(value: unknown): value is {
  status: "approved";
  workspace: CloudWorkspaceDescriptor;
  apiKey: string;
  installation: CloudInstallationDescriptor;
} {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const workspace = v.workspace;
  const installation = v.installation;
  if (v.status !== "approved" || typeof v.apiKey !== "string") return false;
  if (!workspace || typeof workspace !== "object") return false;
  if (!installation || typeof installation !== "object") return false;
  const w = workspace as Record<string, unknown>;
  const i = installation as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.slug === "string" &&
    typeof w.displayName === "string" &&
    (w.scope === "personal" || w.scope === "org") &&
    typeof i.id === "string" &&
    typeof i.localWorkspaceId === "string" &&
    typeof i.projectName === "string" &&
    typeof i.agent === "string" &&
    typeof i.updatedAt === "string"
  );
}
