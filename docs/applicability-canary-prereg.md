# Pre-registration — applicability canary (apply-only)

> Status: **FROZEN pre-registration. NOT RUN.** This document fixes the analysis
> plan *before* any live exposure, so the readout cannot be reverse-justified.
> Phase D.4 ships the rail (default-off); activation is a separate, explicitly
> reviewed decision gated on everything below.

## 1. Hypothesis
The Phase C.3 V4 decision abstains on a class of strong, prose-only applicable
lessons (the D.1/D.2 residual). The D.2 reranker rules them `applicable`, but its
recall recovery is **counterfactual** in shadow (`reranker_only_apply` is never
served — see `docs`/Phase D.3 ledger). The canary's only job is to make that one
quantity **observable**: *does serving the reranker-selected block, when V4
abstained, produce a helpful outcome at acceptable precision?*

**Apply-only.** The canary serves the reranker's `applicable` block when V4
abstains. It does **not** enable reranker *withholds* (those are already
observable in shadow — D.3). One causal question, one rail.

## 2. Unit, assignment, arms
- **Unit:** the problem fingerprint (same shape → same arm), salted per project.
- **Assignment:** deterministic (`assignCanary`); propensity logged on every
  exposure for off-policy correction.
- **Arms:** `treatment` injects the reranker block (+ a real `injection` event so
  the outcome attributes); `control` preserves the baseline abstain.
- **Eligibility (all must hold):** baseline V4 abstained · reranker verdict
  `applicable` · a block id present · no reranker fallback · current feature
  version · not in the global holdout · `TRACEBASE_REASONING_APPLICABILITY=shadow`.

## 3. Caps and minimums (frozen)
| Parameter | Value | Rationale |
|---|---|---|
| Max treatment rate | **5%** of eligible distinct problems | bounded blast radius |
| Min exposed (treatment) outcomes | **100** with attribution ≥ `moderate` | enough to bound precision |
| Min control outcomes | **100** | baseline rate for the lift |
| Min organic fraction | **100%** of analysed trials | bootstrap/synthetic NEVER count (ledger `corpus`) |
| Max run duration | **14 days** or the minimums, whichever first | avoid drift |
| Analysis feature version | exactly the enabled `policyVersion` | stale rows excluded by replay |

## 4. Primary + secondary metrics (from the D.3 ledger/replay, organic only)
- **Primary:** `precision@observed-fire` of the treatment arm (helpful ÷ served),
  with its **Wilson lower bound**. Ship-readiness target declared a priori:
  **Wilson LB ≥ 0.90**.
- **Secondary:** treatment resolved-rate vs control resolved-rate (the lift);
  latency p50/p95; redaction/diagnostic counts.
- **No causal claim** is made from any `counterfactual_unobserved` or `incomplete`
  row. Only `observed_exposed` treatment rows score apply-correctness.

## 5. Attribution quality gates (halt if violated)
- `crossRun` or `ambiguous` diagnostics **> 1%** of trials → **HALT** (attribution
  plumbing is untrustworthy; fix before trusting any metric).
- `agent_used` evidence strength `weak` only, for a treatment row → does **not**
  count toward helpful (canonical loop).
- Inferred-vs-explicit: report `precision@observed-fire` for explicit-attribution
  rows separately; the ship gate uses the explicit subset if it reaches the
  minimum, else the run is inconclusive (not a pass).

## 6. Privacy halt
- Any exposure event or trial found to carry raw prompt/body/path/token text →
  **immediate HALT + purge**. (The event schema forbids it and the cloud
  allowlist strips the stream whole; this is a belt-and-suspenders trip-wire.)
- The salt and fingerprints never leave the machine; only opaque `unitHash`/
  `blockId` and the `queryHash` are recorded.

## 7. Kill conditions (any one → `tracebase canary disable`)
1. Treatment `precision@observed-fire` point estimate **< 0.70** after the first
   30 served outcomes (early-stop for harm).
2. Any `regressed` (harmful) treatment outcome rate **> 5%**.
3. Attribution-quality halt (§5) or privacy halt (§6).
4. p95 serving latency regression **> 50 ms** attributable to the rail.
5. Operator judgement / incident — no threshold required.

## 8. Rollback steps (crash-safe, ordered)
1. `tracebase canary disable` (preserves salt; serving reverts to baseline
   abstain immediately — disabled is byte-identical).
2. Or, without CLI access: set `TRACEBASE_APPLICABILITY_CANARY=off` (env kill
   switch; the env can only ever disable).
3. Or global: `TRACEBASE_DISABLED=1`.
4. The persisted config can be hand-edited to `enabled:false`; malformed config
   also collapses to off.
5. No data deletion is required to stop exposure; analysis proceeds on the rows
   already collected (replay excludes nothing retroactively except by version).

## 9. Decision rule (pre-committed)
- **SHIP-candidate** (toward a Phase-E risk-controlled `on`) iff: minimums met ·
  attribution gates clean · treatment Wilson LB ≥ 0.90 · no kill condition fired ·
  the lift vs control is non-negative.
- **INCONCLUSIVE** iff minimums unmet or attribution inconclusive → extend or stop;
  no claim.
- **REJECT** iff Wilson LB < 0.90 or any harm signal → the apply policy does not
  ship; revisit the reranker (e.g. the semantic provider) before re-pre-registering.

## 10. What this pre-reg does NOT authorize
- It does not authorize *running* the canary — that is a separate reviewed step.
- It does not authorize reranker *withholds*, a higher rate, non-organic readiness
  claims, a semantic-model adapter, or any cloud transmission of the local stream.
