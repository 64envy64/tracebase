/**
 * Phase E.2.2 — shadow transport hardening ($0). Bounded FIFO warm queue, pinned
 * attestation (immediate cache after restart + mismatch rejection), split public
 * liveness vs authenticated admin health, expiresAt-clamped deadline, bounded
 * tenant quota map.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRerankService, type RerankService } from "../../src/experiments/semantic-bakeoff/service/server.js";
import { FakeRerankBackend, type FakeBackendOptions } from "../../src/experiments/semantic-bakeoff/service/backend.js";
import { HttpRerankProvider } from "../../src/experiments/semantic-bakeoff/service/client.js";
import { InMemorySemanticCache, SqliteSemanticCache } from "../../src/experiments/semantic-bakeoff/service/cache.js";
import { FakeAuthenticator, TenantQuota } from "../../src/experiments/semantic-bakeoff/service/auth.js";
import { WarmQueue } from "../../src/experiments/semantic-bakeoff/service/warm-queue.js";
import { RERANK_PROTOCOL_VERSION, type ModelAttestation } from "../../src/experiments/semantic-bakeoff/service/protocol.js";
import type { ApplicabilityCandidate, ApplicabilityContext } from "../../src/core/applicability-reranker.js";

const cand = (id: string): ApplicabilityCandidate => ({ blockId: id, tokens: { situation: ["balance"], mechanism: ["rounding"], unlock: ["kahan"], invariants: [] }, signals: { isPitfall: false, helpful: 1, harmful: 0, unresolved: 0, familySupport: 1, sourceDiversity: 1 } });
const QUERY = { literalText: "running balance off by a tiny fraction" };
const ctx = (deadlineMs = 2000): ApplicabilityContext => ({ deadlineMs, now: Date.now });
const AUTH = new FakeAuthenticator({ "tok-t1": "t1" });
const inMem = () => new InMemorySemanticCache({ ttlMs: 100000, swrMs: 0, maxEntries: 100 });

const svcs: RerankService[] = [];
const start = async (o: FakeBackendOptions = {}, opts: Record<string, unknown> = {}): Promise<{ url: string; svc: RerankService }> => {
  const svc = createRerankService(new FakeRerankBackend(o), { authenticator: AUTH, ...opts });
  svcs.push(svc);
  return { url: `http://127.0.0.1:${await svc.listen(0)}`, svc };
};
afterEach(async () => {
  await Promise.all(svcs.map((s) => s.close().catch(() => {})));
  svcs.length = 0;
});

describe("WarmQueue — real bounded FIFO", () => {
  it("active ≤ maxConcurrent, excess queues (bounded), overflow drops", async () => {
    const wq = new WarmQueue({ maxConcurrent: 2, maxQueued: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    for (let i = 0; i < 6; i++) wq.schedule(`k${i}`, () => gate); // 6 distinct keys
    expect(wq.stats().active).toBe(2);
    expect(wq.stats().pending).toBe(2);
    expect(wq.stats().dropped).toBe(2);
    release();
    await wq.drain();
    expect(wq.stats().active).toBe(0);
    expect(wq.stats().pending).toBe(0);
    expect(wq.stats().scheduled).toBe(4); // 2 ran + 2 queued (dropped not scheduled)
  });

  it("coalesces a key already active OR pending", () => {
    const wq = new WarmQueue({ maxConcurrent: 1, maxQueued: 5 });
    const never = () => new Promise<void>(() => undefined);
    wq.schedule("a", never); // active
    wq.schedule("b", never); // pending
    wq.schedule("a", never); // coalesced (active)
    wq.schedule("b", never); // coalesced (pending)
    expect(wq.stats()).toMatchObject({ active: 1, pending: 1, coalesced: 2 });
  });

  it("pumps pending in FIFO order as slots free", async () => {
    const order: string[] = [];
    const wq = new WarmQueue({ maxConcurrent: 1, maxQueued: 10 });
    const mk = (k: string) => () => { order.push(k); return Promise.resolve(); };
    wq.schedule("1", mk("1"));
    wq.schedule("2", mk("2"));
    wq.schedule("3", mk("3"));
    await wq.drain();
    expect(order).toEqual(["1", "2", "3"]);
  });
});

describe("pinned attestation — immediate cache after restart + mismatch rejection", () => {
  const pin = (revision: string): ModelAttestation => ({ model: "fake", revision, featureVersion: 1, backend: "fake" });
  it("a validated SQLite cache is readable IMMEDIATELY after restart with NO network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-pin-"));
    const dbPath = join(dir, "cache.db");
    const { url } = await start({ revision: "rev-pin" });
    try {
      const c1 = new SqliteSemanticCache(dbPath, { ttlMs: 100000, swrMs: 0, maxEntries: 100 });
      const p1 = new HttpRerankProvider({ baseUrl: url, tenant: "t1", authToken: "tok-t1", cache: c1, pinnedAttestation: pin("rev-pin") });
      await p1.rank(QUERY, [cand("b1")], ctx());
      await p1.drainWarm();
      expect(c1.size()).toBe(1);
      c1.close(); // restart
      // New cache + client on the SAME db, with a fetchImpl that THROWS → proves no network.
      const c2 = new SqliteSemanticCache(dbPath, { ttlMs: 100000, swrMs: 0, maxEntries: 100 });
      const noNet = (() => { throw new Error("no network allowed after restart"); }) as unknown as typeof fetch;
      const p2 = new HttpRerankProvider({ baseUrl: url, tenant: "t1", authToken: "tok-t1", cache: c2, pinnedAttestation: pin("rev-pin"), fetchImpl: noNet });
      const r = await p2.rank(QUERY, [cand("b1")], ctx());
      expect(r).toHaveLength(1); // served from persisted cache — no warm-up needed
      expect(p2.healthSnapshot().cacheFresh).toBe(1);
      c2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a response whose attestation mismatches the pin caches NOTHING", async () => {
    const { url } = await start({ revision: "rev-B" }); // server speaks rev-B
    const cache = inMem();
    const p = new HttpRerankProvider({ baseUrl: url, tenant: "t1", authToken: "tok-t1", cache, pinnedAttestation: pin("rev-A") }); // client pins rev-A
    await p.rank(QUERY, [cand("b1")], ctx());
    await p.drainWarm();
    expect(cache.size()).toBe(0);
    expect(p.healthSnapshot().attestationRejected).toBeGreaterThanOrEqual(1);
  });
});

describe("split health — public liveness vs authenticated admin", () => {
  it("/v1/health is public liveness — no auth, no telemetry/attestation leak", async () => {
    const { url } = await start();
    const r = await fetch(`${url}/v1/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.telemetry).toBeUndefined();
    expect(j.attestation).toBeUndefined();
  });
  it("/v1/admin/health requires auth → 401 without; full telemetry+attestation with", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/v1/admin/health`)).status).toBe(401);
    const r = await fetch(`${url}/v1/admin/health`, { headers: { authorization: "Bearer tok-t1" } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.telemetry).toBeDefined();
    expect(j.attestation).toBeDefined();
  });
});

describe("expiresAt-clamped deadline + bounded quota map", () => {
  it("a near-expiry request clamps the deadline → fast 504 despite a large client deadline", async () => {
    const { url, svc } = await start({ delayMs: 400 }, { maxDeadlineMs: 5000 });
    const res = await fetch(`${url}/v1/rerank`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-t1" }, body: JSON.stringify({ v: RERANK_PROTOCOL_VERSION, requestId: "x", deadlineMs: 5000, expiresAtMs: Date.now() + 40, featureVersion: 1, query: QUERY, candidates: [{ blockId: "b1", mechanism: ["m"], situation: [], unlock: [] }] }) });
    expect(res.status).toBe(504); // expiresAt (40ms) clamped the deadline below the 400ms backend delay
    expect(svc.telemetry.timeouts).toBe(1);
  });

  it("TenantQuota bounds its bucket map (LRU evicts oldest tenants)", () => {
    const q = new TenantQuota(1000, 1000, () => 1000, 3); // generous rate, maxTenants 3
    for (let i = 0; i < 20; i++) q.allow(`t${i}`);
    expect(q.size()).toBeLessThanOrEqual(3); // bounded — not 20
    expect(q.allow("t0")).toBe(true); // an evicted tenant simply starts fresh
  });
});
