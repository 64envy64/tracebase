# TraceBase v2 — Research-Grade Design

**Status:** design-first commit; implementation follows.
**Scope:** re-found the SDK on 4 explicit pillars before any benchmark scaling.

The fundamental claim of the product: **measurable win on repeated
engineering / operational tasks** — higher accuracy, less time, fewer
dead ends, less spend. Token savings are a side effect, not the pitch.

Prior benchmark work (Phase 1 retrieval, Phase 2 ablation, Phase 3 pilot)
showed the current SDK is too coarse to deliver this claim: whole-trace
units store noise, retrieval scores correlate with shallow lexical
overlap rather than reasoning reuse, and no signal is logged about
whether an injection actually helped. These 4 pillars fix those gaps.

---

## Pillar 1. ReasoningBlock — the atomic memory unit

A `ReasoningBlock` is the smallest piece of reasoning worth reusing. Not a
whole trajectory; not a solution summary; a **single recognizable
pattern**: *"when situation X, mechanism Y, avoid Z, unlock W, verify V"*.

### Schema (authoritative definition)

```typescript
interface ReasoningBlock {
  id: string;              // UUID
  version: number;         // for schema evolution

  // TRIGGER — when this block applies
  trigger: {
    situation: string;     // ≤ 40 words, compressed pattern description
    invariants: {          // structural filters applied BEFORE ranking
      language?: string;
      framework?: string;
      error_type?: string;
      api_surface?: string[];  // specific public APIs implicated
    };
    keywords: string[];    // extracted for BM25
    fingerprint: string;   // sha256 of canonical invariants + keywords
  };

  // BODY — the reusable reasoning
  body: {
    mechanism: string;     // root cause structure
    dead_ends: string[];   // approaches that look plausible but fail
    unlock: string;        // the key insight (≤ 30 words)
    verification: string;  // how to confirm the fix works
  };

  // PROVENANCE — how this block came to be
  provenance: {
    source_task_id: string;           // e.g. astropy__astropy-12907
    source_agent?: string;            // "mini-swe-agent" etc.
    source_model?: string;            // model that produced the trajectory
    extracted_from: "trajectory"
                  | "gold_patch"
                  | "manual"
                  | "imported";
    distilled_at: number;
    distilled_by: "llm" | "rule" | "manual";
    distilled_with_model?: string;    // model used for distillation
    parent_trace_id?: string;         // link back to full trajectory if kept
  };

  // REUSE STATS — populated by analytics pipeline (Pillar 4)
  stats: {
    times_retrieved: number;          // top-K included this block
    times_injected: number;           // passed confidence gate
    times_agent_used: number;         // agent output resembles block
    times_helpful: number;            // verified-positive outcome
    times_counterproductive: number;  // verified regression
    last_used_at?: number;
    cumulative_tokens_saved: number;
    cumulative_steps_saved: number;
  };

  // QUALITY — calibrated priors for serving (Pillar 3)
  quality: {
    confidence: number;               // 0..1, posterior mean
    wilson_lower_bound: number;       // used for ranking tie-break
    calibration_cohort?: string;      // which isotonic model calibrated
  };

  // EMBEDDINGS — optional, for semantic retrieval
  embeddings?: {
    situation_vec?: Float32Array;
    unlock_vec?: Float32Array;
    model: string;                    // e.g. text-embedding-3-small
  };

  // LIFECYCLE
  createdAt: number;
  updatedAt: number;
  status: "active" | "demoted" | "retired";
}
```

### Why these fields and not others

- **trigger vs body separation** — retrieval matches on trigger only.
  Body is the reward you get when the trigger matches. Mixing them (as the
  old `ReasoningTrace.problem.description` + `solution.summary` did)
  forces retrieval to match body content, which is noise from the
  retrieval POV.
- **invariants are explicit** — Phase 1 showed that structural match
  (same framework) dominated scores and caused false positives. v2 moves
  invariants from a weighted signal to a **hard pre-filter**: if
  `invariants.language` is set on the block, a query of different
  language never retrieves it, regardless of BM25.
- **provenance is mandatory** — without it, analytics cannot track which
  task produced which block, and drift cannot be diagnosed.
- **stats separate from quality** — stats are raw counts; quality is
  the calibrated posterior. Keeping them separate avoids the bug where
  a newly-stored block with `times_helpful = 0` gets confidence 0 and
  is never served.

### Relation to existing `ReasoningTrace`

`ReasoningTrace` stays as the "raw trajectory record" (problem description
+ full solution + metadata). A `ReasoningBlock` is **derived** from one
or more traces via the distillation pipeline. Traces can be kept for
audit; blocks are the unit that gets injected.

