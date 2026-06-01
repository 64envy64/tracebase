# Local-code Router V2 shadow dogfood

Exercise the **unpushed worktree** Router V2 implementation against your own
Claude Code traffic in **shadow** mode: keep serving the V1 decision (injected
context unchanged) while recording the side-by-side V2-family comparison
locally. Nothing here pushes commits, spends API budget, downloads models, or
enables Router V2 `on`.

> Default everywhere is `off`. Shadow is opt-in and local-only.

## What's here

| File | Purpose | Committed? |
|---|---|---|
| `shadow-inject-context.mjs` | Cross-platform wrapper: runs the **worktree** `inject-context` CLI with `TRACEBASE_REASONING_ROUTER=shadow`, forwarding hook stdin/stdout/exit code. | yes (tooling) |
| `smoke-shadow-hook.ts` | `$0` deterministic smoke that drives the real hook command and verifies the shadow contract. | yes (tooling) |
| `.claude/settings.local.json` (UserPromptSubmit) | The actual activation. | **no — gitignored, you apply it** |

The published `.claude/settings.json` (shared, checked-in) runs
`npx -y tracebase-ai@latest …` — the **published package**, not this worktree.
To dogfood the worktree you add a **local** hook that runs the worktree CLI.

## Verify the contract first (no activation needed)

```bash
npx tsx scripts/dogfood/smoke-shadow-hook.ts
```

This seeds a throwaway store, invokes the worktree `inject-context` CLI exactly
as the hook would (stdin payload + `TRACEBASE_REASONING_ROUTER=shadow`), and
asserts: the served envelope is **V1-identical** (modulo per-recall ids), exactly
**one** local `router.shadow_comparison` event is written with populated V2
fields, **no** raw prompt/body/path/secret is persisted, the cloud sanitizer
strips a shadow-shaped object whole, and `router-shadow-report.ts` runs.

## Activate the live hook (local, gitignored)

`.claude/` is gitignored, so `.claude/settings.local.json` is local-only. Add a
`UserPromptSubmit` hook that runs the wrapper (the **Stop** capture on the
worktree CLI is already present in that file — keep it):

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/worktrees/interesting-mcclintock-a69a77/scripts/dogfood/shadow-inject-context.mjs",
            "timeout": 15,
            "statusMessage": "▣ TB DOGFOOD  shadow (local code)"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx tsx bin/cli.ts capture-turn --host claude-code --capture compact",
            "timeout": 8,
            "statusMessage": "▣ TB DOGFOOD  capturing (local code)"
          }
        ]
      }
    ]
  }
}
```

Notes:

- **Timeout** is 15s (not 5s): a cold `npx tsx` start is slower than the
  published binary. The wrapper sets the env in Node, so it is portable to
  Windows (inline `VAR=val` hook prefixes are not).
- The wrapper resolves `bin/cli.ts` relative to itself, so the path works from
  any cwd; adjust the `command` path if your worktree lives elsewhere.

## ⚠ Avoid duplicate hooks — verify the effective set

Claude Code's merge behavior for hooks defined in **both** `settings.json`
(shared) and `settings.local.json` (local) is **not definitively documented**
(concatenate vs. override), and there is **no selective per-hook disable** (only
`disableAllHooks`). So a local `UserPromptSubmit` may run **in addition to** the
published one → **double injection**.

Before relying on it:

1. Open Claude Code and run **`/hooks`**. Confirm `UserPromptSubmit` resolves to
   the worktree wrapper **once**, not the published command too.
2. If both appear, either accept the duplicate for dogfood, or **locally**
   remove the published `UserPromptSubmit` block from the shared
   `.claude/settings.json` for your session — **do not commit** that change.

## Inspect the shadow traffic

```bash
npx tsx scripts/reasoning-precision/router-shadow-report.ts            # default project store
npx tsx scripts/reasoning-precision/router-shadow-report.ts --json     # machine-readable
```

The report separates **organic** (runtime-captured) from **bootstrap**
(imported) traffic and lists readiness blockers. Bootstrap shadow traffic never
counts toward organic readiness.

## Safety / privacy

- Shadow **serves V1** — the agent's injected context is unchanged.
- The comparison event is **local-only** (never in the cloud `UsageMetrics`
  aggregate) and privacy-safe: queryHash, opaque block ids, and counts only.
- A V2 failure **fails open** to V1 and records only a closed-enum fallback
  class (`error | validation | timeout | unknown`) — never a raw exception
  message. Set `TRACEBASE_DEBUG=1` to see the raw message on stderr (not
  persisted).
- `tracebase doctor` shows the effective rollout mode under the
  `reasoning-router` check.

## Turn it off

Remove the `UserPromptSubmit` block from `.claude/settings.local.json` (or unset
`TRACEBASE_REASONING_ROUTER`). The Stop capture can stay.
