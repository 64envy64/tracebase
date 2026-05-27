# 04 Loop Detection — Pre-Registration (Path A: real-agent child-CLI)

**STATUS: SPEC LOCKED 2026-05-27 → PHASE A SMOKE FAILED 2026-05-27 → PILOT NOT DISPATCHED.** See Amendment 1 below.

Spec is preserved as written so a future re-attempt under different conditions (long-horizon workload, different model class, captured production loop traces) can build on a known baseline. The planned pilot is **indefinitely paused** because Phase A workload-fit failed: on the candidate task, haiku solved the bug without producing any loop pattern that the detector classifies as `straight`, `pingpong`, or `duplicate`. The harness itself works; the task design does not exercise the mechanism. See `bench-results/internal-diagnostics/loop-detection-real-agent-smoke.md` for the diagnostic write-up. Path B-equivalent unit tests (`tool-loop-detect` + `loop-redirect` = 26/26) remain the only mechanism-correctness evidence for 04. This file remains for transparency.

Located under `bench-runs/tool-supervision/` (alongside 03's pre-regs) because the underlying tool-pattern detector serves both mechanisms — 03 supervises individual safe-read duplicates at PreToolUse; 04 detects multi-call loop shapes and surfaces text suggestions at UserPromptSubmit. The shared substrate keeps the bench files near each other.

## Why this exists

03 Path A's smoke showed that on small haiku bug-fix tasks under `mode=soft`, sequential safe-read duplicates are too rare to measure agent-level supervision savings. The recommended next mechanism is **loop detection** because its waste surface is conceptually larger (full repeated tool sequences, not micro-duplicates) and its enforcement is **soft text injection** rather than hard tool blocking — so it can't break the agent even when the heuristic over-fires. This pre-reg measures whether loop detection actually interrupts tail-loop behaviour in real haiku trajectories.

## Claim under test (locked scope)

> **On natural trajectories where the OFF agent enters a repeated tool-pattern (`straight`, `pingpong`, or `duplicate` per the production classifier) of its own accord, TraceBase loop detection surfaces a `▣ TB LOOP` redirect badge in the next `UserPromptSubmit`'s `additionalContext` and the agent diverges from the loop or stops it.**

Narrow on purpose. The claim does NOT extend to "agent savings", "pass-rate", or "general tool-call reduction". It is **tail-loop interruption** — does the badge fire, does the agent change behaviour after the badge.

### In scope
- **Tail-loop interruption signal**: `loop.fallback` or `loop.redirected` event emitted in workspace `.tracebase/memory.db` after the OFF trajectory's repeated pattern is replayed against ON.
- **Badge surfaced in transcript**: `▣ TB LOOP` token present in the `additionalContext` text of at least one ON `UserPromptSubmit` event AFTER the OFF-arm loop entered.
- **Agent next-action divergence**: the tool call immediately after the badge surfaces differs from the OFF agent's next tool call at the same point in the trajectory (loop broken) OR the ON trajectory terminates with fewer tool calls than OFF (loop short-circuited).

### Out of scope (explicitly excluded; called out as caveats in any report)
- **Anchor quality / `matched` vs `fallback`.** Empty `reasoning_blocks` and `indexed_files` means the resolver has no anchor pool. **The expected ON path on this bench is `staticFallback` (event `loop.fallback`, badge `▣ TB LOOP  repeated <kind> · widen scope`)**. Matched-anchor behaviour (with seeded anchors) is a separate future bench.
- **Pass-rate / tokens / wall-time as primary metrics.** Recorded for transparency only. Loop interruption may save or cost tokens depending on whether the agent's next action is cheaper than continued looping — neither is the claim here.
- **Parallel duplicate batches** (carried forward from 03 spike + Path A smoke). The detector reads `tool_observations` after each tool completes; parallel same-turn batches are recorded as separate obs only after PostToolUse fires for each. If the loop pattern is a single parallel batch (rare for loops, common for safe-read dups), the detector won't classify it. Counted descriptively, never claimed as a win.
- **Mode arms.** Loop detection has no `mode` config knob analogous to `toolSupervision.mode`. Always-on when `inject-context` runs and pattern fires. No arm variation.
- **Reasoning-reuse, file-memory, tool-supervision mechanisms.** Disabled by isolation (see §"Isolation method").

## Isolation method

Differs from 03 Path A in exactly which hooks the workspace activates. 03 isolated `PreToolUse + PostToolUse`. 04 isolates `PostToolUse + UserPromptSubmit` (the second is the *opposite* of 03's exclusion).

| Surface | OFF | ON |
|---|---|---|
| `.tracebase/` | absent | present (via `initConfig`) |
| `.tracebase/memory.db` `reasoning_blocks` rows | n/a | **empty** (no reasoning-reuse lane; ensures resolver falls back) |
| `.tracebase/memory.db` `indexed_files` rows | n/a | **empty** (no file_memory lane; ensures resolver falls back) |
| `.tracebase/config.json` `toolSupervision.mode` | n/a | **NOT set** (legacy path is irrelevant — no PreToolUse hook) |
| `.claude/settings.json` `PostToolUse` | absent | `capture-tool-use --host claude-code --path <ws>` |
| `.claude/settings.json` `UserPromptSubmit` | absent | `inject-context --host claude-code --path <ws>` |
| `.claude/settings.json` `PreToolUse`, `Stop`, `PreCompact` | absent | **absent** (must NOT activate — `PreToolUse` would invoke 03's tool supervision and contaminate event counts) |
| Hook command path quoting | n/a | **forward slashes only** (carried from spike; load-bearing on Windows) |

Empty `reasoning_blocks` and empty `indexed_files` together force the resolver's recall + file-hit pools to return zero candidates. When `detectToolPattern` fires, `resolveLoopRedirect` short-circuits to `staticFallback(signal, "no-hit")` and emits `loop.fallback` plus the static badge. That is the expected ON path. **A `loop.redirected` event would be a surprise** and would indicate either seeded content or a code regression — treat as evidence to investigate, not as a richer success.

## Mechanism summary (what fires when)

| Phase | Event in workspace |
|---|---|
| Agent emits tool call A | `PreToolUse` (absent in our setup; nothing happens) |
| Tool runs, returns | `PostToolUse` → `capture-tool-use` appends one `tool_observations` row + flushes to `.tracebase/cache/rtools.bin` warm cache |
| Loop pattern accumulates (e.g. straight = 3 same-argKey rows in a row) | no immediate event — detector doesn't run on PostToolUse |
| Next user prompt arrives | `UserPromptSubmit` → `inject-context` → `runReasoningPatternsRecall` → recall path reads recent observations → runs `detectToolPattern` → signal !== "none" → `resolveLoopRedirect` → emits `loop.fallback` (empty stores) + adds `▣ TB LOOP  repeated <kind> · widen scope` to `additionalContext` |
| Agent receives next user turn with the badge in its system context | agent should diverge: emit a different tool call than the loop continuation, or stop |

**Multi-turn shape is load-bearing.** A single-prompt trajectory that produces 3 same-argKey Reads, then completes, never triggers `UserPromptSubmit` again — so the badge never surfaces and the agent never sees the redirect. The bench *requires* a workload where the agent makes ≥2 user-turn worth of progress so that `UserPromptSubmit` re-fires between the loop accumulating and the agent acting on the redirect.

## Harness contract (reuse + extend Path A)

Reuses commits `97540bf` modules at `scripts/path-a-harness/`:

| Module | Reuse | Adjustment for 04 |
|---|---|---|
| `setup-workspace.ts` | reuse | Different `.claude/settings.json` template: `PostToolUse + UserPromptSubmit` (no `PreToolUse`). Same forward-slash hook command quoting. Extract the settings-builder into a parameterised helper if convenient; not load-bearing. |
| `run-trajectory.ts` | reuse | Same `claude --print --output-format json` shape. `--allowedTools` broader: `Read,Edit,Bash,Grep`. Grep enabled because realistic loops often involve search. `--model claude-haiku-4-5` for parity with 03 smoke. |
| `verify-pass.ts` | reuse | Vitest post-trajectory unchanged. Pass status is descriptive, not the load-bearing claim. |
| `extract-events.ts` | extend | Add: `loop.redirected` + `loop.fallback` event counts (from `analytics_events` payload `event` field); badge-occurrence count from transcript (`additionalContext` containing `▣ TB LOOP`); next-tool divergence — for each post-badge `UserPromptSubmit`, record the next `tool_use` name + argKey and whether it differs from the OFF agent's tool at the equivalent position. |
| `smoke.ts` (new file `scripts/path-a-harness/smoke-04.ts`) | new | Two-phase smoke (see §"Smoke gate"). Distinct from 03's `smoke.ts`; do NOT overwrite. |
| Pilot orchestrator | new | Created only after smoke passes both phases. |

The harness changes are **additive**; nothing in 03's smoke or 03's commits is modified.

## Smoke gate (two-phase, both must pass before pilot)

### Phase A — OFF-arm workload-fit (mechanism-independent)

Run ONE trajectory of the candidate smoke task as **OFF** variant (no `.tracebase/`, no hooks). After the trajectory completes:

1. Parse the post-trajectory `tool_observations` window that WOULD be passed to `detectToolPattern` had the hooks been active. (Synthesise: take the transcript's `tool_use` blocks in order, compute argKey via the production `sanitizeToolArgs` over a small ad-hoc workspace salt, slice the last 8 ≥ classifier window.)
2. Run `detectToolPattern` against that synthetic window.
3. Assert `signal.kind !== "none"` AND the matched pattern (`straight` / `pingpong` / `duplicate`) is at least one we expect from the task.

**If Phase A fails (OFF doesn't loop): ABORT.** Do not proceed to Phase B. Document the failure and either re-design the candidate task or declare 04 has the same workload-fit problem 03 hit and pause indefinitely. Pre-reg amendment block records the decision either way.

### Phase B — ON-arm mechanism (only run if Phase A passed)

Run ONE trajectory of the same task as **ON** variant (the `PostToolUse + UserPromptSubmit` configuration). Verify:

1. **Hooks fired clean**: PostToolUse and UserPromptSubmit attachments present, `exitCode: 0` on every one.
2. **Workspace DB has expected events**: at least one `loop.fallback` row in `analytics_events`. `loop.redirected` is allowed but unexpected (empty stores → no anchor).
3. **Badge surfaced in transcript**: at least one `additionalContext` text containing `▣ TB LOOP` after the OFF-equivalent loop point.
4. **Agent reacts**: the tool call immediately after the badge differs from the OFF agent's tool at the equivalent position, OR the trajectory terminates earlier than OFF's equivalent trajectory (fewer turns).

**If Phase B fails any of (1)–(4): ABORT.** Do not dispatch pilot. Document specifically which gate failed:
- (1) fail → harness wiring; debug and rerun smoke.
- (2) fail → mechanism didn't fire despite loop pattern; suggests detector window / inject-context plumbing issue.
- (3) fail → mechanism fired (event emitted) but badge didn't reach agent context; suggests inject-context output shape issue.
- (4) fail → mechanism fired and badge surfaced but agent ignored it; this is the actual scientific finding ("badge is too subtle to redirect haiku"); document and stop, do NOT iterate prompt-steering to force divergence.

**If harness is modified after a passing smoke, re-run BOTH phases.** No partial reruns.

## Candidate smoke task (proposed; lock when fixture written)

**`misleading-test-error`** — failing vitest test where the error message points at a function that is not the actual buggy site. Plausible loop: agent reads test, reads the named (wrong) function, edits it, re-runs test, sees same failure, re-edits the same function or re-reads it. Produces either `straight` (3+ same Edit / Read on same target) or `pingpong` (Edit X → Read X → Edit X → Read X) classifier signal.

Task fixture creation is **explicitly NOT done in this pre-reg** per the directive. The candidate above is what Phase A smoke would target; it goes into a follow-on commit `feat(bench/04): candidate task fixtures` only after the user signs off on the spec.

Alternative candidate task classes (not chosen, kept here for future re-design if Phase A fails):
- **Module resolution issue**: same Bash command fails identically multiple times (would produce `straight` on Bash).
- **Multi-file refactor**: edit X, test fails, edit Y, test fails, return to X (would produce `pingpong` on Edit family).
- **Mock confusion**: agent edits production code thinking it's test setup; test keeps failing identically; agent re-edits (would produce `straight` on Edit).

If `misleading-test-error` does not pass Phase A on haiku, attempt one of the alternatives before declaring workload-unfit. Maximum two alternative attempts per spec; further attempts require a new pre-reg.

## Metrics (locked)

### Per trajectory (authoritative — harness JSON result)
- `harness.usage.total_tokens`
- `harness.duration_ms`
- `harness.total_cost_usd`
- `harness.num_turns`
- `harness.terminal_reason`
- `transcript.tool_use_count_by_tool` (authoritative tool count from transcript jsonl)
- `transcript.tool_use_argKey_sequence` (oldest-first list of argKey + toolName; needed for Phase A synthesis)
- `transcript.parallel_batches_by_tool` (descriptive only; recorded for context per 03 lesson)
- `transcript.user_prompt_submit_count`
- `transcript.additional_context_includes_tb_loop` (boolean per UserPromptSubmit event)

### Per ON trajectory (from workspace `.tracebase/memory.db`)
- `loop.fallback` count by `reason`
- `loop.redirected` count by `signal` (unexpected — should be 0 on empty stores)
- `drift_injection` count (separate mechanism; descriptive)
- `tool_observations` total + by tool (sanity — should match transcript tool_use_count_by_tool ± parallel-batch effects)

### Post-hoc verification (per trajectory)
- vitest pass / fail (descriptive, not the load-bearing claim)
- next-tool divergence: per ON UserPromptSubmit event whose `additionalContext` contained `▣ TB LOOP`, did the next `tool_use` differ from the OFF agent's next `tool_use` at the equivalent transcript position? (boolean per badge)

## Decision rules (locked)

### §A. Publishable criteria
All four must hold for any agent-level publishable claim:
1. **Pre-flight unit tests pass** (mechanism units sound). Confirmed 2026-05-27: `tests/core/tool-loop-detect.test.ts` + `tests/core/loop-redirect.test.ts` = 26/26 pass.
2. **Phase A passes on at least one candidate task** (workload actually produces loops on haiku unprompted).
3. **Phase B passes all four checks** (hooks fire, event emitted, badge surfaced, agent diverges).
4. **Per-task** in the pilot: at least one `loop.fallback` or `loop.redirected` event AND at least one badge surfaced AND ≥1 next-tool divergence relative to the same task's OFF trajectory.

### §B. Internal-only outcomes
- §A.1 holds, §A.2 fails → workload-fit issue same as 03 Path A → document, pause pilot, internal-diagnostic only.
- §A.1+§A.2 hold, §A.3 fails on (1)/(2)/(3) → harness or wiring bug → fix and rerun smoke.
- §A.1+§A.2 hold, §A.3 fails on (4) (badge surfaced, agent ignored) → **scientific finding**: "loop redirect badge is insufficient to redirect haiku at this task scale" — internal-diagnostic. Do NOT iterate prompt-steering.

### §C. Re-design (no publish, no internal note)
- §A.1 fails (unit tests broken) → fix mechanism code before any bench work.

## Cost basis

| Stage | Estimate |
|---|---|
| Phase A smoke (1 OFF trajectory) | $0.05 – 0.20 |
| Phase B smoke (1 ON trajectory) — only if Phase A passes | $0.10 – 0.30 |
| Pilot 4–6 tasks × OFF/ON × 1 trajectory = 8–12 runs (only after both phases pass) | $0.80 – 3.60 |
| Rerun budget if Phase B fails for harness reasons + 1 retry | $0.20 |
| **Total reasonable cap** | **≈ $4.00** |

Higher than 03's cap (~$2.50) because loop-prone trajectories run longer and have wider variance.

## Reporting structure (locked)

On §A success:
- Write `bench-results/publishable/loop-detection-real-agent.md`
- Headline scoped to tail-loop interruption (NOT savings)
- Caveats: small N, empty-store fallback path only, haiku-class model, no anchor matched
- Per-task table: declared pattern hypothesis + observed events + badge count + next-tool divergence
- Aggregate: per-task results rolled up
- Reading guide: distinguish "mechanism fires" from "agent listens"
- Disclosures: harness + smoke methodology + this pre-reg + Amendments

On §B (internal-only) outcome:
- Write `bench-results/internal-diagnostics/loop-detection-real-agent.md`
- Same structure, "NOT publishable because ..." section at top
- Cross-link to 03 Path A smoke diagnostic for the workload-fit pattern shared between them

## Lock block

Spec-level lock (no changes without an Amendment after this point):

- [x] Pre-flight unit tests pass: `tests/core/tool-loop-detect.test.ts` (13 tests) + `tests/core/loop-redirect.test.ts` (13 tests) = 26/26 PASS. Verified 2026-05-27.
- [x] Spec scope locked: tail-loop interruption only, NOT agent savings.
- [x] Mode arm: none (loop detection has no `mode` knob).
- [x] `--allowedTools`: `Read,Edit,Bash,Grep` for pilot.
- [x] Transcript policy: same as Path A — raw `.jsonl` gitignored under `bench-runs/tool-supervision-path-a-04/transcripts/`; per-trajectory summaries committed.
- [x] Smoke gate is two-phase (OFF workload-fit, then ON mechanism); abort on any failure.
- [x] Empty `reasoning_blocks` and `indexed_files` is the expected configuration. Expected event path: `loop.fallback`, not `loop.redirected`.
- [x] Pre-registration locked: **2026-05-27**.
- [x] Worktree + commit SHA at lock: `claude/interesting-mcclintock-a69a77` @ `97540bf`.

Implementation checklist:

- [x] Candidate task fixture written under `bench-runs/tool-supervision-path-a-04/tasks/misleading-test-error/`; baseline vitest fails 2/3 on the planted parser bug.
- [x] `scripts/path-a-harness/{setup-workspace-04, smoke-04}.ts` implemented; Phase B implementation deferred (skeleton in `smoke-04.ts` raises until invoked).
- [x] `.gitignore` extended: `bench-runs/tool-supervision-path-a*/transcripts/**/*.jsonl` (generalised across 03 and 04) plus the internal Phase A pass-flag.
- [ ] **Phase A smoke FAILED 2026-05-27** — signal `none`, agent solved task without looping. See Amendment 1.
- [ ] **Phase B smoke** — not run (Phase A gate did not pass).
- [x] Smoke result documented under `bench-runs/tool-supervision-path-a-04/results/smoke-phase-a.json` + diagnostic at `bench-results/internal-diagnostics/loop-detection-real-agent-smoke.md`.

Pilot dispatch status: **NOT DISPATCHED**. See Amendment 1.

## Amendments (post-lock changes documented in full)

### Amendment 1 (2026-05-27, after Phase A smoke executed)

**Status change**: pilot bench is **NOT dispatched**. Path A real-agent 04 bench is paused indefinitely under this spec. Pre-reg's "two alternative candidate tasks" allowance is **explicitly NOT exercised**; per the operator's directive at the time of the failure, the bench stops on first Phase A failure rather than iterating candidates. This is a tighter stop than the spec allowed, and is captured as a one-time decision (a future re-attempt may use the spec's two-candidate allowance under a new amendment).

**What was run**: the Phase A smoke described in §"Smoke gate", phase A — one OFF trajectory of `misleading-test-error` with `claude-haiku-4-5`. Result captured in `bench-runs/tool-supervision-path-a-04/results/smoke-phase-a.json`. Cost: $0.098 (within the §"Cost basis" Phase A budget of $0.05–0.20).

**What worked** (the load-bearing harness/method validations):
- Pre-flight unit tests passed both at lock and immediately before smoke: `tests/core/tool-loop-detect.test.ts` (13) + `tests/core/loop-redirect.test.ts` (13) = 26/26.
- Path A harness for 04 (`scripts/path-a-harness/setup-workspace-04.ts`, `smoke-04.ts`) ran end-to-end without harness-class failures.
- The candidate task fixture's baseline vitest failed on the planted bug (2/3 tests fail), as required by the locked checklist.
- The spawned `claude --print` produced a clean trajectory: `exit 0`, 187.8 s, 8 turns, `terminal_reason: completed`, `total_cost_usd: 0.098`.
- Post-trajectory vitest: 3/3 pass — agent solved the task.

**Why Phase A failed** (workload-fit, not mechanism):

The trajectory's tool-use sequence (from the per-instance transcript, synthesised into `ToolObservation`s per §"Smoke gate" step 1):

```
Read=3, Edit=1, Bash=1, TaskOutput=1, TaskStop=1   (total 7 observations)
```

The 3 Reads are of distinct files (`format.test.ts`, `format.ts`, `parser.ts`) — distinct argKeys, no repetition. The agent followed the import from `format.ts` to `parser.ts` on the first pass, identified the regex bug, fixed it, ran vitest once, and finished. **No `straight` (3+ consecutive same argKey), no `pingpong` (A→B→A→B), no `duplicate` (any argKey ≥2)**. `detectToolPattern` returned `{ kind: "none", count: 0 }`.

The misleading assertion message ("the bug is in src/format.ts") did NOT trap haiku into looping on `format.ts`. The model read `format.ts`, observed it was a thin wrapper over `parseAmount`, followed the import, and fixed at the actual source. A 2-file misleading-error setup at small scale is not enough loop pressure.

**Honest conclusion** (the published scope for 04):

> On small haiku bug-fix tasks, real-model trajectories do not produce the redundant tool patterns (`straight` / `pingpong` / `duplicate`) that the loop detector classifies. The mechanism is correctness-verified at the unit level only (`tests/core/tool-loop-detect.test.ts` + `tests/core/loop-redirect.test.ts` = 26/26). The real-agent savings claim for 04 is not supported by evidence and is not published.

**Cross-bench finding (carried jointly with 03 Path A)**:

This is the second Path A bench to abort on Phase A workload-fit (03 abort: `bench-results/internal-diagnostics/tool-supervision-real-agent-smoke.md`). The shared finding is that **on small haiku bug-fix tasks, the redundant tool patterns that 03's hardened tier ladder gates and 04's loop detector classifies are too rare in real-model trajectories to produce a measurable agent-level signal**. Both 03's sequential-safe-read duplicates and 04's straight/pingpong/duplicate loops require the agent to display *the same kind of inefficiency a small-task strong model is good at avoiding*. The pattern is consistent across both mechanisms; this is product evidence about workload-fit, not a Phase-A noise artifact.

**What is not changed by this amendment**:
- The 04 mechanism code (`src/core/tool-loop-detect.ts`, `src/core/loop-redirect.ts`, `src/runtime/recall.ts` integration) is unchanged. 26/26 unit tests still pass.
- The candidate task fixture, harness scripts, and smoke result stay in-tree under `bench-runs/tool-supervision-path-a-04/` and `scripts/path-a-harness/` so any future re-attempt builds on a known baseline rather than starting cold.
- The spec above this Amendment is preserved exactly as locked; not retroactively edited.

**Future criteria for revisiting Path A 04** (queued, not started):

One of three conditions must be met before any rerun:

1. **Long-horizon workload capture**. Production-class trajectories where the agent actually loops (30+ turns, weak-feedback tasks, real refactor cycles). Synthetic small fixtures will not work; we have evidence from two abort runs now.
2. **Different model class**. Haiku at small scale is too good. A weaker / cheaper model (older Sonnet, Haiku-class but smaller, or a research model) may produce more loops on the same task design. Out-of-scope under this pre-reg (`mode arm: none`); requires a new pre-reg variant if pursued.
3. **Observed production loop traces**. Real loops from deployed users hitting the redirect badge — used to design tasks empirically, not to synthesize them. Requires production telemetry pipe and consent for trace ingestion.

None of these conditions hold today; 04 is paused indefinitely. The unit tests + this pre-reg + smoke result document everything needed for future re-attempts.

## Files this pre-reg will produce (after lock + smoke + pilot)

- `bench-runs/tool-supervision-path-a-04/tasks/<id>/` — task fixtures (1–N depending on smoke phase A outcomes)
- `bench-runs/tool-supervision-path-a-04/results/smoke-phase-a.json` — OFF workload-fit result
- `bench-runs/tool-supervision-path-a-04/results/smoke-phase-b.json` — ON mechanism result (only if Phase A passed)
- `bench-runs/tool-supervision-path-a-04/results/<id>.<variant>.json` — per-trajectory pilot results
- `bench-runs/tool-supervision-path-a-04/results/aggregate.json` — pilot roll-up
- `bench-runs/tool-supervision-path-a-04/transcripts/<id>.<variant>.jsonl` — gitignored raw transcripts
- `scripts/path-a-harness/smoke-04.ts` — two-phase smoke runner
- `scripts/path-a-harness/extract-events.ts` — extended to handle loop events + badge counts + next-tool divergence
- `bench-results/publishable/loop-detection-real-agent.md` OR `bench-results/internal-diagnostics/loop-detection-real-agent.md`

## Open questions resolved at lock (or carried as known unknowns)

1. **Synthetic Phase A vs production capture-tool-use Phase A** — Phase A is OFF (no hooks fire). To get `tool_observations`-equivalent input for `detectToolPattern`, the harness synthesises them from the transcript's `tool_use` sequence + ad-hoc argKey. This is acceptable because the detector is pure and dependency-free (see `src/core/tool-loop-detect.ts` header comment). Documented in §"Smoke gate Phase A" step 1.
2. **Anchor seeding for a future bench** — out of scope here. A second 04 pre-reg would add seeded `reasoning_blocks` to bench the `matched` path; that's a different mechanism slice (resolver anchor quality, not detector + redirect surfacing). Queued, not started.
3. **`drift_injection` events** — a separate recall-path event that may fire on the same trajectory. Recorded descriptively in metrics; not part of the §A claim.
4. **Position-equivalence for next-tool divergence** — comparing ON's "next tool after badge" to OFF's "next tool at equivalent transcript position" is fuzzy because trajectories diverge after the loop. The harness uses **same-prefix matching**: walks both trajectories from start until the first divergent tool_use, records ON's first post-divergence tool. Documented in `extract-events.ts` extension when written.
