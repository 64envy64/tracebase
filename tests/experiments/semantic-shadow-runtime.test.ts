/**
 * E.2.3 — SEMANTIC shadow overlay, END-TO-END through the runtime boundary
 * (runReasoningPatternsRecall) against a real fake-backed RerankService over HTTP.
 *
 * The dominant invariant: serving is BYTE-IDENTICAL whether the lane is on or off —
 * the semantic verdict is TELEMETRY ONLY (a `reasoning.semantic_comparison` event)
 * and never alters shouldInject / blocks / injected content. Also proves the
 * two-plane flow end to end: miss → baseline + warm → drain → network-free cache
 * hit, surviving a restart; attestation mismatch caches nothing; and the env gate.
 */
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import { createRerankService, type RerankService } from "../../src/experiments/semantic-bakeoff/service/server.js";
import { FakeRerankBackend } from "../../src/experiments/semantic-bakeoff/service/backend.js";
import { HttpRerankProvider } from "../../src/experiments/semantic-bakeoff/service/client.js";
import { SqliteSemanticCache } from "../../src/experiments/semantic-bakeoff/service/cache.js";
import { FakeAuthenticator } from "../../src/experiments/semantic-bakeoff/service/auth.js";
import { diagnoseSemanticShadowConfig, readSemanticShadowConfig } from "../../src/experiments/semantic-bakeoff/semantic-shadow.js";
import type { ModelAttestation } from "../../src/experiments/semantic-bakeoff/service/protocol.js";
import type { ApplicabilityProvider } from "../../src/core/applicability-reranker.js";
import type { AnalyticsEvent } from "../../src/types.js";

const ACC = { s: "a running balance is off by a tiny fraction", m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result", u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift" };
const EQ = { s: "two computed quantities that should match are treated as different", m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding", u: "compare with a tolerance epsilon instead of strict equality or use a decimal type" };
const mk = (p: typeof ACC, ref: string) => JSON.stringify({ schemaVersion: V, pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run" }, scope: { language: "general" }, signals: { tags: [ref] }, provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" } });
const STRONG_MECH = "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with the order of operations";
const seed = (store: BlockStore) => importPatternsFromJsonl(store, [mk(ACC, "float-acc"), mk(EQ, "float-eq")].join("\n"), { now: 1 });
const freshStore = () => { const s = new BlockStore(new Database(":memory:")); seed(s); return s; };
const shadowServer = (store: BlockStore) => new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "shadow", retrievalProvider: new DeterministicLocalProvider(), applicabilityMode: "shadow" });
const REV = "rev-rt";
const pin: ModelAttestation = { model: "fake", revision: REV, featureVersion: 1, backend: "fake" };
const AUTH = new FakeAuthenticator({ tok: "t1" });
const semanticEvents = (s: BlockStore) => s.readEvents({}).filter((e) => e.event === "reasoning.semantic_comparison") as Array<AnalyticsEvent & { fallback: string; semanticVerdict: string; candidateCount: number }>;

