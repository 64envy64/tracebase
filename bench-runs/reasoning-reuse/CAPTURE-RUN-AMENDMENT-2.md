# Operational Amendment 2 — invalidate v1 checkpoint, harden capture extractor

**Operator-authorized 2026-06-01.** A generic runtime-capture robustness fix
(infrastructure correction, NOT benchmark tuning) + a checkpoint re-run.

## v1 checkpoint — INVALIDATED audit artifact
- run tag `capture-run-v1`, 10 capture + 10 recall, **spend $2.1734**.
- **Reason invalidated:** harness prompt contamination — the prompt led with
  `"Working directory (operate strictly inside):\n<ABS PATH>"`, so
  `extractPattern`'s `situation = firstSentence(userText)` became the abs-path
  boilerplate → `extractPattern` NULL (3/4) or `LeakageError: abs-path-posix`
  (1/4). 0 blocks captured.
- **These trajectories DO NOT count toward readiness.** Their raw progress
  (`capture-run-v1-progress.jsonl`, `-checkpoint.json`, `-aggregate.json`,
  `-retry-audit.json`) is **preserved unchanged** as an audit artifact; nothing
  is deleted or overwritten.
- **Spend carries against the $30 cap.** The re-run (`capture-run-v2`) uses an
  effective cap of **$30 − $2.1734 = $27.83** so total spend never exceeds $30.

## Fixes (committed separately: harness amendment vs. product fix)
1. **Harness prompt boundary** (capture-orchestrator.ts): lead with the natural
   problem statement; move working-directory / test command / operational rules
   to a trailing machine-rules section; keep **absolute paths out of all
   capture-readable task text** (agent operates in cwd; relative test command).
   Frozen manifest + task set UNCHANGED (hash `413a5cad82d4433e`).
2. **Product capture extractor** (capture-turn.ts), GENERIC only: normalize
   capture-readable user text; when selecting `situation`, skip path-only,
   working-directory, command, and operational-boilerplate lines; support normal
   markdown agent output (`## Root Cause`, `## Fix`, and equivalents); preserve
   the privacy scanner as the final authority; **fail closed** when no meaningful
   situation exists. No repo-specific phrases, benchmark rules, threshold
   changes, or task hardcodes.

## Unchanged invariants
- Locked gates: **≥50 captured AND ≥30 precision-ready.** No gate/threshold
  changes. No serving-gate edits. No task substitution/mining. No
  synthetic/imported/discovery-only counting. No SWE-bench.

## Re-run protocol
Re-run the SAME 10 capture + 10 recall checkpoint (`capture-run-v2`, fresh store
so the corpus rebuilds with fixed-prompt captures). Continue automatically to the
remaining frozen manifest only if: captures accumulate credibly toward ≥50;
recall accumulates credibly toward ≥30 precision-ready; attribution works;
privacy + leakage green; no safety-envelope halt. Else halt + report.
