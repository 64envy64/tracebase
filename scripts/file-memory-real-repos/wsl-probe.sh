#!/usr/bin/env bash
# WSL environment probe for box 4c Phase 2A re-run inside Linux.
# Read-only — no installs, no clones, no test runs.

echo "===== shell + user ====="
whoami
echo "HOME=$HOME"
echo "PWD=$(pwd)"
echo

echo "===== tools on PATH (with version) ====="
for tool in node npm yarn corepack python3 pip3 pytest git make gcc clang; do
  printf "%-12s " "$tool"
  if command -v "$tool" >/dev/null 2>&1; then
    "$tool" --version 2>&1 | head -1
  else
    echo "(not on PATH)"
  fi
done
echo

echo "===== node + npm details ====="
if command -v node >/dev/null 2>&1; then
  echo "node path: $(which node)"
  echo "node version: $(node --version)"
fi
if command -v npm >/dev/null 2>&1; then
  echo "npm prefix: $(npm config get prefix)"
fi
echo

echo "===== python details ====="
for py in python3 python3.12 python3.11 python3.10 python; do
  if command -v "$py" >/dev/null 2>&1; then
    echo "$py: $(which $py) — $($py --version 2>&1)"
  fi
done
echo "venv module available: $(python3 -c "import venv; print('yes')" 2>&1)"
echo

echo "===== free disk on WSL native vs /mnt/c ====="
df -h $HOME 2>/dev/null | head -2
df -h /mnt/c 2>/dev/null | head -2
echo

echo "===== mount visibility of worktree ====="
WORKTREE=/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77
if [ -d "$WORKTREE" ]; then
  echo "worktree found at $WORKTREE"
  echo "files: $(ls $WORKTREE | wc -l) top-level entries"
else
  echo "(worktree NOT visible at $WORKTREE)"
fi
echo

echo "===== git config check ====="
git --version 2>&1
git config --global --get user.name 2>&1 || echo "  (no global user.name set)"
git config --global --get user.email 2>&1 || echo "  (no global user.email set)"
git config --global --get safe.directory 2>&1 | head -3 || echo "  (no safe.directory entries)"
