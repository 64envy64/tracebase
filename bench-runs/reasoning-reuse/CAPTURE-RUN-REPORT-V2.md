# Phase 5 Capture Run — FINAL REPORT (v2, post-fix)

**Verdict: NOT READY.** Capture is now proven and meets its target; **precision-ready
has no credible path to ≥30** on this leakage-clean distinct-bug corpus. Halted at
the 10+10 checkpoint per the operator protocol. Total spend $4.38 of $30.

## The capture-path fix worked (the v1 blocker is resolved)
v1 captured 0/10 (harness abs-path contamination + markdown-unaware extractor).
After the generic extractor hardening + problem-first prompt:
- **v2 capture: 9/10 captured (90% yield) → projected 50/56 — MEETS ≥50.** ✓

## Numbered report
| # | item | value |
|---|---|---|
| 1 | commits (local, not pushed) | a09cb06, f211a30, bb8ba0a, 1f21a5c, b260224, ddd8563 (product fix), 201bec5 (harness), 756c14b (v2 cfg) |
| 2 | exact spend | **$4.3768** — v1 $2.1734 (INVALIDATED, harness bug) + v2 $2.2034 |
| 3 | completed / retried / failed | v2: 20 / 0 / 0 (10 cap + 10 rec). v1: 20 invalidated |
| 4 | corpus + leakage audit | 98 tasks (56 cap / 42 rec), hash 413a5cad82d4433e, **leakage CLEAN** |
| 5 | captured / rejected / deduped / attributed / fired / precision-ready | **9 / 4 / 3 / 0 / 0 / 0** (v2) |
| 6 | fire-rate | **0 / 10** recall |
| 7 | abstention reasons | serving gate ABSTAINED on all 10 — no captured block was a confident match (precision-preserving) |
| 8–13 | precision@fire / Wilson LB / FP-rate / recall@useful / latency / calibrator | **n/a** — 0 fires |
| 14 | privacy | **PASS** — 0 leaks reached a block; no abs-path in any stored block |
| 15 | **READY / NOT READY** | **NOT READY** |
| 16 | blocker | precision-ready 0, no credible path to ≥30 (below) |
| 17 | SWE-bench pre-registration | N/A (not READY) |

## Why precision-ready is 0 — a confound AND a structural finding
**Confound (disclosed):** the manifest is family-sorted, so the first 10 capture
and first 10 recall were **all axios** — the checkpoint corpus was 9 axios blocks,
each a *different* axios subsystem (axiosheaders, fetch, http, mergeconfig, …). The
full run would build ~50 blocks across 5 repos / 56 families — more diverse. So
0/10 is a **conservative** floor.

**Structural finding (the real result):** the leakage controls and the precision
gate are in fundamental tension with a ≥30-precision-ready target on distinct
real bug-fixes:
- Leakage safety **requires** capture and recall to be DIFFERENT commits/problems
  (never recall a block for its own fix). So every recall task is, by design, a
  *different* bug than anything captured.
- The serving gate is **precision-tuned** (abstain on weak/ambiguous matches; the
  production default that yields FP≤5%). It fires only on a confident match.
- Distinct, curated bug-fixes rarely near-duplicate each other, so a leakage-safe
  recall task seldom has a confident captured match → the gate (correctly)
  abstains → fire ≈ 0 → precision-ready ≈ 0.

This held even within a single repo (9 distinct axios blocks, 10 distinct axios
recall tasks → 0 fires). More corpus diversity does not resolve it: diversity adds
*more distinct* bugs, not more confident matches for a given recall task.

**Conclusion:** capture (volume) is reachable (≥50); precision-ready (≥30) is not,
because precision-safe recall over leakage-disjoint distinct bugs fires near-zero.
The ≥30 organic gate, as specified, appears unreachable from this paradigm — not
due to a defect (capture, recall, attribution, privacy, and the gate all behave
correctly; the $0 preflight fires+attributes when a query genuinely matches a
captured problem), but because real distinct bug-fixes do not transfer at a
precision-safe confidence threshold.

## Options (no gate/threshold changes were made; none recommended unilaterally)
1. **Accept NOT READY** — capture proven; precision-ready structurally unreachable
   on distinct-bug recall. Strongest-evidence outcome.
2. **Unconfounded recall re-test (~$12–16)** — run the full capture phase to build
   the ~50-block diverse corpus, then the 42 recall tasks against it, to *measure*
   the true fire-rate and definitively rule out the all-axios confound before
   finalizing. (Budget allows: ~$25.6 remains.)
3. **Re-examine fit** — whether the ≥30-precision-ready gate is the right readiness
   bar for *organic distinct-bug* recall (vs. genuinely repeated problems). This
   touches the locked gate and is explicitly out of scope for this run.

Nothing was tuned to flatter results; gates unchanged; no synthetic/imported
counting; v1 preserved as an invalidated artifact.
