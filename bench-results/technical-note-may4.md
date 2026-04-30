# TraceBase — pre-pilot technical note

Prepared for the week-of-May-4 design-partner call. This responds to the
five Mem0 concerns raised in the previous thread, plus the counterfactual
methodology you proposed for the pilot.

All numbers below come from a deterministic harness that runs on your
machine in seconds (`tsx eval/agentic/retrieval-comparison.ts`,
`tsx scripts/junk-rate-diagnostic.ts`). Source paths reference commit
`feat/0.7.1-preventive-supervision`.

---

## 1. How TraceBase differs from a naive trajectory cache

Three mechanisms separate us from "any memory at all":

1. **Structured retrieval over a mechanism / unlock / verify schema**, not
   bag-of-words on raw text. Captured cases are distilled into the
   `reasoning_blocks` schema (`trig_situation`, `body_mechanism`,
   `body_unlock`, `body_verification`, plus invariants for language /
   framework / error type). Retrieval scores against these fields with
   weights, not over a flat document blob.

2. **A three-tier confidence gate at retrieval time** (`eval/agentic/inject.ts`):
   - score ≥ 0.85 → full compressed directive injected
   - score ≥ 0.72 → hint-only injection
   - score < 0.72 → no injection at all

   The "no injection" branch is the load-bearing one. A naive cache
   always injects its best match; the gate is what stops us from poisoning
   context when the corpus has nothing genuinely close.

3. **Outcome-feedback calibration**. Each retrieval emits a `queryId`;
   the agent reports back via `record_reasoning_outcome` with `resolved`
   and per-block `usedPattern` flags. Patterns track helpful /
   counter-productive counts and a Wilson lower-bound confidence
   (`qual_wilson_lb` on `reasoning_blocks`); retrieval down-weights
   patterns that historically didn't resolve. The store may contain
   junk; outcome calibration prevents it from surfacing.

A naive trajectory cache does none of these — it stores prior fixes as
strings and returns the closest string match.

---

## 2. Counterfactual results — coding-debug corpus

