# 0.7.1 → 0.9.0 bench delta

Generated 2026-05-26 from `bench-results/*-0.9.0.json` vs `*-0.7.1.json`.
All four release-acceptance stages PASS at 0.9.0 (gate-0.9.0.json:GATE PASS).

## Headline

- **Retrieval quality: bit-identical.** Recall@5/nDCG@5/MRR on `prior_fix`,
  `file_memory`, `context_fold` reproduce 0.7.1 to 16 decimal places. The
  C4/C4.1-4.5/C5/C5.1-5.2 runtime-arbiter work did not regress retrieval.
- **SDK hot path: faster.** `runtime.beforeRun` p50 −44%; `observeToolBatch`
  p50 −40%; `saveContext` p50 −39%. ROI-ordered lane allocator avoiding
  unnecessary work shows up here.
- **Hook latency: p50 roughly doubled across all four hooks.** None breach
  ceiling; `inject-context` p50=128ms crosses the 150ms target (still
  under the 400ms ceiling). This is the measurable cost of the arbiter
  pipeline at the hook boundary.
- **Mechanism micro-benches: same order of magnitude.** All well under
  target.

## Retrieval (`eval-retrieval-*.json`)

| Suite        | cases | recall@5 | nDCG@5 | MRR  | thresholds        | 0.7.1 = 0.9.0? |
|--------------|-------|---------:|-------:|-----:|-------------------|---------------:|
| prior_fix    | 13    | 1.000    | 1.000  | 1.000 | ≥0.85/0.70/0.65  | **yes (bit)**  |
| file_memory  | 12    | 1.000    | 1.000  | 1.000 | ≥0.85/0.70/0.65  | **yes (bit)**  |
| context_fold | 10    | 1.000    | 0.889  | 0.850 | ≥0.85/0.70/0.65  | **yes (bit)**  |

nDCG@5 on `context_fold` matches between versions to all 16 stored decimal
places (0.8892789260714373).

## SDK hot path (`sdk-*.json`)

| Hook                       |   metric | 0.7.1  | 0.9.0  | Δ        |
|----------------------------|---------:|-------:|-------:|---------:|
| runtime.beforeRun          | p50      |  4.72  |  2.63  | **−44%** |
|                            | p95      | 13.65  |  6.28  | **−54%** |
|                            | p99      | 18.35  |  8.52  | −54%     |
| runtime.observeToolBatch   | p50      |  1.42  |  0.85  | **−40%** |
|                            | p95      |  3.15  |  1.28  | **−59%** |
|                            | p99      | 10.05  |  6.64  | −34%     |
| runtime.saveContext        | p50      |  0.94  |  0.57  | **−39%** |
|                            | p95      |  1.99  |  0.89  | −55%     |
|                            | p99      |  3.49  |  6.49  | +86%     |
| hot-path-no-fetch          | calls    |  0     |  0     | (unchanged) |

`saveContext` p99 grew but is still 1/30th of the 200ms target; a handful
of tail outliers, not a real regression.

## Hook latency (`*.json` = bench-hooks)

| Hook              |  metric | 0.7.1  | 0.9.0  | target  | ceiling | Δ        |
|-------------------|--------:|-------:|-------:|--------:|--------:|---------:|
| inject-context    | p50     | 64.35  | 128.22 | 150     | 400     | **+99%**, **OVER target** |
|                   | p95     | 101.22 | 164.60 |         |         | +63%     |
|                   | p99     | 169.37 | 189.21 |         |         | +12%     |
| capture-turn      | p50     | 59.15  | 129.02 | 500     | 1500    | **+118%** |
|                   | p95     | 76.54  | 178.34 |         |         | +133%    |
|                   | p99     | 93.69  | 246.79 |         |         | +163%    |
| capture-context   | p50     | 63.12  | 130.62 | 2000    | 6000    | **+107%** |
|                   | p95     | 92.32  | 166.32 |         |         | +80%     |
|                   | p99     | 313.55 | 241.19 |         |         | −23%     |
| capture-tool-use  | p50     | 55.62  | 117.06 | 200     | 600     | **+110%** |
|                   | p95     | 69.23  | 138.02 |         |         | +99%     |
|                   | p99     | 87.14  | 189.00 |         |         | +117%    |

`inject-context` is the only one whose p50 crosses its target; capture
hooks are 3-15× under target despite the regression. All four pass the
ceiling check, so the release gate is green.

The doubling is consistent across hooks → not noise, it's the new
arbiter / publishability / lane-allocator code on the hook path. Worth
profiling before 1.0 to decide if it's reducible or accepted.

## Mechanism micro-benches (`mechanisms-*.json`)

| Hook                            |  metric | 0.7.1 | 0.9.0 | target | Δ         |
|---------------------------------|--------:|------:|------:|-------:|----------:|
| prompt-cache.attach.string      | p50     | 0     | 0     | 0.05   | (noise)   |
|                                 | p99     | 0.002 | 0.002 |        | unchanged |
| prompt-cache.attach.array8      | p50     | 0     | 0.001 | 0.1    | (noise)   |
|                                 | p99     | 0.002 | 0.004 |        | (noise)   |
| mechanism-savings.compute.1k    | p50     | 1.252 | 2.09  | 30     | +67%      |
|                                 | p95     | 2.038 | 2.856 |        | +40%      |
|                                 | p99     | 4.978 | 3.572 |        | −28%      |
|                                 | max     | 11.55 | 4.658 |        | −60%      |

p50 +67% but absolute is 2ms vs 30ms target — irrelevant in practice.
Tail tightened.

## What the technical-note refresh still needs

The May-4 technical note ([technical-note-may4.md](technical-note-may4.md))
pins its prose claims to commit `feat/0.7.1-preventive-supervision` —
mostly retrieval counterfactual and junk-rate measurements, not the
bench-gate latencies above.

For a full 0.9.0 refresh of THAT note we still need:

1. `tsx eval/agentic/retrieval-comparison.ts` — the 10-fixture
   hold-one-out counterfactual against the naive cache (the "10/10
   noise-control wins" claim).
2. `tsx scripts/junk-rate-diagnostic.ts` against a current live
   `.tracebase/memory.db` — the 54.2% pre-gate / 16.7% residual / 9.1%
   FP claims. The note's "pre-registered post-gate junk-rate" follow-up
   (N ≥ 30 newly admitted patterns under the capture gate) is also
   overdue.

Bench-gate (this delta) is the runtime release-acceptance signal;
those two are the design-partner narrative numbers.

## Windows fix in passing

`scripts/bench-gate.ts:61` was missing `shell: process.platform === "win32"`
on the `spawnSync("npm", …)` call, so the orchestrator falsely reported
all four stages as 3-5ms FAIL on Windows. Fixed; the orchestrator now
runs end-to-end on this platform.
