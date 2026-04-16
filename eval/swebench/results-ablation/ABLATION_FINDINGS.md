# Ablation Findings — Phase 2 (Locate the Bottleneck)

**Benchmark:** SWE-bench Verified, Sonnet 4.6, 5-task disjoint holdout, official grader.
**Date:** 2026-04-16.

## Conditions

| Label | Injection           | Verify-before-submit | Notes                              |
|-------|---------------------|----------------------|------------------------------------|
| A     | none                | no                   | Pure baseline                      |
| A'    | none                | yes                  | Verify only (reused from v2)       |
| B     | oracle, per-task    | no                   | Oracle injection only              |
| C     | oracle, per-task    | yes                  | Oracle + verify                    |
| D     | bad retrieval (KB)  | yes                  | Reused from v2; broken retrieval   |

**Oracle patterns** are hand-crafted per holdout task in hypothesis form
(`situation / bug_mechanism / fix_approach / avoid / verify`), without leaking
gold file names or exact fix lines. Used **only as internal diagnostic**, not a
benchmark claim.

## Primary metric: official resolved rate

| Cond | Description              | Submitted | Resolved | Cost   | Avg steps |
|------|--------------------------|-----------|----------|--------|-----------|
| A    | no inject, no verify     | 3/5       | **1/5**  | $1.67  | 35.0      |
| A'   | no inject, verify        | 2/5       | **1/5**  | $1.63  | 37.6      |
| B    | oracle, no verify        | 1/5       | **1/5**  | $1.27  | 27.0      |
| C    | oracle, verify           | 1/5       | **1/5**  | $1.49  | 36.8      |
| D    | bad-retrieval, verify    | 2/5       | **1/5**  | $1.78  | 36.6      |

## Pairwise comparisons (resolved delta)

| Comparison                            | Δ resolved |
|---------------------------------------|------------|
| A → A' (verify alone)                 | **+0**     |
| A → B  (oracle alone)                 | **+0**     |
| B → C  (verify added to oracle)       | **+0**     |
| D → C  (retrieval quality: bad→good)  | **+0**     |

## Per-task matrix

```
  astropy-7166   ✓ ✓ ✓ ✓ ✓   ← solvable by every condition (including raw baseline)
  astropy-13398  · · · · ·   ← unsolved by every condition
  astropy-13977  · · · · ·   ← unsolved by every condition
  astropy-14182  · · · · ·   ← unsolved by every condition
  astropy-14369  · · · · ·   ← unsolved by every condition
                 A A' B C D
  ✓=resolved  ·=submitted-or-no-patch
```

## Interpretation

**Primary metric (resolved rate): all 5 conditions produce 1/5.** Every
condition resolves the same single task (astropy-7166), and the other 4 tasks
are unresolved by every condition.

On this 5-task holdout, **none of the tested components (oracle injection,
verify-before-submit, retrieval quality) produce a resolved uplift**.

### Secondary signals (not headline)

- **Verify reduces false submissions.** A submits 3 patches (2 wrong, 1 correct)
  vs A' submits 2 (1 wrong, 1 correct). Verify filters out some bad patches but
  does not help the agent produce more correct ones.
- **Oracle reduces cost.** B: $1.27 / 27 steps vs A: $1.67 / 35 steps
  (~24% cost saving, ~23% step saving), but with same resolved count.
- **Oracle + verify (C) has same cost as A' and same resolved.** The verify
  step erases the cost savings from oracle.

## Honest limitations

- **Sample size: 5 tasks.** Statistically noisy. 1 vs 1 difference ≈ chance.
- **Single model, single repo.** All 5 tasks are astropy. No cross-repo signal.
- **Budget: 40 steps / $1.** Hard tasks may simply be unsolvable in this budget;
  none of our components fix that.
- **Oracle pattern quality is a ceiling.** We believe our hand-crafted oracles
  are among the best possible "hypothesis-form" patterns for these tasks (no
  leakage, directly on-domain). If these don't move resolved rate, more-realistic
  (noisier) KB-derived patterns won't either on this sample.

## Bottleneck localization

Based on the ablation:

- **Not the retrieval quality** (D ≈ C on this sample — but sample too small to confirm).
- **Not the injection format** (A ≈ B → oracle hypothesis doesn't help).
- **Not the verify step** (A ≈ A', B ≈ C → verify doesn't add resolved).

**Most likely bottleneck:** task difficulty vs agent capacity at the chosen
budget. 4 of 5 holdout tasks are not solvable by Sonnet 4.6 in 40 steps,
regardless of injection.

## Recommendation for next steps

Before scaling to 20-task holdout (Phase 3), distinguish:

1. **Is the issue task-level unsolvability?** Run A on a different, less difficult
   subset of SWE-bench Verified (e.g. filter by `difficulty: "<15 min fix"`)
   to confirm there are tasks where Sonnet 4.6 has headroom.
2. **If headroom exists:** Rerun the 4-condition ablation on that easier subset.
   If oracle/verify shift resolved on easier tasks, the current sample was just
   too hard.
3. **If no headroom:** The component being tested is not the bottleneck;
   headline improvement requires model capability (different model, longer
   budget), not TraceBase-side changes.

## What NOT to claim

- No "+X% accuracy" headline from this run. The data does not support it.
- No "oracle injection beats bad retrieval" claim. D ≈ C on this sample.
- No "verify-before-submit improves resolved rate" claim. A ≈ A' on this sample.

## Useful signal we CAN report

- Ablation methodology is clean: disjoint train/holdout, official grader,
  hypothesis-form oracles without gold leakage.
- On the one task solved by all conditions, oracle injection used **24% fewer
  dollars** and **23% fewer steps** to get there (secondary metric).
- Verify filters out some false submissions (A: 2 wrong patches → A': 1 wrong
  patch), at the cost of more steps.

These are pilot-quality observations — useful as internal diagnostics, not
external benchmark claims.
