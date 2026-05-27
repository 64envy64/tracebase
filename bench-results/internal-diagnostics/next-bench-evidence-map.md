# Bench evidence map + next-bet recommendation

**Decision input, not a bench result. Written 2026-05-27 after closing the synthetic-mechanism Path B chain (02 → 03B → 05B) and pausing Path A real-agent attempts (03A → 04A).**

The case for stopping synthetic-mechanism benches and moving to real-workload benches is now strong enough to justify a redirect. This doc captures what we have, what we don't, and where the next bench dollar should go.

## Where we are

### Publishable (defensible external claims, today)
| # | Bench | What it shows | Limit |
|---|---|---|---|
| 02 | [`file-memory.md`](../publishable/file-memory.md) | Glob 3→0 on 3 isolated multi-file bug-fix tasks; wall-time −16 %; tokens flat; pass-rate unchanged | N=3 pairs, ≤5 files each, pre-indexed (not incremental). **Real-agent, real numbers.** |
| 03 Path B | [`tool-supervision.md`](../publishable/tool-supervision.md) | Mechanism wiring 8/8 scripted scenarios at `mode=soft`; tier ladder + mtime bypass fire as designed; non-safe-read never blocked | Synthetic scripted trajectories. Does **not** claim agent savings. |
| 05 Path B | [`context-fold.md`](../publishable/context-fold.md) | Mechanism wiring 6/6 scripted scenarios; fold → persist → recall → render flow + same-session isolation + leakage/injection skip verified | Synthetic synthesised transcripts. No agent run, no compaction performance claim. |

### Internal-only diagnostics (do NOT cite externally without re-scoping)
| # | Bench | What it tells us internally |
|---|---|---|
| 01 | [`lift.md`](lift.md) | Reasoning-reuse oracle ablation at small captured-corpus scale. **Asymmetric payoff**: correct recall slightly reduces search cost; wrong injection heavily inflates trajectory cost. One false positive dominates aggregate. Measures precision/calibration more than reuse usefulness. |
| 03 Path A | [`tool-supervision-real-agent-smoke.md`](tool-supervision-real-agent-smoke.md) | Harness works end-to-end (hooks fire, DB populated). On small haiku bug-fix tasks, sequential safe-read duplicates are too rare to measure. Events observed came from non-safe-read legacy path, not hardened tier. **Workload-fit failure, not mechanism failure.** |
| 04 Path A | [`loop-detection-real-agent-smoke.md`](loop-detection-real-agent-smoke.md) | Same harness sound. Same workload-fit failure: haiku followed import chain on first pass, no `straight`/`pingpong`/`duplicate` patterns. |
| SWE-bench | [`swebench-ablation.md`](swebench-ablation.md), [`swebench-pilot.md`](swebench-pilot.md) | Reasoning-reuse ablation across real SWE-bench tasks (3 arms: no-inject, oracle, oracle+verify). Earlier work; pilot was 40-task baseline. |

### Cross-bench finding (carried by 03 + 04 diagnostics)

On small haiku bug-fix tasks, **the redundant tool patterns that 03's hardened tier ladder and 04's loop detector gate are too rare in real-model trajectories to produce a measurable agent-level signal**. Both mechanisms require the agent to display the kind of inefficiency a small-task strong model is specifically good at avoiding. Two independent benches at two independent mechanism surfaces produced the same null result; this is workload-class evidence, not noise.

## What we have NOT proved

These are gaps the published shelf does not close:

- **No agent-level savings for 03, 04, 05 on any workload.** Path B / unit tests prove the mechanisms work; they do not prove agents pay less when those mechanisms are on.
- **No demonstration that file-memory's −16 % wall-time scales beyond N=3 small fixtures.** The mechanism is structurally promising but the bench is too small to support strong external claims.
- **No reasoning-reuse aggregate-lift number from a corpus large enough to drown one false positive.** 01's negative result is small-N + asymmetric-payoff dominated; a larger organic corpus + tighter gate may produce a publishable lift, or may confirm the negative.
- **No production-style long-horizon trajectory data.** Compaction, loop redirect, and tier-laddered supervision all need >30-turn sessions with real workload pressure to be measurable; current synthetic harness can't generate those cheaply.

## Stop signal

After 03 + 04 Path A failures + 05 Path B success, the marginal value of **another synthetic mechanism-correctness bench** is low:

- 06 Outcome calibration is "not benchable in-session" per the file-memory.md narrative table — it requires production pilot data (≥20 outcomes per pattern).
- Any further synthetic mechanism slice would replicate the 05 Path B shape: useful, narrow, $0 spend, but adds another mechanism-only row to a shelf that already has three.

