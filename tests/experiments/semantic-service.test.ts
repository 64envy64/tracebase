/**
 * Phase E.2 Track B — semantic inference data plane ($0, fake backend).
 *
 * Covers the service + client + SWR cache invariants over real HTTP (127.0.0.1):
 * cache fresh/stale/miss, deadline→fail-open, malformed→fail-open, crash→fail-open,
 * overload→503, leak rejection (client-before-transport AND server-side), and
 * model-version invalidation. No model, no GPU, no network egress.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { createRerankService, type RerankService } from "../../src/experiments/semantic-bakeoff/service/server.js";
import { FakeRerankBackend, type FakeBackendOptions } from "../../src/experiments/semantic-bakeoff/service/backend.js";
import { HttpRerankProvider } from "../../src/experiments/semantic-bakeoff/service/client.js";
import { SwrCache } from "../../src/experiments/semantic-bakeoff/service/cache.js";
import { RERANK_PROTOCOL_VERSION } from "../../src/experiments/semantic-bakeoff/service/protocol.js";
import type { ApplicabilityCandidate, ApplicabilityContext } from "../../src/core/applicability-reranker.js";

const cand = (id: string, mech: string[] = ["rounding", "error"]): ApplicabilityCandidate => ({
  blockId: id,
  tokens: { situation: ["balance"], mechanism: mech, unlock: ["kahan"], invariants: [] },
  signals: { isPitfall: false, helpful: 1, harmful: 0, unresolved: 0, familySupport: 1, sourceDiversity: 1 },
});
const QUERY = { literalText: "running balance off by a tiny fraction", causalText: "fp rounding accumulates" };
const ctx = (deadlineMs: number): ApplicabilityContext => ({ deadlineMs, now: Date.now });

const svcs: RerankService[] = [];
const raws: import("node:http").Server[] = [];
const start = async (o: FakeBackendOptions = {}, opts = {}): Promise<{ url: string; svc: RerankService }> => {
  const svc = createRerankService(new FakeRerankBackend(o), opts);
  svcs.push(svc);
  const port = await svc.listen(0);
  return { url: `http://127.0.0.1:${port}`, svc };
};
afterEach(async () => {
  await Promise.all(svcs.map((s) => s.close().catch(() => {})));
  svcs.length = 0;
  for (const r of raws) r.close();
  raws.length = 0;
});

function client(url: string, clock: { t: number }, cache?: SwrCache, tenant = "t1"): HttpRerankProvider {
  const c = cache ?? new SwrCache({ ttlMs: 1000, swrMs: 1000, maxEntries: 100, now: () => clock.t });
  return new HttpRerankProvider({ baseUrl: url, tenant, cache: c, attestationTtlMs: 0, now: () => clock.t });
}

describe("semantic data plane — cache fresh/stale/miss", () => {
  it("miss → fetch → fresh (second call serves from cache, no new server hit)", async () => {
    const { url, svc } = await start();
    const clock = { t: 1000 };
    const cache = new SwrCache({ ttlMs: 1000, swrMs: 1000, maxEntries: 100, now: () => clock.t });
    const p = client(url, clock, cache);
    const r1 = await p.rank(QUERY, [cand("b1")], ctx(2000));
    expect(r1).not.toBeNull();
    expect(svc.telemetry.served).toBe(1);
    expect(p.healthSnapshot().cacheMiss).toBe(1);
    const r2 = await p.rank(QUERY, [cand("b1")], ctx(2000)); // clock unchanged → fresh
    expect(r2).not.toBeNull();
    expect(svc.telemetry.served).toBe(1); // NO new server hit
    expect(p.healthSnapshot().cacheFresh).toBe(1);
  });

  it("stale → serve cached NOW + async revalidate", async () => {
    const { url, svc } = await start();
    const clock = { t: 1000 };
    const cache = new SwrCache({ ttlMs: 1000, swrMs: 1000, maxEntries: 100, now: () => clock.t });
    const p = client(url, clock, cache);
    await p.rank(QUERY, [cand("b1")], ctx(2000)); // miss → cached @1000
    clock.t = 2500; // age 1500: ttl<age<=ttl+swr → stale
    const r = await p.rank(QUERY, [cand("b1")], ctx(2000));
    expect(r).not.toBeNull();
    expect(p.healthSnapshot().cacheStale).toBe(1);
    expect(p.healthSnapshot().revalidations).toBe(1);
    await new Promise((res) => setTimeout(res, 150)); // let the async revalidation land
    expect(svc.telemetry.served).toBe(2); // revalidation hit the server
  });

  it("miss past the SWR window → refetch", async () => {
    const { url, svc } = await start();
    const clock = { t: 1000 };
    const cache = new SwrCache({ ttlMs: 1000, swrMs: 1000, maxEntries: 100, now: () => clock.t });
    const p = client(url, clock, cache);
    await p.rank(QUERY, [cand("b1")], ctx(2000)); // @1000
    clock.t = 1000 + 1000 + 1000 + 1; // past ttl+swr
    await p.rank(QUERY, [cand("b1")], ctx(2000));
    expect(svc.telemetry.served).toBe(2); // refetched
  });
});

describe("semantic data plane — total fail-open", () => {
  it("deadline exceeded → null (fail open)", async () => {
    const { url } = await start({ delayMs: 300 });
    const clock = { t: 1000 };
    const r = await client(url, clock).rank(QUERY, [cand("b1")], ctx(30)); // client deadline << backend delay
    expect(r).toBeNull();
  });

  it("backend crash → 502 → null (fail open)", async () => {
    const { url, svc } = await start({ throwErr: true });
    const clock = { t: 1000 };
    const r = await client(url, clock).rank(QUERY, [cand("b1")], ctx(2000));
    expect(r).toBeNull();
    expect(svc.telemetry.backendErrors).toBeGreaterThanOrEqual(1);
  });

  it("malformed response → null (fail open)", async () => {
    const raw = createServer((_req, res) => {
      if (_req.url === "/v1/health") return res.end(JSON.stringify({ attestation: { model: "x", revision: "r", featureVersion: 1, backend: "x" } }));
      res.end("this is not json");
    });
    raws.push(raw);
    const port = await new Promise<number>((r) => raw.listen(0, "127.0.0.1", () => r((raw.address() as { port: number }).port)));
    const clock = { t: 1000 };
    const r = await client(`http://127.0.0.1:${port}`, clock).rank(QUERY, [cand("b1")], ctx(2000));
    expect(r).toBeNull();
  });

  it("overload → 503 (server-level)", async () => {
    const { url } = await start({ delayMs: 150 }, { concurrency: 1 });
    const body = JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", tenant: "t", featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["m"], situation: [], unlock: [] }] });
    const post = () => fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const [a, b, c] = await Promise.all([post(), post(), post()]);
    const codes = [a.status, b.status, c.status];
    expect(codes).toContain(503); // at least one shed
  });
});

describe("semantic data plane — leak rejection", () => {
  it("client SCANS before transport — a leak never hits the server", async () => {
    const { url, svc } = await start();
    const clock = { t: 1000 };
    const p = client(url, clock);
    const r = await p.rank(QUERY, [cand("b1", ["see", "/Users/secret/leak.ts"])], ctx(2000));
    expect(r).toBeNull();
    expect(p.healthSnapshot().scannerBlocked).toBe(1);
    expect(svc.telemetry.served).toBe(0); // server never saw it
  });

  it("server re-scans (defence in depth) → 422", async () => {
    const { url, svc } = await start();
    const body = JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", tenant: "t", featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["C:\\Users\\me\\secret.txt"], situation: [], unlock: [] }] });
    const res = await fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(res.status).toBe(422);
    expect(svc.telemetry.rejectedLeak).toBe(1);
  });
});

describe("semantic data plane — model-version invalidation", () => {
  it("a revision change yields different cache keys → miss (old entries don't serve new version)", async () => {
    const clock = { t: 1000 };
    const cache = new SwrCache({ ttlMs: 100000, swrMs: 0, maxEntries: 100, now: () => clock.t });
    const a = await start({ revision: "revA" });
    const pA = client(a.url, clock, cache);
    await pA.rank(QUERY, [cand("b1")], ctx(2000)); // caches under revA
    expect(cache.size).toBe(1);
    // New service at revB; a client pointed at it must MISS (key embeds the revision).
    const b = await start({ revision: "revB" });
    const pB = client(b.url, clock, cache);
    await pB.rank(QUERY, [cand("b1")], ctx(2000));
    expect(pB.healthSnapshot().cacheMiss).toBe(1); // revA entry did not serve the revB request
    expect(b.svc.telemetry.served).toBe(1);
    expect(cache.size).toBe(2); // both revisions coexist; old ages out under LRU/TTL
  });
});
