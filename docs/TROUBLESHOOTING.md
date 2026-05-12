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
2. **The Claude MCP registry is missing `tracebase`.** Re-run
   `npx tracebase-ai init --agent claude-code --force` from the
   project root. Claude Code reads MCP servers from `claude mcp`,
   not from `.claude/settings.json`.
3. **The hook settings file is malformed.** `doctor` surfaces this
   with a `.claude/settings.json` hook check. Fix the JSON (or delete
   the file and re-run `init`).
4. **`npx` can't reach the package.** If your environment blocks
   outbound network or lacks an npm cache, `npx -y tracebase-ai`
   cannot fetch the package at the moment Claude Code spawns the MCP
   server. Install locally or re-run `doctor` once the npm cache is
   warm; its `mcp-boot` check shows the exact command and captured
   error.

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

Most often this means one of two things:

1. The project has not produced enough successful runs yet for a block
   to be captured, verified, and promoted.
2. You are testing the store on a clean project and simply need a
   known-good seed to verify the rest of the surface.

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
npx tracebase-ai remove
npx tracebase-ai init
```

`init` auto-detects the current agent (or every agent installed on
this machine) and wires each surface up — no `--agent` flag needed
under normal use.

If you want to keep the local SQLite store but refresh the adapter
surface only, use:

```
npx tracebase-ai remove --keep-store
npx tracebase-ai init
```

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
