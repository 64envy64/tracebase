# Quickstart

Get TraceBase running with your agent in under 2 minutes.

One command in your project directory wires up the local store, the
agent's MCP surface, and the managed instruction block — no manual
edits required.

```
npx tracebase init
```

`init` is interactive by default: an arrow-key picker lets you choose
Claude Code, Cursor, Codex, or any combination.

To install a specific agent non-interactively:

```
npx tracebase init --agent claude-code
npx tracebase init --agent cursor
npx tracebase init --agent codex
npx tracebase init --all                      # every adapter at once
```

Optional — link the project to the hosted dashboard:

```
npx tracebase init --api-key <your-key>
# or
TRACEBASE_API_KEY=<your-key> npx tracebase init
```

Without an API key, TraceBase runs **local only**. Recall, injection,
and outcome tracking all work; only the cross-project dashboard is
disabled until you link.

---

## Claude Code

```
npx tracebase init --agent claude-code
```

1. Restart Claude Code.
2. Run `/mcp` and confirm `tracebase` shows up as a connected server.
3. Run `/tools` and confirm `get_reasoning_patterns` is listed.
4. Verify: `npx tracebase status` · `npx tracebase doctor`

**What changed:** `.tracebase/config.json`, managed block appended to
`CLAUDE.md`, and a local-scope registration in the `claude mcp` runtime
registry — `init` invokes `claude mcp add tracebase --scope local -- npx
-y tracebase-ai@latest serve --mcp` for you, so there's nothing to edit
by hand. The `@latest` pin forces npx through the npm registry so the
command works identically from any directory, including inside a
monorepo that happens to have a local `tracebase-ai` package. (Legacy
installs that wrote to `.claude/settings.json` are harmless but inert;
`init` sweeps the stale entry on re-run.)

If the `claude` CLI isn't on `PATH`, `init` reports an explicit error
and non-zero exit — it will not silently succeed.

## Cursor

```
npx tracebase init --agent cursor
```

1. Restart Cursor.
2. Open Cursor Settings → MCP and confirm `tracebase` is healthy.
3. Verify: `npx tracebase status` · `npx tracebase doctor`

**What changed:** `.tracebase/config.json`, `~/.cursor/mcp.json`
(merge-safe), managed block appended to `AGENTS.md`.

## Codex

```
npx tracebase init --agent codex
```

1. Start a fresh Codex session in the project.
2. Run `codex mcp list` and confirm `tracebase` is listed.
3. Verify: `npx tracebase status` · `npx tracebase doctor`

**What changed:** `.tracebase/config.json`, Codex MCP registry
entry (via `codex mcp add`), managed block in `AGENTS.md`.

If the `codex` CLI isn't on `PATH`, `init` reports an explicit error
and non-zero exit — it will not silently succeed.

---

## Verify the install

| Command | What it shows |
|---|---|
| `npx tracebase status` | One-screen snapshot: workspace id, wired adapters, local storage, events, cloud link state |
| `npx tracebase doctor` | Deep health check — flags broken config, missing MCP entries, missing instruction blocks, incomplete registrations |
| `npx tracebase events --limit 20` | Most recent retrieval / injection / outcome events from real agent runs |
| `npx tracebase report` | Aggregated reuse metrics from the local event log |

After restarting your agent, run a coding task. `status` should start
showing non-zero `retrieval` counts. Once the agent calls
`record_reasoning_outcome`, you'll see `outcome` events too.

**Capture is explicit.** The managed instruction block tells the agent
to call `store_reasoning_pattern` when it resolves a novel case — that
is how reusable patterns land in the retrieval store and future agents
start compounding on prior work. Without this call, outcomes are
recorded but no new patterns appear in `status` → `Blocks`. The
dashboard's "Patterns" view fills the same way: after a few captured
solves, not after the first resolved outcome.

---

## Hosted dashboard

With an API key linked, `init` registers one installation per agent.
Push rolled-up usage samples when you want the dashboard to refresh:

```
npx tracebase usage sync
```

Idempotent: re-running the same day produces the same sample on the
server (keyed by installation + window). The push is opt-in — the hot
path (retrieval, injection, local events) is always local and never
blocks agent traffic.

Not linked yet? Status will show `cloud: local only` and doctor will
report `cloud-link: local only (…sync disabled, local recall still
works)`. Re-run with `--api-key` when you're ready.

---

## Reset or uninstall

```
npx tracebase remove              # remove this project's install cleanly
npx tracebase remove --keep-store # keep .tracebase/, just detach the agent surfaces
```

Re-install any time with `npx tracebase init`. Re-running `init` on an
already-initialized project preserves the stable `workspaceId`, never
duplicates MCP entries or instruction blocks, and does not re-register
cloud installations.

---

## Advanced

### Manual wiring (if `init` is not available in your environment)

1. Create `.tracebase/config.json`:
   ```json
   { "workspaceId": "<uuid>", "storagePath": ".tracebase/memory.db" }
   ```
2. Register the MCP server with your agent's runtime registry:
   - **Claude Code** — from the project root, run:
     ```
     claude mcp add tracebase --scope local -- npx -y tracebase-ai@latest serve --mcp
     ```
     `.claude/settings.json` is *not* the right place — Claude Code
     reads MCP servers from the `claude mcp` registry, not that file.
     The `@latest` pin is intentional: it forces npx through the npm
     registry so the command works identically from any directory.
   - **Cursor** — add the `tracebase` server to `~/.cursor/mcp.json` under `mcpServers`:
     ```json
     {
       "tracebase": {
         "command": "npx",
         "args": ["-y", "tracebase-ai@latest", "serve", "--mcp"]
       }
     }
     ```
   - **Codex** — `codex mcp add tracebase -- npx -y tracebase-ai@latest serve --mcp`.
3. Append to `CLAUDE.md` (or `AGENTS.md`):
   ```
   <!-- tracebase:begin (managed section — do not edit between markers) -->
   ## TraceBase reasoning layer
   When you start a debugging or problem-solving task:
     1. Call `get_reasoning_patterns` first with a short description.
     2. The response is a hypothesis — verify, don't apply blindly.
     3. If no patterns match, proceed normally.
   When you finish: call `record_reasoning_outcome` with the queryId.
   <!-- tracebase:end -->
   ```
4. Restart your agent. Confirm `get_reasoning_patterns` appears in
   `/tools` (Claude Code) or the equivalent.

### Custom integration via the SDK

Building your own agent framework or need a non-MCP surface? The library
is on npm as `tracebase-ai` — import `ReasoningLayer`, `BlockStore`, and
`BlockServer` and wire them however you need. The MCP server is one
reference integration; the SDK works standalone.

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) if something's off.
