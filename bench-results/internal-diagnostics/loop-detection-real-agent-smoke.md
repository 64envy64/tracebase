# Loop Detection real-agent smoke — internal diagnostic

**TraceBase 0.9.x · Path A child-CLI harness · 1 OFF smoke trajectory · `claude-haiku-4-5` · Phase A only**

## Status

> **Phase A smoke executed 2026-05-27. Harness sound; task design exposed a workload-fit limit identical to 03 Path A. Pilot bench NOT dispatched. 04 real-agent savings claim NOT supported by evidence and NOT published.** Mechanism remains correctness-verified at the unit level only (26/26 tests pass). Phase B was not run because Phase A's load-bearing precondition failed.

## Headline

> **On small haiku bug-fix tasks, real-model trajectories do not produce the `straight` / `pingpong` / `duplicate` loop patterns the detector classifies — so the loop-redirect mechanism cannot be measured at agent level on this workload.** The Path A harness fires hooks cleanly and the detector + resolver are unit-correct; the 04 bench would burn API calls to confirm a null result, so it does not run.

This is the second Path A bench in two attempts (after 03 Tool Supervision) to abort on Phase A workload-fit on small haiku bug-fix tasks. The cross-bench pattern is documented in §"Cross-bench finding" below.

## Caveats up front

1. **N = 1 Phase A smoke trajectory.** Single-task pre-flight required by the locked pre-registration before any pilot dispatch. The smoke failed; per the load-bearing rule the pilot does not run.
2. **One model.** `claude-haiku-4-5` only. Weaker / cheaper / older model classes may produce more loops on the same task design; that comparison is not in scope and explicitly was not attempted (no model upgrade or downgrade to chase the metric).
3. **One task class.** Misleading-error in a 2-file bug-fix workload (~3 source files + test). Other workload classes (long-horizon debugging, multi-file refactor cycles, production loop traces) were not exercised and may behave differently. Findings do not generalise to them.
4. **Phase A allows iteration on alternative candidate tasks** per the locked pre-reg (up to two attempts before workload-unfit declaration). The operator at the time of the failure chose to stop on the first failure rather than iterate candidates. This is a tighter stop than the spec; future re-attempts may use the spec's full allowance under a new amendment.
5. **Result is not "loop detection doesn't work".** The mechanism is well-tested at the unit level. The result is "**on this workload, real models do not give the detector the input it classifies as a loop**" — workload-fit, not mechanism.

## Method

### Unit-test pre-flight (locked precondition §A.1)

Confirmed at lock time and re-confirmed immediately before the smoke run:

```
tests/core/tool-loop-detect.test.ts   (13 tests)
tests/core/loop-redirect.test.ts      (13 tests)
                                       —————————
                                       26 / 26 PASS
```

Mechanism units sound. Any agent-level null result is not attributable to broken classifier or resolver logic.

### Path A harness validation

The same harness substrate as 03 (commit `97540bf`) — `setup-workspace`, `run-trajectory`, `verify-pass` — extended for 04 with:

- `scripts/path-a-harness/setup-workspace-04.ts` — sources fixtures from `bench-runs/tool-supervision-path-a-04/tasks/`, writes ON `.claude/settings.json` with `PostToolUse + UserPromptSubmit` only (no PreToolUse, no `toolSupervision.mode`).
- `scripts/path-a-harness/smoke-04.ts` — two-phase smoke; Phase A synthesises `ToolObservation` window from transcript tool_use sequence and runs `detectToolPattern` directly (OFF arm has no hooks). Phase B implementation deferred until Phase A passes.
- `.gitignore` generalised: `bench-runs/tool-supervision-path-a*/transcripts/**/*.jsonl` covers both 03 and 04 transcript dirs.

### Phase A trajectory

Task `misleading-test-error` — `src/format.ts` is a thin wrapper over `parseAmount` in `src/parser.ts`; `parseAmount` has a regex bug that drops decimals (`/(\d+)/` instead of `/(\d+\.?\d*)/`); `format.test.ts` fails with an explicit "the bug is in src/format.ts" hint pointing the agent at the WRONG file.

Baseline vitest: 2/3 fail on the decimal tests (bug in place).

