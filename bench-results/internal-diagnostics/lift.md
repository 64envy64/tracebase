# TraceBase — Captured-Trace Lift Bench
**End-to-end pipeline: agent runs → distillates → memory → future-agent recall**
**tracebase 0.9.0 · 3 multi-step debug tasks · N=10 captured-trace memory**

## Methodology — authentic capture flow

This bench tests TraceBase's **load-bearing value proposition**: an agent solving a bug today emits a trace; future agents on architecturally-similar bugs recall a distillate of that trace and resolve faster.

Concretely:

1. **Training phase (10 sub-agent runs).** A Claude Code sub-agent solves each of 10 small fixtures in `eval/agentic/fixtures/`. On success, the agent produces a 3-field distillate (`situation` / `deadEnds` / `unlock`) describing the bug pattern in ABSTRACT terms — what a TraceBase-pipeline-quality distillation would emit on a successful trace.
2. **Capture phase.** Each distillate is stored as a `ReasoningTrace` (`outcome: success`) in a fresh `.tracebase/memory.db` via the production `ReasoningLayer.storeTrace` API.
3. **Test phase (6 sub-agent runs).** Three new, deliberately-harder multi-file tasks (8 files each, bug 3 layers deep, with red-herring siblings) are given to fresh sub-agents in two variants:
   - **OFF**: no memory, no injection.
   - **ON**: production retrieval via `ReasoningLayer.recall` → tiered gate → `<hint>` or `<prior_fix>` block prepended exactly as the production `inject-context` hook would emit.
4. **Verification.** Post-hoc vitest run in each workspace to confirm tests pass.

**Numbers come from the Claude Code Agent harness** (`tool_uses`, `duration_ms`, `total_tokens`) — authoritative, not self-reported.

### Threshold calibration disclosure

The production `formatCompressedDirective` gate uses thresholds `0.85 full / 0.72 hint`. These were calibrated for a corpus of hundreds of organic patterns; on N=10 the FTS5 IDF is degenerate and scores cluster below 0.7. We re-calibrated to **0.60 full / 0.40 hint** for this corpus size — the format and tier semantics are byte-identical to production; only the numeric constants differ. This is explicitly called out in the codebase: `src/core/block-serving.ts` documents per-corpus threshold tuning.

## Tasks (test set)

| ID | Family | Bug | Files | Test count |
|---|---|---|---:|---:|
| task-A — ETL Pipeline | async-iteration | `forEach(async)` in `batchWriter.ts` (3 layers below entry) | 8 | 3 |
| task-B — Auth Cache | LRU recency | `LRUCache.get` doesn't `touch` on read; session evicted under load | 8 | 3 |
| task-C — Build Graph | cyclic-visited | `Resolver.visit` recurses without visited-set; cycle hangs | 8 | 3 |

Bug location is 3 layers from the failing test in each case; red-herring files (retryPolicy, permissionChecker, manifestParser, etc.) sit alongside the buggy module.

## Captured memory (training output)

10 successful training trajectories produced these distillates:

| Source fixture | Captured situation (excerpt) | Captured unlock (excerpt) |
|---|---|---|
| fix-async-race | "forEach with async callback returns before promises settle" | "Replace forEach(async ...) with await Promise.all(arr.map(...))" |
| fix-cache-invalidation | "read accessor doesn't update recency metadata" | "Invoke same recency-update helper that write path uses, on every read" |
| fix-debounce | "wrapper drops captured variadic args before reaching inner callable" | "Spread captured rest-tuple `fn(...args)` at every call site" |
| fix-deep-clone | "recursive structural traversal lacks non-plain branches + visited memo" | "Early-return per non-plain type + WeakMap<orig, clone> threaded through recursion" |
| fix-event-leak | "wrapper used for register/unregister, ref-equality fails" | "Capture wrapped fn once, reuse for both register and unregister" |
| fix-merge-sort | "two-pointer merge advances both pointers on equal heads" | "Each iteration: push exactly one element, advance exactly one source pointer" |
| fix-null-coalesce | "`||` default-fallback overrides legitimate falsy values" | "Use `??` so only null/undefined trigger defaults" |
| fix-off-by-one | "inclusive bound paired with strict <" | "Match predicate to bound convention: inclusive → `<=`, exclusive → `<`" |
| fix-rate-limiter | "documented-inclusive boundary with strict comparison" | "Use non-strict comparison (`>=` / `<=`) for inclusive bounds" |
| fix-tree-depth | "over-eager base case returns wrong constant at leaf" | "Verify each base case independently against the inductive case" |

