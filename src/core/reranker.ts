/**
 * Cross-encoder reranker — May-2026 PR B1.
 *
 * Slots between the BM25/multi-signal stage and the isotonic gate in the
 * V2 retrieval cascade:
 *
 *     hard filters → BM25 + multi-signal → top-N → RERANKER → top-K
 *                  → MMR diversity → isotonic gate → injection
 *
 * Why a separate stage
 * --------------------
 * BM25 + multi-signal combination is a fast pointwise lexical+structural
 * pass. A cross-encoder consumes (query, candidate) pairs together and
 * captures semantic compatibility that pointwise scoring misses (e.g.
 * "deserialize JSON in Rust" matching a trace titled "serde untagged
 * variant fallback" even when the trigger text shares few tokens).
 *
 * For a typical retrieval window (top-20 candidates), a modern small
 * cross-encoder gets us 10-25% NDCG@5 lift on heterogeneous corpora
 * without any training data.
 *
 * Implementations
 * ---------------
 *   • `NoopReranker`  — identity / pass-through; the default so a fresh
 *                       install does no network calls, has no native
 *                       deps, and ships as-is.
 *   • `CloudReranker` — POSTs (query, candidates[]) to a hosted endpoint
 *                       (e.g. TraceBase Cloud or any compatible service).
 *                       Zero native deps. Opt-in via config.
 *   • `MiniLMReranker` / `BgeV2M3Reranker` — local ONNX inference in a
 *                       worker thread. Land in a follow-up PR; ONNX
 *                       brings in `onnxruntime-node` as an *optional*
 *                       peer dep that `doctor --fix` checks for. Until
 *                       that PR ships, callers select between Noop and
 *                       Cloud only — the architecture is ready.
 *
 * Honesty contract: a reranker MUST never throw to the caller. Failures
 * (timeout, network error, malformed response, missing native dep) fall
 * back to the input ordering. This invariant lives in
 * `withRerankerFallback` and is the reason every concrete impl returns
 * `null` on error rather than rejecting.
 */

import type { ReasoningBlock } from "../types.js";

/**
 * A candidate as seen by the reranker. We pass the trigger text — the
 * only field allowed to score per §L5 of the design doc (body fields
 * never participate in ranking).
 */
export interface RerankerCandidate {
  blockId: string;
  triggerText: string;
}

/**
 * Reranker contract. Implementations score every candidate against the
 * query and return per-candidate relevance scores in `[0, 1]`. Returning
 * `null` is the graceful-failure signal — the caller falls back to the
 * pre-rerank ordering.
 *
 * Async because remote callers (CloudReranker) and worker-thread local
 * callers (future MiniLMReranker) are both async by nature.
 *
 * Cancellation contract (B1.1 hardening): when `options.signal` is
 * provided, implementations SHOULD abort their underlying work as soon
 * as the signal fires. CloudReranker passes the signal to `fetch`;
 * future worker-thread rerankers wire the signal to `worker.terminate()`.
 * Without this contract, `withRerankerFallback`'s timeout only "races"
 * against work that keeps burning CPU/network in the background.
 */
export interface Reranker {
  /** Human-readable id for logging / observability / doctor surface. */
  readonly name: string;

  /**
   * Score every `candidate` against `query`. Output length must equal
   * input length; the i-th score corresponds to the i-th candidate.
   *
   * MUST return `null` on any failure mode. MUST resolve within the
   * timeout the caller supplies via `withRerankerFallback`. SHOULD
   * abort underlying I/O / compute when `options.signal` fires.
   */
  score(
    query: string,
    candidates: RerankerCandidate[],
    options?: { signal?: AbortSignal },
  ): Promise<number[] | null>;
}

// ---------------------------------------------------------------------------
// NoopReranker — pass-through, default
// ---------------------------------------------------------------------------

/**
 * Default reranker. Returns a constant score for every candidate so the
 * upstream ordering is preserved (the cascade caller sorts by the
 * reranker output stably, so equal scores leave order untouched).
 *
 * Use this when:
 *   • You haven't configured a real reranker yet.
 *   • You're in CI / a smoke test and want the cascade architecture
 *     exercised without external dependencies.
 *   • You want to explicitly disable reranking (`reranker: "none"`).
 */
