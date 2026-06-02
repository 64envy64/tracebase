#!/usr/bin/env bash
# Sync the current worktree code into ~/tb-harness (preserving its Linux-built
# node_modules) and run both $0 preflights there, so the paid run's execution
# environment (WSL) is validated end-to-end before dispatch.
set -uo pipefail
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
WT="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77"
H="$HOME/tb-harness"
echo "=== sync worktree -> $H (excluding node_modules/.git/bench-runs) ==="
for d in src scripts bin; do
  rsync -a --delete --exclude node_modules "$WT/$d/" "$H/$d/"
done
for f in package.json tsconfig.json tsconfig.check.json vitest.config.mts tsup.config.ts; do
  [ -f "$WT/$f" ] && cp "$WT/$f" "$H/$f"
done
echo "synced. harness version: $(node -e "console.log(require('$H/package.json').version)")"
TSX="$H/node_modules/.bin/tsx"
echo ""
echo "=== capture-path preflight (WSL) ==="
"$TSX" "$H/scripts/reasoning-precision/preflight-capture-path.ts"
CP=$?
echo ""
echo "=== orchestrator preflight (WSL) ==="
TB_SHARED_DIR="$HOME/reasoning-capture-preflight" "$TSX" "$H/scripts/reasoning-precision/capture-orchestrator.ts" --preflight
OP=$?
echo ""
echo "=== preflight results: capture-path=$CP orchestrator=$OP ==="