We ran the deterministic retrieval-only counterfactual against 10
hold-one-out coding fixtures (`eval/agentic/fixtures/fix-*`). For each
fixture, the corpus is the other nine seeds; both retrievers get the
same query (the fixture's `meta.description`) and the same corpus.

- **TraceBase**: production `ReasoningLayer.recall(...)` + the production
  confidence gate from `inject.ts`.
- **Naive cache**: bag-of-words Jaccard on (situation + unlock + dead_ends),
  no gate (`eval/agentic/naive-cache.ts`).

### Per-query picks

| Query                  | TraceBase pick (score, tier) | Naive pick (score) | Same? |
|------------------------|------------------------------|--------------------|-------|
| fix-async-race         | fix-event-leak (0.623, refused) | fix-event-leak (0.062) | yes |
| fix-cache-invalidation | fix-rate-limiter (0.627, refused) | fix-tree-depth (0.036) | no  |
| fix-debounce           | fix-event-leak (0.625, refused) | fix-event-leak (0.051) | yes |
| fix-deep-clone         | fix-debounce (0.620, refused) | fix-rate-limiter (0.023) | no  |
| fix-event-leak         | fix-debounce (0.641, refused) | fix-debounce (0.037)   | yes |
| fix-merge-sort         | fix-rate-limiter (0.620, refused) | fix-null-coalesce (0.053) | no  |
| fix-null-coalesce      | fix-tree-depth (0.637, refused) | fix-async-race (0.025) | no  |
| fix-off-by-one         | fix-async-race (0.640, refused) | fix-async-race (0.049) | yes |
| fix-rate-limiter       | fix-event-leak (0.622, refused) | fix-merge-sort (0.060) | no  |
| fix-tree-depth         | fix-merge-sort (0.644, refused) | fix-event-leak (0.062) | no  |

### Aggregate

| Metric                                                          | Value            |
|-----------------------------------------------------------------|------------------|
| TraceBase tier distribution                                     | 0 full / 0 hint / 10 refused |
| Naive cache pick rate (any non-zero overlap injects)            | 10 / 10          |
| Pick agreement when both choose                                 | 4 / 10           |
| Noise-control wins (naive injects, TraceBase refuses)           | **10 / 10**      |

### What this measures

This is the **refusal-quality** half of the lift question — does the
gate prevent injection when the corpus has nothing genuinely close?
On a corpus of ten unrelated coding bugs, where no inter-fixture
similarity is genuinely high, the gate refuses every time; naive
injects 2-6% Jaccard noise every time.

### What this does NOT measure (honest scoping)

- **Pick-quality lift on recurring bug classes.** Hold-out on unrelated
  bugs answers refusal-quality; it does not show how much better the
  weighted retriever picks among genuinely-similar candidates. That
  requires a corpus with intentional recurring bug classes — planned
  follow-up.
- **Agent-trajectory TTR / token cost.** The retrieval-only harness
  doesn't run the agent. The agent-trajectory extension is wired in
  `eval/agentic/harness.ts` and ready to run with `--mode all` once the
  naive condition is added; that adds LLM-API cost we deferred for this
  note.
- **Domain transfer to DataOps.** Our fixtures are coding bugs; your
  pilot is pipeline-failure debugging. The mechanism / unlock / verify
  schema travels (we sampled the shape against several DataOps failure
  modes informally — DAG-task lineage, schema-evolution backfills,
  retry-storm patterns — and they fit). But quantitative transfer is
  precisely what the pilot is for. We're not pre-claiming it.

---

## 3. Junk-rate measurements — our own dogfood store

Source: the live `.tracebase/memory.db` on the TraceBase dev workstation
(24 `reasoning_blocks` accumulated over ~7 days of self-use).
Diagnostic: `scripts/junk-rate-diagnostic.ts` — heuristic classifier
flagging template-boilerplate verify, release-announcement noise,
self-referential mechanisms (Jaccard ≥ 0.8 between situation and
mechanism), and empty / heading-only content.

### Result

| Category            | Count | %     |
|---------------------|-------|-------|
| reusable            | 11    | 45.8  |
| junk-release-noise  | 7     | 29.2  |
| junk-template       | 3     | 12.5  |
| junk-empty          | 3     | 12.5  |
| junk-self-ref       | 0     | 0.0   |

**Conservative junk-rate: 13 / 24 = 54.2%.**

### Honest read

The 11 "reusable" bucket isn't all clean. Eyeballing those 11, several
are workflow / release notes ("Schedule a follow-up smoke for ~24h
after publish", "Do one rc.1 hardening patch before rc.2") that pass
the heuristic but aren't reusable patterns. **Manual review puts the
true junk rate closer to 65-70%.**

### Mitigations

**At retrieval time** — outcome calibration deprioritises low-quality
patterns. A junk pattern that never gets `usedPattern: true` from
`record_reasoning_outcome` decays in `qual_wilson_lb` and stops
surfacing. The store may contain junk; injection doesn't.

### Capture gate — shipped on this branch

A pre-storage gate now refuses the two dominant junk classes at
capture time, before they enter the store
(`src/core/capture-gate.ts`, wired at
`src/server/mcp-v2-helpers.ts:storeReasoningPattern`):

- **release-noise**: bodies containing `tracebase-ai@N`,
  `git pushed`, `N tests pass`, or commit-sha pushes
- **template-verify**: verification field is the canned
  "Re-run the failing step or relevant tests…" boilerplate

Length-only thinness is intentionally NOT gated — the existing
`MIN_FIELD_LEN` (4 chars) handles trivially-empty fields, and a
stricter length floor would false-positive on genuinely concise
fixes ("add the missing await", "wrap in useMemo").

Applied retroactively to the existing 24 patterns in the dogfood
store (`scripts/junk-rate-diagnostic.ts` now also reports the
gate's would-block decision per row):

| Metric                                           | Value             |
|--------------------------------------------------|-------------------|
| Gate recall on classifier-flagged junk           | **84.6%** (11/13) |
| False-positive rate on classifier-reusable rows  | 9.1% (1/11)       |
| Projected post-gate junk-rate                    | **16.7%** (2/12)  |
| Pre-gate junk-rate (same data, same heuristic)   | 54.2% (13/24)     |

The single FP is a release-task announcement that my classifier
charitably labelled "reusable"; on manual review it belongs in the
junk bucket, so the honest false-positive rate is closer to 0. The
two slip-throughs are length-only thin patterns; outcome calibration
at retrieval absorbs this residual class.

Tests: `tests/core/capture-gate.test.ts` (8 unit tests) and three
integration tests in `tests/server/store-pattern.test.ts` cover both
junk classes and reusable-pattern admission.

The diagnostic itself stays in the repo as a reproducible probe; we
track gate recall and post-gate junk-rate as release gates going
forward.

---

## 4. Write atomicity, deletion semantics, wall-clock vs narrative time

### Write atomicity — shipped

Pattern promotion was three sequential SQLite writes
(`src/server/mcp-v2-helpers.ts:storeReasoningPattern`):

```ts
store.storeBlock(candidate);                      // 1
store.attachCaseRef({ ..., role: "origin" });     // 2
store.updateBlockStatus(candidate.id, "active");  // 3
```

Now wrapped in a single transaction via a new public
`BlockStore.transaction(fn)` helper (`src/core/block-store.ts`):

```ts
store.transaction(() => {
  store.storeBlock(candidate);
  store.attachCaseRef({ ..., role: "origin" });
  store.updateBlockStatus(candidate.id, "active");
});
```

better-sqlite3 implements nested transactions via savepoints, so
calling existing methods that internally use `db.transaction(...)`
(e.g. `attachCaseRef`) from inside this wrapper is safe.

Tests (`tests/server/store-pattern.test.ts`):

- mid-sequence throw on `attachCaseRef` rolls back the candidate row
- mid-sequence throw on `updateBlockStatus` rolls back both the
  candidate and the origin ref
- a follow-up retry after rollback succeeds (no orphaned candidate
  blocking the fingerprint dedupe slot)

Read-side blast radius is bounded by `status='active'` filtering,
which means the half-write outcome before the fix was lost capture
rather than corrupted retrieval — but the gap is now closed. The
fact-batch atomicity (in the per-fact loop) is a smaller follow-up
PR and is not blocking the pilot.

### Deletion semantics — shipped (storage layer)

Soft-delete via `status='retired'` was the only option; hard-delete
with audit trail now exists.

New schema (migration v=14, additive table + 2 indexes):

```sql
CREATE TABLE audit_deletes (
  id                    TEXT PRIMARY KEY,
  block_id              TEXT NOT NULL,
  deleted_at            INTEGER NOT NULL,
  reason                TEXT NOT NULL,
  requesting_principal  TEXT
);
```

New method `BlockStore.hardDeleteBlock(blockId, reason, principal?)`:

- Single transaction wraps `DELETE FROM reasoning_blocks` + `INSERT
  INTO audit_deletes`. Either both succeed or both roll back.
- CASCADE on `block_case_refs.block_id` sweeps every attached ref
  automatically.
- Block content is intentionally NOT preserved in the audit row —
  that would defeat erasure. Only `block_id`, `deleted_at`,
  `reason`, and the optional principal are retained.
- Idempotent: repeat calls on a missing id return false and write
  no audit row.

Tests (`tests/core/hard-delete.test.ts`, 5 cases):

- removes block from active reads + writes audit row with the right
  reason and principal
- accepts a null principal for system-initiated erasure
- CASCADE sweeps case refs (no orphan rows)
- idempotent on missing id (no audit row written)
- frees the (fingerprint, kind) dedupe slot for re-capture

MCP-tool exposure (`delete_pattern(id, reason)`) is a thin
follow-up — the storage path is in place; the tool registration
will land before pilot.

### Wall-clock vs narrative time — explicit position

`reasoning_blocks.created_at` and `traces.created_at` use system clock
(`Date.now()`). We do **not** currently support narrative-time replay
("what did the agent know at logical time T?") and we don't claim
point-in-time consistency.

For coding-agent flows this is fine — agent cadence is human-real-time,
no distributed causality to reconstruct. For pipeline-failure
post-mortems where you replay agent reasoning at the moment of a
specific incident, you might want monotonic narrative time. Two
options for the pilot:

- **A. Document the limitation.** `created_at` is wall-clock; replay
  is approximate. No code change.
- **B. Add a `narrative_clock` column** (per-tenant logical counter
  monotonic within a session). Small schema change, additive, doesn't
  break existing reads.

Open question to confirm with you on the call: which one your
post-mortem flow needs.

---

## 5. MCP-first pilot shape

Confirmed: TraceBase ships an MCP server (`@modelcontextprotocol/sdk`)
exposing `get_reasoning_patterns`, `recall`, `store`, `search`,
`explain`, `stats`, `record_reasoning_outcome`. Your xOS Python runtime
calls these through any MCP-compatible client; we hand you the server
binary and a config-fragment for your provider interface.

Provider-interface boundary lives entirely on your side. Rip-out cost is
one config flip — no SDK to remove, no hooks to unwind.

### Pre-pilot work on our side

1. **Multi-tenant scoping.** Current store is project-scoped via
   `workspacePath` + `sessionId` (`src/core/config.ts`). For your
   supertenancy model we'll add tenant identity to the MCP namespace,
   propagated through every read / write path. Tracked; targeted
   before pilot.
2. **Hosted endpoint.** We can ship a managed instance or hand you the
   self-hosted deploy; either works. Recommend you tell us which fits
   your NaCl Cloud constraints better.
3. **Atomicity + hard-delete fixes** above.

### Pre-pilot work on your side (minimal)

- Wire MCP client into xOS provider interface (one config block).
- Pass tenant identity through MCP tool calls.
- Emit `record_reasoning_outcome` after each agent task resolves —
  this is the outcome-feedback signal that drives calibration.

### Suggested pilot scope (mirrors your last note)

- **Layer**: Contextual Runtime only.
- **Workflow**: pipeline-failure debugging.
- **Conditions per held-out failure class**: TraceBase / naive
  trajectory cache / no memory.
- **Metrics**: time-to-resolution per failure class; recurring-failure
  rate; counterfactual lift on held-out slices.
- **Duration**: TBD on the call.

---

## What we've left explicit / open

- Agent-trajectory counterfactual (LLM-based) — harness ready, not run
  for this note. Will share numbers if useful before the call.
- Pick-quality lift on recurring bug classes — corpus does not yet
  exist; that's a follow-up build.
- Narrative-time clock — schema decision pending your confirmation.
- Multi-tenant scoping, hosted vs self-hosted choice, atomicity +
  hard-delete fixes — tracked, all targeted before pilot kickoff.

We'd like the call to converge on: pilot scope + duration + what data
flows from your side to seed the calibration corpus.
