# TraceBase forward plan - Reasoning Memory Router V2

> Status: architecture direction approved for planning.
>
> Review date: 2026-06-01.
>
> This is the forward-looking roadmap. Historical release plans remain in
> `docs/PLAN-0.5.md` and `docs/PLAN-0.5.4.md`.

## 1. Product goal

TraceBase is a local-first runtime memory layer for agents. It captures
privacy-scanned, reusable lessons from completed work and injects a lesson only
when the evidence says it is likely to help the current task.

The next product step is not another hand-tuned lexical threshold. Build a
**Reasoning Memory Router V2**:

```text
capture -> distill -> validate -> consolidate
        -> hybrid retrieve -> family aggregate -> memory-aware rerank
        -> calibrated selective policy -> inject | abstain
        -> outcome attribution -> calibration
```

The router must remain runtime-first, model-agnostic, local-first, bounded,
privacy-preserving, and fail-open.

## 2. Why V2 is needed

The current serving-confidence layer is a good conservative baseline:

- retrieval ranking and serving confidence are separated;
- weak, generic, ambiguous, and below-threshold matches abstain;
- telemetry and feature-versioned calibration exist;
- the async cascade already supports bounded reranking, fallback, rollout, and
  MMR.

The remaining limitation is representation quality:

- confidence is still based on flat lexical overlap over `situation + keywords`;
- fixed scalar weights and a scalar top-vs-second margin cannot express causal
  applicability;
- the margin compares individual blocks rather than families of equivalent
  reasoning;
- the default local reranker is a generic document relevance model;
- the dogfood family fingerprint is intentionally conservative observability,
  not a production clustering contract.

## 3. Non-negotiable invariants

### 3.1 Runtime boundary

- Core serving is generic. GitHub, PR, issue tracker, and CI integrations remain
  optional adapters.
- Customer-side serving remains model-agnostic.
- Network-backed semantic retrieval and reranking are optional providers, never
  a mandatory hot-path dependency.
- Every expensive stage has a deadline, a cache, and a fail-open abstention path.

### 3.2 Privacy

- Never persist or sync raw prompts, transcripts, chain-of-thought, code,
  absolute paths, tool inputs, or tool outputs.
- Every distilled memory and every reranker payload passes the existing leakage
  and injection guards.
- Cloud sync remains aggregate-only unless a future enterprise feature adds an
  explicit, separately-reviewed encrypted content boundary.

### 3.3 Evidence quality

- Precision-first: abstain is the default when evidence is weak or ambiguous.
- Never lower a gate to make a benchmark fire.
- Never count authored bootstrap data as organic readiness evidence.
- Every serving-policy change is versioned, replayable, and evaluated on frozen
  holdouts before rollout.

## 4. Target architecture

### 4.1 Structured reasoning memory

Store a compact, transferable lesson rather than a raw trace:

```ts
interface ReasoningMemoryV2 {
  problemSignature: string;
  applicability: string[];
  mechanism: string;
  unlock: string;
  deadEnds: string[];
  verification: string;
  invariants: string[];
  apiSurface?: string[];
  errorTypes?: string[];
  provenance: MemoryProvenance;
  outcomes: MemoryOutcomeSummary;
}
```

Distill both successful and failed work. Consolidation refines a lesson as new
cases arrive instead of storing an unbounded pile of near-duplicates.

### 4.2 Two-view runtime query compiler

Derive two bounded retrieval views from the current problem:

1. **Literal view** - error type, APIs, symbols, paths, framework, and explicit
   invariants.
2. **Causal view** - a short retrieval intent describing the likely mechanism
   and desired invariant.

The literal view is always available. The causal view is optional and runs only
when the fast path is insufficient. Do not store chain-of-thought.

### 4.3 Hybrid candidate generation

Generate a candidate union instead of trusting one score:

1. exact fingerprint and invariant match;
2. FTS5/BM25 sparse retrieval;
3. dense semantic retrieval over privacy-scanned structured fields;
4. optional learned sparse or late-interaction retrieval for larger corpora.

Keep provider interfaces model-agnostic. Use frozen offline evaluation to pick a
default provider; do not hardcode a benchmark winner into the domain model.

### 4.4 Reasoning-family aggregation

Introduce a production `ReasoningFamily` layer:

```ts
interface ReasoningFamily {
  id: string;
  prototype: ReasoningMemoryV2;
  supportingCaseIds: string[];
  pitfallCaseIds: string[];
  sourceDiversity: number;
  helpfulOutcomes: number;
  harmfulOutcomes: number;
  unresolvedOutcomes: number;
}
```

Aggregate candidates into families before serving. Compare the best family with
the runner-up family, not two nearly-identical blocks. Duplicate captures must
not manufacture confidence. Independent supporting cases may raise confidence;
contradictions and harmful outcomes must reduce it.

The existing top-salient-token fingerprint remains a dogfood monitor until the
production family contract is explicitly implemented and evaluated.

### 4.5 Memory-aware reranker

Replace generic document relevance with applicability scoring:

```text
query views + structured family prototype
  -> applicable | uncertain | inapplicable
  -> calibrated helpfulness score
```

The reranker may read privacy-scanned structured body fields only after bounded
candidate generation. Candidate generation must never depend on full bodies.

Implement the reranker as a provider interface. Evaluate a small local baseline,
a modern general reranker, and a memory-specific reranker. Keep the best proven
default; retain deterministic lexical abstention as fallback.

### 4.6 ServingEvidenceV2 and selective policy

