/**
 * Phase E.2.1 — semantic data plane v2 ($0, fake backend). Two-plane overlay:
 * lookupCached (sync, network-free) + scheduleWarm (async, bounded, single-flight).
 * Cache MISS returns baseline immediately; warming never affects served output.
 *
 * Covers: first-miss no-network serving, async warming, stampede coalescing,
 * SQLite restart persistence, timeout cancellation, forged tenant, attestation/
 * requestId mismatch, extra/duplicate block IDs, malformed payload, 413, overload,
 * leak rejection (client + server).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRerankService, type RerankService } from "../../src/experiments/semantic-bakeoff/service/server.js";
import { FakeRerankBackend, type FakeBackendOptions } from "../../src/experiments/semantic-bakeoff/service/backend.js";
import { HttpRerankProvider } from "../../src/experiments/semantic-bakeoff/service/client.js";
import { InMemorySemanticCache, SqliteSemanticCache, type SemanticCache } from "../../src/experiments/semantic-bakeoff/service/cache.js";
import { FakeAuthenticator, TenantQuota } from "../../src/experiments/semantic-bakeoff/service/auth.js";
import { WarmQueue } from "../../src/experiments/semantic-bakeoff/service/warm-queue.js";
import { decodeRerankResponse, decodeRerankRequest, RERANK_PROTOCOL_VERSION } from "../../src/experiments/semantic-bakeoff/service/protocol.js";
import type { ApplicabilityCandidate, ApplicabilityContext } from "../../src/core/applicability-reranker.js";

const cand = (id: string, mech: string[] = ["rounding", "error"]): ApplicabilityCandidate => ({
  blockId: id,
  tokens: { situation: ["balance"], mechanism: mech, unlock: ["kahan"], invariants: [] },
  signals: { isPitfall: false, helpful: 1, harmful: 0, unresolved: 0, familySupport: 1, sourceDiversity: 1 },
});
const QUERY = { literalText: "running balance off by a tiny fraction", causalText: "fp rounding" };
const ctx = (deadlineMs = 2000): ApplicabilityContext => ({ deadlineMs, now: Date.now });
const AUTH = new FakeAuthenticator({ "tok-t1": "t1", "tok-t2": "t2" });

const svcs: RerankService[] = [];
const raws: import("node:http").Server[] = [];
const start = async (o: FakeBackendOptions = {}, opts: Record<string, unknown> = {}): Promise<{ url: string; svc: RerankService }> => {
  const svc = createRerankService(new FakeRerankBackend(o), { authenticator: AUTH, ...opts });
  svcs.push(svc);
  return { url: `http://127.0.0.1:${await svc.listen(0)}`, svc };
};
const startRaw = async (handler: (url: string, res: import("node:http").ServerResponse) => void): Promise<string> => {
  const s = createServer((req, res) => handler(req.url ?? "", res));
  raws.push(s);
  const port = await new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
  return `http://127.0.0.1:${port}`;
};
afterEach(async () => {
  await Promise.all(svcs.map((s) => s.close().catch(() => {})));
  svcs.length = 0;
  for (const r of raws) r.close();
  raws.length = 0;
});

const mkClient = (url: string, cache: SemanticCache, o: Partial<{ token: string; warm: WarmQueue }> = {}): HttpRerankProvider =>
  new HttpRerankProvider({ baseUrl: url, authToken: o.token ?? "tok-t1", cache, ...(o.warm ? { warmQueue: o.warm } : {}) }); // cache partition derived from the token

describe("two-plane overlay — miss serves baseline immediately, warms async", () => {
  it("first call MISS → no overlay (baseline), network happens only in the async warm; second call FRESH", async () => {
    const { url, svc } = await start();
    const cache = new InMemorySemanticCache({ ttlMs: 100000, swrMs: 0, maxEntries: 100 });
    const p = mkClient(url, cache);
    const r1 = await p.rank(QUERY, [cand("b1")], ctx());
    expect(r1).toEqual([]); // miss → baseline (no overlay) immediately
    expect(svc.telemetry.served).toBe(0); // the served path made NO network call
    await p.drainWarm(); // async warm completes
    expect(svc.telemetry.served).toBe(1); // warm did the network
    expect(cache.size()).toBe(1);
    const r2 = await p.rank(QUERY, [cand("b1")], ctx());
    expect(r2).toHaveLength(1); // now served from cache
    expect(p.healthSnapshot().cacheFresh).toBe(1);
    expect(svc.telemetry.served).toBe(1); // no new network on the served path
  });

  it("stampede coalescing — many concurrent misses share ONE warm flight", async () => {
    const { url, svc } = await start({ delayMs: 40 });
    const warm = new WarmQueue({ maxConcurrent: 4, maxQueued: 64 });
    const cache = new InMemorySemanticCache({ ttlMs: 100000, swrMs: 0, maxEntries: 100 });
    const p = mkClient(url, cache, { warm });
    await Promise.all(Array.from({ length: 8 }, () => p.rank(QUERY, [cand("b1")], ctx())));
    await p.drainWarm();
    expect(warm.stats().coalesced).toBeGreaterThanOrEqual(1); // duplicates coalesced
    expect(svc.telemetry.served).toBe(1); // only one actual rerank hit the backend
  });
});

describe("persistent cache — SQLite restart persistence", () => {
  it("a verdict cached before 'restart' is served (fresh) by a new cache on the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-cache-"));
    const dbPath = join(dir, "cache.db");
    const { url } = await start();
    try {
      const c1 = new SqliteSemanticCache(dbPath, { ttlMs: 100000, swrMs: 0, maxEntries: 100 });
      const p1 = mkClient(url, c1);
      await p1.rank(QUERY, [cand("b1")], ctx());
      await p1.drainWarm();
      expect(c1.size()).toBe(1);
      c1.close(); // "restart"
      const c2 = new SqliteSemanticCache(dbPath, { ttlMs: 100000, swrMs: 0, maxEntries: 100 });
      expect(c2.size()).toBe(1); // persisted
      const p2 = mkClient(url, c2);
      // warm the attestation first (a fresh client has no attestation), then the prior entry is reused
      await p2.rank(QUERY, [cand("b1")], ctx());
      await p2.drainWarm();
      const r = await p2.rank(QUERY, [cand("b1")], ctx());
      expect(r).toHaveLength(1);
      c2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SQLite cache eviction is true LRU: a successful get protects the touched row", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-cache-lru-"));
    const dbPath = join(dir, "cache.db");
    let now = 1;
    const cache = new SqliteSemanticCache(dbPath, { ttlMs: 100000, swrMs: 0, maxEntries: 2, now: () => now++ });
    try {
      cache.set("a", { verdict: "applicable", confidence: 1 });
      cache.set("b", { verdict: "applicable", confidence: 1 });
      expect(cache.get("a").state).toBe("fresh"); // touch a → b is now LRU
      cache.set("c", { verdict: "applicable", confidence: 1 });
      expect(cache.get("a").state).toBe("fresh");
      expect(cache.get("b").state).toBe("miss");
      expect(cache.get("c").state).toBe("fresh");
    } finally {
      cache.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auth — tenant from verified principal, never the body", () => {
  it("no/invalid credentials → 401; forged body tenant is irrelevant (no tenant field in v2)", async () => {
    const { url } = await start();
    const body = JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", deadlineMs: 100, expiresAtMs: Date.now() + 100000, featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["m"], situation: [], unlock: [] }], tenant: "victim" });
    const noAuth = await fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(noAuth.status).toBe(401);
    const ok = await fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-t1" }, body });
    expect(ok.status).toBe(200); // tenant derived from token; the body's "tenant":"victim" is ignored
  });

  it("credential isolation — a different-token client cannot read another's cached verdicts", async () => {
    const { url } = await start();
    const shared = new InMemorySemanticCache({ ttlMs: 100000, swrMs: 0, maxEntries: 100 });
    const pT1 = mkClient(url, shared, { token: "tok-t1" }); // partition = credentialPartition(tok-t1)
    await pT1.rank(QUERY, [cand("b1")], ctx());
    await pT1.drainWarm();
    const pT2 = mkClient(url, shared, { token: "tok-t2" }); // different credential → different partition
    const r = await pT2.rank(QUERY, [cand("b1")], ctx());
    expect(r).toEqual([]); // different credential partition in the key → miss (cannot be forged independently of the token)
    expect(pT2.healthSnapshot().cacheFresh).toBe(0);
  });

  it("quota → 429", async () => {
    const { url } = await start({}, { quota: new TenantQuota(0, 1) }); // burst 1, no refill
    const post = () => fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-t1" }, body: JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", deadlineMs: 100, expiresAtMs: Date.now() + 100000, featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["m"], situation: [], unlock: [] }] }) });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429); // burst exhausted
  });
});

describe("strict v2 decoders — protocol verification", () => {
  const reqIds = new Set(["b1", "b2"]);
  it("response: requestId mismatch / extra id / duplicate id / bad verdict / out-of-range confidence → null", () => {
    const base = (results: unknown[], rid = "r1") => ({ v: RERANK_PROTOCOL_VERSION, requestId: rid, attestation: { model: "m", revision: "rev", featureVersion: 1, backend: "fake" }, results });
    const exp = { requestId: "r1", requestedBlockIds: reqIds };
    expect(decodeRerankResponse(base([{ blockId: "b1", verdict: "applicable", confidence: 0.5 }], "WRONG"), exp)).toBeNull(); // requestId mismatch
    expect(decodeRerankResponse(base([{ blockId: "EXTRA", verdict: "applicable", confidence: 0.5 }]), exp)).toBeNull(); // extra id (not subset)
    expect(decodeRerankResponse(base([{ blockId: "b1", verdict: "applicable", confidence: 0.5 }, { blockId: "b1", verdict: "uncertain", confidence: 0.4 }]), exp)).toBeNull(); // duplicate id
    expect(decodeRerankResponse(base([{ blockId: "b1", verdict: "maybe", confidence: 0.5 }]), exp)).toBeNull(); // bad verdict enum
    expect(decodeRerankResponse(base([{ blockId: "b1", verdict: "applicable", confidence: 1.5 }]), exp)).toBeNull(); // confidence > 1
    expect(decodeRerankResponse(base([{ blockId: "b1", verdict: "applicable", confidence: 0.5 }]), exp)).not.toBeNull(); // valid subset
  });

  it("request: duplicate candidate ids / missing fields / bad version → null", () => {
    const b = (o: Record<string, unknown>) => decodeRerankRequest({ v: RERANK_PROTOCOL_VERSION, requestId: "r", deadlineMs: 50, expiresAtMs: 1, featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: [], situation: [], unlock: [] }], ...o }, { maxCandidates: 8 });
    expect(b({ candidates: [{ blockId: "b1", mechanism: [], situation: [], unlock: [] }, { blockId: "b1", mechanism: [], situation: [], unlock: [] }] })).toBeNull(); // dup
    expect(b({ v: 1 })).toBeNull(); // wrong version
    expect(b({ requestId: "" })).toBeNull(); // empty requestId
    expect(b({ candidates: [] })).toBeNull(); // no candidates
    expect(b({})).not.toBeNull();
  });

  it("client warm caches NOTHING when the server returns a mismatched requestId", async () => {
    const url = await startRaw((u, res) => {
      if (u === "/v1/rerank") return res.end(JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "TOTALLY-WRONG", attestation: { model: "m", revision: "r", featureVersion: 1, backend: "x" }, results: [{ blockId: "b1", verdict: "applicable", confidence: 0.9 }] }));
      res.end("{}");
    });
    const cache = new InMemorySemanticCache({ ttlMs: 100000, swrMs: 0, maxEntries: 100 });
    const p = mkClient(url, cache);
    await p.rank(QUERY, [cand("b1")], ctx());
    await p.drainWarm();
    expect(cache.size()).toBe(0); // verification failed → nothing cached
  });
});

describe("server hardening — fail-open / 413 / overload / leak / timeout", () => {
  it("malformed JSON → 400; oversized body → clean 413", async () => {
    const { url } = await start({}, { maxBodyBytes: 64 });
    const h = { "content-type": "application/json", authorization: "Bearer tok-t1" };
    expect((await fetch(`${url}/v1/rerank`, { method: "POST", headers: h, body: "not json" })).status).toBe(400);
    const big = JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x".repeat(500), deadlineMs: 1, expiresAtMs: Date.now() + 1e6, featureVersion: 1, query: { literalText: "x".repeat(2000) }, candidates: [{ blockId: "b", mechanism: [], situation: [], unlock: [] }] });
    expect((await fetch(`${url}/v1/rerank`, { method: "POST", headers: h, body: big })).status).toBe(413);
  });

  it("overload → 503", async () => {
    const { url } = await start({ delayMs: 120 }, { concurrency: 1 });
    const post = () => fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-t1" }, body: JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", deadlineMs: 1000, expiresAtMs: Date.now() + 1e6, featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["m"], situation: [], unlock: [] }] }) });
    const codes = (await Promise.all([post(), post(), post()])).map((r) => r.status);
    expect(codes).toContain(503);
  });

  it("server-side leak re-scan → 422", async () => {
    const { url, svc } = await start();
    const res = await fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-t1" }, body: JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", deadlineMs: 100, expiresAtMs: Date.now() + 1e6, featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["C:\\Users\\me\\secret.txt"], situation: [], unlock: [] }] }) });
    expect(res.status).toBe(422);
    expect(svc.telemetry.rejectedLeak).toBe(1);
  });

  it("client scans before transport → leak never hits the server (baseline)", async () => {
    const { url, svc } = await start();
    const p = mkClient(url, new InMemorySemanticCache({ ttlMs: 1000, swrMs: 0, maxEntries: 10 }));
    const r = await p.rank(QUERY, [cand("b1", ["see", "/Users/secret/leak.ts"])], ctx());
    expect(r).toBeNull();
    expect(p.healthSnapshot().scannerBlocked).toBe(1);
    await p.drainWarm();
    expect(svc.telemetry.served).toBe(0);
  });

  it("server deadline → 504 (backend aborted via signal)", async () => {
    const { url, svc } = await start({ delayMs: 400 }, { maxDeadlineMs: 40 });
    const res = await fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-t1" }, body: JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", deadlineMs: 1000, expiresAtMs: Date.now() + 1e6, featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["m"], situation: [], unlock: [] }] }) });
    expect(res.status).toBe(504);
    expect(svc.telemetry.timeouts).toBe(1);
  });

  it("expired request → 410", async () => {
    const { url, svc } = await start();
    const res = await fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-t1" }, body: JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", deadlineMs: 100, expiresAtMs: 1, featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["m"], situation: [], unlock: [] }] }) });
    expect(res.status).toBe(410);
    expect(svc.telemetry.rejectedExpired).toBe(1);
  });
});

describe("client lifecycle — lookup-only hook mode + bounded close", () => {
  it("lookup-only mode observes a miss without issuing a warm request", async () => {
    const { url, svc } = await start();
    const p = new HttpRerankProvider({
      baseUrl: url,
      authToken: "tok-t1",
      cache: new InMemorySemanticCache({ ttlMs: 1000, swrMs: 0, maxEntries: 10 }),
      warming: "disabled",
    });
    expect(await p.rank(QUERY, [cand("b1")], ctx())).toEqual([]);
    await p.drainWarm();
    expect(svc.telemetry.served).toBe(0);
    expect(p.healthSnapshot().warmingSuppressed).toBe(1);
  });

  it("close aborts an in-flight warm after its bounded drain deadline", async () => {
    const { url } = await start({ delayMs: 1000 });
    const p = new HttpRerankProvider({
      baseUrl: url,
      authToken: "tok-t1",
      cache: new InMemorySemanticCache({ ttlMs: 1000, swrMs: 0, maxEntries: 10 }),
    });
    await p.rank(QUERY, [cand("b1")], ctx());
    await p.close({ drainDeadlineMs: 5 });
    expect(p.healthSnapshot().warmAborted).toBeGreaterThanOrEqual(1);
    expect(p.warmStats()).toMatchObject({ active: 0, pending: 0, accepting: false });
  });

  it("close stays bounded when a custom fetch violates AbortSignal semantics", async () => {
    const ignoresAbort = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const p = new HttpRerankProvider({
      baseUrl: "http://unused",
      authToken: "tok-t1",
      cache: new InMemorySemanticCache({ ttlMs: 1000, swrMs: 0, maxEntries: 10 }),
      fetchImpl: ignoresAbort,
    });
    await p.rank(QUERY, [cand("b1")], ctx());
    const startedAt = Date.now();
    await p.close({ drainDeadlineMs: 5 });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(p.warmStats()).toMatchObject({ active: 1, pending: 0, accepting: false });
  });
});
