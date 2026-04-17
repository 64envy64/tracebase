# TraceBase v2 — Research-Grade Memory Substrate

**Status:** design-first commit; implementation follows in phases.
**Scope:** full end-to-end architecture for production-grade reasoning
reuse. Not a patch to v1 — v2 treats v1 traces as one layer of a
six-layer substrate.

The fundamental claim of the product: **measurable win on repeated
engineering and operational tasks** — higher accuracy, less time,
fewer dead ends, lower spend. Token savings are a side effect, not
the pitch.

Prior benchmark work (Phase 1 retrieval analysis, Phase 2 ablation,
Phase 3 pilot) and the initial Pillar 1 schema work together showed
that a single "distilled block" layer is necessary but not sufficient:
blocks alone cannot answer *why* an injection helped, cannot survive
repo/codebase drift, and conflate procedural reuse (how to fix bugs
of class X) with project semantics (what the schema of table Y looks
like). v2 is the substrate those two kinds of memory live in, plus
the serving and lifecycle layers that keep them honest.

---

## Immovable principles

These are not up for debate inside v2 implementation. Any proposed
change that violates one of them is scoped as v3 and kept on the
shelf until v2 is measured.

1. **Blocks are never the single source of truth.** Every block links
   back to at least one source case (trace) via `BlockCaseRef`.
   Retrieval surfaces the evidence ref alongside the block so the
   agent or a human can audit it.
2. **Evidence is required.** A block may only reach `active` status
   after it has at least one linked case ref with `role = "origin"`
   and non-null `evidenceQuality`.
3. **Helpful ≠ retrieved, helpful ≠ injected.** The `helpful` signal
   is only set from observable agent behavior plus outcome: the agent
   must have used the block's reasoning AND the task must have
   resolved (or the measurable target metric must have improved).
   Retrieval alone never increments helpful. Injection alone never
   increments helpful.
4. **The v1 trace API stays non-breaking.** `ReasoningTrace` and all
   its SDK surfaces (`ReasoningLayer`, `TraceStore`, middleware
   wrappers) stay source-compatible for v2. New capability ships as
   additional tables and additional exports.
5. **Never claim benchmark wins from retrieved/injected rates alone.**
   Shadow control groups must exist before any external lift claim.

---

## Out of scope for v2

We will not build these until the substrate is proven by measurable
lift on a held-out evaluation:

- Dashboard UI (graphs, knowledge-graph view, drift alerts).
- Cloud / admin / tenant surfaces.
- Organization-level access control, team-scoped sharing.
- Marketing / pricing surfaces.

We will still *log the data* that those features need (e.g. events
are scoped per run / per deployment) so they can be built later with
no schema rewrite.

---

## The 6-layer substrate

```
┌─────────────────────────────────────────────────────────────────┐
│ L1. Episodic substrate — raw append-only trajectories            │
│     (ReasoningTrace; v1-compatible; keeps every case forever)    │
├─────────────────────────────────────────────────────────────────┤
│ L2. Procedural memory — distilled reasoning blocks               │
│     (ReasoningBlock; trigger + body; evidence required)          │
├─────────────────────────────────────────────────────────────────┤
│ L3. Block ↔ case linkage                                         │
│     (BlockCaseRef; every block points to its source cases)       │
├─────────────────────────────────────────────────────────────────┤
│ L4. Semantic / project memory                                    │
│     (ProjectFact; conventions, schemas, repo facts, preferences) │
├─────────────────────────────────────────────────────────────────┤
│ L5. Serving stack                                                │
│     hard-invariant prefilter → lexical → optional semantic       │
│     rerank → calibrated gate → injection as HYPOTHESIS           │
├─────────────────────────────────────────────────────────────────┤
│ L6. Analytics + lifecycle repair                                 │
│     event sink → aggregates → demote/merge/split/recalibrate     │
└─────────────────────────────────────────────────────────────────┘
```

Each layer has a single responsibility, a single storage surface,
and well-defined contracts with adjacent layers. Below, each layer
gets a section covering: purpose, schema, invariants, and the
contracts with other layers.

---

### L1. Episodic substrate — raw append-only trajectories

**Purpose.** Durable record of what happened. One row per task run.
Never rewritten. The ground truth for distillation, drift analysis,
and post-hoc evaluation.

**Storage.** Existing `traces` table (v1) — unchanged. The
`ReasoningTrace` type defined in `src/types.ts` is stable.

**Invariants.**
- Append-only. Updating a trace requires incrementing its
  `updatedAt` but never overwrites the original `problem` or the
  step list; corrections go into provenance/quality.
