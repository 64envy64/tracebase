/**
 * E.2.3 — composition-root wiring for the SEMANTIC shadow overlay (R&D, $0 by
 * default, NOT promoted). Reads an EXPLICIT env config and, only when fully
 * specified, builds ONE HttpRerankProvider (network-free served path + bounded
 * async warm) bound to a persisted SWR cache. Absent/partial config → null → the
 * lane is OFF and serving is byte-identical.
 *
 * The provider is a SHADOW observer only: the boundary discards its result and
 * emits a `reasoning.semantic_comparison` telemetry event, so a semantic verdict
 * NEVER affects served output and NEVER feeds the canary.
 */
import { join } from "node:path";
import { HttpRerankProvider } from "./service/client.js";
import { SqliteSemanticCache } from "./service/cache.js";
import type { ModelAttestation } from "./service/protocol.js";
import type { ApplicabilityProvider } from "../../core/applicability-reranker.js";

/** Env var names (single source of truth). All absent → lane OFF. */
export const SEMANTIC_SHADOW_URL_ENV = "TRACEBASE_SEMANTIC_SHADOW_URL";
export const SEMANTIC_SHADOW_TOKEN_ENV = "TRACEBASE_SEMANTIC_SHADOW_TOKEN";
export const SEMANTIC_SHADOW_ATTESTATION_ENV = "TRACEBASE_SEMANTIC_SHADOW_ATTESTATION";
export const SEMANTIC_SHADOW_ALLOW_UNPINNED_ENV = "TRACEBASE_SEMANTIC_SHADOW_ALLOW_UNPINNED";

export interface SemanticShadowConfig {
  url: string;
  token: string;
  /** Optional pinned attestation — validated cache survives restart without warm-up. */
  attestation?: ModelAttestation;
}

export type SemanticShadowConfigDiagnostic =
  | { status: "off"; reason: "not-configured" }
  | { status: "invalid"; reason: "partial-config" | "missing-attestation" | "malformed-attestation" }
  | { status: "configured"; config: SemanticShadowConfig; unpinnedDevMode: boolean };

/**
 * Parse the explicit env config. REQUIRES both a URL and a token (either missing →
 * null → off). An optional pinned attestation is read from a single JSON env; a
 * malformed pin is ignored (still shadow-only — the client learns attestation from
 * responses).
 */
export function diagnoseSemanticShadowConfig(env: NodeJS.ProcessEnv = process.env): SemanticShadowConfigDiagnostic {
  const url = (env[SEMANTIC_SHADOW_URL_ENV] ?? "").trim();
  const token = (env[SEMANTIC_SHADOW_TOKEN_ENV] ?? "").trim();
  const pin = (env[SEMANTIC_SHADOW_ATTESTATION_ENV] ?? "").trim();
  const allowUnpinned = (env[SEMANTIC_SHADOW_ALLOW_UNPINNED_ENV] ?? "").trim() === "1";
  if (!url && !token && !pin) return { status: "off", reason: "not-configured" };
  if (!url || !token) return { status: "invalid", reason: "partial-config" };
  let attestation: ModelAttestation | undefined;
  if (pin) {
    try {
      const p = JSON.parse(pin) as Partial<ModelAttestation>;
      if (
        typeof p.model === "string" && p.model.length > 0 &&
        typeof p.revision === "string" && p.revision.length > 0 &&
        typeof p.backend === "string" && p.backend.length > 0 &&
        Number.isInteger(p.featureVersion) && p.featureVersion! >= 1
      ) {
        attestation = { model: p.model, revision: p.revision, backend: p.backend, featureVersion: p.featureVersion! };
      } else {
        return { status: "invalid", reason: "malformed-attestation" };
      }
    } catch {
      return { status: "invalid", reason: "malformed-attestation" };
    }
  }
  if (!attestation && !allowUnpinned) {
    return { status: "invalid", reason: pin ? "malformed-attestation" : "missing-attestation" };
  }
  return { status: "configured", config: { url, token, ...(attestation ? { attestation } : {}) }, unpinnedDevMode: !attestation };
}

export function readSemanticShadowConfig(env: NodeJS.ProcessEnv = process.env): SemanticShadowConfig | null {
  const diagnosed = diagnoseSemanticShadowConfig(env);
  return diagnosed.status === "configured" ? diagnosed.config : null;
}

export interface SemanticShadowHandle {
  provider: ApplicabilityProvider;
  /** Bounded drain/cancel, then close the underlying SQLite cache. Idempotent. */
  close(): Promise<void>;
}

/**
 * Build the singleton shadow provider for a project, or null if not configured.
 * The SWR cache persists under `<basePath>/.tracebase/semantic-shadow-cache.db`
 * (content-free), so a validated cache survives restarts (read network-free).
 * Construct ONCE per process and reuse for every recall.
 */
export function createSemanticShadowProvider(
  basePath: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { mode?: "warm" | "lookup-only"; drainDeadlineMs?: number } = {},
): SemanticShadowHandle | null {
  const cfg = readSemanticShadowConfig(env);
  if (!cfg) return null;
  const cache = new SqliteSemanticCache(join(basePath, ".tracebase", "semantic-shadow-cache.db"), {
    ttlMs: 6 * 60 * 60 * 1000, // 6h fresh
    swrMs: 60 * 60 * 1000, // +1h serve-stale-while-revalidate
    maxEntries: 5000,
  });
  const provider = new HttpRerankProvider({
    baseUrl: cfg.url,
    authToken: cfg.token,
    cache,
    warming: opts.mode === "lookup-only" ? "disabled" : "enabled",
    ...(cfg.attestation ? { pinnedAttestation: cfg.attestation } : {}),
  });
  let closed = false;
  return {
    provider,
    close: async () => {
      if (closed) return;
      closed = true;
      await provider.close({ drainDeadlineMs: opts.drainDeadlineMs });
      cache.close();
    },
  };
}