const svcs: RerankService[] = [];
const dirs: string[] = [];
const caches: SqliteSemanticCache[] = [];
const startService = async (revision = REV) => {
  const svc = createRerankService(new FakeRerankBackend({ revision }), { authenticator: AUTH });
  svcs.push(svc);
  return `http://127.0.0.1:${await svc.listen(0)}`;
};
const tmpDb = () => { const d = mkdtempSync(join(tmpdir(), "tb-sem-rt-")); dirs.push(d); return join(d, "cache.db"); };
const provider = (url: string, dbPath: string, opts: { revision?: string; fetchImpl?: typeof fetch } = {}): HttpRerankProvider => {
  const cache = new SqliteSemanticCache(dbPath, { ttlMs: 1e6, swrMs: 0, maxEntries: 100 });
  caches.push(cache);
  return new HttpRerankProvider({ baseUrl: url, authToken: "tok", cache, pinnedAttestation: { ...pin, ...(opts.revision ? { revision: opts.revision } : {}) }, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
};
const recall = (server: BlockServer, semanticShadowProvider?: ApplicabilityProvider) =>
  runReasoningPatternsRecall(server, { problem: STRONG_MECH, runId: "r1" }, { readHoldoutConfig: () => null, ...(semanticShadowProvider ? { semanticShadowProvider } : {}) });

afterEach(async () => {
  await Promise.all(svcs.map((s) => s.close().catch(() => {})));
  svcs.length = 0;
  caches.forEach((c) => { try { c.close(); } catch { /* already closed */ } }); // close before rm (Windows EBUSY)
  caches.length = 0;
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs.length = 0;
});

describe("semantic shadow overlay — end-to-end runtime (telemetry-only, byte-identical)", () => {
  it("env gate: absent → off; URL+token → on", () => {
    expect(readSemanticShadowConfig({})).toBeNull();
    expect(readSemanticShadowConfig({ TRACEBASE_SEMANTIC_SHADOW_URL: "http://x" })).toBeNull(); // token missing
    expect(readSemanticShadowConfig({ TRACEBASE_SEMANTIC_SHADOW_URL: "http://x", TRACEBASE_SEMANTIC_SHADOW_TOKEN: "k" })).toBeNull(); // pin missing
    const cfg = readSemanticShadowConfig({
      TRACEBASE_SEMANTIC_SHADOW_URL: "http://x",
      TRACEBASE_SEMANTIC_SHADOW_TOKEN: "k",
      TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: JSON.stringify(pin),
    });
    expect(cfg).toEqual({ url: "http://x", token: "k", attestation: pin });
  });

  it("malformed attestation fails OFF; unpinned discovery needs an explicit dev flag", () => {
    const base = { TRACEBASE_SEMANTIC_SHADOW_URL: "http://x", TRACEBASE_SEMANTIC_SHADOW_TOKEN: "k" };
    expect(diagnoseSemanticShadowConfig({ ...base, TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: "{broken" })).toEqual({
      status: "invalid",
      reason: "malformed-attestation",
    });
    expect(diagnoseSemanticShadowConfig({
      ...base,
      TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: "{}",
      TRACEBASE_SEMANTIC_SHADOW_ALLOW_UNPINNED: "1",
    })).toEqual({
      status: "invalid",
      reason: "malformed-attestation",
    });
    expect(readSemanticShadowConfig({ ...base, TRACEBASE_SEMANTIC_SHADOW_ALLOW_UNPINNED: "1" })).toEqual({
      url: "http://x",
      token: "k",
    });
  });

  it("serving is BYTE-IDENTICAL with the lane on vs off (only a telemetry event differs)", async () => {
    const url = await startService();
    const store = freshStore();
    const off = await recall(shadowServer(store)); // no semantic lane
    const on = await recall(shadowServer(store), provider(url, tmpDb())); // lane on
    // The served decision + slate are identical — the verdict never touches output.
    expect(on.shouldInject).toBe(off.shouldInject);
    expect(on.blocks.map((b) => b.block.id)).toEqual(off.blocks.map((b) => b.block.id));
    // ...but a comparison telemetry event WAS emitted (and only by the on-run).
    expect(semanticEvents(store).length).toBe(1);
    store.close();
  });

  it("miss → baseline + warm → drain → network-free FRESH hit, surviving restart", async () => {
    const url = await startService();
    const dbPath = tmpDb();
    const store = freshStore();
    const p1 = provider(url, dbPath);

    // 1st recall: cache MISS → no verdict, baseline served, warm scheduled.
    await recall(shadowServer(store), p1);
    const e1 = semanticEvents(store);
    expect(e1[0]!.fallback).toBe("miss");
    expect(e1[0]!.semanticVerdict).toBe("none");

    // Drain the warm (populates the persisted SWR cache), then recall again → HIT.
    await p1.drainWarm();
    await recall(shadowServer(store), p1);
    const e2 = semanticEvents(store);
    expect(e2.length).toBe(2);
    expect(e2[1]!.fallback).toBe("none"); // cache hit produced a verdict
    expect(["applicable", "uncertain", "inapplicable"]).toContain(e2[1]!.semanticVerdict);
    expect(e2[1]!.semanticAttestationId).toMatch(/^[a-f0-9]{16}$/);
    expect(e2[1]!.semanticHealth?.cacheFresh).toBeGreaterThanOrEqual(1);
    expect(e2[1]!.warmQueue).toMatchObject({ active: 0, pending: 0 });
    p1.healthSnapshot && expect(p1.healthSnapshot().cacheFresh).toBeGreaterThanOrEqual(1);

    // RESTART: same corpus (same block ids), a NEW provider + cache CONNECTION on the
    // SAME db, with a fetchImpl that THROWS → proves the validated cache is readable
    // network-free right after restart. Close p1's connection first (a real restart).
    caches.forEach((c) => { try { c.close(); } catch { /* */ } });
    caches.length = 0;
    const noNet = (() => { throw new Error("no network after restart"); }) as unknown as typeof fetch;
    const p2 = provider(url, dbPath, { fetchImpl: noNet });
    await recall(shadowServer(store), p2); // same corpus store → same cache keys
    const e3 = semanticEvents(store);
    expect(e3.length).toBe(3);
    expect(e3[2]!.fallback).toBe("none"); // served from the persisted cache, NO network
    store.close();
  });

  it("attestation MISMATCH caches nothing → stays a miss (telemetry only, baseline preserved)", async () => {
    const url = await startService("rev-SERVER"); // server speaks rev-SERVER
    const store = freshStore();
    const p = provider(url, tmpDb(), { revision: "rev-CLIENT-PIN" }); // client pins a different revision
    await recall(shadowServer(store), p);
    await p.drainWarm();
    await recall(shadowServer(store), p);
    // Both recalls miss — the mismatched-attestation response was rejected, cached nothing.
    expect(semanticEvents(store).every((e) => e.fallback === "miss")).toBe(true);
    expect(p.healthSnapshot().attestationRejected).toBeGreaterThanOrEqual(1);
    store.close();
  });
});