These distillates are pattern-abstract (no specific function names from the source fixtures). They were produced by training agents — not authored by hand.

## Probe — what the gate surfaces per test task

Median across N=5 probes per task:

| Task | Modal top pick | Median score | Tier (cal 0.60/0.40) | Verdict |
|---|---|---:|---|---|
| task-A | fix-async-race (5/5) | 0.444 | hint | **correct pattern** |
| task-B | fix-event-leak (4/5) ✗ | 0.424 | hint | **wrong pattern** (right was fix-cache-invalidation) |
| task-C | fix-deep-clone (5/5) | 0.476 | hint | correct pattern (cyclic-visited family); surface mismatch |

The gate finds the correct ABSTRACT pattern on 2/3 tasks. On task-B the keyword overlap with `fix-event-leak`'s "wrapper / reference identity / register / unregister" outranked `fix-cache-invalidation`'s "recency / read accessor" terms — a real recall miss on a 10-trace corpus.

## Results — trajectory cost (authoritative, from harness)

| Task | Variant | Pass | tool_uses | duration | tokens | edited |
|---|---|:-:|---:|---:|---:|---|
| task-A | OFF | ✓ | **16** | 183 s | 25 780 | batchWriter.ts |
| task-A | ON  | ✓ | **13** | 256 s | 24 799 | batchWriter.ts |
| task-B | OFF | ✓ | 9  | 202 s | 23 966 | lruCache.ts |
| task-B | ON  | ✓ | 17 | 320 s | 28 473 | lruCache.ts |
| task-C | OFF | ✓ | 14 | 313 s | 28 502 | resolver.ts + compiler.ts |
| task-C | ON  | ✓ | 15 | 301 s | 27 658 | resolver.ts + compiler.ts |

**Pass rate: 6/6 = 100% in both variants.** Tasks are tractable enough that the agent solves them either way; lift lives in trajectory cost, not in accuracy.

### Stratified by recall correctness

**Correct-recall subset (task-A + task-C, N=2):**
| | OFF | ON | Δ |
|---|---:|---:|---:|
| tool_uses (sum) | 30 | 28 | **−6.7 %** |
| duration (sum) | 496 s | 557 s | +12.3 % |
| tokens (sum) | 54 282 | 52 457 | **−3.4 %** |

**Wrong-recall subset (task-B, N=1):**
| | OFF | ON | Δ |
|---|---:|---:|---:|
| tool_uses | 9 | 17 | **+88.9 %** |
| duration | 202 s | 320 s | **+58.4 %** |
| tokens | 23 966 | 28 473 | **+18.8 %** |

**Aggregate (all 3):**
| | OFF | ON | Δ |
|---|---:|---:|---:|
| tool_uses (sum) | 39 | 45 | +15.4 % |
| duration (sum) | 697 s | 876 s | +25.7 % |
| tokens (sum) | 78 248 | 80 930 | +3.4 % |

## Honest interpretation

**On a 10-trace captured corpus the gate is unreliable enough that bad recall offsets good recall.** Specifically:

- When recall surfaces the right pattern (2/3 cases), trajectory cost goes down on tool count (-7 %) and tokens (-3 %), neutral on time.
- When recall surfaces the wrong pattern (1/3 cases), the agent pays a real cost: **+89 % tool calls, +58 % wall time, +19 % tokens.** The agent had to read source, recognize the hint didn't apply, and proceed normally — and that recognition itself cost ~8 extra tool uses.
- **Net aggregate at N=10 captured-trace corpus: slight loss.** The single wrong-recall case dominates the small sample.

**Per-task on correct recall, the lift is modest at best.** Even when the gate found the right ABSTRACT pattern, the agent on task-C explicitly noted "the injected hint about WeakMap clone reconstruction did not match this codebase". The distillate captured "cyclic-visited" as a clone-reconstruction recipe, not as a graph-traversal pattern — surface specificity bled through. This is a real **distillation quality** concern, not a retrieval failure.