- Outcome (`solution.outcome`) is captured by whatever grader
  produced it; for agent evaluation that's the formal grader (e.g.
  SWE-bench `run_evaluation`), not self-report.
- No leakage constraints — traces can contain gold patch material,
  pytest IDs, etc. Leakage protection is the distiller's job (L2).

**Contracts.**
- L2 (distillation) reads traces to produce blocks. It never deletes
  or rewrites a trace.
- L3 (case refs) points at trace IDs. Delete of a trace cascades:
  any ref to it becomes `role = "orphan"`, the block is demoted
  until re-linked.
- L6 (analytics) reads trace metadata to attribute token/step
  savings to outcomes.

---

### L2. Procedural memory — distilled reasoning blocks

**Purpose.** The smallest recognizable, reusable pattern:
*"when situation X holds, mechanism Y explains it, avoid Z, unlock
with W, verify via V."* Not a summary of a trace; not a how-to
tutorial. A hypothesis the agent can test against the current task.

**Schema.** `ReasoningBlock` (already in `src/types.ts`, committed in
Pillar 1). The schema is intentionally preserved; v2 adds two new
lifecycle states:

- `"candidate"` — a distilled block that has not yet accumulated
  the minimum evidence (one `origin` case ref + passed leakage
  guards) to be served. Visible to audit, never retrieved.
- `"merged"` — a block that was superseded by merging into another
  block with the same trigger fingerprint. Kept for provenance
  continuity; never retrieved.

Final enum: `"candidate" | "active" | "demoted" | "merged" | "retired"`.

**Invariants.**
- `trigger` is what retrieval matches. `body` is never in the query
  path.
- A block may be `active` only if at least one `BlockCaseRef` with
  `role = "origin"` exists for it.
- Fingerprint dedupe is mandatory: two distilled blocks with the
  same trigger fingerprint must be reconciled before the second one
  is accepted (merge or reject).
- Anti-leakage regex guards (diff headers, patch hunks, pytest
  IDs, `/testbed/…` paths) run on every insert and every update
  that touches `body`. Any positive match hard-rejects the change.

**Contracts.**
- L3 (case refs) is *the* evidence surface for a block. A block
  with zero case refs is an integrity violation.
- L5 (serving) reads `status`, `quality.confidence`, `stats`, and
  trigger fields only.
- L6 (analytics) writes to `stats` and triggers status transitions
  (candidate → active, active → demoted, etc.).

---

### L3. Block ↔ case linkage

**Purpose.** Audit trail and evidence. Every block must be
traceable to one or more concrete task runs (L1 traces). Without
this, we cannot tell a distillation error from a misuse, and we
cannot safely demote a bad block.

**Schema (new — added to `src/types.ts`):**

```typescript
interface BlockCaseRef {
  id: string;
  blockId: string;
  traceId: string;                    // references ReasoningTrace.id

  /**
   * Why this case supports / contests the block.
   * - "origin"     — block was distilled from this case.
   * - "supporting" — case later confirmed the block's mechanism.
   * - "counter"    — case contradicted the block; used to demote.
   * - "orphan"     — referenced trace no longer exists; block is quarantined.
   */
  role: "origin" | "supporting" | "counter" | "orphan";

  /**
   * Distiller / verifier's confidence that this case actually
   * instantiates the block's trigger and mechanism.
   */
  evidenceQuality: "strong" | "moderate" | "weak";

  /**
   * Optional pointer into the trace for audit (e.g. message index
   * or file path in the trajectory where the unlock happened).
   */
  locator?: string;

  createdAt: number;
}
```

**Invariants.**
- Every `active` block has `role = "origin"` on at least one ref.
- A block with any `role = "counter"` ref cannot be `active` until
  the conflict is resolved (typically by split or demote).
- Ref insert with a missing `traceId` is rejected; ref deletion
  requires a reason (manual audit).

**Contracts.**
- L2 (block CRUD) cannot set a block to `active` without at least
  one origin ref. This is enforced at the storage layer, not the
  caller.
- L5 (serving) optionally returns a block's top 1-3 refs alongside
  the block so the agent / human can audit. The serving layer does
  not use refs for scoring.

---

### L4. Semantic / project memory

**Purpose.** Facts that are *not* reasoning patterns. Things like:
*"tenant_id is always the first column in migration files in this
repo"*, *"the team prefers bounded concurrency over worker pools"*,
*"the `users` table has a soft-delete column `deleted_at`"*. Stored
and retrieved separately from blocks because the retrieval
semantics and the lifecycle are different:

