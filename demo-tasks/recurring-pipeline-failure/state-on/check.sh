#!/usr/bin/env bash
# Verifier for the recurring-pipeline-failure task.
# Pass = pipeline runs to completion AND output.txt contains the
# expected total. Fail otherwise.
set -e
python3 pipeline.py
test -f output.txt
grep -q "OK total=60" output.txt
echo "verifier: pass"
