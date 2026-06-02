/**
 * Customer-managed semantic sidecar composition root.
 *
 * This is deliberately separate from the TraceBase control plane and from the
 * local MCP process. It exposes the existing bounded/scanned rerank protocol as
 * a long-lived service, refuses weak credentials, verifies the pinned Qwen
 * artifact before startup, and eagerly handshakes the model worker before
 * listening. It never enables semantic serving; clients still use shadow-only
 * SWR warming until a separately reviewed promotion gate exists.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { FakeRerankBackend, QwenRerankBackend, type RerankBackend } from "./backend.js";
import { StaticBearerAuthenticator, TenantQuota } from "./auth.js";
import { createRerankService, type RerankService } from "./server.js";

export const SIDECAR_BACKEND_ENV = "TRACEBASE_SEMANTIC_SIDECAR_BACKEND";
export const SIDECAR_HOST_ENV = "TRACEBASE_SEMANTIC_SIDECAR_HOST";
export const SIDECAR_PORT_ENV = "TRACEBASE_SEMANTIC_SIDECAR_PORT";
export const SIDECAR_TOKEN_ENV = "TRACEBASE_SEMANTIC_SIDECAR_TOKEN";
export const SIDECAR_TENANT_ENV = "TRACEBASE_SEMANTIC_SIDECAR_TENANT";
export const SIDECAR_ALLOW_FAKE_ENV = "TRACEBASE_SEMANTIC_SIDECAR_ALLOW_FAKE";
export const SIDECAR_QWEN_COMMAND_ENV = "TRACEBASE_SEMANTIC_SIDECAR_QWEN_COMMAND";
export const SIDECAR_QWEN_MODEL_DIR_ENV = "TRACEBASE_SEMANTIC_SIDECAR_QWEN_MODEL_DIR";
export const SIDECAR_QWEN_REVISION_ENV = "TRACEBASE_SEMANTIC_SIDECAR_QWEN_REVISION";

export const QWEN_MODEL_REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473";
export const QWEN_MODEL_SHA256 = "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b";

export interface SemanticSidecarConfig {
  backend: "qwen-local" | "fake";
  host: string;
  port: number;
  token: string;
  tenant: string;
  qwen?: { command: string; modelDir: string; revision: string };
  quota: { ratePerSec: number; burst: number };
}

export type SemanticSidecarConfigDiagnostic =
  | { status: "invalid"; reasons: string[] }
  | { status: "configured"; config: SemanticSidecarConfig };

export interface SemanticSidecarHandle {
  url: string;
  backend: SemanticSidecarConfig["backend"];
  tenant: string;
  service: RerankService;
  close(): Promise<void>;
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return 8787;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65_535 ? n : null;
}

function acceptedHost(value: string | undefined): string | null {
  const host = (value ?? "127.0.0.1").trim();
  return ["127.0.0.1", "localhost", "0.0.0.0", "::1", "::"].includes(host) ? host : null;
}

export function diagnoseSemanticSidecarConfig(env: NodeJS.ProcessEnv = process.env): SemanticSidecarConfigDiagnostic {
  const reasons: string[] = [];
  const backend = (env[SIDECAR_BACKEND_ENV] ?? "").trim();
  const host = acceptedHost(env[SIDECAR_HOST_ENV]);
  const port = parsePort(env[SIDECAR_PORT_ENV]);
  const token = (env[SIDECAR_TOKEN_ENV] ?? "").trim();
  const tenant = (env[SIDECAR_TENANT_ENV] ?? "").trim();
  if (!["qwen-local", "fake"].includes(backend)) reasons.push(`${SIDECAR_BACKEND_ENV} must be qwen-local or fake`);
  if (!host) reasons.push(`${SIDECAR_HOST_ENV} must be a loopback or wildcard bind address`);
  if (port === null) reasons.push(`${SIDECAR_PORT_ENV} must be an integer in [0, 65535]`);
  if (token.length < 16) reasons.push(`${SIDECAR_TOKEN_ENV} must be at least 16 characters`);
  if (!tenant) reasons.push(`${SIDECAR_TENANT_ENV} must be non-empty`);
  let qwen: SemanticSidecarConfig["qwen"];
  if (backend === "fake" && env[SIDECAR_ALLOW_FAKE_ENV] !== "1") {
    reasons.push(`${SIDECAR_ALLOW_FAKE_ENV}=1 is required for the test-only fake backend`);
  }
  if (backend === "qwen-local") {
    const modelDir = (env[SIDECAR_QWEN_MODEL_DIR_ENV] ?? "").trim();
    const revision = (env[SIDECAR_QWEN_REVISION_ENV] ?? QWEN_MODEL_REVISION).trim();
    const command = (env[SIDECAR_QWEN_COMMAND_ENV] ?? "python").trim();
    if (!modelDir) reasons.push(`${SIDECAR_QWEN_MODEL_DIR_ENV} must point at the verified model directory`);
    if (revision !== QWEN_MODEL_REVISION) reasons.push(`${SIDECAR_QWEN_REVISION_ENV} must equal the pinned supply-chain revision`);
    if (!command) reasons.push(`${SIDECAR_QWEN_COMMAND_ENV} must be non-empty`);
    if (modelDir && command && revision === QWEN_MODEL_REVISION) qwen = { modelDir, command, revision };
  }
  if (reasons.length > 0 || !host || port === null) return { status: "invalid", reasons };
  return {
    status: "configured",
    config: {
      backend: backend as SemanticSidecarConfig["backend"],
      host,
      port,
      token,
      tenant,
      ...(qwen ? { qwen } : {}),
      quota: { ratePerSec: 20, burst: 40 },
    },
  };
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function verifyQwenArtifact(modelDir: string): Promise<void> {
  const weights = join(modelDir, "model.safetensors");
  if (!existsSync(weights)) throw new Error(`qwen model artifact missing: ${weights}`);
  const actual = await fileSha256(weights);
  if (actual !== QWEN_MODEL_SHA256) throw new Error("qwen model artifact sha256 does not match the pinned supply-chain manifest");
}

function backendFor(config: SemanticSidecarConfig): RerankBackend {
  if (config.backend === "fake") return new FakeRerankBackend({ revision: "sidecar-fake-v1" });
  if (!config.qwen) throw new Error("qwen sidecar configuration is incomplete");
  return new QwenRerankBackend(config.qwen);
}

export async function startSemanticSidecar(
  config: SemanticSidecarConfig,
  opts: { skipArtifactVerification?: boolean } = {},
): Promise<SemanticSidecarHandle> {
  if (config.backend === "qwen-local" && !opts.skipArtifactVerification) {
    await verifyQwenArtifact(config.qwen?.modelDir ?? "");
  }
  const backend = backendFor(config);
  try {
    await backend.start?.();
  } catch (error) {
    await backend.close?.().catch(() => undefined);
    throw error;
  }
  const service = createRerankService(backend, {
    authenticator: new StaticBearerAuthenticator(config.token, config.tenant),
    quota: new TenantQuota(config.quota.ratePerSec, config.quota.burst),
  });
  let port: number;
  try {
    port = await service.listen(config.port, config.host);
  } catch (error) {
    await service.close().catch(() => undefined);
    throw error;
  }
  const urlHost = config.host.includes(":") ? `[${config.host}]` : config.host;
  return {
    url: `http://${urlHost}:${port}`,
    backend: config.backend,
    tenant: config.tenant,
    service,
    close: () => service.close(),
  };
}
