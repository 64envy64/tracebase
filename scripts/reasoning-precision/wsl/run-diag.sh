#!/usr/bin/env bash
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
WT="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77"
H="$HOME/tb-harness"
rsync -a --exclude node_modules "$WT/scripts/" "$H/scripts/" >/dev/null 2>&1
rsync -a --exclude node_modules "$WT/src/" "$H/src/" >/dev/null 2>&1
exec "$H/node_modules/.bin/tsx" "$H/scripts/reasoning-precision/wsl/diag-capture.ts"
