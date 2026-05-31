#!/usr/bin/env python3
"""
Generalized box-4c reproducibility verifier (fail-then-pass oracle) covering all
working repos. Reads a pool from TB_POOL (the mined candidates), resumable via
TB_PROGRESS, writes TB_OUT. Same logic + per-repo commands proven by
wsl-box-4c-repro.py (zod/mathjs/rich/black) and box-4c-supply.py (axios). pytest
is excluded (0% reproducible — self-test invocation not cleanly scopable).
"""
import json, os, signal, subprocess, sys, time
from pathlib import Path

POOL = Path(os.environ["TB_POOL"])
OUT = Path(os.environ["TB_OUT"])
PROGRESS = Path(os.environ["TB_PROGRESS"])
REPOS_DIR = Path(os.environ.get("TB_REPOS", str(Path.home() / "file-memory-real-repos/repos")))
TEST_CAP = int(os.environ.get("TB_TEST_CAP", "180"))

REPO_DIR_MAP = {
    "colinhacks/zod": "colinhacks-zod",
    "josdejong/mathjs": "josdejong-mathjs",
    "Textualize/rich": "Textualize-rich",
    "psf/black": "psf-black",
    "axios/axios": "axios-axios",
    "pallets/werkzeug": "pallets-werkzeug",
}

def is_real_test(repo, p):
    if repo == "pallets/werkzeug": return p.startswith("tests/") and "/test_" in "/" + p and p.endswith(".py")
    if repo == "josdejong/mathjs": return p.endswith(".test.js") or p.endswith(".test.mjs")
    if repo == "psf/black": return p.startswith("tests/") and not p.startswith("tests/data/") and "/test_" in "/" + p
    if repo == "Textualize/rich": return p.startswith("tests/test_") and p.endswith(".py")
    if repo == "colinhacks/zod": return p.endswith(".test.ts") or p.endswith(".test.tsx") or p.endswith(".test.js")
    if repo == "axios/axios": return p.startswith("tests/") and (p.endswith(".test.js") or p.endswith(".spec.js"))
    return False

def targets(repo, tests):
    real = [t for t in tests if is_real_test(repo, t)]
    if real: return real
    if repo == "psf/black": return ["tests/test_format.py"]
    return []

def cmd_for(repo, t):
    if repo == "josdejong/mathjs": return ["npx", "mocha", "--reporter", "min", *t]
    if repo in ("psf/black", "Textualize/rich", "pallets/werkzeug"): return [".venv/bin/python", "-m", "pytest", "-q", "--no-header", "-x", *t]
    if repo == "colinhacks/zod": return ["pnpm", "test", "--", "--reporter=basic", *t]
    if repo == "axios/axios": return ["npx", "vitest", "run", "--project", "unit", *t]
    raise ValueError(repo)

def run(cmd, cwd, timeout=None, shell=False):
    try:
        p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=shell, text=True, start_new_session=True)
        try: o, e = p.communicate(timeout=timeout); return p.returncode, o or "", e or ""
        except subprocess.TimeoutExpired:
            try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError): pass
            try: o, e = p.communicate(timeout=5)
            except subprocess.TimeoutExpired: o, e = "", ""
            return 124, o or "", e or ""
    except FileNotFoundError as ex: return 127, "", str(ex)

def git(a, cwd): return run(["git", *a], cwd=str(cwd), timeout=120)

