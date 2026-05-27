# 03 Tool Supervision Bench — Pre-Registration (INVALIDATED 2026-05-27)

> **STATUS: INVALIDATED.** This agent-dispatch pre-registration was based on a wrong architectural assumption: that sub-agents launched through the Agent tool would honour workspace-level `.claude/settings.json` and fire `PreToolUse` / `PostToolUse` hooks per-workspace. They do not — sub-agents live inside the parent harness; workspace hooks are only loaded by a fresh Claude Code CLI process started in that cwd.
>
> Two pilot trajectories confirmed this empirically:
> 1. `grep-then-dive.ON` real task: 5 tool calls, 0 rows in workspace's `tool_observations`, no soft-block.
> 2. `hunt-the-bug.ON` instrumentation test: 3 identical Reads of the same file back-to-back, all completed, 0 warnings, 0 blocks. Sub-agent reported `verdict: "hooks_silent"`.
>
> Because the mechanism (`PreToolUse` hook intercepting safe-read duplicates) literally cannot fire under this dispatch method, the bench cannot honestly measure agent-level cost reduction here. Publishing 11 more null-mechanism trajectories would be a null-result-of-wrong-kind: "mechanism never ran," not "mechanism didn't help." Load-bearing guardrail (savings without safety = 0) forbids this.
>
> Pre-registration superseded by `PRE-REGISTRATION.md` for Path B (synthetic integration test through real backend code paths on scripted trajectories). Path A (child Claude Code CLI per workspace) is queued as future work.
>
> The original locked design is preserved below for transparency.

---

**Locked before any agent dispatch.** This file fixes the task set, hypotheses, and decision rules. Do not modify after the first agent run. If anything changes, the bench restarts.

## Claim under test

> Tool supervision (mode=soft) reduces redundant safe-read calls while preserving legitimate re-reads after file changes — without dropping pass-rate.

## Mechanism summary (what's gated)

| priorDupCount of matching argKey | mode=soft behaviour |
|---:|---|
| 0 | free |
| 1 | warn (systemMessage hint; tool runs) |
| 2 or 3 | **soft-redirect** (`decision:"block"`, reason directs agent to prior output) |
| 4+ | **soft-redirect (degraded)** (strict-tier hard block disabled in soft) |

**mtime bypass** (Read family only): when current file mtime > max(prior matching obs ts), return free + emit `tool_supervision.allowed_after_edit`. Edit between Read calls always permits the post-edit re-read.

**Scope**: only `read` and `search` tool families are gated. Bash / Edit / Write fall through to legacy path.

## Isolation (matches 02 file-memory shape)

| Surface | OFF | ON |
|---|---|---|
| `.tracebase/` | absent | present (via `initConfig`) |
| `.tracebase/config.json` toolSupervision | n/a | `{ "mode": "soft" }` |
| `.tracebase/memory.db` reasoning_blocks | n/a | empty (no reasoning-reuse lane) |
| `.tracebase/memory.db` indexed_files | n/a | empty (no file_memory lane) |
| `.claude/settings.json` UserPromptSubmit | absent | **absent** (would inject file_memory) |
| `.claude/settings.json` PreToolUse | absent | `capture-pre-tool-use --path <ws>` |
| `.claude/settings.json` PostToolUse | absent | `capture-tool-use --path <ws>` |
| `.claude/settings.json` Stop / PreCompact | absent | absent |

Mechanism under test ≡ the **only** difference between OFF and ON.

## Tasks (locked — 6 tasks × OFF/ON = 12 trajectories)

Each task has **one declared hypothesis** about what supervision should do. Hypotheses are recorded **before** the agent runs and are not modified post-hoc.

| # | Task id | Class | Hypothesis (declared) | Pass-rate risk |
|---|---|---|---|---|
| 1 | `cross-ref-debug` | real waste | warn x≥1 on handler.ts re-read; possibly 1 soft-redirect (cache_hit) if 3rd | low |
| 2 | `hunt-the-bug` | real waste, aggressive | **cache_hit x≥1** (soft-redirect on 2nd identical Read of parse.ts) | **medium (load-bearing)** |
| 3 | `edit-verify-cycle` | mtime-bypass legitimacy | **`allowed_after_edit` x≥1**, **0 cache_hit** on post-edit Read | medium (bypass must fire) |
| 4 | `wide-grep-narrowing` | null hypothesis (grep) | 0 events; distinct argKey per grep narrowing | none |
| 5 | `unique-reads` | null hypothesis (read) | 0 events; 4 distinct Reads | none |
| 6 | `grep-then-dive` | legacy intent-loop coexistence | warn-only expected on realistic trajectory; intent-block only if ≥4 same-intent greps | low |

### Task workspace contents (locked)

#### 1. cross-ref-debug
Files: `src/types.ts`, `src/handler.ts`, `src/router.ts`, `src/handler.test.ts`, `vitest.config.mjs`.
Bug: `shouldEmit` in `handler.ts` returns `event.archived` instead of `!event.archived`. Router has a date-filter that masks the inversion for old events.
Prompt: directs agent to fix failing test in handler.test.ts; mentions both handler and router exist.

