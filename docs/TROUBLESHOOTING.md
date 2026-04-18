# Troubleshooting

Common issues with the Claude Code install path and how to resolve
them. For a machine-verified health check, run:

```
npx tracebase-ai doctor
```

It reports `PASS / WARN / FAIL` for each integration surface with a
specific `fix:` hint. Most items in this file match one of those
check names; the sections below add context.

---

## `get_reasoning_patterns` doesn't appear in `/tools`

Typical causes, in order of likelihood:

1. **Claude Code wasn't restarted after `init`.** MCP servers are
   loaded at Claude Code startup. Quit and relaunch.
2. **`.claude/settings.json` is malformed.** `doctor` surfaces this
   as `FAIL claude-settings "not valid JSON"`. Fix the JSON (or delete
   the file and re-run `init`).
3. **`tracebase` entry is under a different key.** The Claude Code
   MCP convention is `mcpServers.tracebase`. If a legacy install
   wrote it elsewhere, `doctor` will surface `FAIL claude-settings
   "no tracebase entry"`. Re-run `npx tracebase-ai init --force`.
4. **`npx` can't reach the package.** If your environment blocks
   outbound network or lacks an npm cache, `npx -y tracebase-ai`
   cannot fetch the package at the moment Claude Code spawns the
   MCP server. Install locally: `npm install tracebase-ai` and
   change the `args` in `.claude/settings.json` to point at a local
   CLI entry point.

---

## Tool runs but `status` shows zero events

Two distinct cases:

- **Fresh install, no agent turns yet.** Expected. Events only fire
  when `get_reasoning_patterns` or `record_reasoning_outcome` are
  actually called. A single Claude Code session that never hits a
  debugging task will not produce events.

- **Claude Code is calling the v1 tools (`recall`, `store`) instead.**
  Check `events --type retrieval --limit 5`. If empty, the agent
  likely isn't being prompted to use the v2 tools. The canonical
  CLAUDE.md managed section tells Claude Code to call
  `get_reasoning_patterns` first; if your CLAUDE.md has that section
  but it's ignored, the block is probably too deep in a long file.
  Move it closer to the top.

---

## `doctor` reports `FAIL storage` ("SQLite open failed")

The `.tracebase/memory.db` file is corrupted or not a valid SQLite
database. Options in order of data-loss tolerance:

1. **Rename and retry** (keeps the old file for forensics):
   ```
   mv .tracebase/memory.db .tracebase/memory.db.broken
   ```
   Next agent turn recreates a fresh store.
2. **Delete and start fresh**:
   ```
   rm .tracebase/memory.db .tracebase/memory.db-wal .tracebase/memory.db-shm
   ```

Block + fact data is lost in either case. If you have a JSONL export
(see `export` / `import` commands in the v1 CLI), restore from there.

---

## Blocks never reach `active`

Most often this means distillation is not wired up yet. In Phase 6.0
distillation is available as a manual pipeline (`DistillationPipeline`)
and the `store` CLI command; automatic distillation from real agent
traces lands later.

You can seed a block manually:

```
npx tracebase-ai store \
  -d "your problem description" \
  -s "the fix you used" \
  -l python -f astropy -e MissingDocstring
```

`status` should then show `blocks (active): 1`.

---

## I want to re-install from scratch

```
rm -rf .tracebase/ .claude/settings.json CLAUDE.md
npx tracebase-ai init
```

> Only delete `.claude/settings.json` if you have no other MCP servers
> configured. Otherwise open it in an editor and remove the
> `tracebase` key under `mcpServers`, then re-run `init`.

---

## I want to move to a different `workspaceId`

`workspaceId` is a stable identifier preserved by re-init. To rotate:

```
# Read your current id so you have it for audit
cat .tracebase/config.json | grep workspaceId

# Wipe and regenerate
rm -rf .tracebase/
npx tracebase-ai init
```

Note: rotating `workspaceId` breaks continuity for any cloud-synced
view (Phase 6.2+). Don't rotate casually.

---

## `status` hangs or errors on an NFS-mounted project

SQLite (and better-sqlite3) does not support all locking semantics on
NFS. Keep `.tracebase/` on local disk. Symlink from NFS if you need
the project directory itself to live on NFS.

---

## When in doubt

- `npx tracebase-ai doctor --json` — structured output suitable for
  copy/paste into an issue.
- `npx tracebase-ai status --json` — same for status.
- `npx tracebase-ai events --json --limit 50` — last 50 events with
  full payloads.

The three above capture everything needed to triage an install
without any private data (patterns are hashed / trimmed in the output).
