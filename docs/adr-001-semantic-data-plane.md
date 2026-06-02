# ADR-001 — Semantic applicability inference: deployment of the data plane (R&D)

- Status: **Proposed (R&D)** — not approved for deployment. Cloud Run remains a
  separate, later approval boundary.
- Date: 2026-06-02
- Context branch: `claude/semantic-applicability-rnd-d5`

## Context

The deterministic applicability reranker is authoritative + offline. A learned
semantic reranker (Qwen3-Reranker-0.6B) was benchmarked locally (R&D only). Two
measured facts drive this decision:

1. **Latency.** Warm p95 is **95.6 ms** for the production shape (4 candidates, med
   docs) on an RTX 4070 fp16 — ~2× over the 50 ms rail; only a trivial 2-short-
   candidate shape (48.6 ms) fits. **Synchronous semantic inference cannot meet the
   rail.** (`docs/semantic-gpu-benchmark.md`.)
2. **Quality.** Recall@useful 0.286 → **1.000**, but precision@fire drops 1.000 →
   **0.778** (2 false positives) on adversarial negatives. Real recall lift, real
   precision cost → needs a tuned threshold + the pre-reg precision gate.

⇒ The semantic verdict must be **shadow-first + stale-while-revalidate**: served
from a local cache, revalidated **off the hot path**, deterministic baseline on
miss. This is now a measured requirement, not a preference.

## Decision drivers
Privacy (no raw text egress), the 50 ms rail (→ async only), GPU cost, enterprise
data-residency, and operational burden.

## Options compared

| | A. Hosted TraceBase data plane | B. Enterprise sidecar | C. Optional local |
|---|---|---|---|
| who runs the GPU | TraceBase | the customer | the developer |
| data egress | bounded **scanned DTOs** only | none (their network) | none |
| ops burden on customer | none | runs a container | venv + pinned weights |
| latency posture | async warm + SWR cache | async warm + SWR cache | async warm + SWR cache |
| best for | most teams (default opt-in) | egress-restricted enterprises | offline power users / R&D |
| privacy boundary | inference plane ≠ control plane; DTOs scanned before transport, no payload persisted | same, in-network | same, in-process |

All three sit behind the **same** `ApplicabilityProvider` + the HTTP/JSONL DTO
contract + the SWR client; only the transport differs. None is on the hot path.

## Decision

1. Adopt **shadow-first SWR** as the only serving pattern for semantic verdicts;
   **synchronous serving is rejected by measurement**.
2. **Mode A (hosted data plane) is the default opt-in**; **B (sidecar)** for
   egress-restricted enterprises; **C (local)** is an advanced opt-in / R&D path.
3. The inference data plane stays **separate** from the Next.js control plane:
   different service, different payload (scanned DTOs vs sanitized UsageMetrics),
   different trust boundary; **no query/snippet payload is persisted** anywhere.
4. **No auto-promotion.** A semantic verdict reaches served output only via the
   canary + breaker, after an offline bakeoff (quality) + a precision-gated
   threshold; never on the 50 ms critical path.

## Service sizing — from MEASURED GPU data only

- **Footprint:** 3.3 GB VRAM fp16 → ~3 model instances per 4070-class GPU.
- **Throughput:** ~43 rerank-pairs/s at the production shape (higher at larger
  batches, but latency balloons — irrelevant since serving is async).
- **Pattern:** the GPU **warms the cache asynchronously**, it does not serve the
  hot path. At ~43 pairs/s a single GPU warms ~1.5×10⁵ unique (query,candidate)
  verdicts/hour — far above any plausible canary-eligible organic rate for an
  early dogfood/team fleet. **Conclusion: one modest GPU suffices for mode A at
  dogfood + early-customer scale**; scale out only when the *unique-verdict warm
  rate* (not synchronous QPS) approaches that ceiling. SWR TTL + cache hit ratio
  (to be measured in shadow) set the real warm load.

## Cloud Run

Explicitly **out of scope** here. Deploying mode A on Cloud Run (GPU service,
autoscaling, regional egress, billing) is a **separate later approval boundary**.
This ADR sizes the service from local measurement only; it does not authorize any
cloud deploy.

## Consequences
- Pro: the rail is respected (async); privacy boundary is clean; enterprises get
  residency via B; quality lift is captured without precision risk on the hot path.
- Con: a cache-cold session sees only the deterministic baseline (acceptable — it
  is correct, just lower-recall) until the cache warms; the precision tradeoff
  forces a tuning + gating step before any promotion.

## Next approval decision
Approve (or not) **building mode A’s GPU inference service for a shadow-only
deployment** — populating the SWR cache + the D.3 ledger comparison from organic
dogfood traffic, with **zero** served-output change — to measure cache hit ratio,
shadow precision/recall on organic data, and warm-rate sizing. Promotion to served
output remains a later, separately-gated decision (canary + breaker + precision
gate). Cloud Run deploy is a further boundary beyond that.
