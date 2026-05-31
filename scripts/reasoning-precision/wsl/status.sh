#!/usr/bin/env bash
P="$HOME/file-memory-real-repos/results/box-4c-supply-progress.jsonl"
echo "progress file: $P"
if [ -f "$P" ]; then
  echo "lines: $(wc -l < "$P")"
  echo "--- status tally ---"
  grep -oE '"status": "[a-z_]+"' "$P" | sort | uniq -c
  echo "--- last 6 ---"
  tail -6 "$P" | sed -E 's/.*"pr_commit": "([0-9a-f]{8})[0-9a-f]*".*"status": "([a-z_]+)".*/  \1 \2/'
else
  echo "NO progress file yet"
fi
echo "--- box-4c running? ---"
pgrep -af "box-4c-supply.py" | head -1 || echo "NOT running"
echo "--- vitest/pytest active? ---"
pgrep -af "vitest|pytest" | head -2 || echo "no test runner active"