- Blocks are retrieved when a task *matches a pattern*. Facts are
  retrieved when a task *operates on a known entity*.
- Blocks' staleness is driven by whether the mechanism still holds.
  Facts' staleness is driven by whether the underlying artifact
  (schema, file, convention) has changed.

**Schema (new — added to `src/types.ts`):**

```typescript
interface ProjectFact {
  id: string;
  version: number;

  /**
   * Scope. How wide this fact applies. Used by retrieval to filter.
   * Dotted path; more specific scopes override less specific at
   * retrieval.
   */
  scope: string;            // e.g. "repo:myorg/app", "team:payments"

  factType:
    | "convention"          // "tests go in tests/, not __tests__/"
    | "schema"              // "users.email is UNIQUE NOT NULL"
    | "repo_fact"           // "build command is `pnpm build`"
    | "architecture"        // "auth lives in services/auth/, not middleware/"
    | "preference";         // "favor small PRs over big ones"

  statement: string;        // the fact itself, ≤ 60 words, declarative
  invariants: BlockInvariants;  // same structure as blocks for filtering

  source: {
    origin: "observed" | "declared" | "imported";
    traceId?: string;       // if observed from a trace
    author?: string;        // if declared by a user
    reference?: string;     // e.g. file path or commit sha
  };

  confidence: number;       // 0..1
  lastVerifiedAt: number;   // when this fact was last confirmed still true

  createdAt: number;
  updatedAt: number;
  status: "active" | "stale" | "retired";
}
```

**Invariants.**
- Facts are keyed (for dedupe) by a hash over `scope + factType +
  normalized(statement)`. Two facts with the same key are merged;
  their sources union.
- `stale` is a soft state: fact is not retrieved by default but
  remains visible to background verification, which can restore it
  to `active`.
- Never contains diffs, patches, or pytest IDs. Anti-leakage regex
  guards apply, same as blocks.

**Contracts.**
- L5 (serving) queries facts by scope + invariants in parallel to
  blocks. Facts and blocks are returned in separate slots in the
  recall result; the caller composes them for injection.
- L6 (analytics + lifecycle) writes `lastVerifiedAt` and may flip
  `active ↔ stale` based on observed behavior.

---

### L5. Serving stack

**Purpose.** Turn a fresh task query into a calibrated, auditable
set of candidates — blocks and facts — to inject as a *hypothesis*
for the agent. Never as a command.

**Pipeline.**

```
query + invariants
  │
  ├─► hard-invariant prefilter (L2 blocks AND L4 facts)
  │      query-invariants (lang, framework, errorType, apiSurface,
  │      scope for facts) intersected with block/fact invariants.
  │      If a block sets `language=python` and the query is typescript,
  │      that block is eliminated before scoring.
  │
  ▼
lexical ranker  (BM25 over trigger.situation + trigger.keywords for
                 blocks; statement + keywords for facts)
  │
  ▼
  optional: semantic reranker
      (cross-encoder OR cosine over embeddings, plug-in slot)
  │
  ▼
calibrated confidence gate
      (isotonic regression fitted offline from L6 events;
       threshold τ is a per-deployment operating point, not baked)
  │
  ▼
injection as HYPOTHESIS
      (framed "a prior case suggests …, you can verify via …" —
       not "do this")
```

**Non-negotiable behaviors.**

- The hard-invariant prefilter is applied **before** BM25, not as a
  weighted signal. Phase 1 showed that weighted structural signals
  inflate scores for same-framework unrelated tasks; we don't allow
  that in v2 at any point.
- The gate slot must exist from day one, with a **pass-through
  calibrator** (identity). Nothing else changes when the isotonic
  calibrator ships in Phase 5; it drops into the same slot with no
  schema change.
- Retrieval returns blocks **with their top case refs attached** so
  the agent / a human can audit.
- Injection framing is declarative-hypothesis, not imperative. The
  agent is told what mechanism *might* apply and how to verify it.
- **Gate / payload one-to-one rule.** Every block or fact rendered
  into the injection prompt MUST have a matching `injection` /
  `fact_injection` event, and vice versa. Hits below the gate
  threshold (or every hit under a shadow query) stay in the recall
  result for debugging but never reach the prompt. Without this
  rule, analytics under-count prompt content and lift claims are
  unprovable. Concretely: the server stamps `passesGate` on each
  hit; the formatter renders exactly those hits; event emission
  fires for exactly those hits.