Migration: add a new table `reasoning_blocks` next to the existing
`traces` table. No breaking changes to existing API. Deprecation of
direct trace-based injection happens in a separate minor release.

---

## Pillar 2. Distillation pipeline — trajectory → block

Without this, the block library fills with paraphrases and shallow
summaries. We need a **disciplined, automatable, verifiable** distiller.

### Input

- Full trajectory of a solved task: messages, tool calls, tool outputs.
- Ground truth outcome: resolved / unresolved by **grader** (not
  submission status).
- Optional: the gold patch, for comparison with agent's submitted patch.

### Stages

1. **Gate**: accept only grader-verified `resolved=true` trajectories.
   This is the primary defense against distilling from "plausible
   but wrong" agent output.
2. **Locate unlock step**: find the last message before the agent's
   first successful `editFile` that led to `runTests=pass`. That message
   typically contains the reasoning that mattered.
3. **Mine dead ends**: iterate backwards through assistant messages;
   any hypothesis the agent abandoned (edited, then reverted, or
   explicitly said "that didn't work") is a candidate dead end.
4. **Distill**: LLM call with a tight JSON-schema prompt. Budget: ≤ 400
   output tokens. Prompt enforces the 5-field structure. Temperature 0.
5. **Validate structurally**: reject distillations that leak gold patch
   file paths, exact diff lines, or task instance IDs. These would leak
   ground truth into future retrieval.
6. **Dedupe**: compute fingerprint from invariants + keywords; if a
   block with same fingerprint exists, merge stats instead of creating
   a duplicate.
7. **Self-verify (optional, expensive)**: run a fresh agent on a
   *different* task from the same bug class, with ONLY this block
   injected. If the agent reuses the block and resolves, mark the block
   as `verified`. This is the best quality signal but costs ~$0.30 per
   block. Use it sparingly (e.g. for blocks that repeatedly serve).
8. **Store**: commit with `confidence = 0.5` prior, `status = active`.

### Anti-leakage guarantees

- Distiller never sees the gold patch or the specific FAIL_TO_PASS test
  identifier. Only the agent's trajectory + a binary resolved flag.
- Distilled output must pass a regex guard: no file paths of form
  `(*/*/*\.py)`, no `assert` statements, no patch hunks.
- Any block that fails either guard is discarded silently; counter
  incremented for alerting.

### Offline re-run pipeline

Phase 3 partial data already contains 4 grader-verified resolved
trajectories (easy-subset pilot). The distiller can be run offline on
those trajectories to produce the first real (non-hand-crafted) blocks.
That's the first populated KB we can ablate against.

---

## Pillar 3. Serving quality — retrieval, calibration, policy

Phase 1 showed current scores are not calibrated: 0.70-0.80 did not
correspond to "useful 70-80% of the time." Without calibration, the
confidence gate is arbitrary.

### Retrieval architecture

```
query
  │
  ├─► invariant extraction (from task text)
  │
  ▼
hard filter by invariants ─► candidates (≤ all blocks matching invariants)
  │
  ▼
BM25 over (situation + keywords) ─► top K=20
  │
  ▼
cross-encoder reranker over (query, block.situation + block.unlock)
     ─► top K=5
  │
  ▼
calibrated confidence gate (isotonic regression)
     if p(helpful | score) < τ, skip injection
  │
  ▼
inject block.body (mechanism + dead_ends + unlock + verification)
     formatted as HYPOTHESIS, not command
```

### Calibration

We log every retrieval event as `(query, block_id, ranker_score,
injected, agent_used_block, outcome_resolved, outcome_regressed)`. After
N ≥ 200 events, fit an isotonic regression `score → P(helpful)` using
`helpful = outcome_resolved AND agent_used_block AND NOT regressed`.

The gate threshold τ is set by the **operating point**:
- If we want **high precision** (rarely inject but inject well): τ such
  that calibrated P(helpful) ≥ 0.8.
- If we want **high coverage** (inject often, accept some noise): τ such
  that calibrated P(helpful) ≥ 0.5.
These are per-deployment choices, not baked defaults.

### Negative cache

