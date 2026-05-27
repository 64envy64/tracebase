# File-memory real-repos — Windows environment fragility (internal diagnostic)

**TraceBase 0.9.x · Box 4c Phase 2A install + base-smoke · Windows 11 + Node 20.17 + Python 3.12.6 · 6 verified repos**

## Status

> **Native Windows + Node 20 + Python 3.12 is insufficient for the file-memory real-repos bench.** 3 of 6 verified repos pass install + base test after two rounds of fixes; the remaining 3 fail on environment-specific issues that are out-of-scope to fix at the bench level (Node version requirement, missing native binaries, Windows-specific test failures in upstream test suites). The bench moves to **WSL2 Ubuntu** for Phase 2A re-run; this doc preserves the Windows finding so a future iteration on a different stack has a known baseline.

## Headline

> **On a Windows 11 host with Node 20.17 and Python 3.12.6, install fragility cuts the file-memory real-repos bench's effective pool from 6 to 3 — below the pre-registered minimum of 4 verified repos.** Each remaining failure is rooted in an upstream environment requirement that the bench harness can't reasonably patch.

## What this is

A pre-bench infrastructure finding, not a bench result. No agents ran. No API spend. The bench's per-PR reproducibility loop (box 4c) never started on Windows because the gating install+smoke (Phase 2A) didn't yield enough viable repos. The substantive bench remains pending under a different environment (WSL).

## Method

The 6 VERIFIED repos from `bench-runs/file-memory-real-repos/repo-pool.json` (post-amendment commit `98dfae1`) were each subjected to a two-step gate:

1. **Install**: `npm install` for Node repos; `python -m venv ... && pip install -e <repo>[<extras>]` for Python repos. Driver: [`scripts/file-memory-real-repos/setup-and-smoke.ts`](../../scripts/file-memory-real-repos/setup-and-smoke.ts).
2. **Base test on current HEAD**: run the project's own test command (`npm run test:vitest`, `npm run test:src`, `npx yarn test`, `python -m pytest -q --no-header -x --maxfail=3` as applicable) to confirm the install actually works end-to-end before any PR-level reproducibility check.

Both steps must exit 0 for a repo to be marked OK. Failure surfaces are recorded in `bench-runs/file-memory-real-repos/results/phase-2a-setup-smoke.json` with the actual command attempted, exit code, elapsed seconds, and stderr/stdout tail.

Two iterations of fixes were applied: first round tried defaults (`npm install --prefer-offline`, `pip install -e .[d]`, `npx yarn install --immutable`, etc); second round applied per-repo workarounds (`npm install --include=optional --force` for axios's rolldown native binding, extra `pip install pytest attrs hypothesis` for Python repos missing dev deps, `npm install -g yarn@4.15.0` for prettier's packageManager requirement, `--override-ini=minversion=0.0` for pytest self-bootstrap).

## Phase 2A results (Windows)

After two rounds of fixes:

