#!/usr/bin/env python3
"""Emit {pr_commit: committer_iso_date} for every reproducible box-4c
candidate, read from the WSL clones. Run inside WSL.
"""
import json
import os
import subprocess
from pathlib import Path

WORKTREE = Path("/mnt/c/Users/Wave/Desktop/tracebase/.claude/worktrees/interesting-mcclintock-a69a77")
REPRO = WORKTREE / "bench-runs/file-memory-real-repos/results/box-4c-repro.json"
OUT = WORKTREE / "bench-runs/file-memory-real-repos/results/box-4c-commit-dates.json"
REPOS = Path(os.environ["HOME"]) / "file-memory-real-repos/repos"

REPO_DIR = {
    "josdejong/mathjs": "josdejong-mathjs",
    "psf/black": "psf-black",
    "Textualize/rich": "Textualize-rich",
    "colinhacks/zod": "colinhacks-zod",
}

d = json.loads(REPRO.read_text())
dates = {}
for r in d["results"]:
    if r["status"] != "reproducible":
        continue
    rd = REPOS / REPO_DIR[r["repo"]]
    sha = r["pr_commit"]
    try:
        out = subprocess.run(
            ["git", "show", "-s", "--format=%cI", sha],
            cwd=str(rd), capture_output=True, text=True, timeout=30,
        )
        dates[sha] = out.stdout.strip() if out.returncode == 0 else None
    except Exception as e:
        dates[sha] = None
        print(f"  WARN {r['repo']} {sha[:10]}: {e}")

OUT.write_text(json.dumps(dates, indent=2) + "\n")
print(f"Wrote {OUT} with {len(dates)} dates")
for repo, dirname in REPO_DIR.items():
    repo_shas = [r["pr_commit"] for r in d["results"]
                 if r["status"] == "reproducible" and r["repo"] == repo]
    print(f"  {repo}: {len(repo_shas)} dates")
