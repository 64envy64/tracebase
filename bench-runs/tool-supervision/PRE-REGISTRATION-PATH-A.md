# 03 Tool Supervision — Pre-Registration (Path A: real-agent child-CLI)

**STATUS: LOCKED 2026-05-27 → SMOKE FAILED 2026-05-27 → PILOT NOT DISPATCHED.** See Amendment 1 below.

Spec is preserved as written so future re-attempts can build on a known baseline. The planned 8-run pilot is **indefinitely paused** because the smoke gate exposed that on small haiku bug-fix tasks, real-model trajectories do not produce sequential safe-read duplicates often enough to measure the hardened tier. The Path A harness itself works; the task design does not exercise the mechanism. See `bench-results/internal-diagnostics/tool-supervision-real-agent-smoke.md` for the diagnostic write-up. Path B (`PRE-REGISTRATION.md`) remains the publishable scope for 03; this file remains for transparency.

## Why this exists

Path B (synthetic integration through CLIs) verifies *the mechanism fires correctly under scripted input*. It explicitly does not claim agent-level cost reduction. Path A measures whether **a real model under real Claude Code, with hooks loaded, changes its behaviour when supervision is on** — i.e. whether the mechanism actually saves the agent any tool calls / tokens / time on debugging trajectories.

The Path A spike (`bench-runs/path-a/README.md`) proved:
- spawned `claude --print` loads workspace `.claude/settings.json`
- hooks fire per tool call (6 of 6 in the spike, exit 0)
- workspace `.tracebase/memory.db` gets populated
- one *product-level* mechanism finding: **supervision under `mode=soft` cannot gate parallel tool batches** (an assistant turn with N concurrent `tool_use` blocks → all Pre's see empty cache). This is correct mechanism behaviour, not a bug — and it scopes what this bench can honestly claim.

## Claim under test (locked scope)

> **On natural-sequential debugging trajectories at `mode=soft`, TraceBase tool supervision reduces redundant safe-read calls without dropping pass-rate.**

### In scope
- **Sequential duplicate suppression** — a model that reads X, does something with the result (text, edit, bash), then issues another Read of X later in the trajectory. Supervision should warn or soft-redirect the second Read.
- **mtime bypass for legitimate post-edit re-reads** — model reads X, edits X, re-reads X. Bypass must fire (emit `allowed_after_edit`); the re-read must NOT be soft-redirected.
- **Non-safe-read never blocked** — Bash / Edit / Write duplicates should never produce `decision:"block"` (legacy hint via systemMessage is allowed, consistent with the Path B Amendment 1 finding).

### Out of scope (explicitly excluded; called out as known product gap in any report)
- **Parallel duplicate batches in a single assistant turn.** Supervision cannot gate these by design — there is no prior output yet when the Pre hooks fire. The bench will *count* parallel batches observed in trajectories (descriptive only, not a savings claim). Future work: a same-turn dedup pass before tool batch execution, or LLM-side parallel-dup recognition. Out of scope for this bench iteration.
- **Modes `warn` and `strict`.** Path B unit tests cover them; not re-measured here. `mode=soft` is the recommended default and the only arm benched.
- **Multi-session interaction.** Each task = one fresh workspace, one child claude session.
- **Reasoning-reuse, file-memory, loop-detection, context-fold mechanisms.** All disabled by isolation method.

## Isolation method (same shape as Path B but with real agent)

| Surface | OFF | ON |
|---|---|---|
| `.tracebase/` | absent | present (via `initConfig`) |
| `.tracebase/config.json` `toolSupervision.mode` | n/a | `"soft"` |
| `.tracebase/memory.db` `reasoning_blocks` rows | n/a | empty (no reasoning-reuse lane) |
| `.tracebase/memory.db` `indexed_files` rows | n/a | empty (no file_memory lane) |
| `.claude/settings.json` `PreToolUse` | absent | `capture-pre-tool-use --host claude-code --path <ws>` |
| `.claude/settings.json` `PostToolUse` | absent | `capture-tool-use --host claude-code --path <ws>` |
| `.claude/settings.json` `UserPromptSubmit` | absent | **absent** (would inject file_memory) |
| `.claude/settings.json` `Stop`, `PreCompact` | absent | absent |
| Hook command path quoting | n/a | **forward slashes only** (Windows MSYS bash requirement, per spike §"Windows hook path quoting") |

Mechanism under test ≡ the only difference between OFF and ON.

## Harness contract

Lives at `scripts/path-a-harness/` (to be built per this spec, NOT before pre-reg lock):

| Component | Responsibility |
|---|---|
| `setup-workspace.ts` | Per task × variant: copy `bench-runs/tool-supervision-path-a/tasks/<id>/` → temp workspace; for ON, run `initConfig` + write `toolSupervision.mode = "soft"` config + write Pre/PostToolUse `.claude/settings.json` with **forward-slash command paths**. |
| `run-trajectory.ts` | Spawn `claude --print --output-format json --model claude-haiku-4-5 --permission-mode bypassPermissions --setting-sources project,local --session-id <fixed-uuid-per-task-variant> --max-budget-usd 0.50 --allowedTools Read,Edit,Bash` with the task's prompt via stdin. Capture stdout JSON; record session id, transcript path, exit, stderr. **Grep/Glob/search-family deferred until pilot result clarifies whether the bench needs them.** |
| `extract-events.ts` | Open `<ws>/.tracebase/memory.db` read-only; count `tool_observations` by tool; parse `analytics_events.payload` and group by `event` field matching `tool_supervision.*`. Also parse the per-instance transcript at `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` to count `tool_use` blocks per tool and tally parallel batches (assistant turns with >1 `tool_use` of the same `name`). Copy the transcript jsonl into `bench-runs/tool-supervision-path-a/transcripts/<id>.<variant>.jsonl` for local audit; the raw jsonl is gitignored. Emit a per-trajectory JSON summary that IS committed (counts, decisions, events — no raw transcript content). |
| `verify-pass.ts` | Run vitest in each post-trajectory workspace; record pass/fail. |
| `aggregate.ts` | Per task / variant write `bench-runs/tool-supervision-path-a/results/<id>.<variant>.json`. Roll up to `bench-runs/tool-supervision-path-a/results/aggregate.json`. |

Harness implementation MUST NOT introduce mechanism-level shortcuts — every hook invocation comes from real Claude Code, every event is read from the workspace DB after the trajectory completes.

## Tasks (proposed — locked at lock-block sign-off)

Each task has **one declared hypothesis** about what supervision should do. Hypotheses fixed before any task runs; cannot be altered post-hoc.

Pilot bench: **4 tasks × OFF/ON × 1 trajectory = 8 runs.** Smaller than the invalidated 6-task spec on purpose — calibrate before expanding. Expansion to 6-8 tasks is a separate, post-pilot decision.

| # | Task id | Class | Hypothesis (declared) | Pass-rate risk |
|---|---|---|---|---|
| 1 | `edit-verify-cycle` | mtime-bypass legitimacy | Agent reads bug source → edits → re-reads to verify. `allowed_after_edit ≥ 1`; NO `cache_hit` on post-edit Read. Mechanism must NOT block legitimate verify. | medium — bypass must fire correctly |
| 2 | `read-then-test-then-reread` | sequential dup (no edit) | Agent reads source → runs vitest (Bash) → re-reads source to compare with test output. Sequential dup detected: `cache_hit ≥ 1` (soft-redirect on 2nd Read) AND `warned ≥ 1`. The Bash between Reads is naturally long enough for Post to flush cache. | medium — load-bearing |
| 3 | `cross-reference-back-check` | sequential dup of distinct file | Agent reads test → reads source → edits source → re-reads **test** (not source) to confirm test contract. Test mtime unchanged → soft-redirect should fire on the re-read of test. `cache_hit ≥ 1` for the test file's argKey. | medium |
| 4 | `unique-reads-null` | null hypothesis | 4 files, 1 Read each, all distinct argKey. No supervision events. OFF and ON should be ≈ equal on every metric. | none (null control) |

Optional expansion (NOT in the pilot; revisit after pilot result):
- `hunt-the-bug-multi-turn`: 2 user prompts, second prompt triggers re-read of file from first prompt (requires `--continue` between turns)
- `wide-grep-narrowing`: distinct Grep argKeys, null hypothesis for search family
- `accidental-reread`: 1 organic dup in a 4-file workflow

### Why these tasks and not C5b's tasks

The C5b task fixtures (`bench-runs/tool-supervision/tasks/`, currently uncommitted) were designed for the **invalidated** agent-level bench, before the parallel-Reads discovery. Some of them rely on prompts like *"read X three times back-to-back"* — which the spike showed the model will parallelise, producing 0 supervision events for the wrong reason.

This pre-reg explicitly designs tasks that produce **sequential** trajectories: edit-verify-cycle inserts an `Edit` between Reads (forcing serialization); `read-then-test-then-reread` inserts a `Bash` test run (multi-second wait); `cross-reference-back-check` requires the model to interleave Read and Edit. Models won't parallelise across an Edit or Bash boundary.

C5b fixtures stay deferred. If any of them fit the new design after task lock, they get copied or rewritten — not adopted blindly.

## Metrics (locked)

### Per trajectory (authoritative — from harness JSON result)
- `harness.usage.total_tokens` (input + cache + output)
- `harness.duration_ms`
- `harness.total_cost_usd`
- `harness.num_turns`
- `harness.terminal_reason`
- `transcript.tool_use_count_by_tool` (from `~/.claude/projects/.../<sid>.jsonl` — authoritative tool count, not agent self-report)
- `transcript.parallel_batches_by_tool` (descriptive: count of assistant turns with ≥2 `tool_use` blocks of same `name`)

### Per ON trajectory (from workspace `.tracebase/memory.db`)
- `tool_supervision.warned` count
- `tool_supervision.cache_hit` count
- `tool_supervision.allowed_after_edit` count
- `tool_supervision.would_block` count
- `tool_supervision.suppressed` count
- `tool_observations` total rows by tool

### Post-hoc verification
- `pass` (vitest exit 0 in final workspace)

## Decision rules (locked)

### §A. Publishable agent-level criteria
All four must hold:
1. **Pass-rate not below OFF** (load-bearing): for every task individually, `pass(ON) ≥ pass(OFF)`. Single task drop → not publishable; investigate root cause.
2. **Mechanism fired on the trajectories where its hypothesis predicted it should**: tasks 1, 2, 3 must each show ≥1 of their declared events; null task (4) must show 0 events.
3. **Net safe-read reduction**: aggregate `Read + Glob + Grep` ON ≤ OFF; AND at least one non-null task strict-less-than.
4. **No token/time inflation**: aggregate `total_tokens` ON ≤ OFF × 1.10 AND aggregate `duration_ms` ON ≤ OFF × 1.15. Wider bands than Path B because real-agent run-to-run variance is real.

### §B. Internal-only outcomes
- §A.1 + §A.2 + §A.3 hold, §A.4 fails → "supervision saves tool calls but costs tokens/time on net" — publish caveat-heavy or hold.
- §A.2 fails on tasks 1 or 2 → mechanism didn't fire when expected → re-tune trajectory design before rerun (not a publishable bench).
- §A.3 fails (ON ≥ OFF on safe-reads): mechanism active but agent didn't react → trajectory design issue, internal-only.

### §C. Re-design (no publish, no internal note)
- §A.1 fails on ≥2 tasks → mechanism over-aggressive at `mode=soft`. Re-tune defaults or change mode arm before any further bench.
- All `parallel_batches_by_tool` ≥ trajectory's `tool_use_count` (i.e. every Read in every trajectory was parallel) → bench is measuring nothing in scope. Re-design tasks.

## Smoke gate (must pass before dispatching the pilot)

Before running the 8-trajectory pilot, run **one smoke trajectory** with the harness on task 2 (`read-then-test-then-reread`) ON variant only. Verify:

1. Hook attachments in transcript: each non-blocked Read produces 1 PreToolUse + 1 PostToolUse pair, all `exitCode: 0`. **Blocked tool calls (regardless of mode) do not produce PostToolUse observations — count only non-blocked Reads when checking the Pre/Post pairing.**
2. Workspace DB has `tool_observations` rows > 0.
3. Workspace DB has at least one `tool_supervision.warned` OR `tool_supervision.cache_hit` event.
4. Trajectory's transcript shows ≥1 `tool_use` of name `Read` issued AFTER a previous Bash returned (sequencing confirmed, not parallel).

If any of (1)-(4) fails: **abort, do not dispatch the pilot.** Fix the harness or rewrite task 2 until smoke passes.

**If the harness is modified after a passing smoke, re-run the smoke before dispatching the pilot.** Otherwise one smoke pass is sufficient.

Cost of smoke: ~$0.10 (one trajectory, haiku, expect 8-15 turns).

## Cost basis

| Stage | Estimate |
|---|---|
| Smoke gate (1 trajectory) | $0.05 – 0.15 |
| Pilot bench (8 trajectories) | $0.40 – 1.20 |
| Pilot bench rerun if §A.1 or §A.2 fails (re-tune + 8 more) | $0.40 – 1.20 |
| Expansion to 8 tasks × OFF/ON (16 runs) | $0.80 – 2.40 |
| **Total reasonable budget for this pre-reg + smoke + pilot + one rerun** | **≈ $2.50 cap** |

## Reporting structure (locked)

On §A success, write `bench-results/publishable/tool-supervision-real-agent.md`:
1. Headline (one sentence, scoped to sequential trajectories)
2. Caveats up-front:
   - N = 4 tasks × 1 trajectory per cell (small)
   - `mode=soft` only
   - Parallel duplicate batches explicitly out of scope; descriptive count provided
   - Real-agent run-to-run variance not characterised at this N
3. What this measures / does not measure
4. Per-task table (declared hypothesis + observed events + per-tool counts + pass)
5. Aggregate matching §A criteria columns
6. Reading guide
7. Disclosures (transcript paths preserved? cost; harness invocation; smoke gate result)

Plus `bench-runs/tool-supervision-path-a/results/aggregate.json` raw and per-trajectory `results/<id>.<variant>.json`.

On §B (internal-only) outcome, write `bench-results/internal-diagnostics/tool-supervision-real-agent.md` instead, with the same structure plus an explicit "NOT publishable because ..." section at top.

## Lock block

This pre-reg is locked at the spec level on 2026-05-27. Outstanding checklist items refer to implementation work that must complete **before** the pilot dispatches; spec-level edits after this point require an Amendment.

- [x] Tasks fixed at exactly the 4 in §"Tasks" — fixtures land under `bench-runs/tool-supervision-path-a/tasks/<id>/` (separate dir from invalidated C5b `bench-runs/tool-supervision/tasks/`).
- [x] Mode arm: `soft` (no warn, no strict).
- [x] `--allowedTools`: `Read,Edit,Bash` only for pilot.
- [x] Transcript policy: copy locally to `bench-runs/tool-supervision-path-a/transcripts/`; raw `.jsonl` gitignored; per-trajectory JSON summary committed under `results/`.
- [x] Smoke gate scope: one smoke run before pilot; rerun if harness changes after smoke.
- [x] Cost cap: ≈ $2.50 (smoke + pilot + one rerun).
- [x] Pre-registration locked: **2026-05-27**.
- [x] Worktree + commit SHA at lock: `claude/interesting-mcclintock-a69a77` @ `c194e0a` (HEAD when pre-reg was drafted).

Implementation checklist:

- [x] Each task fixture written; baseline vitest run fails on the bug (mirror of Path B sanity-check). 2026-05-27.
- [x] Harness `scripts/path-a-harness/` implemented per §"Harness contract". 2026-05-27.
- [x] `.gitignore` updated to exclude `bench-runs/tool-supervision-path-a/transcripts/**/*.jsonl`.
- [ ] **Smoke gate FAILED 2026-05-27** — gates 1-3 PASS (harness sound), gate 4 FAIL (sequential Read-after-Bash = 0). See Amendment 1.
- [x] Smoke result documented under `bench-runs/tool-supervision-path-a/results/smoke.json` + diagnostic at `bench-results/internal-diagnostics/tool-supervision-real-agent-smoke.md`.

Pilot dispatch status: **NOT DISPATCHED**. See Amendment 1.

## Amendments (post-lock changes documented in full)

### Amendment 1 (2026-05-27, after smoke gate executed)

**Status change**: pilot bench (8 runs across 4 tasks × OFF/ON at `mode=soft`) is **NOT dispatched**. Path A real-agent 03 bench is paused indefinitely under this spec.

**What was run**: the smoke gate trajectory described in §"Smoke gate" — one trajectory on task `read-then-test-then-reread` at variant `ON` with `claude-haiku-4-5`. Result captured in `bench-runs/tool-supervision-path-a/results/smoke.json`. Cost across all smoke attempts: ≈ $0.10 (within the §"Cost basis" budget).

**What worked** (gates 1, 2, 3 of the smoke gate passed):
- Hooks fired cleanly: 15 PreToolUse + 6 PostToolUse attachment records observed, `exitCode: 0` on every one. The Windows forward-slash quoting fix from `bench-runs/path-a/README.md` §"Windows hook path quoting" held in production.
- Workspace `.tracebase/memory.db` was created and populated: 11 `tool_observations` rows (Bash=4, Edit=2, Read=1, TaskOutput=2, TaskStop=2).
- Supervision events were recorded in the workspace DB: `warned: 4, suppressed: 4`.
- Per-instance transcript was captured at `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` (encoder verified — see Amendment 1 §"Implementation note" below) and copied to `bench-runs/tool-supervision-path-a/transcripts/`.
- Post-trajectory `vitest`: 3/3 tests pass. Task was solved.

**Why we are not dispatching the pilot anyway** (gate 4 failed, and the data behind gates 2 and 3 is misleading for the bench's claim):

The transcript shows `toolUseCountsByTool: { Read: 1, Bash: 2, Edit: 1, ... }`. Haiku used `Read` on `src/parser.ts` exactly **once** in the entire trajectory, despite the prompt explicitly asking it to "look at src/parser.ts again". The model preferred to spend tokens on memory of the file content over a 2nd `Read` call. With only one `Read`, there is no sequential duplicate for the hardened tier to gate.

The `warned: 4, suppressed: 4` events in the DB are **not** from the hardened safe-read tier. They come from the **legacy 0.7.1 code path** firing on Bash dups (2 vitest invocations against the same args) and Edit dups (2 edits against the same file). Per `src/cli/commands/capture-pre-tool-use.ts`, non-safe-read families never go through the hardened tier; they hit `tool_supervision.warned` / `tool_supervision.suppressed` regardless of `toolSupervision.mode`. The bench's claim is about the **hardened tier on safe-reads** — these events do not support that claim.

If the pilot ran today as spec'd, the OFF arms would show the same trajectory shape minus the supervision badges, and the ON arms would not actually exercise the tier ladder on Reads. The expected result would be a near-null per-task comparison with most of the supervision noise coming from a code path Path B already verifies. We would burn ~$1 to learn nothing the existing benches don't already say.

**Honest conclusion** (carried forward as the published scope for 03):

> On small haiku bug-fix tasks under `mode=soft`, redundant sequential safe-read calls are too rare in real-model trajectories to measure tool-supervision savings at agent level. The mechanism is correctness-verified end-to-end (Path B, 8/8 scenarios) and ships in product. The real-agent savings claim is not supported by evidence and is not published.

**What is not changed by this amendment**:
- Path B (`PRE-REGISTRATION.md`) and the published `bench-results/publishable/tool-supervision.md` mechanism-correctness report stand as-is.
- The hardened supervision code (commit `2d363c6`) is not reverted or rescoped.
- The four task fixtures under `bench-runs/tool-supervision-path-a/tasks/` and the harness under `scripts/path-a-harness/` are not deleted — they remain in-tree so a future re-attempt can build on a known baseline rather than starting cold.
- The spec above this Amendment is preserved exactly as locked, not retroactively edited.

**Future criteria for revisiting Path A** (queued, not started):

Two conditions must be met before any rerun:

1. **Task workloads that organically produce redundant sequential safe-reads**. Small bug-fix tasks do not. Plausible candidates: long-horizon debugging trajectories where the agent has reason to re-consult earlier context after intervening work; multi-document analysis tasks where Glob/Grep are necessary; refactors across N files where the agent does several passes. None of these are tasks we have on hand today — they require real workflow capture, not synthetic design.

2. **Product work that broadens what the supervisor catches**. The spike's parallel-batch finding (`bench-runs/path-a/README.md`) plus this smoke's "haiku doesn't re-read at all" finding together suggest the *high-cost* redundant tool patterns in real agent behaviour are not the same patterns the current tier ladder gates. Either the supervisor needs to catch parallel duplicate batches (same-turn dedup pre-emit), or it needs to catch a wider class of redundancy (e.g. semantic-equivalent reads with different argKeys, broader exec-family supervision).

Until at least one of these lands, agent-level 03 numbers are not measurable and not claimed. Re-attempts require a new pre-registration that explicitly addresses why the new workload OR the new supervisor surface fixes the gap this smoke exposed.

**Implementation note (Windows-specific)**:

Two harness bugs were caught and fixed during the smoke iterations; both fixes are now in `scripts/path-a-harness/`:
- Session ID must be a fresh UUID per run (Claude Code rejects reuse with `"Session ID X is already in use"`); `smoke.ts` uses `randomUUID()`.
- The `~/.claude/projects/` directory encoder replaces each of `:`, `\`, `/`, `.` **individually** with `-` (e.g. `C:\Users\Wave\.claude\worktrees` → `C--Users-Wave--claude-worktrees`); collapsing runs of separators into one hyphen produces wrong paths. Fixed in `run-trajectory.ts`.

These are harness-level fixes only; they do not modify the spec or the mechanism.

## Files this pre-reg will produce (after lock + run)

- `bench-runs/tool-supervision-path-a/tasks/{1..4}/` — task fixtures
- `bench-runs/tool-supervision-path-a/results/<id>.<variant>.json` — per-trajectory results
- `bench-runs/tool-supervision-path-a/results/aggregate.json` — roll-up
- `bench-runs/tool-supervision-path-a/transcripts/<id>.<variant>.jsonl` — preserved transcripts (copies from `~/.claude/projects/.../<sid>.jsonl`)
- `scripts/path-a-harness/{setup-workspace, run-trajectory, extract-events, verify-pass, aggregate}.ts`
- `bench-results/publishable/tool-supervision-real-agent.md` OR `bench-results/internal-diagnostics/tool-supervision-real-agent.md`

## Resolved at lock (2026-05-27)

1. **Task fixture location**: NEW DIR `bench-runs/tool-supervision-path-a/tasks/` — clean break from invalidated C5b.
2. **Smoke gate scope**: one smoke before pilot; rerun if harness changes after smoke.
3. **Transcript preservation**: copy locally to `bench-runs/tool-supervision-path-a/transcripts/`; raw `.jsonl` gitignored; per-trajectory JSON summary committed.
4. **`--allowedTools`**: `Read,Edit,Bash` only for pilot. Grep/Glob/search-family deferred until pilot result clarifies the need.
