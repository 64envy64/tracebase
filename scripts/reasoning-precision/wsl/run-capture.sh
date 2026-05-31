#!/usr/bin/env bash
# Dispatch the sanctioned haiku capture run in WSL. Syncs the latest worktree
# code into ~/tb-harness (Linux node_modules preserved), points the orchestrator
# at the frozen manifest + the WSL clones + a results dir on /mnt/c (so progress
# JSONL is readable from Windows). Crash-safe + resumable: re-running continues.
set -uo pipefail
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
corepack enable >/dev/null 2>&1 || true
WT="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77"
H="$HOME/tb-harness"
for d in src scripts bin; do rsync -a --delete --exclude node_modules "$WT/$d/" "$H/$d/"; done
for f in package.json tsconfig.json tsconfig.check.json vitest.config.mts tsup.config.ts; do [ -f "$WT/$f" ] && cp "$WT/$f" "$H/$f"; done

export TB_MANIFEST="$WT/bench-runs/reasoning-reuse/capture-manifest.frozen.json"
export TB_SHARED_DIR="$HOME/reasoning-capture"
export TB_REPOS="$HOME/file-memory-real-repos/repos"
export TB_WORKSPACES="$HOME/reasoning-capture/workspaces"
export TB_RESULTS="$WT/bench-runs/reasoning-reuse/results"
export TB_RUN_TAG="${TB_RUN_TAG:-capture-run-v1}"
export TB_HARD_CAP_USD="${TB_HARD_CAP_USD:-30}"
export TB_MAX_TRAJ_USD="${TB_MAX_TRAJ_USD:-0.50}"
export CLAUDE_CLI="claude"
echo "manifest: $TB_MANIFEST"
echo "shared store: $TB_SHARED_DIR | results: $TB_RESULTS | cap: \$$TB_HARD_CAP_USD"
echo "=== \$0 preflight gate ==="
"$H/node_modules/.bin/tsx" "$H/scripts/reasoning-precision/capture-orchestrator.ts" --preflight || { echo "PREFLIGHT FAILED — refusing paid dispatch"; exit 1; }
echo "=== preflight OK — dispatching paid haiku run ==="
exec "$H/node_modules/.bin/tsx" "$H/scripts/reasoning-precision/capture-orchestrator.ts"
