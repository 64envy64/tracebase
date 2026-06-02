/**
 * Explicit operator probe for a configured semantic shadow endpoint.
 *
 * Never runs on the recall hot path. It checks public liveness, authenticated
 * admin health, strict wire shape, and pinned attestation equality without
 * returning or logging the bearer token.
 */
import { diagnoseSemanticShadowConfig } from "../semantic-shadow.js";
import {
  attestationHash,
  decodeHealthResponse,
  decodeLivenessResponse,
  type HealthDTO,
  type ModelAttestation,
} from "./protocol.js";

export type SemanticShadowDoctorReport =
  | { status: "off"; reason: "not-configured" }
  | { status: "invalid"; reason: string }
  | { status: "unreachable"; endpoint: string; reason: "timeout" | "network-error" }
  | { status: "unauthorized"; endpoint: string }
  | { status: "attestation-mismatch"; endpoint: string; expectedAttestationId: string; actualAttestationId: string }
  | {
    status: "ready";
    endpoint: string;
    attestationId: string;
    unpinnedDevMode: boolean;
    inFlight: number;
    telemetry: HealthDTO["telemetry"];
  };

function sameAttestation(a: ModelAttestation, b: ModelAttestation): boolean {
  return a.model === b.model && a.revision === b.revision && a.backend === b.backend && a.featureVersion === b.featureVersion;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: ac.signal });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // The caller distinguishes malformed responses from connectivity failures.
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeSemanticShadow(
  env: NodeJS.ProcessEnv = process.env,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SemanticShadowDoctorReport> {
  const diagnosed = diagnoseSemanticShadowConfig(env);
  if (diagnosed.status === "off") return diagnosed;
  if (diagnosed.status === "invalid") return { status: "invalid", reason: diagnosed.reason };
  const endpoint = diagnosed.config.url.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const liveness = await fetchJson(fetchImpl, `${endpoint}/v1/health`, {}, timeoutMs);
    if (liveness.status !== 200 || !decodeLivenessResponse(liveness.body)) {
      return { status: "invalid", reason: "public liveness response is malformed or incompatible" };
    }
    const admin = await fetchJson(fetchImpl, `${endpoint}/v1/admin/health`, {
      headers: { authorization: `Bearer ${diagnosed.config.token}` },
    }, timeoutMs);
    if (admin.status === 401) return { status: "unauthorized", endpoint };
    const health = admin.status === 200 ? decodeHealthResponse(admin.body) : null;
    if (!health) return { status: "invalid", reason: "authenticated admin health response is malformed or unavailable" };
    const actualAttestationId = attestationHash(health.attestation);
    if (diagnosed.config.attestation && !sameAttestation(diagnosed.config.attestation, health.attestation)) {
      return {
        status: "attestation-mismatch",
        endpoint,
        expectedAttestationId: attestationHash(diagnosed.config.attestation),
        actualAttestationId,
      };
    }
    return {
      status: "ready",
      endpoint,
      attestationId: actualAttestationId,
      unpinnedDevMode: diagnosed.unpinnedDevMode,
      inFlight: health.inFlight,
      telemetry: health.telemetry,
    };
  } catch (error) {
    return {
      status: "unreachable",
      endpoint,
      reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "network-error",
    };
  }
}
