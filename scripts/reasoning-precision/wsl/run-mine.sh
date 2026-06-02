#!/usr/bin/env bash
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
WT="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77"
export TB_REPOS="$HOME/file-memory-real-repos/repos"
export TB_KNOWN_POOL="$WT/bench-runs/file-memory-real-repos/candidate-pool.json"
export TB_OUT="$WT/bench-runs/file-memory-real-repos/mined-candidates.json"
exec "$HOME/tb-harness/node_modules/.bin/tsx" "$WT/scripts/reasoning-precision/wsl/mine-candidates.ts"
