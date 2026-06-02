# Semantic-applicability provider bakeoff (R&D)

> **Status: R&D substrate only.** Branched from the frozen D.5 runtime
> (`claude/semantic-applicability-rnd-d5` ← `332c366`). This is a comparison
> harness for applicability rerankers. It downloads **no** model weights, builds
> **no** inference adapters, makes **no** network calls, and is **not** wired into
> production serving. Implementing a real adapter is a separate, explicitly-
> approved step (see *Next approval boundary*).

## 1. Why

The shipped applicability reranker (`src/core/applicability-reranker.ts`,
`DeterministicApplicabilityReranker`) is a deterministic, rule-based baseline:
rarity-weighted structured-field overlap + a discriminative gap. The open
question for Phase E is whether a learned cross-encoder recovers materially more
of the V4-abstain residual at acceptable precision **and** within the frozen
pre-reg rail-latency budget (§7.4: p95 ≤ 50 ms). This substrate lets candidates be
scored over the same scanned fixtures, offline and deterministically, **before**
any model touches the serving path.

## 2. Candidate matrix (frozen; verified 2026-06-02 from model cards)

| id | model | params | license | weights | offline | base model | status |
|---|---|---|---|---|---|---|---|
| `deterministic-baseline` | In-repo rule-based reranker | n/a | in-repo (project) | — | ✓ | — | **verified** |
| `qwen3-reranker-0.6b` | Qwen3-Reranker-0.6B | 0.6B | apache-2.0 | ✓ | ✓ | Qwen3-0.6B-Base | **verified** |
| `bge-reranker-v2-m3` | BGE-reranker-v2-m3 | ~568M (bge-m3 backbone) | apache-2.0 | ✓ | ✓ | bge-m3 | **verified** |
| `memreranker` | MemReranker (0.6B / 4B) | 0.6B / 4B | apache-2.0 | ✓ | ✓ | Qwen3-Reranker-4B | **verified** |

Every confirmed candidate is **Apache-2.0** with downloadable weights → all are
offline-capable (local-process inference, no remote API). The `memreranker`
license gate the task imposed ("only if weights and license are verifiable") is
**met**: `IAAR-Shanghai/MemReranker-4B` states `apache-2.0` and ships safetensors.

### Sources

- Deterministic baseline — `src/core/applicability-reranker.ts` (this repo).
- Qwen3-Reranker-0.6B — model card: https://huggingface.co/Qwen/Qwen3-Reranker-0.6B (license: apache-2.0). Release writeup: https://qwenlm.github.io/blog/qwen3-embedding/
- BGE-reranker-v2-m3 — model card: https://huggingface.co/BAAI/bge-reranker-v2-m3 (license: apache-2.0). Multilingual cross-encoder on the bge-m3 backbone.
- MemReranker — model card: https://huggingface.co/IAAR-Shanghai/MemReranker-4B (license: apache-2.0; fine-tuned from Qwen/Qwen3-Reranker-4B). Paper: https://arxiv.org/abs/2605.06132 ("MemReranker: Reasoning-Aware Reranking for Agent Memory Retrieval"). Purpose-built for agent-memory retrieval — the most on-domain candidate for TraceBase; also the largest, so its latency must be validated against the §7.4 rail budget before any serving.

The frozen set is also encoded as data in
`src/experiments/semantic-bakeoff/manifest.ts` (`CANDIDATE_MANIFEST`), pinned by a
content-addressed `manifestDigest()` so a bakeoff run records exactly which
candidate set it scored.

## 3. Substrate architecture

All providers implement the existing `ApplicabilityProvider` contract
(`rank(query, candidates, ctx) → ApplicabilityResult[] | null`, deterministic,
returns `null` — never throws — on failure/timeout). The bakeoff adds:

- **Typed boundary** (`boundary.ts` · `runProbe` / `runBakeoff`). One probe →
  one provider, returning a `BakeoffOutcome` (verdicts, latency, `usedFallback`,
  closed `fallbackReason`).
- **Strict deadline + total fail-open.** A hard wall-clock deadline
  (`DEFAULT_BAKEOFF_DEADLINE_MS = 50`, mirroring the rail budget) races the
  provider; a timeout, a `null`, a throw, or a blocked remote all fall open to
  the deterministic baseline with a recorded reason.
- **Scanned DTOs only.** `scanProbeDTO` runs the shared leakage scanner
  (`detectLeakageExtended`: abs-paths + secrets + env-lines) over each fixture;
  a match drops the fixture *before* any provider sees it (recorded in
  `rejected`).
- **No implicit network.** Each provider declares a posture
  (`none` | `local-process` | `remote-explicit`); a `remote-explicit` provider
  runs only when the caller passes `allowRemote`. None of the shipped candidates
  are remote.
- **Deterministic fake provider** (`fake-provider.ts`) — the only non-baseline
  provider implemented here. Stable verdicts from a hash; configurable to
  simulate null/throw/slow so the boundary's invariants are provable at $0.
- **Reproducible manifest** (`manifest.ts`) + `$0` smoke
  (`tests/experiments/semantic-bakeoff.test.ts`, 9 tests).

## 4. Explicit non-goals (this substrate)

- **No weights downloaded.** The candidate entries are data, not adapters.
- **No inference adapter** for any learned model. `local-process` is a *declared*
  posture an adapter *would* use; no such adapter exists yet.
- **No production serving wired.** The frozen D.5 runtime is untouched; this
  branch adds only `src/experiments/semantic-bakeoff/**` + this doc.
- **No policy tuning.** Thresholds, the pre-reg, and the canary are unchanged.

## 5. Next approval boundary

Implementing a single real adapter (e.g. `qwen3-reranker-0.6b` as the smallest
offline cross-encoder) is the next step and requires explicit approval because it
crosses three lines this substrate deliberately does not:

1. **Download weights** (Apache-2.0, but a real artifact + supply-chain review).
2. **Local-process inference** (a child process / ONNX runtime; still no remote
   API, but real compute + a latency profile to validate against §7.4's 50 ms
   p95 rail budget on representative fixtures).
3. **Offline bakeoff run** over a held-out, organic fixture set (no synthetic /
   bootstrap traffic counted) to compare recovered-residual precision vs the
   deterministic baseline — feeding the Phase-E decision rule, still behind the
   canary + breaker, never auto-promoted.
