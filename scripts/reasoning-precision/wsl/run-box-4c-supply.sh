#!/usr/bin/env bash
# Wrapper: source nvm + uv onto PATH, then run the supply box-4c verifier.
# Pass TB_BOX4C_SMOKE=N to validate on N candidates/repo first.
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
corepack enable >/dev/null 2>&1 || true
WT="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77"
exec python3 "$WT/scripts/reasoning-precision/wsl/box-4c-supply.py"
