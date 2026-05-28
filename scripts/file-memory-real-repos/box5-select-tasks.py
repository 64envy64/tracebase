#!/usr/bin/env python3
"""
Box 5 — select the final N=25 task pairs from the box 4c reproducible set.

Selection rule (operator-locked):
  - N=25 target.
  - Include ALL 3 reproducible black tasks (floor=3 waiver, see below).
  - From mathjs / rich / zod, select deterministic oldest-first by commit
    author date (ascending). Ties broken by pr_commit SHA ascending.
  - Per-repo counts: mathjs 7, rich 6, zod 9, black 3 = 25.
  - If a repo has fewer reproducible than its target, take all and document.

black floor=3 waiver (operator-approved):
  - Original per-repo target was >=4 reproducible.
  - black produced only 3 reproducible because fixture-only candidates
    (tests/data/cases/*.py) are not autonomously reproducible under the
    locked harness (parametrize discovery needs helper changes our
    source_files filter doesn't capture).
  - black stays IN with a documented floor=3 waiver: repo-level setup is
    valid and the 3 reproducible tasks are legitimate bug-fix pairs.
  - No extra black candidate mining; no relaxing reproducibility semantics.

Commit dates come from a sidecar file produced in WSL (git show -s
--format=%cI per pr_commit). NO agents, NO API, NO workspaces.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "bench-runs/file-memory-real-repos"
REPRO_PATH = BASE / "results/box-4c-repro.json"
POOL_PATH = BASE / "candidate-pool.json"
DATES_PATH = BASE / "results/box-4c-commit-dates.json"  # {pr_commit: iso_date}
OUT_PATH = BASE / "selected-tasks.json"

TARGETS = {
    "josdejong/mathjs": 7,
    "Textualize/rich": 6,
    "colinhacks/zod": 9,
    "psf/black": 3,
}

repro = json.loads(REPRO_PATH.read_text(encoding="utf-8"))
pool = json.loads(POOL_PATH.read_text(encoding="utf-8"))
dates = json.loads(DATES_PATH.read_text(encoding="utf-8"))

# Index pool candidates by (repo, pr_commit) for full metadata.
pool_idx = {(c["repo"], c["pr_commit"]): c for c in pool["candidates"]}

reproducible = [r for r in repro["results"] if r["status"] == "reproducible"]

by_repo = {}
for r in reproducible:
    by_repo.setdefault(r["repo"], []).append(r)

selected = []
selection_log = {}
for repo, target in TARGETS.items():
    cands = by_repo.get(repo, [])
    # Deterministic oldest-first by commit author date; tie-break by SHA.
    cands_sorted = sorted(
        cands,
        key=lambda r: (dates.get(r["pr_commit"], "9999"), r["pr_commit"]),
    )
    take = cands_sorted[:target]
    actual = len(take)
    selection_log[repo] = {
        "reproducible_available": len(cands),
        "target": target,
        "selected": actual,
        "shortfall": max(0, target - actual),
        "selected_oldest_first": [t["pr_commit"][:10] for t in take],
        "not_selected": [t["pr_commit"][:10] for t in cands_sorted[target:]],
    }
    for t in take:
        meta = pool_idx.get((repo, t["pr_commit"]), {})
        selected.append({
            "repo": repo,
            "pr_commit": t["pr_commit"],
            "parent_commit": t["parent_commit"],
            "commit_date": dates.get(t["pr_commit"]),
            "title": meta.get("title", t.get("title", "")),
            "test_files_touched": meta.get("test_files_touched", []),
            "source_files_touched": meta.get("source_files_touched", []),
            "source_loc_added": meta.get("source_loc_added"),
            "source_loc_removed": meta.get("source_loc_removed"),
            "box_4c_test_targets": t.get("test_targets"),
            "box_4c_pre_fix_exit": t.get("pre_fix_exit"),
            "box_4c_post_fix_exit": t.get("post_fix_exit"),
            "box_4c_pre_fix_elapsed_sec": t.get("pre_fix_elapsed_sec"),
            "box_4c_post_fix_elapsed_sec": t.get("post_fix_elapsed_sec"),
            "reproducibility_status": "reproducible",
        })

out = {
    "version": "tracebase 0.9.x",
    "pre_registration": "bench-runs/file-memory/PRE-REGISTRATION-REAL-REPOS.md",
    "source_pool": "bench-runs/file-memory-real-repos/candidate-pool.json",
    "reproducibility_baseline": "bench-runs/file-memory-real-repos/results/box-4c-repro.json",
    "phase": "box 5 — final task-pair selection (N=25) from box 4c reproducible set",
    "selected_at": "2026-05-28",
    "selection_rule": {
        "target_n": 25,
        "ordering": "deterministic oldest-first by commit author date (ascending); ties broken by pr_commit SHA ascending",
        "per_repo_targets": TARGETS,
        "include_all_black_reproducible": True,
        "no_extra_candidate_mining": True,
        "no_relaxing_reproducibility_semantics": True,
    },
    "black_floor_3_waiver": {
        "original_per_repo_target": ">=4 reproducible",
        "black_actual_reproducible": 3,
        "reason": "fixture-only candidates (tests/data/cases/*.py) are not autonomously reproducible under the locked harness; parametrize discovery requires helper changes that the source_files_touched filter does not capture. The 3 reproducible black tasks all touch tests/test_black.py directly.",
        "decision": "black remains INCLUDED with a documented floor=3 waiver because repo-level setup is valid and the 3 reproducible tasks are legitimate bug-fix pairs.",
        "approved_by": "operator (turn after 357f2c3)",
    },
    "selection_log": selection_log,
    "total_selected": len(selected),
    "language_distribution": {
        "JavaScript": sum(1 for s in selected if s["repo"] == "josdejong/mathjs"),
        "TypeScript": sum(1 for s in selected if s["repo"] == "colinhacks/zod"),
        "Python": sum(1 for s in selected if s["repo"] in ("psf/black", "Textualize/rich")),
    },
    "tasks": selected,
}

OUT_PATH.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

print(f"Wrote {OUT_PATH}")
print(f"Total selected: {len(selected)}")
print()
for repo, log in selection_log.items():
    flag = "" if log["shortfall"] == 0 else f"  ** SHORTFALL {log['shortfall']} **"
    print(f"  {repo}: {log['selected']}/{log['target']} (of {log['reproducible_available']} repro){flag}")
print()
print("Language distribution:", out["language_distribution"])
