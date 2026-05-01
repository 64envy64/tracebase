#!/usr/bin/env bash
# Verifier — runs the test against the current main.ts. Pass if the
# index lookup returns the expected value; fail otherwise.
set -e
npx --yes tsx@^4 main.test.ts