export class NoopReranker implements Reranker {
  readonly name = "noop";
  async score(_query: string, candidates: RerankerCandidate[], _options?: { signal?: AbortSignal }): Promise<number[]> {
    return candidates.map(() => 0.5);
  }
}

// ---------------------------------------------------------------------------
// CloudReranker — hosted HTTP endpoint, no native deps
// ---------------------------------------------------------------------------

export interface CloudRerankerOptions {
  /** Full URL of the reranker endpoint (POST). */
  endpoint: string;
  /** Optional Bearer token. */
  apiKey?: string;
  /** Optional model identifier passed through to the endpoint. */
  model?: string;
  /** Override `globalThis.fetch` (used by tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Reranker that delegates to a hosted HTTP service. Zero native
 * dependencies — uses the built-in `fetch` available since Node 18.
 *
 * Request shape:
 *   POST <endpoint>
 *   Authorization: Bearer <apiKey?>
 *   Content-Type: application/json
 *   { "query": "...", "candidates": ["...", "..."], "model"?: "..." }
 *
 * Response shape:
 *   200 { "scores": [number, number, ...] }    — one per candidate
 *   any other status → null fallback
 *
 * Same length contract as the abstract interface; mismatched length
 * triggers the null fallback.
 */
export class CloudReranker implements Reranker {
  readonly name = "cloud";
  private readonly opts: CloudRerankerOptions;

  constructor(opts: CloudRerankerOptions) {
    this.opts = opts;
  }

