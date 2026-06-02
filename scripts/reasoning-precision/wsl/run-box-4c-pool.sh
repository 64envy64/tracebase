#!/usr/bin/env bash
# Generic box-4c runner. Caller exports TB_POOL, TB_OUT, TB_PROGRESS (absolute).
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
corepack enable >/dev/null 2>&1 || true
WT="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77"
exec python3 "$WT/scripts/reasoning-precision/wsl/box-4c-verify.py"
