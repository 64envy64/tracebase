# Path A harness spike

**Status: spike complete (2026-05-27). Path A is feasible. Full harness build pending.**
**Driver:** [`scripts/path-a-spike/spike.ts`](../../scripts/path-a-spike/spike.ts).

## Why this exists

The earlier 03 Tool Supervision agent-level pre-registration was invalidated when we discovered that sub-agents launched through the Claude Agent tool do not load workspace-level `.claude/settings.json` (see `bench-runs/tool-supervision/PRE-REGISTRATION-AGENT-INVALIDATED.md`). To bench any hook-based mechanism (tool supervision, loop detection, context fold) at real-agent level, we need a different dispatch method: spawn a child `claude` CLI process *in* the workspace cwd so the workspace settings are loaded natively.

This spike is the minimum-viable proof that the child-CLI approach works end-to-end.

## Verdict

> **Path A is feasible.** A child `claude --print --output-format json` process spawned in a workspace cwd loads that workspace's `.claude/settings.json`, fires PreToolUse and PostToolUse hooks per tool call, populates the workspace's `.tracebase/memory.db`, writes the warm cache (`rtools.bin`), and returns structured JSON with usage/duration/cost. Per-instance transcript is preserved in `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

One product-level mechanism finding fell out as a side effect (parallel duplicate batches — see §"What didn't fire"). That finding rewrites part of the future 03 real-agent pre-registration scope.

## What worked

Single trajectory in `%TEMP%/tb-path-a-spike-<ts>/` with `mode=soft` + PreToolUse + PostToolUse hooks. Model: `claude-haiku-4-5`. Cost: **$0.057**, wall: **11.2 s**, turns: **4**.

| Check | Evidence |
|---|---|
| Workspace `.claude/settings.json` loaded by child claude | 6 hook invocations recorded in transcript (3 Pre + 3 Post) |
| `PreToolUse` + `PostToolUse` fire per tool call, exit 0 | `exitCode: 0`, `durationMs: 700-900 ms` each, in transcript hook attachments |
| Workspace `.tracebase/memory.db` created and populated | 30 tables present, `tool_observations` has 3 rows (all `Read`) |
| Warm cache (`.tracebase/cache/rtools.bin`) populated | 3 JSONL entries, all matching argKey `f53a27e5beabc9ee`, same sessionId |
| Structured result JSON capture | top-level keys: `usage`, `total_cost_usd`, `duration_ms`, `num_turns`, `result`, `session_id`, `terminal_reason`, ... |
| Per-instance transcript captured | `~/.claude/projects/C--Users-Wave-AppData-Local-Temp-tb-path-a-spike-<ts>/<session-id>.jsonl` — full event log including `tool_use`, `tool_result`, hook attachments |

## What didn't fire (and why)

**`tool_supervision.* events = 0`.** No `warned`, no `cache_hit`, no `allowed_after_edit`. The 3rd Read was not soft-redirected.

**Root cause: the model issued all 3 Read calls in parallel within a single assistant turn** (one assistant turn → three concurrent `tool_use` blocks). Hook timestamps confirm: Pre2 started ~160 ms *before* Post1 started. All three PreToolUse hooks fired before any PostToolUse had written to the warm cache, so each Pre hydrated an empty cache and returned `{}` (free).

The cache ended up with 3 entries (all 3 PostToolUse hooks wrote successfully), but by then the tier ladder had nothing left to gate — the agent had already issued and consumed all three Reads.

**This is correct mechanism behaviour, not a Path A defect.** Supervision under `mode=soft` is designed to catch *sequential* duplicates ("agent already has this answer in context, shouldn't re-fetch"). A parallel batch hasn't yet given the agent a "prior output" to reuse — the calls go out simultaneously. The supervisor has nothing to redirect to.

### Evidence

From the spike transcript:

```
Pre1 ended  ~22:43:56.660Z  (durationMs: 944)
Post1 ended ~22:43:57.401Z  (durationMs: 727)  → started ~56.674
Pre2 ended  ~22:43:57.401Z  (durationMs: 888)  → started ~56.513  ← BEFORE Post1 started
Post2 ended ~22:43:57.420Z  (durationMs: 714)
Pre3 ended  ~22:43:57.420Z  (durationMs: 924)  → started ~56.496
Post3 ended ~22:43:57.610Z  (durationMs: 704)
```

All 6 hook stdouts were `{}\n` (free envelope). The cache file (`rtools.bin`) at end of run had 3 entries with timestamps within a 215 ms window — confirming all 3 Posts wrote, just not in time to gate the parallel Pre's.

## Windows hook path quoting (load-bearing)

First spike attempt failed with `exitCode: 127` on every hook:

```
/usr/bin/bash: line 1: C:UsersWaveDesktoptracebase...node_modules.bintsx.cmd: command not found
```

**Cause:** Claude Code on Windows pipes hook commands through MSYS bash. Backslashes in absolute paths are interpreted as shell escape characters and silently collapse the path. The `\` between every directory was eaten.

**Fix:** use forward slashes in the `command` string written to `.claude/settings.json`. Windows file APIs (and Node `child_process`) accept forward slashes natively; MSYS bash does not escape them.

```ts
const toPosix = (p: string) => p.replace(/\\/g, "/");
const preCmd = `${toPosix(TSX_BIN)} ${toPosix(CLI_TS)} capture-pre-tool-use --host claude-code --path ${toPosix(WS)}`;
```

This **must** be applied in every setup script that generates `.claude/settings.json` on Windows. The earlier 03 bench's `scripts/tool-supervision-bench/setup.ts` and the 02 bench's `scripts/file-memory-bench/setup.ts` both use raw Windows paths — they would have hit the same wall if the Agent tool had actually delegated to a child CLI. They didn't, so the issue stayed latent.

After the fix, all hooks exited 0 and the DB/cache were populated as expected.

## Implications for the new 03 real-agent pre-registration

When the 03 PRE-REG is rewritten for Path A (post-spike, post-review), the **scope of the safety claim must shrink** to reflect what supervision actually does and doesn't do:

### In scope (what the bench will measure)
- **Sequential duplicate suppression**: a multi-turn trajectory where the model reads X, does something with the result, then reads X again in a *later* turn. Supervision should fire on the second Read.
- **mtime bypass on post-edit re-reads**: read X → edit X → read X. The bypass should fire on the post-edit Read.
- **Non-safe-read families never blocked**: Bash duplicates fall through to legacy hint, never `decision:"block"`.

### Out of scope (declared up front, not measured)
- **Parallel duplicate batches in a single assistant turn.** Supervision cannot gate these by design — there is no prior output yet. This will be called out as a **known product gap**: under `mode=soft`, an agent that emits 3 simultaneous Reads of the same file in one turn pays the full cost of all 3. The mechanism does not catch parallel-batched duplicates.

### Future work (queued, NOT in 03 real-agent scope)
- **Parallel-batch suppression**: would require either a same-turn deduplication pass before the tool batch executes, OR an LLM-side change to recognise parallel duplicates pre-emit. Both are out of scope for the 03 bench and arguably out of scope for the supervisor as currently designed. Worth a separate spike + design doc later, not a bench iteration.

The implication for trajectory design: prompts must create natural sequencing (multi-turn, or read → analyse → read again because something changed) rather than asking for "N reads in a row" which the model will parallelise.

## Reproduce

From worktree root:

```powershell
.\node_modules\.bin\tsx.cmd scripts\path-a-spike\spike.ts
```

Requires:
- Anthropic auth set up at user level (OAuth or `ANTHROPIC_API_KEY`)
- `claude` CLI v2.1+ on `PATH` (this spike ran on `claude` 2.1.150)
- Network access for the API call

Effects: creates a temp workspace at `%TEMP%/tb-path-a-spike-<ts>/`, spawns one child claude run (`--max-budget-usd 0.50`, typically actual cost ≤ $0.10), preserves the workspace afterwards for inspection. Wipes any *prior* spike workspace.

## Cost basis for the next stage

| Item | Estimate |
|---|---|
| One short trajectory (~5 turns, haiku, ~50K tokens) | $0.05 – 0.10 |
| 03 real-agent: 6 tasks × OFF/ON × 1 trajectory = 12 runs | $0.60 – 1.20 |
| 03 real-agent with mode arms (warn + soft) × 6 tasks × OFF/ON = 36 runs | $1.80 – 3.60 |
| Path A harness build itself (no API calls) | ~0 |

## Next steps (queued, not started)

1. Build `scripts/path-a-harness/` proper: `setup-workspace.ts`, `run-trajectory.ts`, `extract-events.ts`, `aggregate.ts`. Reuse the spike's hook-command quoting fix, structured-JSON parsing, and DB inspection helpers.
2. Write a fresh `bench-runs/tool-supervision/PRE-REGISTRATION-PATH-A.md` with the scope reductions above (sequential-only, parallel-batch declared out of scope).
3. Design tasks where sequential re-reads are natural: multi-turn debugging, post-edit verification cycles, cross-reference checks across separate user prompts. Avoid "read X 3 times" wording that the model will parallelise.
4. Dispatch the 12-run bench. If pass-rate ON ≥ OFF and `cache_hit + allowed_after_edit` events > 0, publish as the first real-agent supervision bench.
5. Only then consider 04 Loop Detection / 05 Context Fold under the same harness.

Do not skip steps. Path A spike validated the foundation; the rest of the load-bearing work is harness-build + pre-reg + task design.
