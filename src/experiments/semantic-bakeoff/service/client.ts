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
import { RERANK_PROTOCOL_VERSION, queryHash, candidateDigest, cacheKey, credentialPartition, decodeRerankResponse, attestationHash, type RerankRequestDTO, type ModelAttestation } from "./protocol.js";
import type { SemanticCache } from "./cache.js";
import { WarmQueue } from "./warm-queue.js";

export interface HttpRerankClientOptions {
  baseUrl: string;
  /**
   * Bearer credential. The cache PARTITION is DERIVED from this (credentialPartition)
   * — there is no separately-settable tenant, so the client's cache namespace can
   * never diverge from the principal the server derives from the same token (E.2.3).
   */
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
  /**
   * Hook processes are short-lived and MUST stay lookup-only. Long-lived MCP/SDK
   * roots keep warming enabled. This avoids starting network work that is thrown
   * away when a hook closes its SQLite handle immediately after recall.
   */
  warming?: "enabled" | "disabled";
}

export interface HttpClientHealth {
  servedCalls: number;
  cacheFresh: number;
  cacheStale: number;
  cacheMiss: number;
  warmsScheduled: number;
  warmsCompleted: number;
  warmErrors: number;
  warmAborted: number;
  warmingSuppressed: number;
  warmLatencyP95Ms: number;
  scannerBlocked: number;
  attestationRejected: number;
}

export class HttpRerankProvider implements ApplicabilityProvider {
  readonly name = "http-rerank";
  private att: ModelAttestation | null = null;
  private readonly warm: WarmQueue;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Cache partition DERIVED from the credential — never independently settable. */
  private readonly partition: string;
  private reqSeq = 0;
  private closed = false;
  private readonly activeControllers = new Set<AbortController>();
  private readonly warmLatenciesMs: number[] = [];
  private readonly health: HttpClientHealth = {
    servedCalls: 0,
    cacheFresh: 0,
    cacheStale: 0,
    cacheMiss: 0,
    warmsScheduled: 0,
    warmsCompleted: 0,
    warmErrors: 0,
    warmAborted: 0,
    warmingSuppressed: 0,
    warmLatencyP95Ms: 0,
    scannerBlocked: 0,
    attestationRejected: 0,
  };

  constructor(private readonly opts: HttpRerankClientOptions) {
    this.warm = opts.warmQueue ?? new WarmQueue({ maxConcurrent: 4, maxQueued: 64 });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.att = opts.pinnedAttestation ?? null; // pinned → cache keys work offline immediately
    this.partition = credentialPartition(opts.authToken); // cache namespace bound to the credential
  }
  get featureVersion(): number {
    return this.att?.featureVersion ?? 0;
  }
  healthSnapshot(): Readonly<HttpClientHealth> {
    return { ...this.health };
  }
  attestationId(): string | null {
    return this.att ? attestationHash(this.att) : null;
  }
  semanticAttestationId(): string | null {
    return this.attestationId();
  }
  warmStats(): ReturnType<WarmQueue["stats"]> {
    return this.warm.stats();
  }
  semanticHealthSnapshot(): Readonly<HttpClientHealth> {
    return this.healthSnapshot();
  }
  semanticWarmStats(): ReturnType<WarmQueue["stats"]> {
    return this.warmStats();
  }
  drainWarm(): Promise<void> {
    return this.warm.drain();
  }

