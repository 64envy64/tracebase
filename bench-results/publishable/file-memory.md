# TraceBase 02 — Semantic File Memory (isolated bench)

**Tracebase 0.9.0 · 3 multi-file TypeScript tasks · file-memory mechanism only**

## Headline

> **On small multi-file tasks where the workspace is pre-indexed, TraceBase file memory eliminated directory-discovery calls while preserving pass rate and keeping net token cost flat.**
>
> Glob/Grep: 3 → 0 (−100 %). Wall time: 449 s → 377 s (−16.1 %, aggregate). Tokens: 69 391 → 69 148 (−0.4 %, ~flat). Pass rate: 3/3 → 3/3 (unchanged).

The Glob→0 effect is what the file_memory mechanism is designed for: the agent already has a structural map of the workspace, so it doesn't run directory-listing. **Reads did not drop** — it's "agent does not have to search for which files to read", not "agent stops reading".

## Caveats up front

These caveats matter for how the result should be read:

1. **N=3 task pairs, N=1 trajectory per cell.** Per-task wall-time variance is ±15-30 s; the aggregate effect is consistent with the mechanism but the small-sample band is real.
2. **One task (alpha) actually regressed slightly** on tools and time (OFF 8 / 159 s → ON 9 / 175 s). Aggregate −16 % comes from beta and gamma. Per-task variance in the table is the honest picture; **do not claim "always faster"**.
3. **Per-tool breakdowns (Read, Glob, Grep, Edit, Bash) are agent self-reports**, cross-checked against the harness's total `tool_uses`. The harness reports an authoritative total but not a per-tool split; the next bench should pull per-tool counts from the SDK trace instrumentation directly.
4. **Tasks are deliberately small** (≤ 5 files each, pre-indexed). This is not a long-repo retrieval stress test. On a 10k-file repo, file_memory's *retrieval* would also have to filter — that's not measured here.
5. **The workspace was pre-indexed via direct `indexWorkspace` call** before the agent run. In production, file_memory accumulates incrementally from PostToolUse capture. The shape of indexed rows is the same; the timing isn't.

## What this measures

This bench isolates **semantic file memory** — the mechanism by which TraceBase indexes a workspace's files into structured summaries (filename, first line, exported symbols, imports) and injects relevant ones into the agent's prompt at session start. Reasoning-reuse, tool supervision, loop redirection, and context fold are **disabled** so the only intervention between OFF and ON is file_memory.

The hypothesis under test: *file_memory should reduce filesystem-exploration tool calls (Glob, Grep) without inflating total token cost.*

## Isolation method

- `.claude/settings.json` for ON variants includes **only** `UserPromptSubmit → inject-context`. No `PreToolUse`, no `PostToolUse`, no `PreCompact`, no `Stop`. This disables tool supervision, capture-pre-tool-use, loop-redirect, context-fold, and outcome calibration at the hook level.
- The `.tracebase/memory.db` is populated **only** with `indexed_files` rows (via `indexWorkspace`). The `reasoning_blocks` table stays empty — disabling the reasoning-reuse lane.
- The retrieval/gate code path is the production `recallFiles` from `src/runtime/recall.ts` + the `<file_memory>` section renderer in `build-injection-payload.ts`. Same code as production.
- OFF workspaces have no `.tracebase/` at all.

## Tasks

| Task | Files | Bug |
|---|---|---|
| alpha-http-retry | 5 files (types, retry, client, retry.test, vitest.config) | `computeBackoff` returns base delay flat instead of applying `Math.pow(factor, attempt)` |
| beta-slug | 4 files (case, slug, slug.test, vitest.config) | `slug()` strips non-ASCII chars instead of folding them; `asciiFold` is defined but not used |
| gamma-ttl-cache | 4 files (lru, ttl, ttl.test, vitest.config) | `TtlCache.set` never reaps expired entries; size grows unbounded under write-only load |

## Probe — what file_memory injects

Production `inject-context` against each ON workspace surfaces 3 file summaries per query (avg 530 bytes inject text, 130 tokens). The injection contains filename, first line, and exported/imported symbols — **not** full file content. Example for alpha-http-retry:

```
<file_memory>
• vitest.config.mjs: vitest.config.mjs (javascript). First line: export default { test: { include: ["src/**/*.test.ts"] } };
• src/http/retry.test.ts: retry.test.ts (typescript). First line: import { describe, it, expect } from "vitest"; imports: vitest, ./retry, ./types
• src/http/client.ts: client.ts (typescript). First line: import type { HttpResponse, RequestOptions, RetryConfig } from "./types.js"; exports: HttpClient; imports: ./types.js, ./retry.js
</file_memory>
```

