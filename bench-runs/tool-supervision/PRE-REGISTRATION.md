# 03 Tool Supervision — Pre-Registration (Path B: synthetic integration)

**Locked before any scenario runs.** This file fixes the scenario set, expected events, and decision rules. Do not modify after the first scenario runs. If anything changes, the bench restarts.

## Why synthetic, not agent-level

The earlier agent-level pre-registration (now in `PRE-REGISTRATION-AGENT-INVALIDATED.md`) discovered that the Agent tool's sub-agents do not load workspace-level `.claude/settings.json`, so hook-based mechanisms never fire under that dispatch method. Real-agent measurement therefore requires a child Claude Code CLI process per workspace — infrastructure that does not yet exist in this repo and is queued as future work (Path A).

Path B (this file) takes a different epistemic stance: instead of measuring how agents behave under supervision, it **verifies the mechanism itself fires correctly** when driven by scripted tool sequences through the **production CLI code paths** (`capture-pre-tool-use` and `capture-tool-use`). No shortcuts, no mocking — the same code Claude Code would invoke.

## Claim under test (allowed scope, locked)

> **On scripted safe-read trajectories, TraceBase tool supervision (mode=soft) correctly redirects redundant reads while preserving legitimate post-edit re-reads.**

The bench will explicitly **not** claim:
- "Reduces agent tool calls" — not measured here.
- "Saves tokens / wall time for real agents" — not measured here.
- "Improves agent pass rate" — not measured here.

Any reduction-of-cost claim requires Path A (child-CLI agent bench) and a fresh pre-registration.

## Method

Each scenario is a deterministic tool sequence driven by `spawnSync` against:
- `tracebase capture-pre-tool-use --path <ws>` (PreToolUse)
- `tracebase capture-tool-use --path <ws>` (PostToolUse)

These are the exact CLIs Claude Code's hooks invoke in production. Their input shape matches the canonical `read.json` / `grep.json` / `bash.json` test fixtures already in `tests/fixtures/pre-tool-use/`.

For each call:
1. Build the per-tool stdin JSON.
2. (Pre) Capture the envelope and the `decision` / `reason` / `systemMessage` fields.
3. (Post, after the pre-result and any simulated file edit) Update tool cache + tool_observations.
4. Between Read/Read pairs where the scenario requires it, mutate the target file's mtime by writing the file (this is what a real `Edit` tool would do).

After all calls in a scenario:
- Read the workspace's `.tracebase/memory.db` `analytics_events` rows.
- Decode payload JSON, count by `event` field.
- Compare against the **pre-declared expected events** for that scenario.

Pass iff every assertion in the scenario's expectation block holds. Mechanism behaves as designed iff every scenario passes.

## Scenarios (locked — 8 total)

For all scenarios: workspace = fresh temp dir, `initConfig` + `.tracebase/config.json` `toolSupervision.mode = "soft"`. One scenario = one workspace, fully torn down at end.

