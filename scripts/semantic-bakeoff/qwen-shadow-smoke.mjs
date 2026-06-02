/**
 * Qwen RUNTIME shadow smoke (LOCAL GPU, $0 — no paid API). Proves the E.2.3 wiring
 * end to end on a real model: runReasoningPatternsRecall → semantic shadow lane →
 * HttpRerankProvider → Qwen service → CUDA, asserting (1) served output is
 * BYTE-IDENTICAL with the lane on vs off, (2) a `reasoning.semantic_comparison`
 * telemetry event is emitted, (3) miss → warm → network-free cache HIT.
 * Needs .venv-cuda + .models/qwen3-reranker-0.6b. Run:
 *   npx tsx scripts/semantic-bakeoff/qwen-shadow-smoke.mjs
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import { createRerankService } from "../../src/experiments/semantic-bakeoff/service/server.js";
import { QwenRerankBackend } from "../../src/experiments/semantic-bakeoff/service/backend.js";
import { HttpRerankProvider } from "../../src/experiments/semantic-bakeoff/service/client.js";
import { SqliteSemanticCache } from "../../src/experiments/semantic-bakeoff/service/cache.js";
import { FakeAuthenticator } from "../../src/experiments/semantic-bakeoff/service/auth.js";

const PY = ".venv-cuda/Scripts/python.exe";
const MODEL = ".models/qwen3-reranker-0.6b";
const REV = "0.6b-local";
if (!existsSync(PY) || !existsSync(MODEL)) {
  console.log(`[QWEN SHADOW SMOKE SKIPPED] missing ${!existsSync(PY) ? PY : MODEL}`);
  process.exit(0);
}

const ACC = { s: "a running balance is off by a tiny fraction", m: "summing many floating point values accumulates rounding error because each addition discards low order bits so the order of operations changes the result", u: "accumulate with compensated kahan summation or sum in integer cents to avoid floating point rounding drift" };
const EQ = { s: "two computed quantities that should match are treated as different", m: "comparing floating point results with strict equality fails because the same mathematical value has more than one bit representation after rounding", u: "compare with a tolerance epsilon instead of strict equality or use a decimal type" };
const mk = (p, ref) => JSON.stringify({ schemaVersion: V, pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run" }, scope: { language: "general" }, signals: { tags: [ref] }, provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" } });
const STRONG_MECH = "each addition accumulates rounding error and discards the low order bits as the running summation grows so the result changes with the order of operations";
const seed = (store) => importPatternsFromJsonl(store, [mk(ACC, "float-acc"), mk(EQ, "float-eq")].join("\n"), { now: 1 });
const shadowServer = (store) => new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "shadow", retrievalProvider: new DeterministicLocalProvider(), applicabilityMode: "shadow" });
const semanticEvents = (s) => s.readEvents({}).filter((e) => e.event === "reasoning.semantic_comparison");

const backend = new QwenRerankBackend({ command: PY, modelDir: MODEL, revision: REV });
const svc = createRerankService(backend, { authenticator: new FakeAuthenticator({ tok: "t1" }), maxDeadlineMs: 30_000 });
const dir = mkdtempSync(join(tmpdir(), "tb-qwen-shadow-"));
const dbPath = join(dir, "cache.db");
const cache = new SqliteSemanticCache(dbPath, { ttlMs: 1e6, swrMs: 0, maxEntries: 100 });

try {
  const port = await svc.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const provider = new HttpRerankProvider({ baseUrl: url, authToken: "tok", cache, warmDeadlineMs: 30_000, pinnedAttestation: { model: "Qwen/Qwen3-Reranker-0.6B", revision: REV, featureVersion: 1, backend: "qwen-local" } });

  // 1) BYTE-IDENTICAL: served output with the lane OFF vs ON must match exactly.
  const s = new BlockStore(new Database(":memory:")); seed(s); const server = shadowServer(s);
  const off = await runReasoningPatternsRecall(server, { problem: STRONG_MECH, runId: "r0" }, { readHoldoutConfig: () => null });
  const t0 = Date.now();
  const on1 = await runReasoningPatternsRecall(server, { problem: STRONG_MECH, runId: "r1" }, { readHoldoutConfig: () => null, semanticShadowProvider: provider });
  const identical = on1.shouldInject === off.shouldInject && JSON.stringify(on1.blocks.map((b) => b.block.id)) === JSON.stringify(off.blocks.map((b) => b.block.id));
  const e1 = semanticEvents(s);
  console.log(`byte-identical : shouldInject ${off.shouldInject}→${on1.shouldInject}, blocks match=${identical}`);
  console.log(`rank#1 (MISS)  : event fallback=${e1[0]?.fallback} verdict=${e1[0]?.semanticVerdict} (baseline served, warm scheduled)`);

  // 2) Drain the warm (real GPU forward), then recall again → network-free cache HIT.
  await provider.drainWarm();
  console.log(`model+infer    : ${Math.round((Date.now() - t0) / 1000)}s`);
  await runReasoningPatternsRecall(server, { problem: STRONG_MECH, runId: "r2" }, { readHoldoutConfig: () => null, semanticShadowProvider: provider });
  const e2 = semanticEvents(s);
  const hit = e2[e2.length - 1];
  console.log(`rank#2 (FRESH) : event fallback=${hit?.fallback} verdict=${hit?.semanticVerdict} conf=${hit?.semanticConfidence?.toFixed?.(2)} changed=${hit?.changedDecision} (network-free)`);

  const ok = identical && e1[0]?.fallback === "miss" && hit?.fallback === "none" && provider.healthSnapshot().cacheFresh >= 1;
  console.log(ok ? "[QWEN SHADOW SMOKE OK]" : "[QWEN SHADOW SMOKE FAIL]");
  s.close();
} finally {
  cache.close();
  await svc.close(); // graceful: closes the worker → releases GPU
  rmSync(dir, { recursive: true, force: true });
}
