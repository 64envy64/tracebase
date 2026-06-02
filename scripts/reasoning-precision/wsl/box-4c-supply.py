#!/usr/bin/env python3
"""
Box-4c reproducibility check for the SUPPLY-expansion repos (axios, pytest,
prettier) — the 69 discovery-only candidates the file-memory pilot never
verified. Same fail-then-pass oracle as wsl-box-4c-repro.py:

  1. git reset --hard <parent>
  2. git diff <parent> <fix> -- <test_paths> | git apply   (test diff only)
  3. run scoped test  → MUST FAIL
  4. git checkout <fix> -- <source_paths>                   (source fix)
  5. run scoped test  → MUST PASS

No agent runs, no API spend, no installs (reuses the installed deps). Resumable:
skips pr_commits already recorded in the progress JSONL. Writes a NEW output so
the existing 45-task box-4c-repro.json is untouched.
"""
import json, os, signal, subprocess, sys, time
from pathlib import Path

WORKTREE = Path("/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77")
POOL_PATH = WORKTREE / "bench-runs/file-memory-real-repos/candidate-pool.json"
OUT_PATH = WORKTREE / "bench-runs/file-memory-real-repos/results/box-4c-supply.json"
PROGRESS_PATH = WORKTREE / "bench-runs/file-memory-real-repos/results/box-4c-supply-progress.jsonl"
REPOS_DIR = Path(os.environ["HOME"]) / "file-memory-real-repos/repos"
TEST_CAP_SEC = 180

# Clean, deterministic, single-file-scopable runners only. prettier is
# intentionally excluded here: its touched files are jest snapshot/fixtures
# under a single parametrized format.test.js, which is not cleanly scopable to a
# fast per-candidate run (recorded honestly as infra-deferred, not counted).
REPO_DIR_MAP = {
    "axios/axios": "axios-axios",
    "pytest-dev/pytest": "pytest-dev-pytest",
}

def is_real_test_file(repo: str, path: str) -> bool:
    if repo == "axios/axios":
        return path.startswith("tests/") and (path.endswith(".test.js") or path.endswith(".spec.js"))
    if repo == "pytest-dev/pytest":
        return path.startswith("testing/") and "/test_" in "/" + path and path.endswith(".py")
    if repo == "prettier/prettier":
        # Real runnable test files only (e.g. tests/integration/__tests__/*.js).
        # Snapshot/fixture files under tests/format/** are handled via dirs below.
        return path.endswith(".js") and "/__tests__/" in path and "__snapshots__" not in path
    return False

def prettier_fixture_dirs(test_files: list[str]) -> list[str]:
    """Map prettier snapshot/fixture paths to their format fixture DIRECTORY,
    which `yarn test <dir>` exercises via the parametrized format.test.js."""
    dirs = []
    for t in test_files:
        if "/__snapshots__/" in t:
            d = t.split("/__snapshots__/")[0]
        elif t.startswith("tests/format/"):
            d = "/".join(t.split("/")[:-1])
        else:
            continue
        if d and d not in dirs:
            dirs.append(d)
    return dirs

def resolve_test_targets(repo: str, test_files: list[str]) -> list[str]:
    real = [t for t in test_files if is_real_test_file(repo, t)]
    if real:
        return real
    if repo == "prettier/prettier":
        return prettier_fixture_dirs(test_files)
    return []

def test_command_for(repo: str, targets: list[str]) -> list[str]:
    if repo == "axios/axios":
        # axios migrated to vitest; unit tests live under the "unit" project.
        return ["npx", "vitest", "run", "--project", "unit", *targets]
    if repo == "pytest-dev/pytest":
        return [".venv/bin/python", "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider", *targets]
    if repo == "prettier/prettier":
        # prettier's jest run; pass fixture dirs as path filters.
        return ["yarn", "jest", *targets]
    raise ValueError(repo)

def run(cmd, cwd, capture=True, timeout=None, shell=False):
    try:
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE if capture else None,
                                stderr=subprocess.PIPE if capture else None, shell=shell,
                                text=True, start_new_session=True)
        try:
            out, err = proc.communicate(timeout=timeout)
            return proc.returncode, out or "", err or ""
        except subprocess.TimeoutExpired:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError): pass
            try: out, err = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired: out, err = "", ""
            return 124, out or "", err or ""
    except FileNotFoundError as e:
        return 127, "", str(e)

def git(args, cwd): return run(["git", *args], cwd=str(cwd), timeout=120)
def reset_to(rd, sha):
    ec, _, err = git(["reset", "--hard", sha], cwd=rd)
    return (ec == 0, "" if ec == 0 else f"git reset {sha}: {err[:200]}")
def apply_test_diff(rd, parent, fix, paths):
    arg = " ".join(f"'{p}'" for p in paths)
    ec, _, err = run(f"git diff {parent} {fix} -- {arg} | git apply", cwd=str(rd), shell=True, timeout=60)
    return (ec == 0, "" if ec == 0 else f"git apply test-diff: {err[:200]}")
def checkout_source(rd, fix, paths):
    ec, _, err = git(["checkout", fix, "--", *paths], cwd=rd)
    return (ec == 0, "" if ec == 0 else f"git checkout src: {err[:200]}")
