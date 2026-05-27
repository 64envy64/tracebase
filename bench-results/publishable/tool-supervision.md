# TraceBase 03 — Tool Supervision (Path B: synthetic integration)

**TraceBase 0.9.x · 8 scripted safe-read scenarios · mode=soft · synthetic, NOT agent-level**

## Headline

> **On scripted safe-read trajectories driven through the production `capture-pre-tool-use` / `capture-tool-use` CLIs, TraceBase tool supervision (mode=soft) correctly redirects redundant reads while preserving legitimate post-edit re-reads.**
>
> 8 of 8 pre-registered scenarios pass on the second run (after Amendment 1 to PRE-REGISTRATION; see disclosure below). Tier-ladder decisions (`free → warn → soft-redirect`) match production code paths. mtime-bypass fires on post-edit re-reads. Non-safe-read tools (Bash) never receive `decision:"block"`.

This is **not** an "agent does less waste" bench — see Caveats §1.

## Caveats up front

These matter for how the result should be read:

1. **No real LLM.** This bench drives the production hook CLIs with scripted tool sequences. It verifies that the mechanism produces the pre-registered decisions and events under known inputs. It does **not** measure how a real agent's `tool_uses`, `duration_ms`, or `total_tokens` change with supervision on. That measurement requires Path A (child Claude Code CLI per workspace), queued as future work — see §Why synthetic.
2. **`mode=soft` only.** The pre-registered mode under test. `warn` and `strict` arms are unit-tested separately (`tests/cli/capture-pre-tool-use.test.ts` — 51 passing) and not re-verified here.
3. **`priorDupCount >= 4` is unreachable in mode=soft on realistic trajectories.** When PreToolUse returns `decision:"block"`, the tool does not execute and PostToolUse does not fire — so the duplicate counter freezes at the value that triggered the first block. The originally-considered "five-reads-soft-degraded" scenario was dropped before any scenario ran, for this reason.
4. **PRE-REGISTRATION required one amendment after the first run.** Initial result: 7/8. The single failure was a pre-registration labelling error, not a mechanism defect (the non-safe-read 2nd-duplicate `systemMessage` reuse hint, documented 0.7.1+ behaviour). Amendment 1 corrected the expectation; second run was 8/8. **Both results are disclosed below.**
5. **An earlier agent-level pre-registration was invalidated** during method validation. Sub-agents through the Agent tool do not load workspace-level `.claude/settings.json` and therefore cannot fire `PreToolUse`/`PostToolUse` hooks per-workspace. Two pilot trajectories proved this empirically (one real task, 0 rows in workspace's `tool_observations`; one forced 3-identical-Reads instrumentation test, agent self-reported `verdict: "hooks_silent"`). The full architectural finding is preserved in [`bench-runs/tool-supervision/PRE-REGISTRATION-AGENT-INVALIDATED.md`](../../bench-runs/tool-supervision/PRE-REGISTRATION-AGENT-INVALIDATED.md).

## What this measures

This bench isolates the **tool supervision hardened tier ladder** (the 0.9.x `applyHardenedTier` logic in `src/cli/commands/capture-pre-tool-use.ts`) plus the **mtime bypass** for post-edit Reads. The mechanism under test:

- For safe-read tool families (`read` / `search`):
  - 1st identical-argKey duplicate → warn (`systemMessage` reuse hint, no block).
  - 2nd-3rd → soft-redirect (`decision:"block"` with "use prior output" reason).
  - mtime bypass: if the target file's `mtimeMs` is newer than the most recent prior matching observation's `ts`, the call is free + `tool_supervision.allowed_after_edit` event.
- For non-safe-read tool families (`exec` / `edit` / etc.): never blocked. Legacy reuse-hint badge may attach to envelope's `systemMessage` on first-hit duplicate.

The bench does **not** measure agent ergonomics, savings in tool calls / tokens / time, or pass-rate under supervision. See [`PRE-REGISTRATION.md`](../../bench-runs/tool-supervision/PRE-REGISTRATION.md) §"Claim under test" and §"Out of scope".

## Why synthetic (vs agent-level)

The original pre-registration assumed sub-agents launched through the Agent tool would honour workspace-level `.claude/settings.json` and fire `PreToolUse` / `PostToolUse` hooks per-workspace. They do not — sub-agents live inside the parent harness; workspace hooks are only loaded by a fresh Claude Code CLI process started in that cwd.

Two pilot trajectories confirmed this empirically before the full dispatch:

| Pilot | Trajectory | Workspace events written | Verdict |
|---|---|---:|---|
| 1 | Real task on `grep-then-dive.ON` workspace, 5 tool calls, agent solved the bug | 0 rows in `tool_observations` | hooks silent |
| 2 | Instrumentation: forced 3 identical `Read(parse.ts)` calls in `hunt-the-bug.ON` | 0 rows, 0 warnings, 0 blocks | sub-agent self-reported `"hooks_silent"` |

For comparison, the published 02 file-memory bench worked by **baking** the file-memory injection into the **prompt** as plain text (build-prompts.mjs:55-59) — the agent saw it as part of his initial context, no hook needed. There is no analogous "bake into prompt" path for runtime tool blocking.

Therefore: **Path B (this bench)** verifies mechanism correctness via the production CLIs on scripted trajectories. **Path A (real-agent measurement via child Claude Code CLI per workspace)** is queued as future work.

## Per-scenario results

Mode = `soft` for all scenarios. Each scenario runs in a fresh temp workspace (`initConfig` + `toolSupervision.mode = "soft"`), torn down at end.

Tool-call notation: `R(X)` = Read(file_path=X); `G(p,path)` = Grep(pattern=p, path); `B(c,d)` = Bash(command=c, description=d); `E(X,content)` = direct FS write to X + `utimesSync` mtime bump (NOT routed through hooks — simulates a real Edit's file-system side effect).

Decision-tag classifier:
- `free` — empty envelope.
- `warn` — envelope has `systemMessage` (any family) but no `decision:"block"`.
- `soft-redirect` — envelope has `decision:"block"` with "prior output" / "soft-redirect" reason.
- `block` — envelope has `decision:"block"` with any other reason.

| # | Scenario | Tool sequence | Expected decisions | Actual decisions | Expected events | Actual events | Pass |
|---|---|---|---|---|---|---|:-:|
| 1 | `single-read` | R(a) | `[free]` | `[free]` | — | — | ✓ |
| 2 | `read-read-warn` | R(a), R(a) | `[free, warn]` | `[free, warn]` | `warned: 1` | `warned: 1` | ✓ |
| 3 | `read-read-read-soft` | R(a), R(a), R(a) | `[free, warn, soft-redirect]` | `[free, warn, soft-redirect]` | `warned: 2, cache_hit: 1` | `warned: 2, cache_hit: 1` | ✓ |
| 4 | `edit-bypass` | R(a), E(a, "new"), R(a) | `[free, free]` | `[free, free]` | `allowed_after_edit: 1` | `allowed_after_edit: 1` | ✓ |
| 5 | `dup-then-edit-then-read` | R(a), R(a), E(a, "new"), R(a) | `[free, warn, free]` | `[free, warn, free]` | `warned: 1, allowed_after_edit: 1` | `warned: 1, allowed_after_edit: 1` | ✓ |
| 6 | `bash-not-supervised` | B("ls"), B("ls"), B("ls") | `[free, warn, free]` ¹ | `[free, warn, free]` | `warned: 1, suppressed: 1` | `warned: 1, suppressed: 1` | ✓ |
| 7 | `distinct-reads-null` | R(a), R(b), R(c) | `[free, free, free]` | `[free, free, free]` | — | — | ✓ |
| 8 | `grep-grep-grep-soft` | G("foo","src"), G("foo","src"), G("foo","src") | `[free, warn, soft-redirect]` | `[free, warn, soft-redirect]` | `warned: 2, cache_hit: 1` | `warned: 2, cache_hit: 1` | ✓ |

¹ Per Amendment 1 to PRE-REG; see §Disclosures.

## Aggregate

| | OFF (baseline) | ON (mode=soft) | Δ |
|---|---:|---:|---|
| Scenarios pre-registered | — | 8 | — |
| Scenarios pass (initial run, before Amendment 1) | — | **7 / 8** | — |
| Scenarios pass (final run, after Amendment 1) | — | **8 / 8** | — |
| Substantive safety claim ("non-safe-read never blocks") | — | upheld in every scenario | ✓ |

There is no OFF/ON tools/tokens/time delta to report here. **By design.** This bench measures mechanism correctness under scripted input, not agent-level cost. The OFF/ON workspace pairs that were prepared for the (now-invalidated) agent-level bench remain in the repo at `bench-runs/tool-supervision/workspaces/` but were never run as a measurement source.

## Reading guide

1. **`free → warn → soft-redirect` tier ladder fires per design on safe-read families.** Scenarios 2, 3, 8 cover this end-to-end through the real CLIs.
2. **mtime bypass works.** Scenarios 4 and 5 confirm: when a file is modified between Reads, the post-edit Read is free + emits `allowed_after_edit`. The supervisor steps aside for legitimate verification re-reads.
3. **Non-safe-read tools (Bash) are not blocked, ever.** Scenario 6 confirms `decision:"block"` is absent for 3 identical Bash calls. A first-hit reuse-hint `systemMessage` may attach (documented legacy behaviour), but no tier-ladder events fire.
4. **Different `argKey`s are not collapsed.** Scenario 7 confirms three distinct Reads → 0 events. The supervisor doesn't over-fire on superficially similar but semantically distinct calls.
5. **`would_block` event is unreachable in mode=soft on this surface.** The tier function emits `would_block` only when `tier.wouldBlock && !tier.blocked`. In mode=soft, every duplicate ≥2 is blocked → `!blocked` is always false → the counterfactual event never fires. It would fire under `mode=warn` for `priorDupCount ≥ 4`, but `mode=warn` is not in this bench's pre-registered scope.
6. **Initial 7/8 → amended 8/8 disclosure**: the single first-run failure (scenario 6, `bash-not-supervised`) was a labelling error in the original PRE-REG. The mechanism behaved correctly; the expectation was over-strict. See §Disclosures for the verbatim amendment.

## How this fits the full TraceBase savings narrative

| Mechanism | Bench | Status |
|---|---|---|
| 01 Reasoning reuse | [`lift.md`](../internal-diagnostics/lift.md) ablation | Risky steering at small captured-corpus scale. Precision insufficient for net-positive expected value. Internal diagnostic only. |
| 02 Semantic file memory | [`file-memory.md`](file-memory.md) | Glob 3→0 on isolated 3-task suite, wall-time −16 %, tokens flat, pass-rate unchanged. **Publishable.** |
| **03 Tool supervision** | **this bench (Path B)** | **8/8 scripted scenarios pass; mechanism correctness verified end-to-end through production CLIs. mode=soft only. Path A (real-agent bench) queued — depends on child Claude Code CLI harness not yet in repo.** |
| 04 Loop detection | future | Same architectural blocker as 03 — runtime hook mechanism; will also need Path-A-style infra to measure agent ergonomics. |
| 05 Context fold | future | Likely path B + path A hybrid. |
| 06 Outcome calibration | not benchable in-session | Requires production pilot accumulating ≥ 20 outcomes per pattern. |

## Disclosures

### How events were extracted
Each scenario's workspace `.tracebase/memory.db` was opened read-only after the trajectory ran. `analytics_events.payload` (TEXT) was JSON-parsed; the `event` field was matched against the `tool_supervision.*` prefix; counts were summed per event class. Code: `scripts/tool-supervision-bench/integration.ts` — function `readEvents`.

### Reproducibility
Single command from worktree root:
```powershell
.\node_modules\.bin\tsx.cmd scripts\tool-supervision-bench\integration.ts
```
Exits 0 iff 8/8 pass. Writes `bench-runs/tool-supervision/integration-results.json` (preserved alongside this report).

Smoke test (asserts mechanism fires end-to-end on a real ON workspace):
```powershell
.\node_modules\.bin\tsx.cmd scripts\tool-supervision-bench\smoke.ts
```

### Pre-registration record
- Original (Path A, agent-level): [`PRE-REGISTRATION-AGENT-INVALIDATED.md`](../../bench-runs/tool-supervision/PRE-REGISTRATION-AGENT-INVALIDATED.md) — invalidated by architectural discovery before any agent dispatch produced a measurement.
- Active (Path B, synthetic integration): [`PRE-REGISTRATION.md`](../../bench-runs/tool-supervision/PRE-REGISTRATION.md) — 8 scenarios, amendments section authoritative.

### Initial run result (before Amendment 1)
Reported in full per Amendment 1's reporting obligation:

```
Pass: 7 / 8
[FAIL] bash-not-supervised
        decision[1] mismatch: expected free, got warn
        actualDecisions: ["free","warn","free"]
        actualEvents: {"warned":1,"suppressed":1}
```

### Amendment 1 (verbatim from `PRE-REGISTRATION.md`)

> **What changed**: corrected the pre-registered `expectedDecisions` for the `bash-not-supervised` scenario from `["free", "free", "free"]` to `["free", "warn", "free"]`.
>
> **Why**: the substantive safety claim under test is *"non-safe-read tools are not blocked"* — i.e. the supervisor never returns `decision:"block"` for Bash / Edit / Write / Task. The original expectation was over-strict: it also asserted the supervisor would never attach a `systemMessage` reuse hint to a non-safe-read duplicate, but that behaviour is documented in the legacy 0.7.1+ code path (`src/cli/commands/capture-pre-tool-use.ts` line 497+ — the warned-event emit path also attaches `systemMessage` on first-hit duplicates regardless of family). The hint is a visible badge, **not** a tool-call interception, and is not part of the tier ladder.
>
> **What this is not**: not a change to mechanism code, not a change to the scenario set (still 8), not a change to the substantive safety assertion, not a change to other scenarios' expectations. The only edit is the `expectedDecisions` array for scenario 6 (`bash-not-supervised`).
>
> **What is preserved**: the **events** expectations for `bash-not-supervised` (`warned x1, suppressed x1, NO tier-ladder events`) were correct in the original PRE-REG and do not change. The **substantive constraint** `0 blocks for Bash` is verified by the decision sequence containing zero `"block"` or `"soft-redirect"` tags.

### What is NOT claimed
- **Agent-level savings.** `tool_uses` / `duration_ms` / `total_tokens` reductions are not measured here. Any such claim requires Path A. **Do not cite this bench as "reduces agent tool calls."**
- **Agent pass-rate preservation.** Not measured here. The load-bearing guardrail from the invalidated agent-level pre-reg ("pass-rate ON ≥ OFF") does not apply to this report.
- **Mode=warn or mode=strict.** Only `mode=soft` is in scope. Unit tests at `tests/cli/capture-pre-tool-use.test.ts` cover the other modes (51 passing).

Raw: [`integration-results.json`](../../bench-runs/tool-supervision/integration-results.json). Driver: [`scripts/tool-supervision-bench/integration.ts`](../../scripts/tool-supervision-bench/integration.ts). Smoke: [`scripts/tool-supervision-bench/smoke.ts`](../../scripts/tool-supervision-bench/smoke.ts).

## Verdict

**Publishable scope:** "Mechanism correctness verified on 8 scripted safe-read trajectories at mode=soft. The tier ladder fires per design; mtime bypass preserves legitimate post-edit re-reads; non-safe-read tools are never blocked."

**NOT publishable:** any agent-ergonomics / cost-reduction claim. That requires Path A and a fresh pre-registration.
