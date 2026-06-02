/**
 * HTTP client adapter for the semantic data plane (R&D): an ApplicabilityProvider
 * that calls `/v1/rerank` with a bounded, SCANNED DTO, behind a fail-open baseline
 * and a stale-while-revalidate cache.
 *
 * Fail-open is total: a leak, timeout, HTTP error, malformed response, or
 * unreachable service → `null` → the caller (boundary) uses the deterministic
 * baseline. SWR: all-fresh → no network; some-stale/none-miss → serve cached NOW +
 * revalidate async (never blocks); any-miss → one bounded fetch or fail open.
 * The cache key embeds the model revision + featureVersion (from /v1/health
 * attestation), so a model-version change invalidates automatically.
 */
import { detectLeakageExtended } from "../../../core/guard.js";
import type {
  ApplicabilityProvider,
  ApplicabilityQueryViews,
  ApplicabilityCandidate,
  ApplicabilityContext,
  ApplicabilityResult,
} from "../../../core/applicability-reranker.js";
import type { WireCandidate, WireQuery, WireResult } from "../worker-protocol.js";
import { RERANK_PROTOCOL_VERSION, queryHash, cacheKey, type RerankRequestDTO, type RerankResponseDTO, type ModelAttestation } from "./protocol.js";
import { SwrCache } from "./cache.js";

export interface HttpRerankClientOptions {
  baseUrl: string;
  tenant: string;
  cache: SwrCache;
  /** Fallback featureVersion until /v1/health is reached. */
  featureVersion?: number;
  maxCandidates?: number;
  maxTokensPerField?: number;
  /** Health attestation cache TTL (ms). */
  attestationTtlMs?: number;
  now?: () => number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface HttpClientHealth {
  requests: number;
  cacheFresh: number;
  cacheStale: number;
  cacheMiss: number;
  revalidations: number;
  failOpen: number;
  scannerBlocked: number;
}

export class HttpRerankProvider implements ApplicabilityProvider {
  readonly name = "http-rerank";
  private _featureVersion: number;
  private att: ModelAttestation | null = null;
  private attFetchedAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly health: HttpClientHealth = { requests: 0, cacheFresh: 0, cacheStale: 0, cacheMiss: 0, revalidations: 0, failOpen: 0, scannerBlocked: 0 };

  constructor(private readonly opts: HttpRerankClientOptions) {
    this._featureVersion = opts.featureVersion ?? 1;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }
  get featureVersion(): number {
    return this._featureVersion;
  }
  healthSnapshot(): Readonly<HttpClientHealth> {
    return { ...this.health };
  }

  private async attestation(deadlineMs: number): Promise<ModelAttestation | null> {
    const ttl = this.opts.attestationTtlMs ?? 60_000;
    if (this.att && this.now() - this.attFetchedAt <= ttl) return this.att;
    try {
      const r = await this.timedFetch(`${this.opts.baseUrl}/v1/health`, { method: "GET" }, deadlineMs);
      const h = (await r.json()) as { attestation?: ModelAttestation };
      if (h?.attestation?.revision) {
        this.att = h.attestation;
        this.attFetchedAt = this.now();
        this._featureVersion = h.attestation.featureVersion;
        return this.att;
      }
    } catch {
      /* fall through */
    }
    return this.att; // last-known, or null
  }

