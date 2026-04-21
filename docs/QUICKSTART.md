# Quickstart

Get TraceBase running with your agent in under 2 minutes.

TraceBase keeps local memory project-scoped, but the install path can
also link the project into the hosted dashboard automatically. For a
normal developer install, you still start with one command.

---

## Claude Code

### Install

```
npx tracebase-ai init
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
   npx tracebase-ai doctor
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
npx tracebase-ai status
```

You should see non-zero counts under `retrieval` and (once a pattern
has been distilled) `injection`. Blocks start at 0 until
distillation produces its first one — see below.

### When do I get my first block?

A block comes from a distilled trace. In Phase 6.0 you can seed one
manually:

```
npx tracebase-ai store \
  -d "TypeError: Cannot read property 'map' of undefined" \
  -s "Added optional chaining on the list prop" \
  -l typescript -f react -e TypeError
```

(Full automatic distillation from real Claude Code runs comes in
Phase 6.1+; for now the manual path is how you seed.)

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

> **Status:** Phase 6.0 ships Claude Code first. Cursor parity is
> tracked for Phase 6.4+. The MCP server itself works with any
> MCP-compatible client — the blocker is a polished `init` target
> for Cursor's `~/.cursor/mcp.json`.

Manual install works today:

1. Add to `~/.cursor/mcp.json` under `mcpServers`:
   ```json
   {
     "tracebase": {
       "command": "npx",
       "args": ["-y", "tracebase-ai", "serve", "--mcp"]
     }
   }
   ```
2. Create an `AGENTS.md` in your project root with the same instruction
   block as the CLAUDE.md "Manual setup" section above.
3. Restart Cursor. Check Cursor Settings → MCP; `tracebase` should
   show a green indicator.

---

## Codex

> **Status:** Phase 6.0 ships Claude Code first. Codex parity is
> tracked for Phase 6.4+.

Manual install works today: run `codex mcp add tracebase -- npx -y tracebase-ai serve --mcp`.
Create an `AGENTS.md` in your project root. Run `codex mcp list` and
confirm `tracebase` is listed.

---

## What to do next

- `npx tracebase-ai status` — one-screen install + store snapshot.
- `npx tracebase-ai doctor` — deep verification with actionable fixes.
- `npx tracebase-ai events --limit 20` — recent retrieval / injection /
  outcome events from real agent runs.
- `npx tracebase-ai report` — aggregated metrics (coverage, hit rate,
  helpful rate, per-block top list).

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) if something's off.

---

## Custom integration

Building your own agent framework or need a custom setup? The SDK is
on npm as `tracebase-ai` — import `ReasoningLayer`, `BlockStore`,
`BlockServer` and wire them however you want. The MCP server in this
repo is one reference integration; the library is fully usable without
it.
