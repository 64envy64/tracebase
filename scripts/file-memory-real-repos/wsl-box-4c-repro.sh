#!/usr/bin/env bash
# Bash wrapper for the box 4c reproducibility-only baseline.
# Sources nvm + uv on PATH, then runs the Python driver.
# Output JSON lands at /mnt/c/.../bench-runs/file-memory-real-repos/results/box-4c-repro.json
set -uo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

# Activate corepack for pnpm/yarn (already done in Phase 2A; idempotent).
corepack prepare pnpm@10.12.1 --activate >/dev/null 2>&1 || true

SCRIPT_DIR="/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77/scripts/file-memory-real-repos"

echo "===== box 4c reproducibility-only baseline ====="
echo "node $(node --version), python3 $(python3 --version 2>&1 | head -1), pnpm $(pnpm --version 2>&1 | head -1)"
echo

export PYTHONUNBUFFERED=1
python3 -u "$SCRIPT_DIR/wsl-box-4c-repro.py"
