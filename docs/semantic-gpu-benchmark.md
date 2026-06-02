# GPU viability benchmark — Qwen3-Reranker-0.6B on RTX 4070 (R&D, 2026-06-02)

Measured on the pinned local artifact (revision `e61197ed…`, sha-verified, offline,
`trust_remote_code=False`), torch **2.6.0+cu124**, fp16, in an isolated pinned CUDA
venv. **NON-ORGANIC** synthetic latency probes + the frozen + adversarial quality
fixtures. Model-load latency is reported, not hidden.

## Environment
RTX 4070 (12 GB VRAM, driver 572.83, CUDA 12.8) · cold model load **1415 ms** ·
cold first inference **380 ms** · peak VRAM **3337 MB** (fp16). A single 4070 holds
~3 instances; this run used one.

## Latency matrix — 1 query × N candidates, one batched forward (warm)

| input bucket | candidates | p50 ms | p95 ms | p99 ms | pairs/s | rail ≤50 ms |
|---|---|---|---|---|---|---|
| short (~20 tok) | 2 | 44.1 | **48.6** | 50.5 | 44.9 | PASS (only this cell) |
| short | 4 | 81.3 | 83.8 | 86.5 | 54.8 | OVER |
| short | 8 | 90.3 | 94.1 | 94.5 | 89.0 | OVER |
| short | 16 | 144.7 | 163.1 | 166.4 | 109.8 | OVER |
| med (~80 tok) | 2 | 80.1 | 89.0 | 91.0 | 24.6 | OVER |
| **med** | **4** | **93.0** | **95.6** | **101.8** | **42.9** | **OVER (production shape)** |
| med | 8 | 124.5 | 133.6 | 140.8 | 63.8 | OVER |
| med | 16 | 310.1 | 367.4 | 374.5 | 53.1 | OVER |
| long (~200 tok) | 2 | 107.4 | 115.9 | 176.7 | 18.1 | OVER |
| long | 4 | 129.5 | 150.9 | 176.6 | 30.0 | OVER |
| long | 8 | 301.2 | 348.0 | 377.2 | 25.9 | OVER |
| long | 16 | 716.7 | 796.3 | 828.6 | 22.4 | OVER |

## Rail verdict — honest

**Warm p95 ≤ 50 ms is NOT achievable for the bounded production request shape.**
Only the most trivial cell (2 short candidates) reaches 48.6 ms; the realistic shape
(**4 candidates, medium docs**) is **95.6 ms p95 — ~2× over** — and it degrades fast
with candidates/length. CPU was 559 ms (E.1); the 4070 fp16 cuts it ~6× to ~95 ms,
still ~2× over. A 0.6B causal-LM reranker **cannot serve synchronously within the
50 ms rail** on this hardware.

→ This **validates the shadow-first / stale-while-revalidate architecture as
necessary, not optional**: the semantic verdict must be served from a local cache
and revalidated **off the hot path**; a cache miss serves the deterministic baseline
immediately. Synchronous semantic inference on the 50 ms critical path is ruled out
by measurement.

## Quality — frozen fixtures + adversarial negatives (18 total)

| provider | precision@fire | recall@useful | FP | abstain |
|---|---|---|---|---|
| deterministic-baseline | 1.000 | 0.286 | 0 | 0.28 |
| qwen3-reranker-0.6b | 0.778 | 1.000 | **2** | 0.00 |

Qwen recovers the **full** V4-abstain residual (recall 1.000) but the **adversarial
negatives expose a precision cost**: it false-positives on 2 of 4 lexically-similar/
wrong-mechanism cases (precision 1.000 → 0.778). The baseline keeps perfect precision
at low recall. **There is a real precision/recall tradeoff** — Qwen is not strictly
better, so promotion needs a tuned confidence threshold + the precision gate from the
pre-reg, never a naive swap. (Earlier 14-fixture run without adversarials showed
precision 1.000 — the adversarial set is what surfaced the FP, which is why it was
added.)

## Sizing (from measured data)
- Footprint: 3.3 GB VRAM fp16 → ~3 instances per 4070-class GPU.
- Throughput: ~43 pairs/s at the production shape (4-cand med); higher at larger
  batches but latency balloons. Async **cache-warming** (not synchronous serving) is
  the viable pattern; a single GPU can warm a modest fleet's cache.
- The exact data-plane GPU count is an async-warm-throughput sizing, computed in the
  ADR from these numbers — not a synchronous-QPS sizing.