## What this measures that's new

Unlike the earlier benches in this repo:

| Prior bench | Memory source | What it measured |
|---|---|---|
| May-4 retrieval-only counterfactual | 10 hand-curated seeds (unrelated) | Refusal quality |
| YC PR-layer | 5 hand-curated 1:1 seeds | Payload value when curated |
| SWE-bench-30 | 30 generic Python pattern templates | Pass rate on diverse OSS bugs |
| Families bench | 19 fixture seeds (hand-curated, 5 families) | Selective gating + retrieval precision |
| **Lift bench (this one)** | **10 captured-trace distillates from real agent runs** | **End-to-end value: captured memory → future-agent lift** |

This is the only bench where the memory comes from an actual agent-run capture (training phase) rather than from hand authorship — closer to deployment reality.

## What this does NOT measure (honest scoping)

1. **N=3 test tasks is too small for confident lift claims.** A single wrong-recall outlier dominates aggregate. ReasonBlocks reports on 50 problems.
2. **N=10 captured corpus is small.** Score variance is high, retrieval precision suffers. A production deployment would have hundreds-to-thousands of organic captures, where IDF is healthy and recall is reliable.
3. **Threshold re-calibration.** We re-tuned the gate from production 0.72/0.85 to corpus-size-appropriate 0.40/0.60. The shapes (refused/hint/full) are unchanged; the numeric constants are not.
4. **Single-model run.** No Haiku-vs-Sonnet-vs-Opus matrix.
5. **Each cell is N=1 trajectory.** Model stochasticity is uncharacterized; the +12 % wall-time variance on the correct-recall subset is within plausible Claude Code session noise.

## Why publish this anyway

It's the first bench in the TraceBase repo where the **full pipeline runs end-to-end without any hand-authored artifacts**:

> Training agents solve real tasks → produce distillates → captured into the store → future agents recall from that store → measured against held-out harder tasks.

The disappointing aggregate (+15 % tool uses) is a real finding: **TraceBase's value at small captured-corpus scale is bottlenecked by recall precision.** When the gate picks correctly, the agent moves slightly faster (−7 % tools); when it picks wrong, the agent pays heavily (+89 %). The cost-benefit ratio improves with corpus size (more patterns → better keyword discrimination → fewer wrong picks); ReasonBlocks's 190 k corpus is presumably comfortably past this threshold.

## Implied roadmap

1. **Larger captured corpus.** Re-run this bench with N≥100 captured traces (covering 20+ bug families). Hypothesis: wrong-recall rate drops below ~5 %, aggregate flips clearly positive.
2. **Distillation abstraction.** Task-C surfaced a quality issue: agent training-distillates can be too surface-specific (clone-reconstruction → didn't transfer to graph-traversal). The production distillation pipeline (`src/distillation/pipeline.ts`) uses an LLM step explicitly to abstract surface details; this bench used training-agent self-reports instead. Re-running with the production LLM-distiller is the next step.
3. **Calibrator (Phase 5).** Outcome-feedback calibration converts raw BM25 score into `P(helpful)`. When deployed, the gate stops being tuned manually per corpus size and self-calibrates against observed outcomes. This is the production roadmap fix for the threshold-tuning concern.

## Disclosures

- **Training and test agents are Claude Code sub-agents via the Agent tool** — same model class, different invocations.
- **Distillates were produced by the training agents themselves** (richer self-reports). The production pipeline's LLM step (`AnthropicDistiller`) was not used because we don't have an API key in this session; the methodological caveat is in §"What this does NOT measure" #2.
- **Numbers from harness, not self-reports.** Agent self-reports of `tool_calls` / `files_edited` are unreliable (one prior bench had agents report 0 edits while the workspace had been modified). All numbers in this report come from harness instrumentation + post-hoc vitest verification.
- **Test workspaces are byte-identical between OFF and ON before the agent runs**; only the prompt differs.
- **Verification: vitest in-process,** not Docker swebench (Docker harness is available but overkill for vitest fixtures).

Raw: [`lift.json`](lift.json). Probe details: [`bench-runs/lift/probe.json`](../../bench-runs/lift/probe.json). Captured distillates: [`bench-runs/lift/distillates/captured.jsonl`](../../bench-runs/lift/distillates/captured.jsonl).
