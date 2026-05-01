# YC demo — TraceBase OFF vs ON · Synthetic fixtures (illustrative)

Generated: 2026-05-01T11:24:58.537Z

Each task ran twice against the same model, prompt, and verifier. The agent-side metrics come from synthetic transcripts checked into `demo-tasks/<task>/runs/<variant>.json` — they are illustrative for the harness contract and **must not** be used in any external demo. Replace them with real-agent recordings via `scripts/demo-real-runner.ts` for the YC overlay. The verifier is real either way: state-off is broken, state-on is fixed, so the off-fail-on-pass column is honest in both modes.

## recurring-pipeline-failure  ·  _Synthetic fixture — illustrative numbers only_

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

## search-read-loop  ·  _Synthetic fixture — illustrative numbers only_

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
