#!/usr/bin/env python3
"""
Box 4c reproducibility-only baseline for the file-memory real-repos bench
(PRE-REGISTRATION-REAL-REPOS.md §"Selection process" step 4).

For each surviving candidate (66 after operator-approved pre-excludes):
  1. git reset --hard <parent_commit>
  2. apply test diff only: git diff <parent> <pr_commit> -- <test_paths> | git apply
  3. run repo test command scoped to touched test files; MUST FAIL (non-zero exit)
  4. apply source fix: git checkout <pr_commit> -- <source_paths>
  5. run same test command; MUST PASS (zero exit)

Records per-candidate status (reproducible / non_reproducible / infra_failed
/ timeout), exit codes, elapsed seconds, and a short failure reason. NO agent
runs, NO API calls, NO installs (install state from WSL Phase 2A is reused).

Per-candidate test cap: 180s. Single repo failure does not abort the run.

Outputs (paths into the worktree on /mnt/c, so results land in the repo):
  bench-runs/file-memory-real-repos/results/box-4c-repro.json
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

# Worktree-side paths (cross-FS access via /mnt/c from WSL).
WORKTREE = Path("/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77")
POOL_PATH = WORKTREE / "bench-runs/file-memory-real-repos/candidate-pool.json"
OUT_PATH = WORKTREE / "bench-runs/file-memory-real-repos/results/box-4c-repro.json"
# Append-only progress log so a mid-run WSL kill leaves a recoverable trail.
PROGRESS_PATH = WORKTREE / "bench-runs/file-memory-real-repos/results/box-4c-progress.jsonl"

# WSL-side install state from Phase 2A.
REPOS_DIR = Path(os.environ["HOME"]) / "file-memory-real-repos/repos"

TEST_CAP_SEC = 180  # per per-candidate test run (FAIL run + PASS run cap independently)

REPO_DIR_MAP = {
    "josdejong/mathjs": "josdejong-mathjs",
    "psf/black": "psf-black",
    "Textualize/rich": "Textualize-rich",
    "colinhacks/zod": "colinhacks-zod",
}

# Per-repo "fallback test" when the candidate touches only data-fixture files
# (e.g. black/tests/data/cases/foo.py). Mapped to the parametrize-driven runner.
REPO_FIXTURE_FALLBACK = {
    "psf/black": ["tests/test_format.py"],
}

# Per-repo glob heuristics for classifying a path as a "real test file"
# (i.e., something pytest/vitest/mocha will execute directly) vs a fixture.
def is_real_test_file(repo: str, path: str) -> bool:
    if repo == "psf/black":
        # tests/data/** are fixtures consumed by tests/test_format.py.
        # tests/test_<name>.py are real.
        return path.startswith("tests/") and not path.startswith("tests/data/") and "/test_" in "/" + path
    if repo == "Textualize/rich":
        # rich's tests/ has no fixture sub-dir; all tests/test_*.py are real.
        return path.startswith("tests/test_") and path.endswith(".py")
    if repo == "josdejong/mathjs":
        # mathjs: test/unit-tests/**/*.test.js are real.
        return ".test.js" in path or ".test.mjs" in path
    if repo == "colinhacks/zod":
        # zod: anything ending .test.ts or .test.tsx is real.
        return path.endswith(".test.ts") or path.endswith(".test.tsx") or path.endswith(".test.js")
    return False


def resolve_test_targets(repo: str, test_files: list[str]) -> list[str]:
    real = [t for t in test_files if is_real_test_file(repo, t)]
    if real:
        return real
    return REPO_FIXTURE_FALLBACK.get(repo, test_files)


def test_command_for(repo: str, test_targets: list[str]) -> list[str]:
    """Returns the shell command (as a single string for shell=True) to invoke
    the repo's test runner against the given target files.
    """
    quoted = " ".join(f"'{t}'" for t in test_targets)
    if repo == "josdejong/mathjs":
        return ["npx", "mocha", "--reporter", "min", *test_targets]
    if repo == "psf/black":
        return [".venv/bin/python", "-m", "pytest", "-q", "--no-header", "-x", *test_targets]
    if repo == "Textualize/rich":
        return [".venv/bin/python", "-m", "pytest", "-q", "--no-header", "-x", *test_targets]
    if repo == "colinhacks/zod":
        # `pnpm exec vitest run <file>` failed in v3 attempt with vite _createServer
        # error (vite 7.3.2 + zod workspace plumbing). `pnpm test -- <file>` calls
        # the package.json script (`vitest run`) and passes <file> through; that
        # path matches what WSL Phase 2A used to verify a base passing run.
        return ["pnpm", "test", "--", "--reporter=basic", *test_targets]
    raise ValueError(f"unknown repo {repo}")


def run(cmd, cwd, capture=True, timeout=None, shell=False):
    """Wrapper around subprocess.run with proper process-group kill on timeout.

    Python's default `subprocess.run(timeout=...)` only kills the immediate
    child. Test runners (mocha, pytest, vitest) often spawn worker processes
    that survive a SIGKILL to the shell wrapper and keep the run alive past
    the timeout. We use `start_new_session=True` (POSIX setsid) and kill the
    entire process group with SIGKILL on timeout.
    """
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            shell=shell,
            text=True,
            start_new_session=True,  # become process-group leader
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            return proc.returncode, stdout or "", stderr or ""
        except subprocess.TimeoutExpired:
            # Kill the entire process group.
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                stdout, stderr = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                stdout, stderr = "", ""
            return 124, stdout or "", stderr or ""
    except FileNotFoundError as e:
        return 127, "", str(e)


def git(args, cwd):
    return run(["git", *args], cwd=str(cwd), timeout=120)


def reset_to(repo_dir: Path, sha: str) -> tuple[bool, str]:
    """Reset repo to <sha>. We intentionally do NOT run `git clean -fdx` —
    that wipes gitignored files essential to the install state, e.g.
    psf/black's generated `src/_black_version.py` (versioneer output;
    deleting it breaks `import black` and fails pytest collection with
    exit 2 for every candidate). `git reset --hard` already restores all
    tracked files; leftover untracked files from a prior candidate's
    `git apply test-diff` are overwritten when the next candidate's
    test diff is applied (or harmless if not). Trade-off: a small risk
    of cross-candidate untracked pollution vs. the certainty that
    essential generated install artifacts survive.
    """
    ec, _, err = git(["reset", "--hard", sha], cwd=repo_dir)
    if ec != 0:
        return False, f"git reset --hard {sha}: {err[:300]}"
    return True, ""


def apply_test_diff(repo_dir: Path, parent: str, pr_commit: str, test_paths: list[str]) -> tuple[bool, str]:
    # Use shell pipe: git diff ... | git apply
    test_arg = " ".join(f"'{p}'" for p in test_paths)
    cmd = f"git diff {parent} {pr_commit} -- {test_arg} | git apply"
    ec, _, err = run(cmd, cwd=str(repo_dir), shell=True, timeout=60)
    if ec != 0:
        return False, f"git apply test-diff failed: {err[:300]}"
    return True, ""


def checkout_source(repo_dir: Path, pr_commit: str, source_paths: list[str]) -> tuple[bool, str]:
    args = ["checkout", pr_commit, "--", *source_paths]
    ec, _, err = git(args, cwd=repo_dir)
    if ec != 0:
        return False, f"git checkout source failed: {err[:300]}"
    return True, ""


def run_tests(repo: str, repo_dir: Path, test_targets: list[str]) -> tuple[int, float, str]:
    cmd = test_command_for(repo, test_targets)
    t0 = time.time()
    ec, _, err = run(cmd, cwd=str(repo_dir), timeout=TEST_CAP_SEC)
    elapsed = time.time() - t0
    return ec, elapsed, err[-600:] if err else ""


def process_candidate(c: dict) -> dict:
    repo = c["repo"]
    pr = c["pr_commit"]
    parent = c["parent_commit"]
    repo_dir = REPOS_DIR / REPO_DIR_MAP[repo]
    short = pr[:8]

    result = {
        "repo": repo,
        "pr_commit": pr,
        "parent_commit": parent,
        "title": c["title"][:120],
        "status": None,
        "reason": None,
        "pre_fix_exit": None,
        "pre_fix_elapsed_sec": None,
        "post_fix_exit": None,
        "post_fix_elapsed_sec": None,
        "test_targets": None,
        "stderr_tail": None,
    }

    if not repo_dir.exists():
        result["status"] = "infra_failed"
        result["reason"] = f"repo_dir_missing: {repo_dir}"
        return result

    targets = resolve_test_targets(repo, c["test_files_touched"])
    result["test_targets"] = targets

    # Step 1: reset to parent
    ok, msg = reset_to(repo_dir, parent)
    if not ok:
        result["status"] = "infra_failed"
        result["reason"] = msg
        return result

    # Step 2: apply test diff only
    ok, msg = apply_test_diff(repo_dir, parent, pr, c["test_files_touched"])
    if not ok:
        result["status"] = "infra_failed"
        result["reason"] = msg
        # Try to leave repo in clean parent state for next iter
        reset_to(repo_dir, parent)
        return result

    # Step 3: run tests, expect FAIL
    pre_exit, pre_elapsed, pre_err = run_tests(repo, repo_dir, targets)
    result["pre_fix_exit"] = pre_exit
    result["pre_fix_elapsed_sec"] = round(pre_elapsed, 1)

    if pre_exit == 124:
        result["status"] = "timeout"
        result["reason"] = f"pre_fix_test_timeout at {TEST_CAP_SEC}s"
        result["stderr_tail"] = pre_err
        reset_to(repo_dir, parent)
        return result
    if pre_exit == 127:
        result["status"] = "infra_failed"
        result["reason"] = f"test_runner_not_found: {pre_err[:200]}"
        reset_to(repo_dir, parent)
        return result
    if pre_exit == 0:
        result["status"] = "non_reproducible"
        result["reason"] = "pre_fix_test_unexpectedly_passed (test diff alone passed without source fix)"
        result["stderr_tail"] = pre_err
        reset_to(repo_dir, parent)
        return result

    # Step 4: apply source fix on top of parent + test diff
    ok, msg = checkout_source(repo_dir, pr, c["source_files_touched"])
    if not ok:
        result["status"] = "infra_failed"
        result["reason"] = msg
        reset_to(repo_dir, parent)
        return result

    # Step 5: re-run tests, expect PASS
    post_exit, post_elapsed, post_err = run_tests(repo, repo_dir, targets)
    result["post_fix_exit"] = post_exit
    result["post_fix_elapsed_sec"] = round(post_elapsed, 1)

    if post_exit == 124:
        result["status"] = "timeout"
        result["reason"] = f"post_fix_test_timeout at {TEST_CAP_SEC}s"
        result["stderr_tail"] = post_err
        reset_to(repo_dir, parent)
        return result
    if post_exit == 127:
        result["status"] = "infra_failed"
        result["reason"] = f"test_runner_not_found: {post_err[:200]}"
        reset_to(repo_dir, parent)
        return result
    if post_exit == 0:
        result["status"] = "reproducible"
        result["reason"] = "fail_then_pass_as_expected"
    else:
        result["status"] = "non_reproducible"
        result["reason"] = f"post_fix_test_still_failed (exit {post_exit})"
        result["stderr_tail"] = post_err

    reset_to(repo_dir, parent)  # leave clean for next iter
    return result


def main():
    if not POOL_PATH.exists():
        print(f"FATAL: pool not found at {POOL_PATH}", file=sys.stderr)
        sys.exit(2)

    pool = json.loads(POOL_PATH.read_text(encoding="utf-8"))
    sel_repos = {
        r for r, s in pool["per_repo_stats"].items()
        if s.get("selectable_after_v3_amendment") is not False
    }
    surviving = [
        c for c in pool["candidates"]
        if c["repo"] in sel_repos and not c.get("pre_excluded_before_4c", False)
    ]
    print(f"Surviving candidates: {len(surviving)} across {len(sel_repos)} repos", flush=True)

    # Reset every repo to its known-good HEAD before starting
    # (so a previous interrupted run doesn't leave half-applied state)
    head_shas = {}
    for repo, dirname in REPO_DIR_MAP.items():
        rd = REPOS_DIR / dirname
        if not rd.exists():
            print(f"  WARN: {repo} -> {rd} missing", flush=True)
            continue
        ec, out, _ = git(["rev-parse", "HEAD"], cwd=rd)
        if ec == 0:
            head_shas[repo] = out.strip()
            print(f"  {repo} HEAD = {out.strip()[:10]}", flush=True)

    results = []
    by_status = {"reproducible": 0, "non_reproducible": 0, "infra_failed": 0, "timeout": 0}
    by_repo_status: dict[str, dict[str, int]] = {r: dict(by_status) for r in sel_repos}

    # Run in fastest-test-first order: rich, mathjs, zod, black
    order = ["Textualize/rich", "josdejong/mathjs", "colinhacks/zod", "psf/black"]
    surviving.sort(key=lambda c: (order.index(c["repo"]) if c["repo"] in order else 99, c["pr_commit"]))

    # Load any prior progress so a restart skips already-processed candidates.
    processed_keys: set[tuple[str, str]] = set()
    if PROGRESS_PATH.exists():
        for line in PROGRESS_PATH.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
                processed_keys.add((r["repo"], r["pr_commit"]))
                results.append(r)
                by_status[r["status"]] = by_status.get(r["status"], 0) + 1
                if r["repo"] in by_repo_status:
                    by_repo_status[r["repo"]][r["status"]] = by_repo_status[r["repo"]].get(r["status"], 0) + 1
            except Exception:
                pass
        if processed_keys:
            print(f"Resuming: {len(processed_keys)} candidates already in progress log", flush=True)

    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)

    t_start = time.time()
    for i, c in enumerate(surviving, 1):
        key = (c["repo"], c["pr_commit"])
        if key in processed_keys:
            continue
        print(f"\n[{i:>2}/{len(surviving)}] {c['repo']:<18} {c['pr_commit'][:10]}  src+{c['source_loc_added']}/-{c['source_loc_removed']}", flush=True)
        try:
            r = process_candidate(c)
        except Exception as e:
            r = {
                "repo": c["repo"],
                "pr_commit": c["pr_commit"],
                "parent_commit": c["parent_commit"],
                "title": c["title"][:120],
                "status": "infra_failed",
                "reason": f"runner_exception: {type(e).__name__}: {str(e)[:200]}",
            }
        results.append(r)
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        by_repo_status[r["repo"]][r["status"]] = by_repo_status[r["repo"]].get(r["status"], 0) + 1
        print(f"     -> {r['status']:<16} {r.get('reason', '')[:80]}", flush=True)
        # Append to progress JSONL so we recover from WSL/process kills.
        with open(PROGRESS_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(r) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    # Restore each repo to its original HEAD
    for repo, sha in head_shas.items():
        rd = REPOS_DIR / REPO_DIR_MAP[repo]
        git(["reset", "--hard", sha], cwd=rd)

    total_elapsed = time.time() - t_start

    out = {
        "version": "tracebase 0.9.x",
        "pre_registration": "bench-runs/file-memory/PRE-REGISTRATION-REAL-REPOS.md",
        "phase": "box 4c — per-PR reproducibility-only baseline (no agent runs)",
        "ran_at_wall_clock_ish": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "wall_time_total_sec": round(total_elapsed, 1),
        "test_cap_sec_per_run": TEST_CAP_SEC,
        "candidates_count": len(surviving),
        "head_shas_at_run_start": head_shas,
        "by_status": by_status,
        "by_repo_status": by_repo_status,
        "results": results,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

    print("\n===== SUMMARY =====")
    print(f"Total: {len(surviving)} candidates, {round(total_elapsed/60,1)} min wall time")
    for k, v in by_status.items():
        print(f"  {k}: {v}")
    print("\nPer-repo:")
    for r, sd in by_repo_status.items():
        nonzero = {k: v for k, v in sd.items() if v > 0}
        print(f"  {r}: {nonzero}")
    print(f"\nWrote {OUT_PATH}")


if __name__ == "__main__":
    main()
