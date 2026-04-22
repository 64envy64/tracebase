# Quickstart

Get TraceBase running with your agent in under 2 minutes.

TraceBase keeps local memory project-scoped, but the install path can
also link the project into the hosted dashboard automatically. For a
normal developer install, you still start with one command.

---

## Claude Code

### Install

```
npx tracebase init
```

1. Run the command above in your project directory — it creates
   `.tracebase/config.json`, adds TraceBase to `.claude/settings.json`
   (project-local), and writes a managed instruction block into
   `CLAUDE.md`.
2. If you are already signed into TraceBase in the browser, `init`
   can open a short approval page and finish the hosted link
   automatically. If you ignore it, local install still completes.
3. Restart Claude Code.
4. Run `/tools` in Claude Code and confirm `get_reasoning_patterns`
   is listed.
5. Verify install health:
   ```
   npx tracebase doctor
   ```

> The MCP server entry, CLAUDE.md instruction block, and
> `.tracebase/` store are all **project-local**. Re-run `init` in
> each project where you want TraceBase active. A project-wide
> global install is deliberately not supported — TraceBase's
> correctness guarantees depend on per-project scoping.

### What the install changes

| File | Purpose |
|---|---|
| `.tracebase/config.json` | Storage path + stable `workspaceId` (UUID) + optional hosted workspace link |
| `.tracebase/memory.db` | SQLite event/block/fact store (created on first write) |
| `.claude/settings.json` | Adds `mcpServers.tracebase` entry (merge-safe) |
| `CLAUDE.md` | Managed `tracebase:begin … :end` section with usage instructions |

All four are idempotent. Re-running `init` preserves your
`workspaceId`, preserves any other `mcpServers` entries or
permissions, and rewrites **only** the content between the
`tracebase:begin` / `:end` markers in `CLAUDE.md`.

### Verify it's working

After a Claude Code session that touched a coding task:

```
npx tracebase status
```

You should see non-zero counts under `retrieval` and (once a pattern
has been distilled) `injection`. Blocks start at 0 until
distillation produces its first one — see below.

### When do I get my first block?

A block comes from a distilled trace or a manual seed. On a fresh
project it is normal for `status` to show zero active blocks until the
first useful run is captured and promoted. If you want a known-good
seed immediately, add one manually:

```
npx tracebase store \
  -d "TypeError: Cannot read property 'map' of undefined" \
  -s "Added optional chaining on the list prop" \
  -l typescript -f react -e TypeError
```

Once real runs begin flowing, retrieval, injection, usage, and outcome
events accumulate in the same local store and feed later reuse
analytics.

### Manual setup (if `init` is not available in your environment)

1. Create `.tracebase/config.json`:
   ```json
   {
     "workspaceId": "<uuid>",
     "storagePath": ".tracebase/memory.db"
   }
   ```
2. Add to `.claude/settings.json` under `mcpServers`:
   ```json
   {
     "tracebase": {
       "command": "npx",
       "args": ["-y", "tracebase-ai", "serve", "--mcp"]
     }
   }
   ```
3. Append to `CLAUDE.md`:
   ```
   <!-- tracebase:begin (managed section — do not edit between markers) -->
   ## TraceBase reasoning layer

   When you start a debugging, bug-fixing, or problem-solving task:
   1. Call `get_reasoning_patterns` first with a short description.
   2. The response is a hypothesis — verify, don't apply blindly.
   3. If no patterns match, proceed normally.

   When you finish:
   1. Call `record_reasoning_outcome` with the queryId.
   2. Report `usedPattern` and `resolved`.
   <!-- tracebase:end -->
   ```
4. Restart Claude Code. Confirm `get_reasoning_patterns` appears in
   `/tools`.

---

## Cursor

### Install

```
npx tracebase init
```

1. Run the command above in your project directory — `init` auto-detects
   Cursor if it is installed locally and writes `~/.cursor/mcp.json`
   plus an `AGENTS.md` instruction block in the project.
2. Restart Cursor.
3. Open Cursor Settings → MCP and confirm `tracebase` is healthy.

> Cursor uses the same local store and hosted dashboard link as Claude
> Code. The only difference is the last-mile adapter surface:
> `~/.cursor/mcp.json` + `AGENTS.md`.

---

## Codex

### Install

```
npx tracebase init
```

1. Run the command above in your project directory — if the `codex`
   CLI is available on PATH, `init` auto-detects Codex and registers
   TraceBase via `codex mcp add`, plus writes the managed `AGENTS.md`
   block in the project.
2. Run `codex mcp list` and confirm `tracebase` is listed.
3. Start a fresh Codex session in the project.

> Codex uses the same core path as the other adapters. The only
> difference is MCP registration happens through the `codex mcp`
> registry instead of a JSON file.

---

## What to do next

- `npx tracebase status` — one-screen install + store snapshot.
- `npx tracebase doctor` — deep verification with actionable fixes.
- `npx tracebase events --limit 20` — recent retrieval / injection /
  outcome events from real agent runs.
- `npx tracebase report` — aggregated metrics (coverage, hit rate,
  helpful rate, per-block top list).
- `npx tracebase remove` — uninstall the local project wiring cleanly.

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) if something's off.

---

## Custom integration

Building your own agent framework or need a custom setup? The SDK is
on npm as `tracebase-ai` — import `ReasoningLayer`, `BlockStore`,
`BlockServer` and wire them however you want. The MCP server in this
repo is one reference integration; the library is fully usable without
it.
