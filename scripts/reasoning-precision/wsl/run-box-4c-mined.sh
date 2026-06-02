#!/usr/bin/env bash
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
corepack enable >/dev/null 2>&1 || true
WT="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77"
export TB_POOL="$WT/bench-runs/file-memory-real-repos/mined-candidates.json"
export TB_OUT="$WT/bench-runs/file-memory-real-repos/results/box-4c-mined.json"
export TB_PROGRESS="$WT/bench-runs/file-memory-real-repos/results/box-4c-mined-progress.jsonl"
exec python3 "$WT/scripts/reasoning-precision/wsl/box-4c-verify.py"