Spawned: `claude --print --output-format json --model claude-haiku-4-5 --permission-mode bypassPermissions --setting-sources project,local --session-id <fresh-uuid> --max-budget-usd 0.50 --allowedTools Read,Edit,Bash` with PROMPT.txt piped via stdin.

## Phase A result

| Field | Value |
|---|---|
| Cost | **$0.098** (within $0.05-0.20 budget) |
| Wall | 187.8 s |
| Turns | 8 |
| Trajectory | `exit: 0`, `terminal_reason: completed` |
| Vitest after trajectory | 3/3 pass — agent solved the task |
| Tool use counts (from transcript) | `Read: 3, Edit: 1, Bash: 1, TaskOutput: 1, TaskStop: 1` |
| Synthesised observation window | 7 obs (full transcript fits within window) |
| `detectToolPattern` result | **`{ kind: "none", count: 0 }`** |
| Phase A verdict | **FAIL** |

## What happened

Haiku followed the import chain on the first pass:

1. Read `src/format.test.ts` (see the failing assertion) → distinct argKey
2. Read `src/format.ts` (the named "buggy" file) → distinct argKey
3. Read `src/parser.ts` (followed the import from `format.ts`) → distinct argKey
4. Edit `src/parser.ts` (fix the regex) → distinct argKey
5. Bash `vitest` (verify) → distinct argKey

Three distinct file Reads. One Edit. One Bash. **Zero repetition by argKey.** The classifier needs ≥3 consecutive same-argKey calls (straight), or A→B→A→B in 4 obs (pingpong), or any argKey ≥2 (duplicate). None of these conditions held in the trajectory.

The misleading assertion message ("the bug is in src/format.ts") did NOT mislead haiku into looping on `format.ts`. The model treated the hint as a starting point, not a verdict, read `format.ts`, observed it was a thin wrapper, and followed to `parser.ts`. Reasonable agent behaviour; null result for the bench.

## Cross-bench finding (jointly with 03 Path A)

Two Path A benches at agent level, two Phase A workload-fit failures on haiku-small bug-fix tasks:

| | 03 Tool Supervision (Path A) | 04 Loop Detection (Path A) |
|---|---|---|
| Mechanism under test | Hardened safe-read tier ladder (warn / soft-redirect on Read dups + mtime bypass) | Loop classifier + redirect resolver (straight / pingpong / duplicate → redirect badge) |
| Smoke task class | small (~3-7 file) bug-fix | small (3 file) bug-fix with misleading error |
| Expected agent waste | sequential duplicate Reads | repeated tool patterns in trajectory |
| Observed waste | model used a single Read, used in-context memory thereafter | model followed import on first pass; 3 distinct Reads, no repetition |
| Hardened-tier or loop event fired? | No (events from legacy non-safe-read path only) | No (`signal: none`) |
| Cost of finding | $0.10 across 4 smoke iterations | $0.098 in one Phase A run |
| Mechanism unit tests | 51/51 pass (Path B published) | 26/26 pass (no Path B; unit-only) |

**The pattern**: **on small haiku bug-fix tasks, the redundant tool patterns that 03's hardened tier ladder gates and 04's loop detector classifies are too rare in real-model trajectories to produce a measurable agent-level signal**. Both mechanisms require the agent to display the kind of inefficiency that a small-task strong model is specifically good at avoiding. The pattern is consistent across two independent benches at two independent mechanism surfaces; this is product evidence about workload-fit, not a one-shot noise artifact.

The corollary: **any agent-level bench of 03 / 04 / similar redundancy mechanisms requires either a substantially different workload class or a substantially different model class.** Continuing to design small synthetic bug-fix tasks for these mechanisms is unlikely to yield publishable agent-level results.

## Implications