**Don't write another Path B. The plumbing is proven.** The unanswered question — "does any of this help real users on real workloads" — needs different evidence shapes.

## Next-bet candidates (decision input)

Three plausible real-workload benches, each with a different cost / risk / payoff. Listed in declining order of confidence-per-dollar, not declining order of importance.

### A. Expand 02 file-memory to real repos

**What**: take 02's published bench shape and run it on real public repos (django, flask, requests, …) with real failing tests from the repo's bug-fix PR history. Each task = a real bug, a real test, a real source layout (not 4-file synthetic).

**Cost**: medium. Per task: setup workspace from public repo, freeze a known-failing commit, run OFF/ON pair at haiku. Budget ~$0.10-0.30 per trajectory × 10-20 tasks × OFF/ON = $2-12. Workspace setup is the dev cost (each repo's vitest/pytest configuration is its own work).

**Risk**: low-medium. The mechanism is published; this just scales N from 3 to ~20 and replaces synthetic-small with real-medium. Most likely failure modes are operational (repo idiosyncrasies) rather than null result.

**Payoff if positive**: extends the publishable "Glob → 0, wall-time saved" claim from a 3-task curiosity to a 20-task pattern on real workloads. This is the cleanest path to a stronger external story.

### B. 01 reasoning-reuse with larger organic corpus + high-confidence gate + Docker/SWE-bench

**What**: revisit 01 with the diagnosis from the lift.md write-up. Build a larger captured-trace corpus (target: 100+ entries, not 10), tighten the gate to high-precision (raise threshold, require abstention margin, prefer no-inject over weak-match), and evaluate on Docker-isolated SWE-bench-style tasks where injected hints have more room to help on hard tasks the frontier model wouldn't pass otherwise.

**Cost**: high. Corpus collection + Docker harness build is the dev cost. Per-task running is $1-5 at sonnet (haiku has too little room to benefit). Pilot ~50 tasks × OFF/ON = $100-500. **Real money.**

**Risk**: medium-high. Could vindicate reasoning-reuse (positive aggregate lift) or could confirm the negative at larger N. The lift.md diagnosis suggests the small-N negative is correctable with corpus size + gate, but it's not certain.

**Payoff if positive**: the headline. Reasoning-reuse going from "internal-only" to "publishable with positive lift on SWE-bench-style real tasks" would be the most important repositioning win for the product. Worth the spend IF the calibration story is sound.

### C. Long-horizon production-style pilot for 03/04/05

**What**: stop trying to synthesise loop-prone workloads; instead, sample real long-horizon trajectories (from a friendly user, internal dogfooding, or recorded production traces if any exist) where compaction, loops, and tool dups actually happen. Run OFF/ON pair on the same task or replay-style.

**Cost**: very high. Cannot replay closed-source production traces; needs either (1) live dogfood with consent + telemetry pipe, or (2) constructing genuinely long synthetic workflows (multi-document analysis, refactor cycles, hour-long debugging) — neither cheap, neither fast.

**Risk**: very high. Most expensive to set up; most likely to produce useful evidence about the mechanisms that 03/04 PATHA could not measure. But the dev cost of getting to a single comparable OFF/ON pair on a long trajectory is in days, not hours.

**Payoff if positive**: closes the agent-level savings gap for THREE mechanisms at once (tool supervision, loop detection, context fold). All three pause states clear simultaneously.

## Recommended sequencing

If only one of A/B/C gets resourced next, choose **A (02 expansion)**:
- Highest confidence-per-dollar — extends a published claim rather than risking a null on an unpublished one.
- Smallest dev cost — reuses 02's existing harness shape (`scripts/file-memory-bench/`).
- Quickest cycle — first 5-task pilot can run in a day for $1-3.
- Reduces the most common external skepticism about 02 ("only 3 tasks").

If two get resourced, add **C** as the long bet — even partial progress (1-2 long workflows OFF/ON pairs) generates the first agent-level data point for the paused mechanisms.

**Defer B** until 02's expansion produces leverage. Reasoning-reuse needs corpus + gate calibration that takes longer than a single bench cycle; better to do it after 02 demonstrates we can stand up real-repo benches at all.

## What this doc does NOT do

- Does not pick a winner for you. Three paths, three different risk profiles.
- Does not commit to dev work on any of A/B/C. Each requires its own pre-registration.
- Does not affect any of the committed publishable / internal-diagnostic reports. They stand as-is.
- Does not extend or re-scope any existing published claim.

## File status

This doc is **untracked** (`bench-results/internal-diagnostics/next-bench-evidence-map.md`). Read, decide, then either:
- Commit it as a separate decision-input artifact (one-line commit `docs(bench-results): next-bench evidence map + recommendations`), OR
- Discard it after reading if you'd rather keep the decision out of the repo.