The agent gets a structural overview without having to discover the layout via Glob.

## Per-task results

| Task | Variant | Pass | tool_uses | duration | tokens | Read | **Glob** | Grep | Edit | Bash |
|---|---|:-:|---:|---:|---:|---:|---:|---:|---:|---:|
| alpha-http-retry | OFF | ✓ | 8 | 159.1 s | 23 345 | 3 | **1** | 0 | 1 | 2 |
| alpha-http-retry | ON  | ✓ | **9** | **174.9 s** | 23 388 | 3 | **0** | 0 | 1 | 4 |
| beta-slug | OFF | ✓ | 7 | 147.1 s | 22 606 | 3 | **1** | 0 | 1 | 1 |
| beta-slug | ON  | ✓ | 6 | **99.4 s** | 22 407 | 3 | **0** | 0 | 1 | 1 |
| gamma-ttl-cache | OFF | ✓ | 7 | 142.7 s | 23 440 | 4 | **1** | 0 | 1 | 1 |
| gamma-ttl-cache | ON  | ✓ | 6 | **102.3 s** | 23 353 | 4 | **0** | 0 | 1 | 1 |

Note `alpha` ON: +1 tool use, +15 s vs OFF. Beta and gamma each saved ~50 s. The aggregate effect is real but not uniform; this is the honest per-task picture, not a "every task is faster" claim.

## Aggregate

|  | OFF | ON | Δ |
|---|---:|---:|---:|
| Pass rate | 3/3 | 3/3 | 0 |
| **Filesystem exploration (Glob+Grep)** | **3** | **0** | **−100 %** |
| Total tool_uses | 22 | 21 | −4.5 % |
| Total duration | 449 s | 377 s | **−16.1 %** |
| Total tokens | 69 391 | 69 148 | **−0.4 %** (~flat) |
| Read tool calls | 10 | 10 | 0 |

## Reading guide

1. **"Glob → 0, 3/3 tasks"** — this is the deterministic mechanism effect. The agent has a structural map injected, so it skips directory listing.
2. **Reads did not drop.** This is *not* "agent does not have to read files". It's "agent does not have to search for which files to read".
3. **Net tokens flat (−0.4 %).** The ~130-token injection per task is balanced by the saved Glob-output tokens. file_memory does not inflate context.
4. **Wall-time aggregate −16 %.** Not from tool-call count (only −4.5 %) but from cheaper trajectories: less time parsing Glob output, faster path to the target file.
5. **Pass rate identical.** Three out of three OFF agents also solved the tasks. This bench measures cost reduction at saturated accuracy.

## How this fits the full TraceBase savings narrative

| Mechanism | Bench | Status |
|---|---|---|
| 01 Reasoning reuse | `lift.md` ablation | Risky steering at small captured-corpus scale (oracle ceiling −5 % tools / floor +10 %). Precision insufficient for net-positive expected value. Internal diagnostic only. |
| **02 Semantic file memory** | **this bench** | **Glob 3→0 on isolated 3-task suite, wall-time −16 %, tokens flat, pass-rate unchanged. Publishable.** |
| 03 Tool supervision | next | Designed: 20 tasks where baseline issues redundant tool calls; measure blocked-call rate without pass-rate drop. |
| 04 Loop detection | future | Designed: 10 loop-prone tasks; p95 trajectory length contraction. |
| 05 Context fold | future | Designed: 3 long-horizon (25+ turn) tasks; coherence preserved at lower token cost. |
| 06 Outcome calibration | not benchable in-session | Requires production pilot accumulating ≥ 20 outcomes per pattern. |

## Disclosures

- Workspace pre-indexing was via direct `indexWorkspace` (production summarizer = heuristic). In a deployment, file_memory accumulates incrementally from PostToolUse capture as agents work. Same row shape; different timing of accumulation.
- The bench tasks are deliberately small (≤ 5 files). On a real codebase the absolute Glob savings would be larger but the *relative* effect should hold by construction (the agent has a structural map either way; the question is whether retrieval still surfaces relevant entries — not measured here).
- Numbers (`tool_uses`, `duration_ms`, `total_tokens`) from the Claude Code Agent harness — authoritative. Per-tool breakdown from agent self-reports; sums cross-check with harness `tool_uses` within ±1. **Next bench should pull per-tool counts from the SDK trace directly rather than via self-report.**
- All 6 trajectories post-hoc verified by running vitest against the modified workspace.

Raw: [`file-memory.json`](file-memory.json). Per-injection probe: [`bench-runs/file-memory/probe-injections/`](../../bench-runs/file-memory/probe-injections/). Workspaces: [`bench-runs/file-memory/workspaces/`](../../bench-runs/file-memory/workspaces/).