| # | Repo | Install | Base test | Status | Failure mode |
|---|---|---|---|---|---|
| 1 | `josdejong/mathjs` | npm 1.4 s | mocha 7.5 s exit 0 | ✅ **OK** | — |
| 2 | `psf/black` | pip 6.3 s + extras 1 s | pytest 44.6 s exit 0 | ✅ **OK** | — (after adding `pytest pytest-mock pytest-cov click>=8.2` as separate `pip install` step; `.[d]` extra is the `aiohttp`/daemon dep, NOT dev tools) |
| 3 | `Textualize/rich` | pip 3.3 s + extras 3.4 s | pytest 6.1 s exit 0 | ✅ **OK** | — (after adding `attrs attr hypothesis pytest-mock` as separate `pip install` step; rich's pyproject uses `[tool.poetry.dev-dependencies]` which pip silently ignores) |
| 4 | `axios/axios` | npm 1.2 s exit 0 | vitest exit 1 | ❌ **FAIL** | vitest 4 uses rolldown bundler; rolldown's `rolldown-binding.win32-x64-msvc.node` native package isn't installed on `npm install --include=optional --force`. Stack ends `Cannot find module './rolldown-binding.win32-x64-msvc.node'`. |
| 5 | `prettier/prettier` | exit 1 (no yarn on PATH) | n/a | ❌ **FAIL** | (a) `packageManager: yarn@4.15.0` requires yarn 4; (b) `engines.node: >=22` requires Node 22 (host has 20.17); (c) `corepack enable yarn` silently fails on Windows; (d) `npm install -g yarn@4.15.0` does not add yarn to PATH (npm global bin dir not in PATH by default on this Windows). |
| 6 | `pytest-dev/pytest` | pip 6.8 s + extras 4 s | pytest exit 1 | ❌ **FAIL** | pytest's own test suite has Windows-specific failures on `testing/python/metafunc.py` (`No module named 'hypothesis'` even after adding hypothesis extras), `testing/test_assertion.py` (`No module named 'attr'`), `testing/acceptance_test.py`. The `[testing]` pyproject extra does not pull these on Windows in our env. |

**Total: 3/6 OK.** Pre-reg minimum is 4 verified repos. Below floor.

## Why each failure is upstream, not bench-fixable

- **axios**: rolldown's `optionalDependencies` for platform-specific bindings depend on npm correctly resolving and downloading platform-matched packages. On Windows + npm 11.2.0, `--include=optional --force` did not pull the `@rolldown/binding-win32-x64-msvc` package. Workarounds (manual `npm install <native-pkg>`, downgrade vitest, etc.) are bench-level patches that drift the repo away from its actual PR-merge state — defeats the bench's reason for using real repos.
- **prettier**: explicit upstream `engines.node` requirement of 22+ blocks compatibility with our Node 20. Upgrading Node host-wide is invasive; using nvm to pin Node 22 just for prettier is reasonable on Linux but more friction on Windows + corepack.
- **pytest**: pytest's own dev test suite has long-tail Windows-specific platform failures that the pytest team works around in CI matrices (specific extras, `pytest-xdist`, environment markers). Reproducing that CI matrix is out-of-scope for a per-PR-loop bench.

## The honest conclusion

> Real OSS repos on a Windows + Node 20 + Python 3.12 host are install-fragile in ways that bench-level fixes cannot reasonably overcome without forking each upstream's CI matrix. Two passes of per-repo workarounds got from 1/6 → 3/6; further workarounds risk drifting test environments away from each PR's actual reproduction context, which would invalidate the bench's claim about real workloads.

This is **not** a bug in the bench design or in any individual repo. It's a real-world signal: **modern OSS test infrastructure assumes Linux as the development environment.** Bench infrastructure for real-repo benches should match that assumption.

## Decision taken

Per operator review, the bench moves to **WSL2 Ubuntu 24.04** (already installed on this host) for Phase 2A re-run. WSL2 native filesystem gives:

- 941 GB free vs Windows C:'s 14 GB (room to clone 6 repos cleanly)
- Linux package ecosystem (apt, NodeSource, corepack with working Linux yarn) matching what these OSS repos actually CI against
- ~5–10× faster I/O for npm/pip install + test runs vs /mnt/c

WSL plan + commands are queued in the session log; this doc is the pre-WSL baseline so that finding can be cited if a future iteration revisits a Windows-native target.

## What is preserved as evidence

| Artifact | Path |
|---|---|
| Pre-reg locked spec | [`bench-runs/file-memory/PRE-REGISTRATION-REAL-REPOS.md`](../../bench-runs/file-memory/PRE-REGISTRATION-REAL-REPOS.md) |
| Locked + amended pool | [`bench-runs/file-memory-real-repos/repo-pool.json`](../../bench-runs/file-memory-real-repos/repo-pool.json) (commit `98dfae1`) |
| Phase 2A raw result (Windows) | [`bench-runs/file-memory-real-repos/results/phase-2a-setup-smoke.json`](../../bench-runs/file-memory-real-repos/results/phase-2a-setup-smoke.json) |
| Discovery script (used in box 4b) | [`scripts/file-memory-real-repos/discover-candidates.ts`](../../scripts/file-memory-real-repos/discover-candidates.ts) |
| Setup + smoke driver (Windows version) | [`scripts/file-memory-real-repos/setup-and-smoke.ts`](../../scripts/file-memory-real-repos/setup-and-smoke.ts) |
| WSL environment probe | [`scripts/file-memory-real-repos/wsl-probe.sh`](../../scripts/file-memory-real-repos/wsl-probe.sh) |
| Candidate pool (111 candidates from box 4b) | [`bench-runs/file-memory-real-repos/candidate-pool.json`](../../bench-runs/file-memory-real-repos/candidate-pool.json) — still valid; SHAs reference upstream, repo clone location is environment-independent |

## What is NOT in this doc

- No agent runs, no API spend ($0)
- No per-PR reproducibility data
- No claim about file_memory's effect on real workloads (the bench hasn't run yet)
- No re-pool decision — the 6 repos stay as proposed; environment changes, not the pool

## Cumulative session spend (Windows phase only)

- API: $0
- Local CPU: ~30 min across two Phase 2A iterations + diagnostics
- Disk: ~110 MB across cloned repos + ~150 MB across node_modules + Python venvs (all gitignored)

## Next step (WSL Phase 2A)

Out-of-scope for this doc; tracked in the session log:
- `sudo apt install` for python3-pip, python3-venv, build-essential, etc.
- NodeSource Node 22 install
- `corepack enable` for yarn
- Re-clone 6 repos to `~/file-memory-real-repos/repos/` (WSL native FS)
- Linux-native setup-and-smoke variant
- Re-run Phase 2A; ≥4/6 OK → proceed; <4/6 → stop and report.
