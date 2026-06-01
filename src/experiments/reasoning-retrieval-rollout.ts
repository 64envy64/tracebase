/**
 * Hybrid retrieval rollout resolver (Router V2, Phase C).
 *
 *   TRACEBASE_REASONING_RETRIEVAL = off | shadow | on
 *
 *   off    (DEFAULT) → sparse FTS only. Byte-for-byte the legacy slate; no
 *                      provider is invoked.
 *   shadow           → serve the SPARSE slate unchanged, but ALSO compute the
 *                      hybrid (sparse ⊕ semantic) slate and the Router-V2
 *                      decision on it side-by-side, and persist a privacy-safe
 *                      comparison event. Zero effect on what the agent sees.
 *   on               → serve the fused HYBRID slate. Any provider
 *                      failure/timeout falls back to the sparse slate.
 *
 * Read once at BlockServer construction (mirrors the cascade + reasoning-router
 * rollout convention). Orthogonal to TRACEBASE_REASONING_ROUTER: this axis
 * chooses the candidate SLATE; that axis chooses the DECISION on the slate.
 *
 * Default MUST remain `off`. An unset / unrecognized value resolves to `off`
 * with a diagnostic, surfaced by `doctor` — a typo never silently enables it.
 *
 * The default semantic provider for shadow/on is the model-free
 * DeterministicLocalProvider; a real dense provider (Qwen3/BGE-M3) would be a
 * separately-configured adapter implementing `RetrievalProvider`.
 */
import { DeterministicLocalProvider } from "../core/deterministic-local-provider.js";
import type { RetrievalProvider, RetrievalRolloutMode } from "../core/retrieval-provider.js";

export type { RetrievalRolloutMode };

export const REASONING_RETRIEVAL_ENV = "TRACEBASE_REASONING_RETRIEVAL";

export interface RetrievalModeResolution {
  mode: RetrievalRolloutMode;
  diagnostics: string[];
}

/** Resolve the rollout mode from the environment. Default `off`; never throws. */
export function resolveReasoningRetrievalMode(env: NodeJS.ProcessEnv = process.env): RetrievalModeResolution {
  const raw = env[REASONING_RETRIEVAL_ENV];
  if (raw === undefined || raw === "") return { mode: "off", diagnostics: [] };
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "shadow" || v === "on") {
    return { mode: v, diagnostics: v === "off" ? [] : [`${REASONING_RETRIEVAL_ENV}=${v}`] };
  }
  return { mode: "off", diagnostics: [`${REASONING_RETRIEVAL_ENV}="${raw}" ignored (expected off|shadow|on); using off`] };
}

/** BlockServer option fragment for a retrieval rollout mode. */
export interface RetrievalRolloutOptions {
  retrievalMode: RetrievalRolloutMode;
  retrievalProvider?: RetrievalProvider;
}

/**
 * Map a rollout mode onto the BlockServer retrieval primitives. `off` wires no
 * provider (sparse only). `shadow`/`on` wire the model-free deterministic local
 * provider by default; pass an explicit provider to override with a real
 * adapter. `providerFactory` is injectable for tests.
 */
export function retrievalRolloutOptionsForMode(
  mode: RetrievalRolloutMode,
  providerFactory: () => RetrievalProvider = () => new DeterministicLocalProvider(),
): RetrievalRolloutOptions {
  if (mode === "off") return { retrievalMode: "off" };
  return { retrievalMode: mode, retrievalProvider: providerFactory() };
}

/**
 * Convenience: resolve the env and return the BlockServer option fragment to
 * spread at each construction site (CLI inject-context, MCP, SDK runtime,
 * TracebaseRuntimeProvider) — one rollout contract, one default-off behaviour.
 */
export function reasoningRetrievalOptions(
  env: NodeJS.ProcessEnv = process.env,
  providerFactory?: () => RetrievalProvider,
): RetrievalRolloutOptions {
  return retrievalRolloutOptionsForMode(resolveReasoningRetrievalMode(env).mode, providerFactory);
}
