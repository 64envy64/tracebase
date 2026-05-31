# Sanctioned Capture Run — Phase 5 Report

**Verdict: NOT READY.** Halted at the 10+10 health checkpoint per operator
protocol — projected capture yield 0/56 (cannot reach the locked ≥50). Root
cause is a **harness prompt-contamination bug**, not a product capture limit or
a gate failure. No gates lowered; no prompts/thresholds tuned.

## Exact spend
**$2.1734** (20 paid haiku trajectories at the checkpoint; an earlier dispatch
crashed at startup before any trajectory → $0). Hard cap $30 never approached.

## Trajectory accounting
- completed 20 (10 capture + 10 recall); retried 0; failed 0; 0 empties.
- **All 10 capture trajectories SOLVED their task** (verify=PASS) and all 10
  recall trajectories passed too — the agent + workspace + test-oracle path works.

## Checkpoint metrics (organic, runtime-capture path only)
| metric | value | locked target |
|---|---|---|
| captured runtime blocks | **0** / 10 (yield 0%) → projected 0/56 | ≥50 |
| precision-ready (fired+attributed) | **0** / 10 → projected 0/42 | ≥30 |
| fired | 0 | — |
| attributed | 0 | — |
| rejected (capture) | 4 | — |
| duplicates | 0 | — |
| precision@fire | n/a (0 fires) | ≥90% |
| Wilson LB | n/a | ≥80% |
| false-positive rate | n/a (0 fires) | ≤5% |
| recall@useful | n/a | — |
| latency p50/p95 | n/a (decision layer not exercised; 0 captures) | — |
| calibrator coverage | n/a | — |
| **privacy** | **PASS** — 0 leaks reached a stored block; the leakage scanner
  correctly REJECTED the one extracted pattern that contained a workspace
  abs-path (see root cause). No raw prompt/secret entered any block or manifest. |
| leakage audit (manifest) | CLEAN (capture/recall refs disjoint, no own-fix) |

## Root cause (diagnosed on real transcripts, $0)
`extractPattern` (capture-turn.ts:736) sets `situation = firstSentence(userText)`.
The harness prompt's first line is `"Working directory (operate strictly inside):\n<ABS PATH>"`.
Consequence, confirmed by running the real extraction path on captured transcripts:
- **3/4 → `extractPattern` returns NULL**: the boilerplate-first prompt is not
  problem-question-shaped, so `isPatternShapedUserText` / the unlock gate reject
  it — even though the agent's answer clearly contained "## Root Cause … the fix".
- **1/4 → extracted, then `storeReasoningPattern` REJECTED with
  `LeakageError: abs-path-posix`**: the extracted situation literally was the
  `/home/summrlove/…workspaces/…` path. The scanner worked as designed.

The capture mechanism itself is sound: the $0 preflight (a NATURAL
problem-statement userText) captured + recalled + attributed 5/5 in WSL. The live
failure is the test harness feeding a working-directory/abs-path preamble as the
"situation". Recall=0 is purely downstream of the empty corpus (nothing to fire
against), not an independent recall defect.

## Recommended fix (requires operator sanction — touches the prompt)
1. Restructure the capture/recall prompt so the **natural problem statement
   leads** (e.g. "A unit test is failing: <test> — <one-line symptom>.") and the
   working-directory / test-command / abs-path operational rules are **trailing**
   and never the first sentence.
2. Ensure **no absolute path** appears in any text the capture path can read as
   the situation (use a relative/neutral cwd reference in the prompt).
3. Re-run the 10+10 checkpoint; capture yield should recover (the heuristic is
   proven on natural prompts). Only then continue to the full manifest.

This is a harness/prompt correction, not gate/threshold tuning. Per the operator
directive ("do not tune prompts post-hoc"), it is reported for authorization
rather than applied unilaterally.

## What is ready (unchanged, reusable on re-run)
- Frozen manifest: 98 organic tasks (56 cap / 42 rec), hash `413a5cad82d4433e`,
  leakage CLEAN.
- Crash-safe orchestrator (resume preserved the 20 completed records), $0
  preflight gate (7/7), capture→recall→attribute pipeline (5/5 in WSL), full WSL
  provisioning. dogfood-status read-only defect fixed + regression-tested.
