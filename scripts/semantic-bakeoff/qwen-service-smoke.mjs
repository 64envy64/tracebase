/**
 * Qwen service smoke (LOCAL GPU, $0 — no paid API). Proves the full integration
 * link the fake backend can't: HTTP service → QwenRerankBackend → qwen-worker.py →
 * CUDA → real verdicts, with PINNED-attestation cache (rank#2 served network-free).
 * Needs .venv-cuda + .models/qwen3-reranker-0.6b. Run:
 *   npx tsx scripts/semantic-bakeoff/qwen-service-smoke.mjs
 */
import { existsSync } from "node:fs";
import { createRerankService } from "../../src/experiments/semantic-bakeoff/service/server.js";
import { QwenRerankBackend } from "../../src/experiments/semantic-bakeoff/service/backend.js";
import { HttpRerankProvider } from "../../src/experiments/semantic-bakeoff/service/client.js";
import { InMemorySemanticCache } from "../../src/experiments/semantic-bakeoff/service/cache.js";
import { FakeAuthenticator } from "../../src/experiments/semantic-bakeoff/service/auth.js";

const PY = ".venv-cuda/Scripts/python.exe";
const MODEL = ".models/qwen3-reranker-0.6b";
const REV = "0.6b-local";
if (!existsSync(PY) || !existsSync(MODEL)) {
  console.log(`[QWEN SMOKE SKIPPED] missing ${!existsSync(PY) ? PY : MODEL}`);
  process.exit(0);
}

const backend = new QwenRerankBackend({ command: PY, modelDir: MODEL, revision: REV });
const svc = createRerankService(backend, { authenticator: new FakeAuthenticator({ tok: "t1" }), maxDeadlineMs: 30_000 });
const port = await svc.listen(0);
const url = `http://127.0.0.1:${port}`;
const cand = (id, mech, unlock) => ({ blockId: id, tokens: { situation: ["floating point sum"], mechanism: mech, unlock, invariants: [] }, signals: { isPitfall: false, helpful: 1, harmful: 0, unresolved: 0, familySupport: 1, sourceDiversity: 1 } });
const Q = { literalText: "running balance drifts by a tiny fraction after many additions", causalText: "float accumulation rounding error" };
const C = [cand("b-kahan", ["floating point rounding"], ["kahan summation"]), cand("b-unrelated", ["sql index"], ["add btree index"])];

try {
  const t0 = Date.now();
  const cache = new InMemorySemanticCache({ ttlMs: 1e6, swrMs: 0, maxEntries: 50 });
  const p = new HttpRerankProvider({ baseUrl: url, tenant: "t1", authToken: "tok", cache, warmDeadlineMs: 30_000, pinnedAttestation: { model: "Qwen/Qwen3-Reranker-0.6B", revision: REV, featureVersion: 1, backend: "qwen-local" } });

  const r1 = await p.rank(Q, C, { deadlineMs: 30_000, now: Date.now });
  console.log(`rank#1 (MISS)  : overlay=${JSON.stringify(r1)} → baseline; warm scheduled=${p.warmStats().scheduled}`);
  await p.drainWarm(); // awaits the real GPU forward
  console.log(`model load+infer: ${Math.round((Date.now() - t0) / 1000)}s`);

  const r2 = await p.rank(Q, C, { deadlineMs: 30_000, now: Date.now });
  console.log(`rank#2 (FRESH) : ${r2.map((x) => `${x.blockId}=${x.verdict}(${x.confidence.toFixed(2)})`).join(", ")} — network-free`);

  const admin = await (await fetch(`${url}/v1/admin/health`, { headers: { authorization: "Bearer tok" } })).json();
  console.log(`admin health   : served=${admin.telemetry.served} backend=${admin.attestation.backend} rev=${admin.attestation.revision} attRejected=${p.healthSnapshot().attestationRejected}`);
  console.log(r2.length === 2 && p.healthSnapshot().cacheFresh === 2 && admin.telemetry.served >= 1 ? "[QWEN SERVICE SMOKE OK]" : "[QWEN SERVICE SMOKE FAIL]");
} finally {
  await svc.close(); // graceful: closes the worker → releases GPU
}