def process(c):
    repo, pr, parent = c["repo"], c["pr_commit"], c["parent_commit"]
    rd = REPOS_DIR / REPO_DIR_MAP[repo]
    r = {"repo": repo, "pr_commit": pr, "parent_commit": parent, "title": c["title"][:120], "status": None, "reason": None, "pre_fix_exit": None, "post_fix_exit": None, "test_targets": None}
    if not rd.exists(): r["status"], r["reason"] = "infra_failed", "repo_dir_missing"; return r
    tg = targets(repo, c["test_files_touched"]); r["test_targets"] = tg
    if not tg: r["status"], r["reason"] = "infra_failed", "no_runnable_test_target"; return r
    ec, _, e = git(["reset", "--hard", parent], rd)
    if ec != 0: r["status"], r["reason"] = "infra_failed", f"reset: {e[:150]}"; return r
    arg = " ".join(f"'{p}'" for p in c["test_files_touched"])
    ec, _, e = run(f"git diff {parent} {pr} -- {arg} | git apply", cwd=str(rd), shell=True, timeout=60)
    if ec != 0: r["status"], r["reason"] = "infra_failed", f"apply: {e[:150]}"; git(["reset", "--hard", parent], rd); return r
    t0 = time.time(); pre, _, pe = run(cmd_for(repo, tg), cwd=str(rd), timeout=TEST_CAP); r["pre_fix_exit"] = pre; r["pre_fix_elapsed_sec"] = round(time.time()-t0, 1)
    if pre == 124: r["status"], r["reason"] = "timeout", "pre_timeout"; git(["reset","--hard",parent],rd); return r
    if pre == 127: r["status"], r["reason"] = "infra_failed", f"runner_not_found:{pe[:120]}"; git(["reset","--hard",parent],rd); return r
    if pre == 0: r["status"], r["reason"] = "non_reproducible", "pre_passed"; git(["reset","--hard",parent],rd); return r
    ec, _, e = git(["checkout", pr, "--", *c["source_files_touched"]], rd)
    if ec != 0: r["status"], r["reason"] = "infra_failed", f"checkout:{e[:150]}"; git(["reset","--hard",parent],rd); return r
    t0 = time.time(); post, _, poe = run(cmd_for(repo, tg), cwd=str(rd), timeout=TEST_CAP); r["post_fix_exit"] = post; r["post_fix_elapsed_sec"] = round(time.time()-t0, 1)
    if post == 124: r["status"], r["reason"] = "timeout", "post_timeout"
    elif post == 127: r["status"], r["reason"] = "infra_failed", f"runner_not_found:{poe[:120]}"
    elif post == 0: r["status"], r["reason"] = "reproducible", "fail_then_pass"
    else: r["status"], r["reason"] = "non_reproducible", f"post_failed(exit {post})"
    git(["reset", "--hard", parent], rd)
    return r

def main():
    pool = json.loads(POOL.read_text())
    cands = pool.get("candidates", pool if isinstance(pool, list) else [])
    cands = [c for c in cands if c["repo"] in REPO_DIR_MAP]
    done = set()
    if PROGRESS.exists():
        for l in PROGRESS.read_text().splitlines():
            try: done.add(json.loads(l)["pr_commit"])
            except Exception: pass
    todo = [c for c in cands if c["pr_commit"] not in done]
    print(f"box-4c-verify: {len(cands)} candidates, {len(done)} done, {len(todo)} to run", flush=True)
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    for i, c in enumerate(todo, 1):
        t0 = time.time(); res = process(c)
        with PROGRESS.open("a") as f: f.write(json.dumps(res) + "\n"); f.flush(); os.fsync(f.fileno())
        print(f"  [{i}/{len(todo)}] {res['repo']} {c['pr_commit'][:8]} -> {res['status']} ({round(time.time()-t0,1)}s) {res['reason'] or ''}", flush=True)
    allr = []
    for l in PROGRESS.read_text().splitlines():
        try: allr.append(json.loads(l))
        except Exception: pass
    bs, brs = {}, {}
    for r in allr:
        bs[r["status"]] = bs.get(r["status"], 0) + 1
        d = brs.setdefault(r["repo"], {}); d[r["status"]] = d.get(r["status"], 0) + 1
    OUT.write_text(json.dumps({"phase": "box-4c mined verify", "results_count": len(allr), "by_status": bs, "by_repo_status": brs, "results": allr}, indent=2))
    print(f"\nDONE by_status={bs}\nby_repo={brs}", flush=True)

if __name__ == "__main__":
    main()