- **Path A infrastructure (including 04 extensions) is sound.** The harness spawn, hook firing, DB persistence, transcript capture, and event extraction all behave as designed for both 03 and 04. A future re-attempt under different conditions can build on it without re-validating the plumbing.
- **04 ships mechanism-tested at the unit level only.** 26/26 unit tests for `tool-loop-detect` + `loop-redirect`. There is no Path B-equivalent synthetic integration bench for 04 (the unit tests already cover the classifier + resolver decision points at higher granularity than 03's Path B scenarios).
- **The "loop detection reduces agent tool calls / tokens / time" claim is NOT supported by evidence and will NOT be published.** Anyone citing 04 externally must source from the unit-test coverage and the documented mechanism behaviour, NOT from any agent-level number.
- **Future Path A 04 re-attempts** require one of:
  1. Long-horizon workload capture — production-class trajectories where the agent actually loops (30+ turns, weak-feedback tasks, real refactor cycles). Synthetic small fixtures will not work; evidence from two abort runs now.
  2. Weaker / cheaper / older model class — haiku at small scale is too good. Older or smaller models may produce more loops on the same task design. Requires a new pre-reg variant.
  3. Observed production loop traces — real loops from deployed users hitting the redirect badge, used to design tasks empirically rather than synthesize them. Requires production telemetry pipe.

  None hold today; 04 paused indefinitely.

## Decisions explicitly NOT taken

To document the constraints that kept this honest:

- Did **not** strengthen / amend the prompt to coerce a loop. (Operator directive, also matches anti-cherry-pick rule from 03.)
- Did **not** try an alternative candidate task. (Operator chose tighter-than-spec stop on first failure. Pre-reg's two-attempt allowance unused.)
- Did **not** switch to sonnet or any other model. (Out-of-scope per pre-reg; would change the variable under test mid-bench.)
- Did **not** dispatch the pilot anyway "just to see numbers". (Pre-reg load-bearing rule — Phase A pass required before Phase B; Phase B pass required before pilot.)
- Did **not** delete the harness, fixtures, or pre-reg. (They stay in-tree so the next re-attempt has a known baseline.)
- Did **not** auto-amend the pre-reg before operator review. (Decision-level; user approved Amendment 1 explicitly via choice D+A.)

## Cost

| Item | Cost |
|---|---|
| Phase A smoke (1 OFF trajectory) | $0.098 |
| Cumulative this session for 04 | **$0.098** |
| Pre-reg budget for full 04 (smoke + pilot + rerun) | $4.00 |
| Spend / budget | 2.4% |

The smoke gate did its job: caught the workload-fit failure at $0.098 instead of letting it surface after the $0.80-2.40 pilot.

## Pointers

- Pre-registration + Amendment 1: [`bench-runs/tool-supervision/PRE-REGISTRATION-04-LOOP-DETECTION.md`](../../bench-runs/tool-supervision/PRE-REGISTRATION-04-LOOP-DETECTION.md)
- Raw Phase A smoke result: [`bench-runs/tool-supervision-path-a-04/results/smoke-phase-a.json`](../../bench-runs/tool-supervision-path-a-04/results/smoke-phase-a.json)
- 03 Path A smoke (the cross-bench partner): [`tool-supervision-real-agent-smoke.md`](tool-supervision-real-agent-smoke.md)
- Path A spike (prior feasibility study): [`bench-runs/path-a/README.md`](../../bench-runs/path-a/README.md)
- Mechanism code: [`src/core/tool-loop-detect.ts`](../../src/core/tool-loop-detect.ts) (classifier), [`src/core/loop-redirect.ts`](../../src/core/loop-redirect.ts) (resolver), [`src/runtime/recall.ts`](../../src/runtime/recall.ts) (integration)
- Unit tests: [`tests/core/tool-loop-detect.test.ts`](../../tests/core/tool-loop-detect.test.ts) (13), [`tests/core/loop-redirect.test.ts`](../../tests/core/loop-redirect.test.ts) (13)
- Task fixture (preserved for future re-attempts): [`bench-runs/tool-supervision-path-a-04/tasks/misleading-test-error/`](../../bench-runs/tool-supervision-path-a-04/tasks/misleading-test-error/)
- Harness scripts: [`scripts/path-a-harness/setup-workspace-04.ts`](../../scripts/path-a-harness/setup-workspace-04.ts), [`scripts/path-a-harness/smoke-04.ts`](../../scripts/path-a-harness/smoke-04.ts)
- Raw transcript (gitignored, local audit only): `bench-runs/tool-supervision-path-a-04/transcripts/misleading-test-error.OFF.jsonl` (not copied locally since extract-events extension wasn't run; transcript still exists in `~/.claude/projects/`)
