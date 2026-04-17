# Phase 3 Capability Pilot — Findings (Partial)

**Date:** 2026-04-17.
**Status:** Partial (infrastructure failure mid-run).

## Design

Purpose: decide whether Phase 2 null result was due to TraceBase components or
task difficulty, **before** spending API budget on more ablations.

- Holdout: 10 tasks, `difficulty="<15 min fix"`, 5 repos
  (astropy, django, matplotlib, sphinx-doc, sympy), disjoint from train.
- Train: 5 tasks (1 per repo).
- Condition tested: plain baseline, no injection, no verify, budget=40 steps / $1.
- Grader: official `swebench.harness.run_evaluation`,
  `princeton-nlp/SWE-bench_Verified` test split.

Decision rule:
- If baseline resolves **≥ 30%** → headroom exists; TraceBase ablation is
  worth running at this budget.
- If baseline resolves **< 30%** → task/budget is the bottleneck;
  more TraceBase-side ablations on this sample are not informative.

## What actually ran

Docker VM ran out of disk pulling new-repo images. Sequential runner then
deadlocked on `docker container prune -f` (Docker containerd stuck on
ext4 I/O errors inside VM). Only 5/10 holdout tasks completed agent runs;
4 of those 5 were graded before Docker fully failed; 1 (`matplotlib-20676`)
has a submitted patch but is ungraded.

| Task                         | Status    | Graded? | Resolved? |
|------------------------------|-----------|---------|-----------|
| astropy-14995                | submitted | yes     | **yes**   |
| astropy-7336                 | submitted | yes     | **yes**   |
| django-10880                 | submitted | yes     | **yes**   |
| django-10914                 | submitted | yes     | **yes**   |
| matplotlib-20676             | submitted | no      | ?         |
| matplotlib-22719             | not run   | —       | —         |
| sphinx-10435                 | not run   | —       | —         |
| sphinx-7440                  | not run   | —       | —         |
| sympy-12481                  | not run   | —       | —         |
| sympy-13372                  | not run   | —       | —         |

## Primary metric (partial)

**Official resolved: 4 / 4 graded (100%). Submission rate: 5 / 5 attempted (100%).**
Avg cost per task: ~$0.12. No pre-submit verification, no injection.

For comparison, Phase 2 on the hard holdout (same config, step=40/$1, Sonnet
4.6) resolved **1 / 5** across all 5 conditions. Same task (astropy-7166,
the only `<15 min fix` task in that holdout) was the one resolved in every
Phase 2 condition.

## Interpretation

Sonnet 4.6 at budget 40 steps / $1 has **clear headroom** on easy
SWE-bench Verified tasks — and had **no headroom** on Phase 2's harder mix.
This directionally confirms: **the Phase 2 null result (oracle/verify don't
move resolved rate) was dominated by task difficulty, not TraceBase
component quality.**

This is a **pilot-quality signal** (n=4 graded + 1 ungraded, 2 repos, no
bigger-budget control) — not a benchmark. Stated as directional evidence.

## Not yet answered

- Does the same 4/4 hold for the missing 5 tasks (matplotlib, sphinx, sympy)?
  Without those, the repo mix is astropy+django only.
- Does the @80/$2 budget control add any resolved on harder tasks?
  (Planned but blocked by infrastructure.)
- On this easy subset with headroom, does oracle / verify / retrieval
  shift cost, steps, or resolve rate? (Planned A/B/C ablation blocked.)

## Infrastructure blocker

Docker Desktop VM on Apple Silicon has limited virtual-disk size (~60GB
default). Running SWE-bench at scale requires pulling per-task images
(1-2 GB each). Sequential pruning doesn't free space fast enough, and
when the VM disk fills, ext4 inside the VM gets I/O errors that do not
recover without a full Docker Desktop factory reset.

Options to unblock:
1. **Docker Desktop → Settings → Resources → Disk image size**: increase
   from default (~60 GB) to ~120 GB.
2. **Docker Desktop → Troubleshoot → Clean / Purge data**: wipes all
   cached images, frees the VM disk, then re-pull on demand (slow but works).
3. Run benchmark on a machine with more disk headroom.

Without one of the above, further tasks cannot be run on this system.

## What we will NOT claim

- No "+X% headline" from the pilot.
- No ablation result until A/B/C runs on an easy subset.
- The 4/4 resolved is **evidence of headroom at this budget**, not a
  benchmark number.

## Next steps (once infrastructure is fixed)

1. Complete the remaining 5 holdout runs @ 40/$1.
2. Run same 10 tasks @ 80/$2 (budget control).
3. If headroom confirmed across 10 tasks → run A/B/C ablation on the
   solvable subset (efficiency question: does TraceBase reduce cost/steps
   while preserving resolved?).
4. Only after that, consider scale: 20+ tasks / 3 models.

The value of this pilot is to **prevent** running a 30-run ablation that
would again hit the task-difficulty null result.
