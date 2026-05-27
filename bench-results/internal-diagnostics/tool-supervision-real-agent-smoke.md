# Tool Supervision real-agent smoke — internal diagnostic

**TraceBase 0.9.x · Path A child-CLI harness · 1 smoke trajectory · `mode=soft` · `claude-haiku-4-5`**

## Status

> **Smoke gate executed 2026-05-27. Harness sound; task design exposed a product limit. Pilot bench NOT dispatched. 03 real-agent savings claim NOT supported by evidence and NOT published.** Path B mechanism-correctness (`bench-results/publishable/tool-supervision.md`) remains the only publishable 03 result.

## Headline

> **On small haiku bug-fix tasks under `mode=soft`, real-model trajectories do not produce sequential duplicate safe-read calls often enough to measure tool-supervision savings at agent level.** The Path A harness — which spawns a child Claude Code CLI per workspace so workspace `.claude/settings.json` hooks actually fire — works correctly end-to-end. The bench would burn ≈ $1 of API calls to confirm a null result, so it does not run.

The mechanism itself is verified by Path B's 8/8 scripted scenarios. This diagnostic documents *why* the agent-level analogue does not produce a measurable signal on the workload we tried, and what would have to change before re-attempting it.

## Caveats up front

1. **N = 1 smoke trajectory.** This is not a sample size from which to generalise model behaviour broadly. It is a single-task pre-flight that the pre-registration required before dispatching the 8-run pilot. The smoke gate failed; per the locked pre-registration's load-bearing rule the pilot is not dispatched.
2. **One model.** `claude-haiku-4-5` only. Sonnet-class behaviour may differ; that comparison is not in scope and was explicitly excluded from this iteration (no model upgrade to chase the metric).
3. **One task class.** Small (~3-7 file) self-contained bug-fix workloads of the kind the synthetic Path B already covers. Other workload classes (multi-document analysis, long-horizon debugging across many turns, code archaeology, refactor passes) were not exercised. Findings do not generalise to those.
4. **Result is not "supervision doesn't work".** Path B verifies the mechanism fires correctly under scripted input. The result here is "**on this workload, real models do not give the supervisor the input it gates**" — a workload-fit observation, not a mechanism critique.

## Method

`scripts/path-a-harness/smoke.ts` ran one trajectory per `bench-runs/tool-supervision/PRE-REGISTRATION-PATH-A.md` §"Smoke gate". The trajectory:

- Task: `read-then-test-then-reread` (ON variant only — the OFF arm is irrelevant to the smoke gate).
- Workspace: fresh copy of `bench-runs/tool-supervision-path-a/tasks/read-then-test-then-reread/` into `bench-runs/tool-supervision-path-a/workspaces/read-then-test-then-reread.ON/`, with `.tracebase/` (`toolSupervision.mode = "soft"`) and `.claude/settings.json` carrying PreToolUse + PostToolUse hooks (forward-slash command paths per `bench-runs/path-a/README.md` §"Windows hook path quoting").
- Spawn: `claude --print --output-format json --model claude-haiku-4-5 --permission-mode bypassPermissions --setting-sources project,local --session-id <fresh-uuid> --max-budget-usd 0.50 --allowedTools Read,Edit,Bash` with the task prompt piped via stdin.
- Trajectory result: `exitCode: 0`, 198.7 s, 7 turns, 0.049 USD, `terminal_reason: "completed"`. Post-trajectory `vitest`: 3/3 pass.

After the trajectory, `extract-events.ts` read the workspace's `.tracebase/memory.db` and the per-instance transcript at `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`, then `smoke.ts` evaluated the four smoke-gate conditions.

## Smoke gate results

| Gate | Definition | Result | Evidence |
|---|---|:-:|---|
| 1 | hooks_fired_clean | ✅ PASS | `preCount: 15`, `postCount: 6`, `nonZeroExit: 0`. No `127`-class hook failures (the Windows backslash bug from the spike). |
| 2 | tool_observations_present | ✅ PASS | 11 rows: `Bash: 4, Edit: 2, Read: 1, TaskOutput: 2, TaskStop: 2`. |
| 3 | supervision_event_fired (warned ∨ cache_hit) | ✅ PASS (but see §"What the events actually represent") | `warned: 4, suppressed: 4`. Zero `cache_hit`, zero `allowed_after_edit`, zero `would_block`. |
| 4 | sequential_read_after_bash ≥ 1 | ❌ FAIL | `0` occurrences. The model issued exactly one `Read` of `src/parser.ts` in the entire trajectory; there was no second Read to come after the Bash test runs. |

Per the locked pre-registration, **any single gate failure aborts the pilot**. The pilot does not dispatch.

## What the events actually represent

The 4 `warned` and 4 `suppressed` events in gate 3 are misleading at first read. They come from the **legacy 0.7.1 non-safe-read code path** in `src/cli/commands/capture-pre-tool-use.ts`, **not** from the hardened 0.9.x tier ladder the bench was designed to measure.

