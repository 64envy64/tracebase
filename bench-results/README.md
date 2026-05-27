# bench-results — layout

Bench reports are sorted by *what claim they support externally*, not by date.

## `publishable/`
Reports whose headline is defensible to investors / external users **as written**, with the disclosed scope and caveats.

| File | Mechanism | Scope of claim |
|---|---|---|
| [`file-memory.md`](publishable/file-memory.md) | 02 Semantic file memory | Glob 3→0, wall-time −16 %, tokens flat, pass-rate unchanged on 3 isolated multi-file tasks. Real agent measurement. |
| [`tool-supervision.md`](publishable/tool-supervision.md) | 03 Tool supervision | **Mechanism-correctness only** (synthetic scripted trajectories, 8/8 scenarios pass). Does **not** claim agent-level cost reduction — that requires Path A child-CLI harness, queued. |
| [`context-fold.md`](publishable/context-fold.md) | 05 Context fold | **Mechanism-correctness only** (synthetic synthesised-transcript scenarios, 6/6 pass first-run, 0 privacy regressions). Verifies fold → persist → recall → render flow + same-session isolation + leakage/injection skip rules. Does **not** claim agent savings, coherence, or compaction performance in real Claude sessions. |

Anything published in marketing / pitch decks should source numbers from this directory.

## `internal-diagnostics/`
Reports that exist for the team's understanding of mechanism state. Useful for engineering decisions; **not** for external claims as written.

| File | What it tells us |
|---|---|
| [`lift.md`](internal-diagnostics/lift.md) | 01 Reasoning reuse — oracle-ceiling ablation. Lift insufficient for net-positive expected value at current captured-corpus scale. Decision input only. |
| [`tool-supervision-real-agent-smoke.md`](internal-diagnostics/tool-supervision-real-agent-smoke.md) | 03 Path A real-agent smoke (1 trajectory at haiku). Harness works end-to-end; task design exposed that small bug-fix workloads do not produce sequential safe-read duplicates often enough to measure. Pilot NOT dispatched; agent-level savings claim NOT supported by evidence. Read before designing any future hook-based real-agent bench. |
| [`loop-detection-real-agent-smoke.md`](internal-diagnostics/loop-detection-real-agent-smoke.md) | 04 Path A real-agent Phase A smoke (1 OFF trajectory at haiku). Harness works; unit tests 26/26 pass; OFF arm produced no loop pattern → bench paused. **Cross-bench finding** with 03: on small haiku bug-fix tasks, redundant tool patterns are too rare to measure. Loop detection ships mechanism-tested at unit level only. |
| [`swebench-ablation.md`](internal-diagnostics/swebench-ablation.md) | SWE-bench reasoning-reuse ablation findings (A/B/C arms). Copy of `eval/swebench/results-ablation/ABLATION_FINDINGS.md`. |
| [`swebench-pilot.md`](internal-diagnostics/swebench-pilot.md) | SWE-bench pilot findings (40-task baseline). Copy of `eval/swebench/results-pilot/PILOT_FINDINGS.md`. |

Do **not** cite these in external materials without first re-scoping the claim with the latest data.

## `release-trail/`
Versioned per-release telemetry snapshots. Useful for diffing 0.X.Y → 0.X.Z but not as headline claims. Naming convention: `{kind}-{semver}.json` (or just `{semver}.json` for the rollup).

- `{semver}.json` — release rollup (one per release, every release back to 0.4.3).
- `eval-retrieval-{semver}.json` — retrieval eval snapshot per release.
- `gate-{semver}.json` — bench gate state per release.
- `mechanisms-{semver}.json` — per-mechanism-count snapshot.
- `sdk-{semver}.json` — SDK-side telemetry per release.
- `delta-0.7.1-to-0.9.0.md` — narrative diff between two releases.
- `technical-note-may4.md` — long-form internal note (May 4 deep dive).
- `junk-rate-0.7.1.txt` — junk-rate per release (txt).

## What's NOT in this directory

- **Raw bench artifacts** (workspaces, generated prompts, probe injections, seeded DBs) — those live under `bench-runs/<bench-id>/`, most of which is gitignored. See `.gitignore` for what is/isn't versioned.
- **Pre-registrations** for individual benches — those live next to the bench's raw artifacts at `bench-runs/<bench-id>/PRE-REGISTRATION.md`.
- **Driver scripts** — `scripts/<bench-id>-bench/`.
- **SWE-bench detailed traj data** — `eval/swebench/results*/**/*.traj.json` is gitignored (~tens of MB). Summaries (`tracebase.*.json`, `preds.json`, `predictions.jsonl`, `exit_statuses_*.yaml`) and findings (`*.md`) stay versioned.
- **Harness spike notes** (e.g. Path A child-CLI feasibility study) — live at `bench-runs/<spike-id>/README.md`. The Path A spike note is at [`bench-runs/path-a/README.md`](../bench-runs/path-a/README.md) — read it before designing any hook-based real-agent bench.

## How to add a new bench report

1. Write the report in the appropriate subdir based on the **defensibility of its headline as written**:
   - publishable iff the headline survives a hostile read with the caveats included
   - internal-diagnostics otherwise
2. Put raw artifacts under `bench-runs/<bench-id>/` and pre-registration in `bench-runs/<bench-id>/PRE-REGISTRATION.md`.
3. Update this README's table.
4. Commit in granular chunks (driver script, fixtures, results, report) — not one mega-commit.