  async score(
    query: string,
    candidates: RerankerCandidate[],
    options?: { signal?: AbortSignal },
  ): Promise<number[] | null> {
    if (candidates.length === 0) return [];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) headers["Authorization"] = `Bearer ${this.opts.apiKey}`;
    const body = JSON.stringify({
      query,
      candidates: candidates.map((c) => c.triggerText),
      ...(this.opts.model ? { model: this.opts.model } : {}),
    });
    const f = this.opts.fetchImpl ?? globalThis.fetch;
    if (!f) return null;
    let res: Response;
    try {
      // B1.1: forward AbortSignal so fetch is actually cancelled when
      // withRerankerFallback times out. Pre-hardening the race only
      // ignored the late response — the network call kept running
      // and burned bandwidth until the server's own timeout fired.
      const init: RequestInit = { method: "POST", headers, body };
      if (options?.signal) init.signal = options.signal;
      res = await f(this.opts.endpoint, init);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const scores = (parsed as { scores?: unknown }).scores;
    if (!Array.isArray(scores)) return null;
    if (scores.length !== candidates.length) return null;
    const out: number[] = [];
    for (const s of scores) {
      if (typeof s !== "number" || !Number.isFinite(s)) return null;
      // Clamp into [0, 1] defensively — some endpoints return logits
      // or unbounded relevance numbers and we don't want a downstream
      // sort to interact with extreme values.
      out.push(Math.max(0, Math.min(1, s)));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Cascade wrapper — timeout + graceful fallback
// ---------------------------------------------------------------------------

export interface RerankerOptions {
  /** Hard timeout for one reranker call. Default 300ms. */
  timeoutMs?: number;
  /** Callback for observability — fires on every failure mode. */
  onFallback?: (reason: RerankerFallbackReason) => void;
}

/**
 * Reason a reranker call collapsed to the fallback path.
 *
 *   • "timeout"     — withRerankerFallback aborted the call.
 *   • "error"       — score() threw an exception.
 *   • "null"        — score() returned null (graceful failure).
 *   • "empty"       — length mismatch between scores and candidates.
 *   • "validation"  — at least one score was NaN / Infinity / out of
 *                     band (a custom Reranker that misbehaves; B1.1
 *                     adds wrapper-level checks since not every
 *                     implementation validates internally).
 */
export type RerankerFallbackReason = "timeout" | "error" | "null" | "empty" | "validation";

/**
 * Apply a reranker with a strict timeout, cancellation, and graceful
 * fallback.
 *
 * The cascade contract: a reranker MUST NEVER block the injection path
 * unbounded, and MUST NEVER throw to the caller. This wrapper enforces
 * both:
 *
 *   • Race the score() call against a timeout (default 300ms).
 *   • On timeout, abort the controller passed via `options.signal`
 *     so the reranker can stop its in-flight I/O / compute — pre-B1.1
 *     the race only ignored the late return, but CloudReranker's fetch
 *     and future ONNX worker_threads kept burning resources.
 *   • Validate every returned score is finite and in [0, 1]; out-of-
 *     band values would otherwise corrupt downstream sort/MMR math.
 *   • On any failure, return the input order unchanged + a reason
 *     code so the caller can stamp telemetry.
 *
 * On success, returns the candidates sorted DESC by reranker score
 * (stable sort, equal scores preserve input order) along with the
 * per-candidate `scores` array — keeping the scores around lets MMR
 * use them as relevance instead of falling back to the pre-rerank
 * BM25 score, which would otherwise defeat the point of the rerank.
 */
export async function withRerankerFallback<T extends RerankerCandidate>(
  reranker: Reranker,
  query: string,
  candidates: T[],
  opts: RerankerOptions = {},
): Promise<{
  reranked: T[];
  scores?: number[];
  fellBack: boolean;
  reason?: RerankerFallbackReason;
}> {
  if (candidates.length === 0) {
    return { reranked: candidates, fellBack: false };
  }
  const timeoutMs = opts.timeoutMs ?? 300;

  const controller = new AbortController();
  let timeoutFired = false;
  const timeoutHandle = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, timeoutMs);
  timeoutHandle.unref?.();

  let result: { scores: number[] | null; reason?: RerankerFallbackReason };
  try {
    const scores = await reranker.score(query, candidates, { signal: controller.signal });
    result = { scores };
  } catch {
    result = { scores: null, reason: timeoutFired ? "timeout" : "error" };
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Detect the case where the awaited call returned after timeout
  // fired (race between throw-on-abort and natural completion). Treat
  // as timeout so telemetry isn't muddied.
  if (timeoutFired && !result.reason) {
    result = { scores: null, reason: "timeout" };
  }

  if (!result.scores) {
    const reason = result.reason ?? "null";
    opts.onFallback?.(reason);
    return { reranked: candidates, fellBack: true, reason };
  }
  if (result.scores.length !== candidates.length) {
    opts.onFallback?.("empty");
    return { reranked: candidates, fellBack: true, reason: "empty" };
  }

  // B1.1: wrapper-level numeric validation. Custom rerankers (or a
  // misbehaving CloudReranker endpoint that escapes its own clamping)
  // could return NaN / Infinity / negative / >1 values; we'd silently
  // sort against them and produce garbage. Hard-reject the whole batch
  // rather than try to coerce — better to fall back than to ship
  // ranking based on corrupted scores.
  for (const s of result.scores) {
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 1) {
      opts.onFallback?.("validation");
      return { reranked: candidates, fellBack: true, reason: "validation" };
    }
  }

  // Stable sort by score DESC. Pair items with scores and indices to
  // tie-break on original position so equal scores leave order intact.
  const indexed = candidates.map((c, i) => ({ c, s: result.scores![i]!, i }));
  indexed.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return {
    reranked: indexed.map((x) => x.c),
    scores: indexed.map((x) => x.s),
    fellBack: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers used by BlockServer integration (Phase B1)
// ---------------------------------------------------------------------------

/**
 * Convenience: turn a `(block, score)[]` pair into the reranker's
 * candidate shape and back. Trigger text is the only body field
 * allowed at scoring time (§L5).
 */
export function blockCandidatesFor(
  hits: Array<{ block: ReasoningBlock; score: number }>,
): RerankerCandidate[] {
  return hits.map((h) => ({
    blockId: h.block.id,
    triggerText: h.block.trigger.situation,
  }));
}
