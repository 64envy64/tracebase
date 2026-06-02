# Offline semantic bakeoff — results (R&D, 2026-06-02)

Real run of `scripts/semantic-bakeoff/run-bakeoff.ts`: deterministic baseline vs
**Qwen3-Reranker-0.6B** (revision `e61197ed…`, sha-verified) on the 14 frozen
recurring-family fixtures (positives + negatives + hard negatives). **NON-ORGANIC**
fixtures — hand-authored holdouts, never counted as organic traffic. Inference ran
locally on **CPU** (torch 2.12.0+cpu, transformers 5.9.0) in an isolated venv;
weights in gitignored `.models/`. R&D validation only — not a client install path.

## Results

| provider | precision@fire | recall@useful | FP | abstain | fallback | cold ms | warm p50 | warm p95 | rail (≤50ms) |
|---|---|---|---|---|---|---|---|---|---|
| deterministic-baseline | 1.000 | 0.286 | 0 | 0.36 | 0.00 | 1 | 0 | 1 | **PASS** |
| qwen3-reranker-0.6b (CPU) | 1.000 | **1.000** | 0 | 0.00 | 0.00 | 4424 | 497 | 559 | **OVER (11×)** |

## What this validates (the four §7 goals)

1. **Quality — strong positive.** Qwen recovers the **entire** V4-abstain residual
   (recall@useful 0.286 → **1.000**) at **the same perfect precision (1.000) with
   zero false positives** on the negatives + hard negatives. The baseline is
   correctly conservative (never fires wrong) but misses 5/7 useful holdouts; Qwen
   fires on all 7 useful and none of the 7 non-useful. This is the recall recovery
   the semantic provider exists for, with no precision regression on this set.
2. **Warm latency — CPU is non-viable.** Warm p95 **559 ms** on CPU is 11× the
   50 ms rail (NOT relaxed). Cold load 4.4 s. So the rail **cannot** be met on CPU;
   the inference must run on a **GPU** data plane (the hosted mode A / sidecar mode
   B, or local mode C on a GPU). The 50 ms target is a GPU target.
3. **Artifact pinning — validated.** `download_qwen.py` pinned revision
   `e61197ed45024b0ed8a2d74b80b4d909f1255473` and **sha256-verified**
   `model.safetensors` (`27cd75a4…`) + `tokenizer.json` (`aeb13307…`) before use;
   the worker loaded with `trust_remote_code=False`, `local_files_only=True`.
4. **Service sizing — GPU required; small model.** Footprint: `model.safetensors`
   1.19 GB on disk; resident ≈ 2.4 GB fp32 (CPU) / ≈ 1.2 GB fp16 (GPU). A 0.6B
   cross-encoder on a single modern GPU (e.g. the RTX 4070 present here) is
   expected to warm to ~10–30 ms/query — i.e. plausibly within the 50 ms rail —
   so a single GPU can host the data plane for a modest fleet. **The exact GPU warm
   p95 must be measured with CUDA torch before promotion** (see next step); CPU
   here is a conservative upper bound that already rules CPU out.

## Conclusion

The semantic provider is **worth pursuing**: large recall recovery at no precision
cost on the frozen fixtures. The gating constraint is latency — it is a **GPU data
plane** decision, consistent with the architecture (hosted mode A as the default).
Nothing here is promoted to serving: the result feeds the Phase-E decision, still
behind the canary + breaker, never auto-promoted, never on the hot path.

## Next measurement (sizing)

Install CUDA torch on the 4070 and re-run to capture the **GPU** warm p50/p95 +
throughput — the number that decides whether the rail is met and how many GPUs the
hosted data plane needs per N developers. Everything else (quality, pinning,
footprint) is validated above. The fixtures should also be widened to more
families + adversarial negatives before any ship decision.