Breakdown:
- `Bash` invocations: 4 in DB / 2 unique in transcript → 2 duplicate Bash calls (re-running vitest). The legacy path attaches `warned` on the first duplicate and `suppressed` on the next, regardless of `mode`. Non-safe-read families fall straight to legacy.
- `Edit` invocations: 2 in DB / 1 unique in transcript → 1 duplicate Edit (likely the agent's retry on the same file). Same legacy path.
- `Read` invocations: 1. No duplicates. The hardened tier (warn → soft-redirect) **was not exercised on Read at all in this trajectory**.

If the pilot ran today on the 4-task slate, the ON arms would produce supervision events of the *same shape* — Bash/Edit legacy noise dominant, hardened-tier safe-read events near-zero. The OFF arms would produce the same tool-call sequence minus the supervision events. The expected per-task delta on `Read + Glob + Grep` (the bench's safe-read reduction metric) is ≈ 0 because there are no safe-read duplicates to suppress.

## Why this happened

Three reasons, in declining order of certainty:

1. **Haiku optimises away the 2nd Read.** The prompt explicitly asked the agent to "look at src/parser.ts again", and the model declined. It used its in-context memory of the file content rather than spending tokens on a duplicate `Read`. This is rational economic behaviour by the model; harder prompt-steering would either fail in the same way or veer into cherry-pick territory (forcing a duplicate just so we can measure suppression of it). We did not attempt the harder steer, by design.
2. **Small bug-fix tasks don't structurally need re-reads.** A 1-bug-in-1-small-file task naturally produces a Read-Edit-Test loop with no read repetition. The agent reads the file once, sees the bug, edits, verifies via test. The only natural source of safe-read duplication in this workload class is the agent re-reading after a confused test result, which haiku is good at avoiding.
3. **The parallel-batch limitation discovered in the Path A spike is reinforced.** The spike showed that on tasks where the agent does emit multiple safe-reads, it tends to parallelise them in one turn (all Pre's see empty cache → no supervision). Together with finding 1, the conclusion is that the *kinds* of redundant tool patterns real agents actually pay for (parallel batches; semantically-equivalent reads with different argKeys; broader exec-family redundancy) are **not the patterns the current hardened tier gates**. The current ladder is designed for sequential-same-argKey safe-read dups, and real-model behaviour produces those rarely.

## Implications

- **Path A infrastructure is sound.** The harness spawn, workspace bootstrap, hook firing, DB persistence, transcript capture, and event extraction all behave as designed. A future Path A bench can build on it without re-validating the plumbing.
- **Path B remains the source of truth for 03 publishable claims.** Mechanism correctness is verified (8/8 scripted scenarios at `mode=soft`). Nothing about this smoke invalidates the Path B report or the shipped supervision code.
- **The "tool supervision reduces agent tool calls / tokens / time" claim is NOT supported by evidence and will NOT be published.** Anyone presenting 03 externally should source from `bench-results/publishable/tool-supervision.md` (mechanism-correctness only) and explicitly NOT make agent-cost-reduction claims.
- **Future Path A re-attempts require either a different workload or a broader supervisor surface.** Detailed criteria in `bench-runs/tool-supervision/PRE-REGISTRATION-PATH-A.md` Amendment 1. We do not have either today; the bench is paused indefinitely rather than iterated.

## Decisions explicitly NOT taken

To document the constraint that kept this honest:

- Did **not** strengthen the prompt to coerce a duplicate Read. That would be measuring a forced behaviour, not a real-agent one.
- Did **not** switch to sonnet to chase the metric. That would change the variable under test mid-bench.
- Did **not** rewrite the task on the fly. The pre-registered task slate is locked.
- Did **not** dispatch the pilot anyway "just to see numbers". The pre-reg load-bearing rule (smoke pass required) applies.
- Did **not** delete the harness, fixtures, or pre-reg. They stay in-tree so the next re-attempt has a known baseline.

## Cost

≈ $0.10 total across 3 smoke iterations:
- run 1 (UUID format bug) — < $0.01, didn't reach API
- run 2 (UUID fixed; transcript path encoder bug) — $0.057 (cached run, gates 2/3 pass via DB)
- run 3 (session-ID collision; harness modified after this) — < $0.01, didn't reach API
- run 4 (fresh UUID + encoder fix) — $0.049 (this is the smoke result captured below)

Under the §"Cost basis" cap of ≈$2.50 in the pre-registration.

## Pointers

- Pre-registration + Amendment 1: [`bench-runs/tool-supervision/PRE-REGISTRATION-PATH-A.md`](../../bench-runs/tool-supervision/PRE-REGISTRATION-PATH-A.md)
- Raw smoke result: [`bench-runs/tool-supervision-path-a/results/smoke.json`](../../bench-runs/tool-supervision-path-a/results/smoke.json)
- Path A spike (prior feasibility study, also internal): [`bench-runs/path-a/README.md`](../../bench-runs/path-a/README.md)
- Path B publishable: [`tool-supervision.md`](../publishable/tool-supervision.md)
- Harness scripts: [`scripts/path-a-harness/`](../../scripts/path-a-harness/)
- Raw transcript (gitignored, local audit only): `bench-runs/tool-supervision-path-a/transcripts/read-then-test-then-reread.ON.jsonl`
