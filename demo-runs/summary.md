# YC demo — TraceBase OFF vs ON

Generated: 2026-05-01T11:07:44.642Z

Each task ran twice against an identical model + verifier. The OFF variant had no `tracebase inject-context` hook, no PreToolUse supervision, no Stop capture. The ON variant ran the normal TraceBase runtime. The verifier is a real shell command run against a freshly-reset workspace; the agent-side metrics come from the recorded transcript at `demo-tasks/<task>/runs/<variant>.json`.

## recurring-pipeline-failure

Off model: claude-haiku-4-5-20251001 · On model: claude-haiku-4-5-20251001 · token source: off=estimate / on=estimate
Notes: off=Synthetic baseline — agent loops on Grep / Read across the repo trying to localize the KeyError, never reaches the case-fix. Numbers illustrative. · on=Synthetic — TraceBase recalls prior CSV DictReader case-sensitivity pattern; agent skips diagnosis, edits row['amount'] → row['AMOUNT'], reruns. Numbers illustrative.

| Metric | OFF | ON | Δ |
|---|---:|---:|---:|
| Wall-clock (ms) | 47200 | 9300 | +37900 |
| Tokens (total) | 7500 | 1670 | +5830 |
| TraceBase injected tokens | — | 240 | — |
| **Net tokens saved (Δ − injected)** | — | — | **+5590** |
| Tool calls | 14 | 4 | +10 |
| Duplicate tool calls | 4 | 0 | +4 |
| Blocked tool calls (supervision) | — | 0 | — |
| TraceBase overhead (ms) | — | 60 | — |
| Verifier | FAIL | PASS | off-fail-on-pass |

## search-read-loop

Off model: claude-haiku-4-5-20251001 · On model: claude-haiku-4-5-20251001 · token source: off=estimate / on=estimate
Notes: off=Synthetic baseline — agent re-greps and re-reads the same files multiple times, never connects the test failure to the off-by-one in main.ts. Numbers illustrative. · on=Synthetic — TraceBase injects the prior 'arr[i+1] off-by-one' pattern, agent goes directly to main.ts; safe-read dedup blocks 3 redundant re-reads. Numbers illustrative.

| Metric | OFF | ON | Δ |
|---|---:|---:|---:|
| Wall-clock (ms) | 31800 | 8100 | +23700 |
| Tokens (total) | 6080 | 1475 | +4605 |
| TraceBase injected tokens | — | 210 | — |
| **Net tokens saved (Δ − injected)** | — | — | **+4395** |
| Tool calls | 17 | 5 | +12 |
| Duplicate tool calls | 6 | 1 | +5 |
| Blocked tool calls (supervision) | — | 3 | — |
| TraceBase overhead (ms) | — | 55 | — |
| Verifier | FAIL | PASS | off-fail-on-pass |