  async rank(query: ApplicabilityQueryViews, candidates: readonly ApplicabilityCandidate[], ctx: ApplicabilityContext): Promise<ApplicabilityResult[] | null> {
    this.health.requests++;
    const wireQ: WireQuery = { literalText: cap(query.literalText, this.opts.maxTokensPerField ? 8000 : 8000), ...(query.causalText ? { causalText: cap(query.causalText, 8000) } : {}) };
    const wireC: WireCandidate[] = candidates.slice(0, this.opts.maxCandidates ?? 16).map((c) => ({
      blockId: c.blockId,
      mechanism: c.tokens.mechanism.slice(0, this.opts.maxTokensPerField ?? 64) as string[],
      situation: c.tokens.situation.slice(0, this.opts.maxTokensPerField ?? 64) as string[],
      unlock: c.tokens.unlock.slice(0, this.opts.maxTokensPerField ?? 64) as string[],
    }));
    // SCAN BEFORE TRANSPORT.
    if (detectLeakageExtended(JSON.stringify({ wireQ, wireC })) !== null) {
      this.health.scannerBlocked++;
      return this.failOpen();
    }
    const att = await this.attestation(ctx.deadlineMs);
    if (!att) return this.failOpen(); // can't key the cache without an attestation → baseline

    const qh = queryHash(wireQ);
    const verdicts = new Map<string, WireResult>();
    let anyMiss = false;
    let anyStale = false;
    for (const c of wireC) {
      const { state, value } = this.opts.cache.get(cacheKey(this.opts.tenant, att, qh, c.blockId));
      if (state === "fresh" && value) { this.health.cacheFresh++; verdicts.set(c.blockId, { blockId: c.blockId, verdict: value.verdict, confidence: value.confidence }); }
      else if (state === "stale" && value) { this.health.cacheStale++; anyStale = true; verdicts.set(c.blockId, { blockId: c.blockId, verdict: value.verdict, confidence: value.confidence }); }
      else { this.health.cacheMiss++; anyMiss = true; }
    }

    if (anyMiss) {
      // bounded sync fetch; failure → fail open
      const fresh = await this.fetchRerank(wireQ, wireC, att, qh, ctx.deadlineMs);
      if (!fresh) return this.failOpen();
      for (const r of fresh) verdicts.set(r.blockId, r);
    } else if (anyStale) {
      // serve cached NOW; revalidate async (never blocks)
      this.health.revalidations++;
      void this.fetchRerank(wireQ, wireC, att, qh, ctx.deadlineMs).catch(() => undefined);
    }

    const out: ApplicabilityResult[] = [];
    for (const c of wireC) {
      const v = verdicts.get(c.blockId);
      if (!v) continue;
      out.push({ blockId: c.blockId, verdict: v.verdict, confidence: clamp01(v.confidence), reasons: [], featureVersion: this._featureVersion, evidence: { mechanism: clamp01(v.confidence), remediation: 0, invariants: 0, discriminativeGap: 0, contradiction: 0, familySupport: 0 } });
    }
    return out;
  }

  /** POST /v1/rerank, validate, populate the cache. Returns null (fail open) on any error. */
  private async fetchRerank(q: WireQuery, candidates: WireCandidate[], att: ModelAttestation, qh: string, deadlineMs: number): Promise<WireResult[] | null> {
    const body: RerankRequestDTO = { v: RERANK_PROTOCOL_VERSION, requestId: `req-${this.now()}`, tenant: this.opts.tenant, featureVersion: att.featureVersion, query: q, candidates };
    try {
      const r = await this.timedFetch(`${this.opts.baseUrl}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, deadlineMs);
      if (!r.ok) return null;
      const resp = (await r.json()) as RerankResponseDTO;
      if (resp?.v !== RERANK_PROTOCOL_VERSION || !Array.isArray(resp.results)) return null; // malformed → fail open
      // Cache keyed by the RESPONSE attestation (model-version invalidation).
      for (const res of resp.results) {
        if (!res || typeof res.blockId !== "string" || typeof res.verdict !== "string") return null; // malformed element
        this.opts.cache.set(cacheKey(this.opts.tenant, resp.attestation, qh, res.blockId), { verdict: res.verdict, confidence: clamp01(res.confidence) });
      }
      return resp.results;
    } catch {
      return null;
    }
  }

  private async timedFetch(url: string, init: RequestInit, deadlineMs: number): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(1, deadlineMs));
    try {
      return await this.fetchImpl(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private failOpen(): null {
    this.health.failOpen++;
    return null;
  }
}

function clamp01(n: number): number {
  return !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n;
}
function cap(s: string, n: number): string {
  return typeof s === "string" && s.length > n ? s.slice(0, n) : s ?? "";
}