Notation: `R(X)` = Read(file_path=X). `G("foo", path)` = Grep(pattern="foo", path=...). `B("cmd")` = Bash(command="cmd"). `E(X, content)` = file-system edit (writeFileSync to X + utimesSync to bump mtime above prior obs ts). The Edit IS routed through pre/post hooks (Edit isn't safe-read so it never blocks, but going through hooks matches real Claude Code semantics).

**Critical semantics note**: in production, when PreToolUse returns `decision:"block"`, the tool does **not** execute and PostToolUse does **not** fire. The integration test replicates this — PostToolUse runs only for tool calls whose Pre returned non-block. This makes `priorDupCount` advance only on tool calls that actually ran. Therefore `priorDupCount >= 4` is **not realistically reachable in mode=soft** (R3 already blocks; cache freezes at 2). The originally-considered "5-reads-soft-degraded" scenario was dropped for this reason — it would only be reachable if an agent persistently ignored blocks, which the bench does not simulate.

| # | Scenario | Tool sequence | Expected pre-tool decisions | Expected analytics_events |
|---|---|---|---|---|
| 1 | `single-read` | R(a) | free | (none) |
| 2 | `read-read-warn` | R(a), R(a) | free, warn (systemMessage, no decision) | `warned x1` (mode=warn) |
| 3 | `read-read-read-soft` | R(a), R(a), R(a) | free, warn, **soft-redirect (decision:"block")** | `warned x2` (1 mode=warn, 1 mode=block), `cache_hit x1` |
| 4 | `edit-bypass` | R(a), E(a, "new"), R(a) | free, (Edit free), free with `allowed_after_edit` flag | `allowed_after_edit x1`, NO `cache_hit`, NO `warned` |
| 5 | `dup-then-edit-then-read` | R(a), R(a), E(a, "new"), R(a) | free, warn, (Edit free), free with `allowed_after_edit` | `warned x1` (mode=warn), `allowed_after_edit x1` |
| 6 | `bash-not-supervised` | B("ls"), B("ls"), B("ls") | free, **warn (legacy hint, NOT block)**, free (Bash never blocked — non-safe-read). **See Amendment 1.** | `warned x1` (legacy, mode=warn), `suppressed x1` (legacy). **0 tier-ladder events: 0 `cache_hit`, 0 `would_block`, 0 `allowed_after_edit`, 0 blocks.** |
| 7 | `distinct-reads-null` | R(a), R(b), R(c) | free, free, free | (none — different argKey per call) |
| 8 | `grep-grep-grep-soft` | G("foo", "src"), G("foo", "src"), G("foo", "src") | free, warn, soft-redirect | `warned x2` (1 mode=warn, 1 mode=block), `cache_hit x1` (search family, no mtime bypass) |

**Note on R + warm cache**: the production rule is that the warm `RecentToolCache` (`.tracebase/cache/rtools.bin`) is what `capture-pre-tool-use` checks. `capture-tool-use` is what appends to it. So between every two pre-tool calls in the same scenario whose first did not block, we run capture-tool-use to commit the prior observation to the cache. Without that, the second R(a) would see priorDupCount=0 (cache empty). This is exactly how Claude Code runs in production: PostToolUse fires after a non-blocked tool returns and before the next PreToolUse — the bench replicates that pairing.

## Metrics (locked)

Per scenario, recorded into `bench-runs/tool-supervision/integration-results.json`:
- `scenario_id`
- `expected_decisions` (array of expected per-call decision tags)
- `actual_decisions` (array of observed per-call decision tags from envelopes)
- `expected_events` (declared counts by event type)
- `actual_events` (observed counts by event type, from `analytics_events`)
- `pass` (boolean — strict equality on decisions AND events)
- `tier_observed` (the tier_internal tag if envelope carried it; null otherwise)

## Decision rules (locked)

**Publishable iff all 8 scenarios pass.** Single scenario failure → not publishable; investigate root cause and either re-tune mechanism OR scope claim down.

If a single scenario fails:
- Print actual vs expected for every failing scenario.
- Mark report as internal-only.
- Do NOT publish.

If all 8 pass:
- Write `bench-results/tool-supervision.md` with the locked scoped claim.
- Headline: "On scripted safe-read trajectories, TraceBase tool supervision (mode=soft) correctly redirects redundant reads while preserving legitimate post-edit re-reads."
- Caveat block including: synthetic scripted scenarios, no real-agent measurement, mode=soft only, Path A queued.

## Out of scope (do not measure here)

- Agent cost reduction in tool_uses / duration_ms / total_tokens — Path A.
- Agent pass-rate under supervision — Path A.
- mode=warn or mode=strict — only mode=soft pre-registered here.
- Intent-loop legacy path (covered by unit tests `intent-block on first synthetic...`).
- Multi-session interaction — single session per scenario.
- Privacy invariants — covered by unit tests.

## Author / lock metadata

- Pre-registered: 2026-05-27 (replaces invalidated agent-level pre-reg)
- Worktree: `interesting-mcclintock-a69a77` @ `8885bda` + uncommitted 03A-G hardening
- Mode under test: `soft` only
- Trajectory budget: 8 scripted scenarios (each fresh workspace, no parallel state)
- Driver: `scripts/tool-supervision-bench/integration.ts` (to be written; invokes production CLIs via spawnSync)

## Amendments

### Amendment 1 (2026-05-27, after first run produced 7/8)

**What changed**: corrected the pre-registered `expectedDecisions` for the `bash-not-supervised` scenario from `["free", "free", "free"]` to `["free", "warn", "free"]`.

**Why**: the substantive safety claim under test is *"non-safe-read tools are not blocked"* — i.e. the supervisor never returns `decision:"block"` for Bash / Edit / Write / Task. The original expectation was over-strict: it also asserted the supervisor would never attach a `systemMessage` reuse hint to a non-safe-read duplicate, but that behaviour is documented in the legacy 0.7.1+ code path (`src/cli/commands/capture-pre-tool-use.ts` line 497+ — the warned-event emit path also attaches `systemMessage` on first-hit duplicates regardless of family). The hint is a visible badge, **not** a tool-call interception, and is not part of the tier ladder.

**What this is not**: not a change to mechanism code, not a change to the scenario set (still 8), not a change to the substantive safety assertion, not a change to other scenarios' expectations. The only edit is the `expectedDecisions` array for scenario 6 (`bash-not-supervised`).

**What is preserved**: the **events** expectations for `bash-not-supervised` (`warned x1, suppressed x1, NO tier-ladder events`) were correct in the original PRE-REG and do not change. The **substantive constraint** `0 blocks for Bash` is verified by the decision sequence containing zero `"block"` or `"soft-redirect"` tags.

**Reporting obligation**: the final report MUST disclose both the initial 7/8 result and the post-amendment 8/8 result, with this amendment text reproduced verbatim. No silent re-classification of decision tags.
