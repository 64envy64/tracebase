# Semantic applicability provider — deployment architecture (R&D)

> Branched from the frozen D.5 runtime. This document is the architecture; the
> code substrate (provider boundary, persistent-worker adapter, bakeoff) lives
> beside it under `src/experiments/semantic-bakeoff/**` + `scripts/semantic-
> bakeoff/**`. **The local model download is R&D-only validation, never a client
> install requirement** (see §6).

## 0. First principle — the deterministic runtime is authoritative

The in-repo **deterministic applicability reranker** (`DeterministicApplicability
Reranker`) is the source of truth and is fully **offline-capable**. A semantic
provider is an *advisory enhancement* that can only ever do one thing: recover
recall on the V4-abstain residual the baseline is too conservative to fire on
(measured: baseline precision@fire 1.000, recall@useful 0.286 on the frozen
fixtures). It is **never required for correctness**. Every mode below degrades, on
any failure/timeout/absence, to the deterministic verdict — byte-identically.

The canary + circuit breaker (D.4.2) remain the only path by which *any* applied
verdict (deterministic or semantic) reaches served output, and the breaker's
frozen kill rules apply regardless of which provider produced the verdict.

## 1. The provider boundary (unchanged contract)

Every provider implements `ApplicabilityProvider` (`rank() → ApplicabilityResult[]
| null`, deterministic-enough, **never throws**, `null` on any failure → fail
open). The bakeoff's `PersistentWorkerProvider` already wraps a worker behind a
strict deadline + scanner-before-transport + concurrency cap + fail-open. The
three deployment modes below are three *transports* behind this one contract;
the runtime is agnostic to which is configured.

## 2. Three deployment modes

| mode | who runs inference | data leaves the machine? | default |
|---|---|---|---|
| **A. Hosted TraceBase semantic data plane** | TraceBase (GPU service) | only bounded **scanned DTOs** (§4) | **opt-in default** |
| **B. Customer-managed enterprise sidecar** | the customer, in their infra | no (stays in their network) | enterprise |
| **C. Optional local power-user mode** | the developer, locally | no | opt-in, advanced |

### A. Hosted TraceBase semantic data plane (default opt-in)
A dedicated TraceBase **inference service** (GPU, runs the pinned reranker) exposed
over a small request/response API. The client transport is a thin HTTP variant of
the JSONL worker contract: it sends a bounded, scanned `rank` DTO and gets back
verdicts + confidences. Opt-in: off unless the operator enables it; when off, the
deterministic runtime serves unchanged. This is the **default** managed path so a
team gets the semantic lift without provisioning a GPU — at the cost of sending
bounded scanned DTOs (never raw text, §4) to the data plane.

### B. Customer-managed enterprise sidecar
The exact same inference service, packaged as a container the **customer runs in
their own network** (a sidecar / internal endpoint). Identical DTO contract; data
never leaves the customer's infrastructure. For teams whose policy forbids any
egress. TraceBase ships the image + the pinned model manifest (§ supply-chain);
the customer hosts it.

### C. Optional local power-user mode
A developer runs the model on their own machine via the `PersistentWorkerProvider`
+ a local worker (the R&D `qwen-worker.py`, or a future ONNX worker). Weights are
revision-pinned + sha-verified into a gitignored `.models/` dir. This is **opt-in
and advanced** — useful for offline power users and for R&D — and is explicitly
**not** something every client must do. Most users take mode A or B.

In all three modes the provider is wired through the *same* `ApplicabilityProvider`
boundary + the same scanner + the same fail-open; only the transport differs
(in-process child / HTTP-to-hosted / HTTP-to-sidecar).

## 3. Shadow-first, stale-while-revalidate — never block the hot path

Remote (or local) semantic inference must **never** block serving or be required
for correctness. The hot path is:

