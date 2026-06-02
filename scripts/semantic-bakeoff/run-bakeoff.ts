/**
 * Frozen offline bakeoff runner (R&D): deterministic baseline vs Qwen3-Reranker-
 * 0.6B over the frozen recurring-family fixtures. Baseline ALWAYS runs; Qwen runs
 * only if the revision-pinned, hash-verified weights exist under .models/ (else it
 * is reported as "not present" — never fabricated). Reports precision@fire,
 * recall@useful, FP, abstention, warm/cold p50/p95, timeout/fallback rate, and the
 * model footprint, then compares warm p95 to the §7.4 rail target (≤ 50 ms; NOT
 * relaxed). Run: `npx tsx scripts/semantic-bakeoff/run-bakeoff.ts`
 */
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DeterministicApplicabilityReranker, type ApplicabilityProvider } from "../../src/core/applicability-reranker.js";
import { PersistentWorkerProvider } from "../../src/experiments/semantic-bakeoff/worker-adapter.js";
import { BAKEOFF_FIXTURES, type BakeoffFixture } from "./bakeoff-fixtures.js";

const RAIL_WARM_P95_MS = 50; // frozen §7.4 target — not relaxed
const here = dirname(fileURLToPath(import.meta.url));
const modelDir = join(here, "..", "..", ".models", "qwen3-reranker-0.6b");

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

interface Row { verdict: string; latencyMs: number; fellOpen: boolean; label: BakeoffFixture["label"] }

async function runProvider(name: string, provider: ApplicabilityProvider, deadlineMs: number): Promise<{ name: string; rows: Row[] } | null> {
  const rows: Row[] = [];
  for (const fx of BAKEOFF_FIXTURES) {
    const t0 = Date.now();
    let res: Awaited<ReturnType<ApplicabilityProvider["rank"]>> = null;
    try {
      res = await provider.rank(fx.query, [fx.candidate], { deadlineMs, now: Date.now });
    } catch {
      res = null;
    }
    const latencyMs = Date.now() - t0;
    const verdict = res && res[0] ? res[0].verdict : "fallback";
    rows.push({ verdict, latencyMs, fellOpen: res === null, label: fx.label });
  }
  return { name, rows };
}

function metrics(rows: Row[]) {
  const total = rows.length;
  const useful = rows.filter((r) => r.label === "useful").length;
  const fired = rows.filter((r) => r.verdict === "applicable");
  const tp = fired.filter((r) => r.label === "useful").length;
  const fp = fired.filter((r) => r.label === "not-useful").length;
  const abstain = rows.filter((r) => r.verdict === "uncertain").length;
  const fellOpen = rows.filter((r) => r.fellOpen).length;
  const lat = rows.map((r) => r.latencyMs);
  const warm = lat.slice(1); // first call is cold
  return {
    precisionAtFire: fired.length ? tp / fired.length : null,
    recallAtUseful: useful ? tp / useful : null,
    falsePositives: fp,
    abstentionRate: total ? abstain / total : 0,
    fallbackRate: total ? fellOpen / total : 0,
    coldMs: lat[0] ?? null,
    warmP50: warm.length ? pct(warm, 50) : null,
    warmP95: warm.length ? pct(warm, 95) : null,
  };
}

function fmt(n: number | null, d = 3): string {
  return n === null || Number.isNaN(n) ? "—" : n.toFixed(d);
}

async function main(): Promise<void> {
  const results: { name: string; rows: Row[] }[] = [];
  const baseline = await runProvider("deterministic-baseline", new DeterministicApplicabilityReranker(), 50);
  if (baseline) results.push(baseline);

  let qwenNote = "";
  if (existsSync(join(modelDir, "model.safetensors"))) {
    const sizeGb = (statSync(join(modelDir, "model.safetensors")).size / 1e9).toFixed(2);
    const qwen = new PersistentWorkerProvider({
      command: process.platform === "win32" ? "python" : "python3",
      args: [join(here, "qwen-worker.py")],
      name: "qwen3-reranker-0.6b",
      handshakeTimeoutMs: 240_000, // cold model load
      concurrency: 1, // sequential for clean latency measurement
      env: { TB_QWEN_MODEL_DIR: modelDir },
    });
    const r = await runProvider("qwen3-reranker-0.6b", qwen, 120_000);
    await qwen.close();
    if (r && r.rows.some((x) => x.verdict !== "fallback")) {
      results.push(r);
      qwenNote = `model.safetensors on disk ${sizeGb} GB; health ${JSON.stringify(qwen.healthSnapshot().state)}`;
    } else {
      qwenNote = `Qwen present (${sizeGb} GB) but produced only fallbacks (worker/handshake failed — check torch/transformers>=4.51).`;
    }
  } else {
    qwenNote = "Qwen NOT present (.models/qwen3-reranker-0.6b/model.safetensors missing) — run download_qwen.py first. Baseline-only.";
  }

  // Report
  console.log("\n=== Offline semantic bakeoff (frozen fixtures, NON-ORGANIC) ===");
  console.log(`fixtures: ${BAKEOFF_FIXTURES.length} (positives + negatives + hard negatives)`);
  console.log(`rail target: warm p95 <= ${RAIL_WARM_P95_MS} ms (frozen §7.4)`);
  console.log(qwenNote);
  console.log("\nprovider                | precision@fire | recall@useful | FP | abstain | fallback | cold ms | warm p50 | warm p95 | rail");
  for (const r of results) {
    const m = metrics(r.rows);
    const railOk = m.warmP95 !== null ? (m.warmP95 <= RAIL_WARM_P95_MS ? "PASS" : "OVER") : "—";
    console.log(
      `${r.name.padEnd(23)} | ${fmt(m.precisionAtFire).padEnd(14)} | ${fmt(m.recallAtUseful).padEnd(13)} | ${String(m.falsePositives).padEnd(2)} | ${fmt(m.abstentionRate, 2).padEnd(7)} | ${fmt(m.fallbackRate, 2).padEnd(8)} | ${fmt(m.coldMs, 0).padEnd(7)} | ${fmt(m.warmP50, 0).padEnd(8)} | ${fmt(m.warmP95, 0).padEnd(8)} | ${railOk}`,
    );
  }
  console.log(JSON.stringify({ bakeoff: results.map((r) => ({ name: r.name, ...metrics(r.rows) })) }));
}

void main();
