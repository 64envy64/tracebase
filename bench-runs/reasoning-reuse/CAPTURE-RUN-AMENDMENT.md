# Operational Amendment — Sanctioned Capture Run (Phase 5)

**Recorded before paid dispatch. Operator-authorized 2026-05-31.**

## Supply outcome
- Honestly-verified organic supply was **exhausted at 98 box-4c-reproducible
  tasks** (manifest hash `413a5cad82d4433e`, frozen): 56 capture / 42 recall,
  56 families, leakage audit CLEAN.
- The **preferred ≥100-task supply buffer was missed by 2 tasks** (98 vs 100).
  The preferred 110–120 headroom was not reachable: deeper-history mining busts
  on dependency/version drift (mathjs deeper 0/37, axios mocha-era 0/35, zod
  deeper 4/44), `pytest` self-tests are not cleanly scopable (0/24), and fresh
  repos at recent history are thin (werkzeug 1/4). Recent-history
  reproducibility against installed deps is the real ceiling.

## Gates — UNCHANGED (no relaxation)
- Locked readiness gate stands exactly as pre-registered:
  **≥50 captured runtime blocks AND ≥30 precision-ready (fired + attributed)
  recall cases.**
- **No task substitution. No gate lowering. No synthetic / imported /
  discovery-only / SWE-bench tasks counted toward readiness.** Imported/authored
  fixtures, if reported, are reported separately and never counted.

## Dispatch protocol (operator-directed)
1. Run the `$0` preflight gate; refuse paid dispatch if it fails.
2. Dispatch **only the 10 capture + 10 recall health checkpoint first**
   (`TB_CHECKPOINT_ONLY=1`), then stop.
3. Continue with the remaining manifest **only if** the checkpoint shows a
   **credible path to both locked targets** (≥50 captured, ≥30 precision-ready)
   **and** all safety checks are green.
4. **Halt and report immediately** if projected yield cannot reach both targets,
   or on any safety-envelope condition (privacy regression, fix leakage,
   repeated pipeline failure, 3 consecutive empties, hard cap).

## Budget / scope
- Hard cap **$30** (haiku only). No further repo mining during this run.
- SWE-bench is **not** dispatched.

## Note on checkpoint recall yield
The checkpoint's 10 recall trajectories run against a thin (~10-block) corpus,
so their precision-ready yield is a **conservative under-estimate** of the
full-corpus yield (the remaining recall runs against ~50 blocks). The
credible-path judgment accounts for this asymmetry: capture yield projects
linearly (corpus-independent); recall yield is expected to improve post-checkpoint.