When a block's injection is followed by `outcome_resolved=false AND
outcome_regressed=true` (the agent would have resolved without it but
didn't with it), the block's `stats.times_counterproductive` increments
and it is demoted: `status = demoted`. Demoted blocks are not served
again until explicitly re-promoted. Closes the loop on "our own bad
blocks hurt us."

### Shadow mode

In production or during benchmarks, a configurable fraction (e.g. 10%)
of queries runs **without** injection even when a high-confidence match
is found. Their outcomes are the control data for calibration. Without
this, calibration data is confounded by "would have solved anyway."

---

## Pillar 4. Reuse analytics — measure what's paid for

### Event log

Append-only JSONL per deployment:

```jsonc
{ "ts": 1776..., "event": "retrieval",    "query_id": "...", "block_ids": [...], "scores": [...] }
{ "ts": 1776..., "event": "injection",    "query_id": "...", "block_id": "...", "score": 0.83 }
{ "ts": 1776..., "event": "agent_used",   "query_id": "...", "block_id": "...", "match_signal": "jaccard≥0.3" }
{ "ts": 1776..., "event": "outcome",      "query_id": "...", "resolved": true, "tokens": 4200, "steps": 14, "control_group": false }
```

### Aggregates (SQL views)

- **Coverage**: `retrievals_with_injection / total_retrievals`
- **Hit rate**: `agent_used / injected`
- **Lift (resolved rate)**: `resolved(injected) - resolved(control)` —
  requires shadow mode to compute honestly.
- **Lift (tokens)**: `mean(tokens | no_injection) - mean(tokens |
  injected)` on the same task distribution.
- **Calibration curve**: binned `score → observed P(helpful)`.
- **Per-block**: times used, times helpful, cumulative lift, last use,
  drift indicator.

### Dashboard surfaces (non-technical users)

1. **Coverage × Lift scatter** per team/project.
2. **Top-10 blocks** by cumulative tokens saved / steps saved.
3. **Drift alert list**: blocks whose rolling-30d helpful-rate dropped
   > 2σ from prior.
4. **Calibration plot** (makes the confidence number trustworthy).
5. Later, the knowledge graph view (nodes = blocks, edges = "derived
   from" and "co-retrieved with").

The dashboard is Pillar 4 output, not a separate pillar — we log the
events correctly once and the UI reads views.

---

## Order of implementation

1. **Pillar 1** — schema + SQLite migration v4 + types.ts update.
   Backwards-compatible: existing `ReasoningTrace` API untouched. New
   `ReasoningBlock` API added in parallel.
2. **Pillar 3 (retrieval only)** — before distillation, the retrieval
   path must work on blocks. Add invariant pre-filter + basic BM25 over
   trigger fields. Cross-encoder is optional at first (can mock with
   cosine). Calibration fitting starts disabled; infrastructure present.
3. **Pillar 4 (event log only)** — add `logs/events.jsonl` append path
   and aggregate script. No dashboard yet, but data from here on is
   shaped right for one.
4. **Pillar 2 (distillation)** — implement the pipeline, run offline on
   the 4 grader-verified trajectories from pilot. First real (not
   hand-crafted) blocks in KB.
5. **Re-run Phase 3 ablation** against the new block KB, with shadow
   mode enabled to generate calibration data. This is where a benchmark
   claim can first be tested.
6. **Dashboard UI** (Pillar 4 front-end). Deliberate: dashboard only
   after the data behind it is trustworthy.

Only after step 5 does a benchmark claim become defensible. Step 6 is
the commercial surface. Scaling to 50+ tasks / 3 models happens after
step 5, not before.

---

## What this design explicitly does NOT do

- **No hand-crafted oracle patterns** in the main product code. Oracle
  patterns stay strictly in `eval/` as internal diagnostics.
- **No whole-trace injection**. The old `trace.solution.summary` path
  still exists but is deprecated and excluded from block-based
  evaluation.
- **No benchmark claims** from data collected before Pillar 4 event
  log is wired up. Without shadow-group outcomes, lift is not
  identifiable.
- **No knowledge graph visualization** in v1. It's downstream of having
  real block reuse data. We log the edges now; render them later.

---

## Open questions (explicit, to answer during implementation)

1. What LLM to use for distillation step 4? Sonnet 4.6 same model?
   Cheaper Haiku? A smaller open model self-hosted?
2. Cross-encoder: do we use a hosted API, a small local model, or
   pseudo-cross-encoder via cosine with a good embedding model?
3. Confidence gate: one global τ, or one per-invariant-class τ?
4. How do we resolve block-merge conflicts when two traces distill to
   the same fingerprint but slightly different bodies? Vote by success
   rate? Keep both and let ranker choose?
5. Does self-verify in Stage 7 need a held-out task, or can it use a
   paraphrase of the source task? Paraphrase is cheaper; held-out is
   stricter.

These do not block Pillar 1; they influence Pillars 2 and 3.