**Contracts.**
- L2 and L4 are read-only from serving's POV. The only writes
  serving does are to L6 (emit retrieval + injection events).
- L6 (analytics) is the sole consumer of serving events and the
  sole producer of calibration models.

---

### L6. Analytics + lifecycle repair

**Purpose.** Measure reuse, measure helpfulness, and keep the
block library healthy (demote bad blocks, merge duplicates, split
over-broad ones, refresh stale project facts, recalibrate gates).

**Storage.**
- Append-only JSONL event log at `<config-dir>/events.jsonl`.
  One event per line, schema is the `AnalyticsEvent` union already
  in `src/types.ts`.
- SQL views materialized nightly (or on-demand) for aggregates.

**Events.** (Already defined in types; kept here for reference.)

| Event              | Fires when                                                     |
|--------------------|----------------------------------------------------------------|
| retrieval          | a query returns ranked block + fact candidate lists            |
| injection          | a **block** passed the gate and was injected                   |
| fact_injection     | a **fact** passed the gate and was injected                    |
| agent_used         | observable signal agent followed an injected **block**         |
| fact_agent_used    | observable signal agent followed an injected **fact**          |
| outcome            | outcome is known (resolved / regressed / tokens)               |

Blocks and facts attribute independently: a single query may have
any combination of block/fact injections, and their helpfulness
tallies do not mix.

**Helpfulness definition (binding).**
For each `entity ∈ {block, fact}`, the entity is credited `helpful`
only if **all three** hold:

1. An `injection` or `fact_injection` event fired for that entity on
   that query.