def run_tests(repo, rd, targets):
    t0 = time.time()
    ec, _, err = run(test_command_for(repo, targets), cwd=str(rd), timeout=TEST_CAP_SEC)
    return ec, time.time() - t0, (err[-500:] if err else "")

def process(c):
    repo, pr, parent = c["repo"], c["pr_commit"], c["parent_commit"]
    rd = REPOS_DIR / REPO_DIR_MAP[repo]
    r = {"repo": repo, "pr_commit": pr, "parent_commit": parent, "title": c["title"][:120],
         "status": None, "reason": None, "pre_fix_exit": None, "post_fix_exit": None,
         "test_targets": None, "stderr_tail": None}
    if not rd.exists():
        r["status"], r["reason"] = "infra_failed", f"repo_dir_missing: {rd}"; return r
    targets = resolve_test_targets(repo, c["test_files_touched"])
    r["test_targets"] = targets
    if not targets:
        r["status"], r["reason"] = "infra_failed", "no_runnable_test_target"; return r
    ok, msg = reset_to(rd, parent)
    if not ok: r["status"], r["reason"] = "infra_failed", msg; return r
    ok, msg = apply_test_diff(rd, parent, pr, c["test_files_touched"])
    if not ok:
        r["status"], r["reason"] = "infra_failed", msg; reset_to(rd, parent); return r
    pre, pre_s, pre_err = run_tests(repo, rd, targets)
    r["pre_fix_exit"], r["pre_fix_elapsed_sec"] = pre, round(pre_s, 1)
    if pre == 124: r["status"], r["reason"], r["stderr_tail"] = "timeout", "pre_fix_timeout", pre_err; reset_to(rd, parent); return r
    if pre == 127: r["status"], r["reason"] = "infra_failed", f"runner_not_found: {pre_err[:160]}"; reset_to(rd, parent); return r
    if pre == 0: r["status"], r["reason"], r["stderr_tail"] = "non_reproducible", "pre_fix_unexpectedly_passed", pre_err; reset_to(rd, parent); return r
    ok, msg = checkout_source(rd, pr, c["source_files_touched"])
    if not ok: r["status"], r["reason"] = "infra_failed", msg; reset_to(rd, parent); return r
    post, post_s, post_err = run_tests(repo, rd, targets)
    r["post_fix_exit"], r["post_fix_elapsed_sec"] = post, round(post_s, 1)
    if post == 124: r["status"], r["reason"], r["stderr_tail"] = "timeout", "post_fix_timeout", post_err
    elif post == 127: r["status"], r["reason"] = "infra_failed", f"runner_not_found: {post_err[:160]}"
    elif post == 0: r["status"], r["reason"] = "reproducible", "fail_then_pass"
    else: r["status"], r["reason"], r["stderr_tail"] = "non_reproducible", f"post_fix_still_failed(exit {post})", post_err
    reset_to(rd, parent)
    return r

def main():
    pool = json.loads(POOL_PATH.read_text(encoding="utf-8"))
    cands = [c for c in pool["candidates"] if c["repo"] in REPO_DIR_MAP and not c.get("pre_excluded_before_4c", False)]
    done = set()
    if PROGRESS_PATH.exists():
        for line in PROGRESS_PATH.read_text(encoding="utf-8").splitlines():
            try: done.add(json.loads(line)["pr_commit"])
            except Exception: pass
    todo = [c for c in cands if c["pr_commit"] not in done]
    if os.environ.get("TB_BOX4C_SMOKE"):
        # Validation gate: first N (default 1) candidates per repo only.
        n = int(os.environ.get("TB_BOX4C_SMOKE", "1") or "1")
        seen = {}
        smoke = []
        for c in todo:
            r = c["repo"]
            if seen.get(r, 0) < n:
                smoke.append(c); seen[r] = seen.get(r, 0) + 1
        todo = smoke
        print(f"SMOKE mode: {n}/repo -> {len(todo)} candidates", flush=True)
    print(f"supply box-4c: {len(cands)} candidates, {len(done)} already done, {len(todo)} to run", flush=True)
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    results = []
    for i, c in enumerate(todo, 1):
        t0 = time.time()
        res = process(c)
        with PROGRESS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(res) + "\n"); f.flush(); os.fsync(f.fileno())
        results.append(res)
        print(f"  [{i}/{len(todo)}] {res['repo']} {c['pr_commit'][:8]} -> {res['status']} ({round(time.time()-t0,1)}s) {res['reason'] or ''}", flush=True)
    # Merge full progress (all-time) into the aggregate output.
    allres = []
    for line in PROGRESS_PATH.read_text(encoding="utf-8").splitlines():
        try: allres.append(json.loads(line))
        except Exception: pass
    by_status, by_repo_status = {}, {}
    for r in allres:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        by_repo_status.setdefault(r["repo"], {}).update()
        d = by_repo_status.setdefault(r["repo"], {}); d[r["status"]] = d.get(r["status"], 0) + 1
    OUT_PATH.write_text(json.dumps({
        "phase": "box-4c supply expansion (axios/pytest/prettier)",
        "candidates_count": len(cands), "results_count": len(allres),
        "by_status": by_status, "by_repo_status": by_repo_status, "results": allres,
    }, indent=2), encoding="utf-8")
    print(f"\nDONE. by_status={by_status}", flush=True)
    print(f"by_repo_status={by_repo_status}", flush=True)

if __name__ == "__main__":
    main()