#### 2. hunt-the-bug
Files: `src/parse.ts`, `src/parse.test.ts`, `vitest.config.mjs`.
Bug: `parseNum` regex is `/(\d+)/` — drops decimals. Should be `/(\d+\.?\d*)/`. Test expects `parseNum("3.14") === 3.14`, gets `3`.
Prompt: minimal — "parse.ts has a bug; one test fails; fix it".

#### 3. edit-verify-cycle
Files: `src/lru.ts`, `src/lru.test.ts`, `vitest.config.mjs`.
Bug: LRU `get` returns value but doesn't move key to recent end → wrong eviction order under capacity overflow.
Prompt: prompts agent to fix the LRU eviction order bug; standard test-driven loop.

#### 4. wide-grep-narrowing
Files: `src/api/auth/validate.ts` (real bug + `// TODO`), `src/api/users/get.ts` (TODO), `src/api/posts/create.ts` (TODO), `src/lib/format.ts` (TODO), `src/lib/clock.ts`, `src/api/auth/validate.test.ts`, `vitest.config.mjs`.
Bug: `validateToken` returns true without checking `expiresAt`. TODO comment on the same line marks it.
Prompt: directs agent to find a TODO marking a real security bug — natural to grep "TODO" wide and narrow down.

#### 5. unique-reads
Files: `src/pipeline.ts`, `src/stage1.ts`, `src/stage2.ts` (bug), `src/stage3.ts`, `src/stage4.ts`, `src/pipeline.test.ts`, `vitest.config.mjs`.
Bug: `stage2.validate` returns true on empty input (should be false).
Prompt: directs agent to fix the pipeline test failure on empty input.

#### 6. grep-then-dive
Files: `src/auth.ts` (bug), `src/middleware.ts`, `src/auth.test.ts`, `src/middleware.test.ts`, `vitest.config.mjs`.
Bug: `validateToken` uses `now > token.expiresAt`; boundary contract requires `>=`. Off-by-one at exactly `now === expiresAt`.
Prompt: directs agent to fix failing boundary test in auth.test.ts.

## Metrics (collected from harness + .tracebase/memory.db)

### Per trajectory (authoritative)
- `harness.tool_uses` — total tool calls
- `harness.duration_ms` — wall time
- `harness.total_tokens` — input + output
- `agent_self_report.tool_breakdown.{Read,Glob,Grep,Edit,Bash}` — cross-checked vs harness total

### Per ON trajectory (from `analytics_events` in `.tracebase/memory.db`)
- `tool_supervision.warned` count
- `tool_supervision.suppressed` count
- `tool_supervision.allowed_after_edit` count
- `tool_supervision.cache_hit` count
- `tool_supervision.would_block` count

### Per trajectory (post-hoc verification)
- `pass` boolean — run vitest against final workspace, parse pass/fail

## Decision rules (locked)

Computed from per-task and aggregate. **All four conditions in §A must hold for publishable.**

### §A. Publishable criteria
1. **Safe-read reduction**: aggregate `Read + Glob + Grep` ON ≤ OFF, AND at least one task shows strict-less-than.
2. **Mechanism fired**: aggregate `cache_hit + allowed_after_edit` ≥ 1 over ON trajectories, with at least 1 task hitting expected event class per its hypothesis row.
3. **Pass-rate not below OFF**: for every task individually, `pass(ON) ≥ pass(OFF)`. **Load-bearing.** Single per-task drop → not publishable.
4. **No token/time inflation**: aggregate `total_tokens` ON ≤ OFF × 1.05, AND aggregate `duration_ms` ON ≤ OFF × 1.10. (Small windows for run-to-run variance.)

### §B. Internal-only outcomes
- §A.1 holds, §A.2 holds, §A.3 holds, but §A.4 fails → "saves tool calls but inflates tokens/time" — publish caveat-heavy or hold.
- §A.2 fails (no cache_hit and no allowed_after_edit anywhere) → "mechanism never fired on realistic trajectories" — null result, internal-only, re-design tasks.
- §A.3 fails on exactly one task → "supervision over-aggressive on hypothesis-class N" — scope claim down to other classes OR hold.

### §C. Re-design (no publish, no internal note)
- §A.3 fails on ≥ 2 tasks → mechanism is broken at default mode=soft — re-tune defaults before any further bench.

## Reporting structure (locked)

When complete, write `bench-results/tool-supervision.md` in same shape as `bench-results/file-memory.md`:
1. Headline (one sentence — precise, no overclaim)
2. Caveats up-front (N, design choices, mode=soft only, no warn arm, no strict arm)
3. What this measures / does not measure (isolation method)
4. Per-task table (the locked hypothesis matrix + observed events column)
5. Aggregate table (matches §A criteria columns)
6. Reading guide
7. Disclosures (event extraction method, db queries used)

Plus `bench-results/tool-supervision.json` raw + `bench-runs/tool-supervision/events/<task>.<variant>.json` (extracted analytics events).

## Author / lock metadata

- Pre-registered: 2026-05-27
- Worktree: `interesting-mcclintock-a69a77` @ `8885bda` + uncommitted 03A-G hardening
- Mode arms: **mode=soft only** (no warn arm, no strict arm — per RESUME.md and §"Critical open decisions")
- Trajectory budget: 12 (6 tasks × 2 variants × 1 trajectory)
