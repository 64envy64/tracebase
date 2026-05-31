# Bootstrap / Cold-Start Import Eval — Phase 1 Report (offline, $0)

**BOOTSTRAP / COLD-START evidence — NOT organic readiness. Never counted toward
the Phase-5 gate.** Per BOOTSTRAP-IMPORT-PREREG.md. No paid agents, no mining, no
serving-gate changes, no threshold tuning.

## Corpus (frozen)
- Hand-authored, disclosed **recurring-class** corpus (NOT organic, NOT
  public-mined): **10 families** (null-guard, off-by-one, unawaited-async,
  cache-staleness, timezone, resource-leak, encoding, retry-storm,
  pagination-dup, float-precision).
- **10 imported canonical patterns** (1 reusable pattern / class) via the generic
  `ReasoningPatternDTO → ingestPattern` boundary (import provenance).
- **20 useful holdouts** (2 / family — different concrete instance of the same
  class) + **10 unrelated negative controls** (distinct concepts not imported).
- `corpusHash = de94b5202715edbd`, `frozenAt = 1780262013`. Artifacts:
  `bootstrap/corpus.import.jsonl`, `bootstrap/phase1-report.json`.

## Import + leakage audit
- import: **10 accepted / 0 rejected / 0 deduped**.
- holdouts are **distinct instances** from imported patterns (no own-fix; disjoint);
  imported patterns carry reusable class reasoning, not a holdout's answer;
  **10 negative controls** present to verify abstention. Audit: clean.

## Metrics (real serving policy, production gate)
| metric | value |
|---|---|
| corpus size | 10 imported · 20 useful holdouts · 10 controls (30 queries) |
| family count / distribution | 10 families · 1 canonical + 2 holdouts each |
| accepted / rejected / deduped | 10 / 0 / 0 |
| fire-rate overall | **3.3%** (1/30) |
| fire-rate within recurring families | **5.0%** (1/20 useful holdouts) |
| precision@fire | **1.00** |
| precision Wilson-LB | 0.207 (n=1 fire) |
| false-positive rate | **0** (overall and on controls: 0/10) |
| recall@useful | **5.0%** |
| abstention reasons | `ambiguous_margin` ×28 · `no_candidates` ×1 |
| latency p50 / p95 | 1 ms / 3 ms |
| calibrator | mixed · coverage 3.3% (identity on uncalibrated) |

### Sensitivity (diagnostic; production gate UNCHANGED)
| gateThreshold | fire | precision@fire | Wilson-LB | FP | recall@useful |
|---|---|---|---|---|---|
| 0 (production) | 0.033 | 1.0 | 0.207 | 0 | 0.05 |
| 0.2 | 0.033 | 1.0 | 0.207 | 0 | 0.05 |
| 0.4 | 0.033 | 1.0 | 0.207 | 0 | 0.05 |
| 0.6 | 0.033 | 1.0 | 0.207 | 0 | 0.05 |

**Flat** — the calibrated-prob gate is NOT the binding lever. The 28 abstentions
are `ambiguous_margin`: the evidence-policy margin (top-vs-second) abstains because
a different family's block sits close behind the right one.

## Interpretation
On a corpus that DOES contain recurring families, the gate is **high-precision
(1.00, FP 0) but very low-recall (5%)**, and the bottleneck is the **evidence-policy
margin, not the calibrated-prob threshold** (sensitivity flat). This is consistent
with the product's load-bearing design (abstain on ambiguity to protect precision —
the asymmetric-payoff argument). It also explains the organic capture run: even
*genuine* recurrence fires rarely because realistic same-class instances don't
clear the margin against close cross-family candidates.

## Recommendation: **AGAINST paid Phase 2 now**
- Offline Phase 1 already answers the mechanism question (high-precision /
  low-recall, margin-bound). Paid trajectories would mostly **reproduce a ~5%
  fire-rate** — low information per dollar; the precision side is already validated
  (1.0, FP 0).
- The actionable lever is an **offline ($0) investigation of the evidence-policy
  margin + distillation abstraction** (can recall rise while precision/FP hold?),
  NOT a paid confirmation. This is investigation, **not gate-lowering / tuning to
  flatter** — production thresholds stay fixed; any change would be a separate,
  reviewed product decision with its own re-eval.
- Revisit paid Phase 2 **only if** an offline margin/distillation study lifts
  within-family recall materially (e.g., ≥30–40%) while holding precision ≥0.90 and
  FP ≤0.05 — then a small paid run to confirm fire→use→resolve attribution end to
  end would be justified.

## Caveats (honesty)
Hand-authored cold-start corpus (disclosed); small N (30 queries, 1 fire → wide
Wilson interval); cross-family vocabulary overlap contributes to `ambiguous_margin`
(a more lexically-distinct corpus might fire somewhat more — but tuning the corpus
to fire is not done, by design). Bootstrap only; never organic readiness.
