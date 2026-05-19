/**
 * Cascade rollout — May-2026 B1.2.
 *
 * Two responsibilities, kept separate so they don't entangle:
 *
 *   1. `buildRerankerFromCascadeConfig(config)`
 *      Construct the Reranker singleton at MCP server boot from the
 *      persisted cascade config. Returns NoopReranker for `kind: "noop"`
 *      / when config is absent / when CloudReranker's required fields
 *      are missing — that "fail-safe to identity" path matters because
 *      the BlockServer captures the reranker reference once at
 *      construction and we never want a malformed config to wedge the
 *      MCP server with a broken reranker.
 *
 *   2. `shouldUseCascade(fingerprint, config)`
 *      Per-query decision: does this query route through the async
 *      `recallAsync()` cascade, or stay on the sync `recall()` path?
 *      Pure SHA256-uint32 hash of `(salt, fingerprint)` against
 *      `rate × 2^32` — exact reuse of `shouldHoldOut` semantics so we
 *      have ONE mental model for deterministic-by-fingerprint
 *      experimental gating, not two.
 *
 * Why split:
 *   • `reranker.kind` is process-lifetime (changing it requires a
 *     server restart anyway because the BlockServer captures the
 *     reference at construction).
 *   • `rollout.rate` is hot — the MCP entry reads the config on every
 *     call so `tracebase cascade set-rate 0.05` takes effect without
 *     a restart, same as `tracebase experiment enable|disable` today.
 *
 * Cascade rollout reuses `shouldHoldOut` directly to keep the hashing
 * contract unambiguous: if a query is "in the cascade arm", that
 * decision is identical to "fingerprint hashes below rate × 2^32" no
 * matter which experimental gate is asking.
 */

import type { CascadeConfig } from "../types.js";
import {
  type Reranker,
  NoopReranker,
  CloudReranker,
} from "../core/reranker.js";
import { MiniLMReranker } from "../core/rerankers/minilm.js";
import { shouldHoldOut } from "./holdout.js";

/**
 * Construct the Reranker selected by the persisted cascade config.
 *
 * Failure-safe rules — every branch falls back to `NoopReranker`:
 *   • Config null / undefined.
 *   • `kind: "noop"` (explicit identity).
 *   • `kind: "cloud"` without an `endpoint`.
 *   • `kind` set to a known-but-unimplemented value (ONNX kinds land
 *     in a later PR; until then they downgrade to Noop so a forward-
 *     declared config doesn't break the cascade).
 *   • Any unrecognized `kind`.
 *
 * The fail-safe path always exercises the cascade architecture (Noop
 * + MMR), so even a misconfigured production deployment still gets
 * the diversity step — never silently better, never broken.
 */
export function buildRerankerFromCascadeConfig(
  config: CascadeConfig | null | undefined,
): Reranker {
  if (!config) return new NoopReranker();
  switch (config.reranker.kind) {
    case "cloud": {
      if (!config.reranker.endpoint) return new NoopReranker();
      return new CloudReranker({
        endpoint: config.reranker.endpoint,
        ...(config.reranker.apiKey ? { apiKey: config.reranker.apiKey } : {}),
        ...(config.reranker.model ? { model: config.reranker.model } : {}),
      });
    }
    case "minilm":
      // May-2026 B1.3 — local ONNX cross-encoder in a worker_threads
      // worker. Optional peer dep `@xenova/transformers`. If the dep
      // is missing at runtime the worker emits a structured error and
      // MiniLMReranker.score() returns null; withRerankerFallback
      // then collapses to the pre-rerank order with reason "error".
      // The host should pre-warm via `tracebase doctor --fix`.
      return new MiniLMReranker();
    case "bge-v2-m3":
      // Reserved for B1.4 (570MB int8 — different cache, latency, and
      // worker config). Downgrade to Noop so a forward-declared config
      // doesn't break the cascade.
      return new NoopReranker();
    case "noop":
    default:
      return new NoopReranker();
  }
}

/**
 * Decide whether `fingerprint` should route through the async cascade.
 *
 * Returns false when:
 *   • config is null / undefined,
 *   • `enabled === false`,
 *   • `rate <= 0` / non-finite,
 *   • `fingerprint` is empty (assignment cannot be deterministic
 *     without it — better to keep the run on the well-trodden sync
 *     path than to fabricate a cohort).
 *
 * Otherwise reuses `shouldHoldOut` for the hash decision. This means
 * the cascade rollout, the holdout cohort, and any future
 * experimental gate share one mathematical contract: same fingerprint
 * + same salt + same rate → same bool.
 */
export function shouldUseCascade(
  fingerprint: string | undefined,
  config: CascadeConfig | null | undefined,
): boolean {
  if (!config) return false;
  if (!config.enabled) return false;
  if (!Number.isFinite(config.rollout.rate) || config.rollout.rate <= 0) return false;
  if (!fingerprint) return false;
  return shouldHoldOut(fingerprint, config.rollout.rate, config.rollout.salt);
}

/**
 * Pull the cascade-tuning knobs that BlockServer accepts (timeout,
 * MMR lambda, fetch multiplier) out of the config. Returns `undefined`
 * for any unset field so BlockServer's own defaults apply — keeps the
 * MCP wiring honest: "config decides ranker + rollout; BlockServer
 * decides its own internal defaults".
 */
export function extractCascadeKnobs(
  config: CascadeConfig | null | undefined,
): {
  rerankerTimeoutMs?: number;
  mmrLambda?: number;
  cascadeFetchMultiplier?: number;
} {
  if (!config) return {};
  return {
    ...(config.timeoutMs !== undefined ? { rerankerTimeoutMs: config.timeoutMs } : {}),
    ...(config.mmrLambda !== undefined ? { mmrLambda: config.mmrLambda } : {}),
    ...(config.fetchMultiplier !== undefined ? { cascadeFetchMultiplier: config.fetchMultiplier } : {}),
  };
}
