/**
 * Shadow-only smoke ($0, no GPU, no paid API) — exercises the full data-plane
 * transport against the FAKE backend end-to-end over real HTTP:
 *   public liveness → rank#1 (cache MISS → deterministic baseline, no overlay,
 *   warm scheduled) → drainWarm → rank#2 (FRESH from cache, network-free) →
 *   authenticated admin health. Run: npx tsx scripts/semantic-bakeoff/shadow-smoke.mjs
 */
import { createRerankService } from "../../src/experiments/semantic-bakeoff/service/server.js";
import { FakeRerankBackend } from "../../src/experiments/semantic-bakeoff/service/backend.js";
import { HttpRerankProvider } from "../../src/experiments/semantic-bakeoff/service/client.js";
import { InMemorySemanticCache } from "../../src/experiments/semantic-bakeoff/service/cache.js";
import { FakeAuthenticator } from "../../src/experiments/semantic-bakeoff/service/auth.js";

const REV = "rev-smoke";
const svc = createRerankService(new FakeRerankBackend({ revision: REV }), { authenticator: new FakeAuthenticator({ tok: "t1" }) });
const port = await svc.listen(0);
const url = `http://127.0.0.1:${port}`;
const cand = (id) => ({ blockId: id, tokens: { situation: ["s"], mechanism: ["rounding"], unlock: ["kahan"], invariants: [] }, signals: { isPitfall: false, helpful: 1, harmful: 0, unresolved: 0, familySupport: 1, sourceDiversity: 1 } });
const Q = { literalText: "running balance off by a fraction" };
const C = [cand("b1"), cand("b2")];

try {
  const liveness = await (await fetch(`${url}/v1/health`)).json();
  console.log("liveness        :", JSON.stringify(liveness), "(public, no telemetry)");

  const cache = new InMemorySemanticCache({ ttlMs: 1e6, swrMs: 0, maxEntries: 50 });
  const p = new HttpRerankProvider({ baseUrl: url, tenant: "t1", authToken: "tok", cache, pinnedAttestation: { model: "fake", revision: REV, featureVersion: 1, backend: "fake" } });

  const r1 = await p.rank(Q, C, { deadlineMs: 2000, now: Date.now });
  console.log("rank#1  (MISS)  : overlay=", JSON.stringify(r1), "→ baseline; cacheMiss=", p.healthSnapshot().cacheMiss, "warm=", p.warmStats().scheduled);

  await p.drainWarm();
  const r2 = await p.rank(Q, C, { deadlineMs: 2000, now: Date.now });
  console.log("rank#2  (FRESH) : verdicts=", r2.map((x) => `${x.blockId}:${x.verdict}`).join(","), "; cacheFresh=", p.healthSnapshot().cacheFresh, "(network-free)");

  const admin = await (await fetch(`${url}/v1/admin/health`, { headers: { authorization: "Bearer tok" } })).json();
  console.log("admin health    : served=", admin.telemetry.served, "attestation.revision=", admin.attestation.revision);
  console.log("[SHADOW-ONLY FAKE-BACKEND SMOKE OK]");
} finally {
  await svc.close();
}