```
recall → deterministic verdict (authoritative, sub-ms, offline)
       → look up the semantic verdict for this (queryHash, blockId, featureVersion)
         in the LOCAL semantic cache:
           • FRESH hit  → use it as the advisory overlay (still gated by canary+breaker)
           • STALE hit  → use the stale value NOW, fire an async revalidation (SWR)
           • MISS       → use the deterministic verdict NOW, fire an async warm-up
       → SERVE immediately. The remote call is never awaited on the hot path.
```

Properties:
- **Shadow-first.** A newly-wired semantic provider runs in shadow: its verdicts
  populate the cache + the D.3 ledger comparison, but do not change served output
  until explicitly promoted (and even then only via the canary, never auto).
- **SWR.** The cache returns immediately (fresh or stale); revalidation is a
  background, deadline-bounded, fail-open call. A revalidation timeout/error
  leaves the stale (or deterministic) value in place and increments health
  counters — it never degrades correctness.
- **Bounded cache.** Keyed by `(queryHash, blockId, applicabilityFeatureVersion)`;
  values are verdict + confidence + `fetchedAt`; TTL’d; size-capped (LRU); local
  only; content-free. A feature-version bump invalidates wholesale.
- **Correctness floor.** With an empty/cold cache and the provider unreachable,
  serving is exactly the deterministic baseline. Semantic adds recall when warm,
  subtracts nothing when cold.

## 4. Plane separation + DTO discipline

Two **separate** planes, different data, different services:

- **Inference data plane** (modes A/B/C): receives only a **bounded, scanned**
  `rank` DTO — scrubbed query views (literal/causal text, length-capped) + opaque
  `blockId`s + bounded lesson tokens. It is scanned with `detectLeakageExtended`
  **before transport**; a match is never sent (fail open). It returns verdict +
  confidence only. It **never** receives raw prompts, source, diffs, transcripts,
  file paths, secrets, or the salt.
- **Control plane** (the existing Next.js hosted control plane): receives only the
  sanitized `UsageMetrics` aggregate through the existing cloud allowlist
  (`sanitizeForCloud`) — counts + ids, no bodies. It does **no** inference.

These are independent: the control plane (dashboard/usage sync) and the inference
data plane share no transport, no payload, and no trust boundary. A compromise or
outage of one does not affect the other, and neither ever carries raw user text.

## 5. Failure + kill posture (carried from D.4.2)

- Any provider failure/timeout/unreachable → deterministic verdict (fail open).
- The canary + latched circuit breaker gate every applied verdict; the frozen kill
  rules (precision floor, harm rate, attribution diagnostics, privacy, **rail p95
  ≤ 50 ms**) apply to semantic verdicts too. A semantic provider that pushes warm
  p95 over 50 ms trips the breaker like anything else.
- `TRACEBASE_DISABLED`, the env kill, and `canary disable` still win unconditionally.

## 6. Role of the local Qwen benchmark (R&D only)

The local Qwen3-Reranker-0.6B run (pinned + sha-verified, gitignored `.models/`)
exists **only to validate**, for the hosted/sidecar service:
1. **Quality** — precision@fire / recall@useful / FP vs the deterministic baseline
   on the frozen recurring-family fixtures (recall recovery is the whole point).
2. **Warm latency** — to confirm a warmed model can plausibly meet the 50 ms p95
   rail (on the service's GPU; a local CPU run is a conservative upper bound).
3. **Artifact pinning** — the revision + sha256 the hosted/sidecar image must pin.
4. **Service sizing** — memory footprint + throughput to size the GPU data plane.

It is **not** a client install path. No customer is required to download a model;
the default is the hosted data plane (A), enterprise self-hosts the sidecar (B),
and local (C) is an advanced opt-in.

## 7. Next approval boundary

Mode A/B require building the inference service (HTTP transport behind the same
DTO contract) — a separate, explicitly-approved step. Promotion of any semantic
verdict to served output remains gated on: a successful offline bakeoff (quality),
a warm p95 ≤ 50 ms validation on the target hardware, the canary, and the breaker —
never auto-promoted, never on the hot path's critical section.
