/**
 * Two-plane HTTP client for the semantic data plane (R&D, E.2.1).
 *
 * The served path and the inference path are SEPARATE methods:
 *   - lookupCached(): SYNCHRONOUS, local, network-free. Reads the verdict cache.
 *   - scheduleWarm():  ASYNC, bounded, single-flight. Populates the cache for
 *     FUTURE lookups; it NEVER affects served output.
 *
 * rank() (the ApplicabilityProvider contract) = lookupCached + scheduleWarm and
 * returns immediately: fresh/stale cached verdicts are returned now; a **cache
 * miss yields no overlay (the caller uses the deterministic baseline) and schedules
 * a warm**. No network call is ever awaited on the served path. Total fail-open.
 */
import { detectLeakageExtended } from "../../../core/guard.js";
import type {
  ApplicabilityProvider,
  ApplicabilityQueryViews,
  ApplicabilityCandidate,
  ApplicabilityContext,
  ApplicabilityResult,
} from "../../../core/applicability-reranker.js";
import type { WireCandidate, WireQuery } from "../worker-protocol.js";
import { RERANK_PROTOCOL_VERSION, queryHash, candidateDigest, cacheKey, decodeRerankResponse, type RerankRequestDTO, type ModelAttestation } from "./protocol.js";
import type { SemanticCache } from "./cache.js";
import { WarmQueue } from "./warm-queue.js";

export interface HttpRerankClientOptions {
  baseUrl: string;
  tenant: string; // used for cache keying; the server independently derives it from the token
  authToken: string;
  cache: SemanticCache;
  warmQueue?: WarmQueue;
  maxCandidates?: number;
  maxTokensPerField?: number;
  warmDeadlineMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /**
   * E.2.2 — PINNED model attestation. When set, the client keys the cache from it
   * IMMEDIATELY (no /v1/health round-trip), so a validated persisted cache is
   * readable right after restart with NO network warm-up. Every response's
   * attestation is also VALIDATED against it; a mismatch caches nothing.
   */
  pinnedAttestation?: ModelAttestation;
}

export interface HttpClientHealth {
  servedCalls: number;
  cacheFresh: number;
  cacheStale: number;
  cacheMiss: number;
  warmsScheduled: number;
  scannerBlocked: number;
  attestationRejected: number;
}

export class HttpRerankProvider implements ApplicabilityProvider {
  readonly name = "http-rerank";
  private att: ModelAttestation | null = null;
  private readonly warm: WarmQueue;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private reqSeq = 0;
  private readonly health: HttpClientHealth = { servedCalls: 0, cacheFresh: 0, cacheStale: 0, cacheMiss: 0, warmsScheduled: 0, scannerBlocked: 0, attestationRejected: 0 };