  /**
   * Stop new warm work, allow a bounded graceful drain, then abort anything still
   * in flight. Safe to call repeatedly. The cache owner closes SQLite afterwards.
   */
  async close(opts: { drainDeadlineMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.warm.stopAccepting();
    const deadlineMs = Math.max(0, opts.drainDeadlineMs ?? 250);
    if (await this.waitForWarmDrain(deadlineMs)) return;
    this.warm.cancelPending();
    for (const ac of this.activeControllers) ac.abort();
    // A custom fetch implementation may violate AbortSignal semantics. Close
    // remains bounded even then; late cache writes fail open after its owner
    // closes the SQLite handle.
    await this.waitForWarmDrain(Math.min(50, deadlineMs));
  }

  private async waitForWarmDrain(deadlineMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      this.warm.drain().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return drained;
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
      const key = cacheKey({ partition: this.partition, revision: this.att.revision, featureVersion: this.att.featureVersion, queryHash: qh, candidateDigest: candidateDigest(c), blockId: c.blockId });
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
    if (this.closed || this.opts.warming === "disabled") {
      this.health.warmingSuppressed++;
      return;
    }
    const qh = queryHash(q);
    // Coalesce key is VERSION + CONTENT bound: tenant + model revision/featureVersion
    // + queryHash + each candidate's content digest. A model-version OR candidate-
    // content change yields a different flight key (no wrong coalescing).
    const ver = this.att ? `${this.att.revision}@${this.att.featureVersion}` : "unpinned";
    const sig = candidates.map((c) => `${c.blockId}:${candidateDigest(c)}`).sort().join(",");
    const flightKey = `${this.partition} ${ver} ${qh} ${sig}`;
    const status = this.warm.schedule(flightKey, () => this.fetchAndCache(q, qh, candidates));
    if (status === "started" || status === "queued") this.health.warmsScheduled++;
  }

  private async fetchAndCache(q: WireQuery, qh: string, candidates: WireCandidate[]): Promise<void> {
    const requestId = `req-${this.now()}-${++this.reqSeq}`;
    const deadlineMs = this.opts.warmDeadlineMs ?? 2000;
    const body: RerankRequestDTO = { v: RERANK_PROTOCOL_VERSION, requestId, deadlineMs, expiresAtMs: this.now() + deadlineMs, featureVersion: this.att?.featureVersion ?? 1, query: q, candidates };
    const ac = new AbortController();
    this.activeControllers.add(ac);
    const startedAt = this.now();
    const timer = setTimeout(() => ac.abort(), deadlineMs);
    try {
      const r = await this.fetchImpl(`${this.opts.baseUrl}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.authToken}` }, body: JSON.stringify(body), signal: ac.signal });
      if (!r.ok) {
        this.health.warmErrors++;
        return;
      }
      const resp = decodeRerankResponse(await r.json(), { requestId, requestedBlockIds: new Set(candidates.map((c) => c.blockId)) });
      if (!resp) {
        this.health.warmErrors++;
        return; // strict decode / verification failed → cache nothing
      }
      // PINNED attestation validation: a response from a different model/revision/
      // backend/featureVersion is REJECTED and cached nothing.
      const pin = this.opts.pinnedAttestation;
      if (pin && (resp.attestation.model !== pin.model || resp.attestation.revision !== pin.revision || resp.attestation.backend !== pin.backend || resp.attestation.featureVersion !== pin.featureVersion)) {
        this.health.attestationRejected++;
        this.health.warmErrors++;
        return;
      }
      if (!pin) this.att = resp.attestation; // learn attestation only when not pinned
      const byId = new Map(candidates.map((c) => [c.blockId, c] as const));
      for (const res of resp.results) {
        const c = byId.get(res.blockId);
        if (!c) continue;
        this.opts.cache.set(cacheKey({ partition: this.partition, revision: resp.attestation.revision, featureVersion: resp.attestation.featureVersion, queryHash: qh, candidateDigest: candidateDigest(c), blockId: res.blockId }), { verdict: res.verdict, confidence: res.confidence });
      }
      this.health.warmsCompleted++;
    } catch (err) {
      // warm failures are invisible to serving
      if (ac.signal.aborted) this.health.warmAborted++;
      else {
        void err;
        this.health.warmErrors++;
      }
    } finally {
      clearTimeout(timer);
      this.activeControllers.delete(ac);
      this.warmLatenciesMs.push(Math.max(0, this.now() - startedAt));
      if (this.warmLatenciesMs.length > 256) this.warmLatenciesMs.shift();
      const sorted = [...this.warmLatenciesMs].sort((a, b) => a - b);
      this.health.warmLatencyP95Ms = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    }
  }

  /** ApplicabilityProvider contract: lookupCached + scheduleWarm; returns immediately. */
  async rank(query: ApplicabilityQueryViews, candidates: readonly ApplicabilityCandidate[], _ctx: ApplicabilityContext): Promise<ApplicabilityResult[] | null> {
    if (this.closed) return null;
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
