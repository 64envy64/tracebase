#!/usr/bin/env bash
# $0 WSL environment probe for the reasoning-reuse capture run.
# Sources nvm, reports toolchain + prior-provisioning inventory. No spend.
set -uo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

echo "=== toolchain (nvm sourced) ==="
for b in node npm npx pnpm yarn python3 git timeout claude tsx; do
  printf "%-8s " "$b"; command -v "$b" 2>/dev/null || echo MISSING
done
echo "node: $(node --version 2>&1)   claude: $(claude --version 2>&1 | head -1)"

echo "=== ~/tb-harness ==="
if [ -d "$HOME/tb-harness" ]; then
  ls -la "$HOME/tb-harness" | head -20
  echo "--- better-sqlite3 built for linux? ---"
  ls "$HOME/tb-harness/node_modules/better-sqlite3/build/Release/"*.node 2>/dev/null || echo "no prebuilt .node"
  echo "--- package version ---"; (cd "$HOME/tb-harness" && node -e "console.log(require('./package.json').version)" 2>&1)
else echo "ABSENT"; fi

echo "=== ~/file-memory-real-repos (clones + deps) ==="
if [ -d "$HOME/file-memory-real-repos" ]; then
  for d in "$HOME"/file-memory-real-repos/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    nm=""; [ -d "$d/node_modules" ] && nm="node_modules"; [ -d "$d/.venv" ] && nm="$nm .venv"
    head=$(git -C "$d" rev-parse --short HEAD 2>/dev/null || echo "no-git")
    printf "  %-28s HEAD=%-10s deps:[%s]\n" "$name" "$head" "$nm"
  done
else echo "ABSENT"; fi

echo "=== /mnt/c worktree visible? ==="
WT="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77"
[ -d "$WT" ] && echo "OK: $WT" && ls "$WT/bench-runs/file-memory-real-repos/selected-tasks.json" 2>&1 || echo "NOT VISIBLE"
echo "=== done ==="
