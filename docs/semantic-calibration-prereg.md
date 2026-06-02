# Semantic reranker calibration — FROZEN pre-registration (E.2.3)

**Status:** frozen protocol with an auditable runner. Nothing is promoted by this
document. It defines, *before any results are seen*, the dataset protocol, metrics,
gate, and stop conditions for deciding whether the semantic reranker may graduate
from shadow to apply. The machine-checkable form is
[`manifest.ts`](../src/experiments/semantic-bakeoff/calibration/manifest.ts);
a calibration run must emit a `CalibrationManifest` that `validateCalibrationManifest`
accepts and that commits to this doc's hash (`preregHashOf`). The runner is
[`runner.ts`](../src/experiments/semantic-bakeoff/calibration/runner.ts); its `$0`
plumbing proof is `npx tsx scripts/semantic-bakeoff/run-calibration-smoke.ts`.

This pre-registration exists so the eventual promotion decision cannot be rationalised
after the fact. Edit it only *before* a run; an edit changes its hash and invalidates
any manifest pinned to the old hash.

## 1. Objective

Estimate, on held-out data, the precision of the semantic reranker's `applicable`
verdict at a candidate confidence threshold, and decide promotion strictly by the
pre-registered gate. The serving question is narrow: *when the deterministic V4
baseline abstains, does the semantic verdict apply the right block often enough,
and rarely enough wrongly, to be worth serving?*

## 2. Dataset protocol (the hard rules)

1. **The 18 adversarial viability fixtures are OFF-LIMITS for fitting.** They are a
   regression/viability set (does the model run, does it not crash on near-misses).
   Fitting thresholds on them overfits the known cases and tells us nothing about
   generalisation. `split.usesAdversarialFixturesForFitting` **must be false**; they
   may only be used as a *non-fitting* regression check reported alongside.
2. **Family-grouped split.** Examples are grouped by family key (the same structured
   signature grouping used in serving). Train and validation are split *by family*,
   never by example.
3. **Leakage-safe holdout.** No family key may appear in both train and validation.
   A shared family lets the model memorise a family in train and inflate validation
   precision. The validator rejects any train/val family overlap.
4. **Hard negatives required.** Validation must contain ≥ `MIN_HARD_NEGATIVES` (20)
   *near-miss* candidates — superficially similar but genuinely inapplicable — so
   precision is measured against the cases that actually matter, not easy negatives.
5. **Deterministic split.** A recorded `splitSeed` plus `trainRatio` makes the
   family assignment reproducible.
6. **Content-addressed rows.** The manifest embeds frozen rows and hashes the
   complete registry, provenance and row-level split assignment. The validator
   recomputes all three hashes and every reported metric. Declared counts alone
   are never trusted.
7. **Pinned execution identity.** Every scored run records runner version,
   algorithm version, git SHA, threshold grid, TRAIN precision floor, chosen threshold and a
   privacy-safe hash of model/revision/backend/featureVersion attestation.

## 3. Metrics (reported post-run in `CalibrationMetrics`)

- **Precision (primary):** TP / (TP + FP) on validation, where a positive is an
  `applicable` verdict and a false positive is a *harmful apply* (applied where the
  block was not actually applicable).
- **Wilson 95% lower bound on precision** (`wilsonLowerBound`) — the gate uses the
  LOWER bound, not the point estimate, so a small validation set cannot fake a pass.
- **Harmful-apply rate** on validation.
- **Cache + warm metrics:** cache hit-rate, warm completion rate, warm P95 latency.
  The overlay's entire value proposition is network-free cache hits on the served
  path; a low hit-rate or a slow warm makes it not worth the capacity.
- **Shadow agreement rate:** fraction of `reasoning.semantic_comparison` events where
  the semantic verdict agreed with the V4 baseline decision.

## 4. Promotion gate (`PromotionGate`, frozen)

Promote **only if** the Wilson-LB precision on the leakage-safe validation set is
≥ `minWilsonLbPrecision`. The point estimate is never sufficient.

## 5. Explicit STOP conditions (any one blocks promotion → `reject`)

- Validation `n` < `minValidationN` (thin val set → no promotion).
- Harmful-apply rate > `maxHarmfulApplyRate`.
- Cache hit-rate < `minCacheHitRate`.
- Warm P95 latency > `maxWarmLatencyP95Ms`.
- Any of the 18 viability-only adversarial fixtures fires.

If the gate is not met but no stop condition trips, the decision is **hold** (collect
more validation or improve the model), never a soft promote.

## 6. What this protocol deliberately does NOT do

- It does not turn fixture smoke data into evidence: `fixture-smoke` registries
  always return `hold`, even when their plumbing run is perfect.
- It does not quietly mutate thresholds after validation is observed: the grid is
  frozen and the selected threshold is fit on TRAIN rows only.
- Promotion remains a separate, explicit, reviewed step gated on a passing manifest —
  outside this document.