  constructor(private readonly opts: HttpRerankClientOptions) {
    this.warm = opts.warmQueue ?? new WarmQueue({ maxConcurrent: 4, maxQueued: 64 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.att = opts.pinnedAttestation ?? null; // pinned → cache keys work offline immediately
  }
  get featureVersion(): number {
    return this.att?.featureVersion ?? 0;
  }
  healthSnapshot(): Readonly<HttpClientHealth> {
    return { ...this.health };
  }
  warmStats(): ReturnType<WarmQueue["stats"]> {
    return this.warm.stats();
  }
  drainWarm(): Promise<void> {
    return this.warm.drain();
  }

  private toWire(query: ApplicabilityQueryViews, candidates: readonly ApplicabilityCandidate[]): { q: WireQuery; wire: WireCandidate[] } {
    const maxT = this.opts.maxTokensPerField ?? 64;
    return {
      q: { literalText: String(query.literalText ?? "").slice(0, 8000), ...(query.causalText ? { causalText: String(query.causalText).slice(0, 8000) } : {}) },
      wire: candidates.slice(0, this.opts.maxCandidates ?? 16).map((c) => ({ blockId: c.blockId, mechanism: c.tokens.mechanism.slice(0, maxT) as string[], situation: c.tokens.situation.slice(0, maxT) as string[], unlock: c.tokens.unlock.slice(0, maxT) as string[] })),
    };
  }

  /** SYNCHRONOUS, local, network-free read. Returns cached verdicts + what needs warming. */
  lookupCached(q: WireQuery, wire: WireCandidate[]): { results: ApplicabilityResult[]; toWarm: WireCandidate[] } {
    const results: ApplicabilityResult[] = [];
    const toWarm: WireCandidate[] = [];
    if (!this.att) return { results, toWarm: [...wire] }; // no attestation yet → everything must warm
    const qh = queryHash(q);
    for (const c of wire) {
      const key = cacheKey({ tenant: this.opts.tenant, revision: this.att.revision, featureVersion: this.att.featureVersion, queryHash: qh, candidateDigest: candidateDigest(c), blockId: c.blockId });
      const { state, value } = this.opts.cache.get(key);
      if (state === "miss" || !value) {
        this.health.cacheMiss++;
        toWarm.push(c); // miss → baseline now (omit) + warm
      } else {
        if (state === "fresh") this.health.cacheFresh++;
        else {
          this.health.cacheStale++;
          toWarm.push(c); // stale → serve cached NOW + warm
        }
        results.push({ blockId: c.blockId, verdict: value.verdict, confidence: value.confidence, reasons: [], featureVersion: this.att.featureVersion, evidence: { mechanism: value.confidence, remediation: 0, invariants: 0, discriminativeGap: 0, contradiction: 0, familySupport: 0 } });
      }
    }
    return { results, toWarm };
  }

  /** ASYNC, bounded, single-flight. Populates the cache; NEVER affects served output. */
  scheduleWarm(q: WireQuery, candidates: WireCandidate[]): void {
    if (candidates.length === 0) return;
    const qh = queryHash(q);
    // Coalesce key is VERSION + CONTENT bound: tenant + model revision/featureVersion
    // + queryHash + each candidate's content digest. A model-version OR candidate-
    // content change yields a different flight key (no wrong coalescing).
    const ver = this.att ? `${this.att.revision}@${this.att.featureVersion}` : "unpinned";
    const sig = candidates.map((c) => `${c.blockId}:${candidateDigest(c)}`).sort().join(",");
    const flightKey = `${this.opts.tenant} ${ver} ${qh} ${sig}`;
    this.health.warmsScheduled++;
    this.warm.schedule(flightKey, () => this.fetchAndCache(q, qh, candidates));
  }

  private async fetchAndCache(q: WireQuery, qh: string, candidates: WireCandidate[]): Promise<void> {
    const requestId = `req-${this.now()}-${++this.reqSeq}`;
    const deadlineMs = this.opts.warmDeadlineMs ?? 2000;
    const body: RerankRequestDTO = { v: RERANK_PROTOCOL_VERSION, requestId, deadlineMs, expiresAtMs: this.now() + deadlineMs, featureVersion: this.att?.featureVersion ?? 1, query: q, candidates };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deadlineMs);
    try {
      const r = await this.fetchImpl(`${this.opts.baseUrl}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.authToken}` }, body: JSON.stringify(body), signal: ac.signal });
      if (!r.ok) return;
      const resp = decodeRerankResponse(await r.json(), { requestId, requestedBlockIds: new Set(candidates.map((c) => c.blockId)) });
      if (!resp) return; // strict decode / verification failed → cache nothing
      // PINNED attestation validation: a response from a different model/revision/
      // backend/featureVersion is REJECTED and cached nothing.
      const pin = this.opts.pinnedAttestation;
      if (pin && (resp.attestation.model !== pin.model || resp.attestation.revision !== pin.revision || resp.attestation.backend !== pin.backend || resp.attestation.featureVersion !== pin.featureVersion)) {
        this.health.attestationRejected++;
        return;
      }
      if (!pin) this.att = resp.attestation; // learn attestation only when not pinned
      const byId = new Map(candidates.map((c) => [c.blockId, c] as const));
      for (const res of resp.results) {
        const c = byId.get(res.blockId);
        if (!c) continue;
        this.opts.cache.set(cacheKey({ tenant: this.opts.tenant, revision: resp.attestation.revision, featureVersion: resp.attestation.featureVersion, queryHash: qh, candidateDigest: candidateDigest(c), blockId: res.blockId }), { verdict: res.verdict, confidence: res.confidence });
      }
    } catch {
      // warm failures are invisible to serving
    } finally {
      clearTimeout(timer);
    }
  }

  /** ApplicabilityProvider contract: lookupCached + scheduleWarm; returns immediately. */
  async rank(query: ApplicabilityQueryViews, candidates: readonly ApplicabilityCandidate[], _ctx: ApplicabilityContext): Promise<ApplicabilityResult[] | null> {
    this.health.servedCalls++;
    const { q, wire } = this.toWire(query, candidates);
    if (detectLeakageExtended(JSON.stringify({ q, wire })) !== null) {
      this.health.scannerBlocked++;
      return null; // leak → never transported, baseline
    }
    const { results, toWarm } = this.lookupCached(q, wire);
    if (toWarm.length > 0) this.scheduleWarm(q, toWarm); // async; does not block or affect this result
    return results; // cached verdicts only; misses fall to baseline immediately
  }
}