2. The matching `agent_used` / `fact_agent_used` event fired for
   that entity on that query (observed via structural or semantic
   match against the agent's output).
3. `outcome.resolved = true` (or the measurable metric improved,
   for non-binary tasks).

If `(1) ∧ (2) ∧ ¬ outcome.resolved`, the entity is credited
`counterproductive`.

If `(1) ∧ ¬ (2)`, the entity is *neutral*: retrieved but ignored,
not scored either way.

Retrievals without injection (shadow group) are **control data**
and never count toward helpfulness for the candidate entity; they
are the reference distribution for outcome lift.

**Lifecycle repair actions.**

| Action        | Trigger                                                | Effect                      |
|---------------|--------------------------------------------------------|-----------------------------|
| promote       | candidate with ≥ 1 origin ref and passes guards        | status: candidate → active  |
| demote        | Wilson_lb(helpful, injected) ≤ τ_demote                | status: active → demoted    |
| merge         | duplicate trigger fingerprint                          | keep winner, loser → merged |
| split         | block has high retrieval but low `agent_used` rate     | flag for distiller rerun    |
| stale         | fact `lastVerifiedAt` older than scope-dependent TTL   | status: active → stale      |
| reverify      | background check resolves stale fact as still true     | status: stale → active      |
| recalibrate   | ≥ 200 new outcome events since last fit               | refit isotonic calibrator   |

All transitions are event-driven, not time-driven. The repair loop
reads from the event log, never from live traffic.

---

## Cross-cutting data flows

### Trace → Block (distillation, L1 → L2+L3)

1. Trace enters L1 with `outcome = success` (grader-verified).
2. Distiller runs on its trajectory, produces a candidate block.
3. Candidate passes leakage guards; fingerprint computed.
4. Dedupe: if fingerprint collides, merge stats + refs; else insert
   as `candidate`.
5. Case ref inserted with `role = "origin"`, `evidenceQuality`
   assigned by distiller's own confidence.
6. Block promoted `candidate → active` at end of step 5.

### Query → Injection → Outcome (L5 → L6)

1. `retrieval` event emitted with full candidate list.
2. If gate passes, `injection` event emitted.
3. After agent runs, `agent_used` is emitted iff observable match.
4. When outcome is known, `outcome` event emitted with
   `resolved` + cost metrics + `control` flag.
5. Aggregation job consumes the event tuple and updates the block's
   `stats`; `quality.wilsonLowerBound` is refreshed; lifecycle
   check may fire a transition.

### Fact freshness (L4 ↔ L6)

- On every query that *touches* a fact's scope, if the fact was
  actually injected and the outcome was `resolved`, bump
  `lastVerifiedAt`.
- Scope-dependent TTL determines when `active → stale`. Schema
  facts are shorter-lived than preference facts.

---

## Order of implementation (phases)

### Phase 0 — Design commit. (this document.)

### Phase 1 — Storage foundation.
Types and tables only. No retrieval behavior changes.

- `src/types.ts`: add `BlockCaseRef`, `ProjectFact`; extend
  `ReasoningBlock.status` to the 5-state enum.
- SQLite tables: `reasoning_blocks`, `block_case_refs`,
  `project_facts`, `analytics_events`.
- Operations:
  - Block CRUD (create/get/list/update_status).
  - Case ref attach/list/detach; cascade to `orphan` on trace
    delete.
  - Project fact CRUD + scope/invariants search.
  - Append-only event writer + reader.
  - Dedupe primitive: `mergeByTriggerFingerprint(block)`.
- Migration path: additive. All v1 tables unchanged.
- Tests: unit coverage for each storage operation + invariant
  enforcement (no `active` block without origin ref, leakage
  guard, fingerprint dedupe).

### Phase 2 — Serving base.
Retrieval reads L2 + L3 + L4; hard invariant prefilter + BM25 over
trigger-only (or statement-only) fields; gate slot is pass-through
identity.

- New API: `recallV2(query) → { blocks: BlockHit[], facts: FactHit[] }`.
- Each `BlockHit` carries top 1-3 case refs for audit.
- Injection helper: formats hypothesis framing (no imperative).
- Old `recall()` stays as v1 behavior.
- Tests: prefilter correctness, trigger-only scoring (body fields
  never contribute), deterministic ranking.

### Phase 3 — Analytics event sink.
Append-only JSONL writer + basic aggregation.

- Serving layer emits `retrieval` + `injection` events.
- Middleware adapters emit `agent_used` + `outcome` events.
- Events reference `traceId`, `runId`, `blockId`, optional
  `caseRefId`, `factId`.
- Shadow-group flag on every `retrieval` event.
- Tests: event schema validation, round-trip, control-group
  accounting, no PII in default events.

### Phase 4 — Distillation pipeline.
Trace → candidate block → leakage check → dedupe → origin ref →
promote to active. Offline runnable against existing trace store.

### Phase 5 — Lifecycle repair loop.
Consume the event log; run the repair action table above.
Isotonic calibrator fits here and is swapped into L5's gate slot.

### Phase 6 — Evaluation harness.
Re-run SWE-bench Verified (easy subset) against the full stack
with shadow mode enabled. First defensible external metric.

---

## Definition of done for the next milestone (Phase 1 + early Phase 2)

All the following must be true before we call the next milestone
complete:

- Block CRUD with all 5 lifecycle states.
- BlockCaseRef attach / list / detach; `active` blocks cannot exist
  without an origin ref (enforced).
- ProjectFact stored in a separate table with scope + invariants
  search.
- Retrieval returns candidates filtered by hard invariants,
  ranked by trigger-only BM25, with case refs attached.
- Retrieval and injection events emitted to `events.jsonl`.
- Gate slot is present and pluggable. A calibrator can be dropped
  in without changing any other schema.
- v1 trace API (`ReasoningLayer`, `TraceStore`, middleware) is
  source-compatible and all 134 existing tests pass.

Only after all six bullets hold do we move to Phase 3's full event
wiring and Phase 4's distiller.

---

## What this design explicitly does NOT do

- **No hand-crafted oracle patterns** in product code. Oracles live
  strictly in `eval/` as internal diagnostics.
- **No whole-trace injection** as a supported path. The legacy
  `trace.solution.summary` injection stays only for v1
  back-compat; v2 eval excludes it from lift measurement.
- **No benchmark claim** from data collected before Phase 5 shadow
  calibration is wired up. Without control outcomes, lift is not
  identifiable.
- **No single-source-of-truth block.** Blocks without case refs do
  not become active. Period.
- **No dashboard, no admin UI, no org controls** in v2. We log the
  data they need; we build them only after the substrate earns it.

---

## Open questions (to answer during implementation, not blocking)

1. Distillation model: Sonnet 4.6, Haiku, or a self-hosted smaller
   model? Cost vs. leakage discipline trade-off.
2. Semantic reranker: hosted cross-encoder, local ONNX, or pseudo
   cross-encoder via embedding cosine?
3. One global gate threshold τ or one per invariant class
   (language × framework × errorType)?
4. Merge conflict policy for same-fingerprint, different-body
   blocks: vote by success rate, keep both as siblings with
   ranker choice, or hand off to the distiller for reconciliation?
5. Verifier design for project facts: schema facts verify by
   re-reading the schema; architecture facts verify by grep over
   file tree; preference facts verify by asking the author.
6. Event-log retention: rotate nightly? keep 90 days? compact into
   parquet?

These do not block Phase 1 or Phase 2.