Upgrade the feature vector:

- exact fingerprint and invariant matches;
- sparse rank and lexical rarity;
- dense similarity;
- late-interaction score when available;
- reranker score and logit gap;
- family-level support and source diversity;
- contradiction and harmful-outcome counts;
- applicability matches;
- freshness and calibrator coverage;
- provider latency and fallback state.

Calibrate `P(helpful)` from outcomes. Move from a hand-tuned fixed margin toward
risk-controlled selective serving: inject only when the estimated risk stays
within the configured precision target; otherwise abstain.

### 4.7 Outcome attribution and learning

- Preserve deterministic holdouts and shadow routing.
- Attribute test success, command success, follow-through, and counterproductive
  outcomes.
- Refit calibration only on sufficient feature-version-matched evidence.
- Use off-policy replay before changing rollout percentages.
- Do not introduce online exploration that can surprise customers without an
  explicit opt-in.

## 5. Runtime budget

| Stage | Target behavior |
|---|---|
| exact + sparse fast path | local, synchronous, bounded |
| dense retrieval | cached, optional provider, bounded |
| family aggregation | local and deterministic |
| memory reranker | async top-N only, strict timeout |
| expensive judge | ambiguous-band only, opt-in provider |
| any failure | abstain or fall back; never block customer work |

MMR remains useful for a multi-memory payload. It is not a substitute for
family-level disambiguation when deciding whether one lesson should be served.

## 6. Delivery sequence

### Phase A - Representation contract

- Add `ServingEvidenceV2`.
- Define `ReasoningMemoryV2`, `ReasoningFamily`, and provider-neutral candidate
  types.
- Thread structured, privacy-scanned reranker payloads through the existing
  cascade.
- Extend telemetry and replay fixtures.

**Exit gate:** deterministic tests, migrations, lint, and replay parity green.

### Phase B - Family consolidation

- Build family assignment, prototype consolidation, contradiction tracking, and
  family-level outcome summaries.
- Keep dogfood observability separate from the production family contract.
- Add adversarial sibling-family fixtures.

**Exit gate:** duplicates cannot inflate confidence; contradictory evidence
reduces confidence; family margin is explainable.

### Phase C - Hybrid retrieval providers

- Wire existing embedding storage into the V2 serving path.
- Add provider adapters for local and optional hosted retrieval.
- Add dense+sparse union and bounded late interaction where it proves useful.
- Ensure SDK runtime parity, including cascade configuration in the contextual
  provider path.

**Exit gate:** frozen offline eval improves useful recall without precision,
privacy, or latency regressions.

### Phase D - Memory-aware reranking

- Replace the generic MiniLM default experiment with a provider-neutral
  memory-applicability contract.
- Evaluate a modern small reranker and a memory-specialized reranker.
- Add hard negatives: lexical sibling, causal mismatch, misleading API overlap,
  dialogue ambiguity, and stale lesson.

**Exit gate:** precision@fire, Wilson lower bound, and latency budget beat the
current baseline on frozen holdouts.

### Phase E - Risk-controlled selective serving

- Fit feature-versioned calibration on organic and disclosed bootstrap evidence
  separately.
- Produce coverage-risk curves.
- Introduce a risk-controlled policy with conservative defaults and explicit
  fallback.
- Shadow-roll out before serving by default.

**Exit gate:** organic dogfood meets the locked precision target; bootstrap
evidence is reported separately and never upgrades readiness alone.

### Phase F - Evidence ladder

1. deterministic unit and migration tests;
2. frozen `$0` offline recurring-family holdouts;
3. hard-negative and sensitivity study;
4. shadow dogfood;
5. small paid attribution confirmation;
6. broader agent benchmark only if the preceding gates pass.

## 7. What not to do

- Do not tune `marginThreshold` until a small authored fixture looks good.
- Do not make embeddings the only retrieval path.
- Do not treat random distinct bug fixes as a reuse corpus.
- Do not invoke an LLM judge for every prompt.
- Do not turn GitHub ingestion into a core runtime dependency.
- Do not make the current monitoring fingerprint the production family model.
- Do not claim lift from fire-rate alone; outcomes and holdouts remain required.

## 8. Current decision

The existing runtime foundation is worth keeping. Implement V2 as an additive
upgrade inside the current contracts:

- preserve local-first SQLite + FTS5;
- preserve fail-open serving and privacy guards;
- reuse embedding persistence, async cascade, rollout, telemetry, and
  calibration infrastructure;
- replace weak representation and block-level ambiguity handling with
  structured, family-aware, risk-controlled serving.

## 9. Research basis

Primary references informing this direction:

- ReasoningBank: https://arxiv.org/abs/2509.25140
- Google Research ReasoningBank overview:
  https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/
- BRIGHT reasoning-intensive retrieval benchmark:
  https://arxiv.org/abs/2407.12883
- ReasonIR reasoning retriever training:
  https://arxiv.org/abs/2504.20595
- MemReranker agent-memory reranking:
  https://arxiv.org/abs/2605.06132
- Qwen3 Embedding and reranking:
  https://arxiv.org/abs/2506.05176
- BGE-M3 dense, sparse, and multi-vector retrieval:
  https://arxiv.org/abs/2402.03216
- ColBERTv2 late interaction:
  https://arxiv.org/abs/2112.01488
- PLAID efficient late interaction:
  https://arxiv.org/abs/2205.09707
- SCoRE selective conformal risk control:
  https://arxiv.org/abs/2603.24704

