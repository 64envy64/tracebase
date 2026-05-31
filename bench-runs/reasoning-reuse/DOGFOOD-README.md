# Runtime dogfood accumulation — operator guide

Goal: accumulate **organic** reasoning-reuse evidence from real TraceBase
development sessions over time, then read readiness with one command. No paid
benchmark trajectories; no random-bug mining. Capture is asynchronous,
fail-safe, and privacy-preserving.

## 1. Capture is ON for dev sessions (Stop hook)
The project `.claude/settings.json` already runs a **Stop hook** that captures one
distilled reasoning pattern per completed turn into `.tracebase/memory.db`:
- **asynchronous + fail-safe** — short timeout, best-effort; a capture failure
  never blocks or slows your session.
- **privacy-preserving** — only the *distilled, leakage-scanned* situation /
  mechanism / unlock are stored; raw prompts and secrets are rejected by the
  capture gate, and the exported manifest carries only hashes (`situationHash`).
  The monitor reports `raw prompts stored: 0`.

### Dogfooding the LOCAL (in-development) code
The shipped Stop hook uses the published package. To exercise the code *in this
worktree* instead (true dogfood of local changes), add a local override in
`.claude/settings.local.json` (per-developer, not committed):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{
      "type": "command",
      "command": "node_modules/.bin/tsx bin/cli.ts capture-turn --host claude-code --capture compact",
      "timeout": 8
    }] }]
  }
}
```

This captures into the worktree's `.tracebase/memory.db`. (`--setting-sources
project,local` is the default; the local file wins.)

## 2. Read accumulation + readiness — one command
```
npx tsx scripts/reasoning-precision/dogfood-monitor.ts            # human summary
npx tsx scripts/reasoning-precision/dogfood-monitor.ts --json     # machine
npx tsx scripts/reasoning-precision/dogfood-monitor.ts --db <path>
```
Reports: `captured` (runtime/imported) · `deduped` · `attributed` ·
`recurring-family count` · `fired` · `precision-ready` · `privacy rejects` ·
`calibrator coverage`, plus the **locked readiness gate**. Exit code: `0` READY,
`2` NOT READY.

It prints **READY only when the locked organic gate is truly met**:
`≥50 runtime captures`, `≥30 precision-ready`, `precision@fire ≥0.90`,
`Wilson-LB ≥0.80`, `FP ≤0.05`. Quality is computed from stored telemetry events
(no raw query text, no recall re-run).

## 3. The precondition to watch: recurring families
Reasoning *reuse* can only fire when a problem **recurs** (a captured family gets
a second, distinct instance). The monitor reports `recurring families (≥2
captures)` via a deterministic, generic fingerprint over distilled block content
(`src/eval/family-fingerprint.ts`). Until that count climbs, precision-ready will
stay ~0 regardless of capture volume — this was the binding finding of the
arbitrary-distinct-bug capture run (`CAPTURE-RUN-AUDIT.md`).

## 4. What this is NOT
No GitHub sync/webhooks, no serving-gate changes, no paid dispatch, no SWE-bench.
This is local runtime accumulation + observability only. When recurring families
and precision-ready actually accumulate to the gate, the monitor will say READY —
that is the trigger for the next (separately-budgeted) evaluation decision.
