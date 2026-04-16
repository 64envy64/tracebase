#!/usr/bin/env python3
"""Clean re-run: removes failed entries from preds.json + exit_statuses,
so mini-swe-agent won't skip them."""
import json, subprocess, sys, yaml, shutil, re, os, glob
from pathlib import Path

MODEL = "anthropic/claude-sonnet-4-6"
OUT_DIR = Path("eval/swebench/results-ablation/C-oracle-verify")
TO_RERUN = ["astropy__astropy-7166", "astropy__astropy-13398", "astropy__astropy-13977"]

# 1. Remove these instance_ids from preds.json
preds_path = OUT_DIR / "preds.json"
if preds_path.exists():
    preds = json.load(open(preds_path))
    for inst in TO_RERUN:
        preds.pop(inst, None)
    json.dump(preds, open(preds_path, "w"), indent=2)
    print(f"Cleaned preds.json: {list(preds.keys())}")

# 2. Remove from exit_statuses yaml files (mini-swe-agent also checks these)
for es in glob.glob(str(OUT_DIR / "exit_statuses_*.yaml")):
    d = yaml.safe_load(open(es)) or {}
    for inst in TO_RERUN:
        if isinstance(d, dict):
            for key in list(d.keys()):
                if isinstance(d[key], list) and inst in d[key]:
                    d[key].remove(inst)
                if isinstance(d[key], dict) and inst in d[key]:
                    d[key].pop(inst, None)
    yaml.dump(d, open(es, "w"))

# 3. Remove task dirs if they exist
for inst in TO_RERUN:
    d = OUT_DIR / inst
    if d.exists():
        shutil.rmtree(d)

print(f"\nRe-running {len(TO_RERUN)} tasks with 20-min per-task timeout...\n")

oracles = json.load(open("eval/swebench/oracle-patterns.json"))
base_config = yaml.safe_load(open("eval/swebench/config-C-oracle-verify.yaml"))

for i, inst in enumerate(TO_RERUN):
    oracle = oracles[inst]
    oracle_block = (
        f"\nInstitutional pattern matched for this bug class:\n"
        f"  Situation: {oracle['situation']}\n"
        f"  Bug mechanism: {oracle['bug_mechanism']}\n"
        f"  Fix approach: {oracle['fix_approach']}\n"
        f"  Avoid: {oracle['avoid']}\n"
        f"  Verify: {oracle['verify']}\n"
        f"\nUse this as a starting hypothesis. Verify against the actual code before applying."
    )
    cfg = json.loads(json.dumps(base_config))
    cfg["agent"]["system_template"] = cfg["agent"]["system_template"].replace(
        "___ORACLE_PATTERN_PLACEHOLDER___", oracle_block
    )
    cfg["model"]["model_name"] = MODEL
    cfg_path = f"/tmp/rerunv2-C-{inst}.yaml"
    yaml.dump(cfg, open(cfg_path, "w"), default_flow_style=False, allow_unicode=True)

    print(f"[{i+1}/{len(TO_RERUN)}] {inst}...", end=" ", flush=True)
    cmd = [
        sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
        "--subset", "verified", "--split", "test",
        "--filter", re.escape(inst),
        "--output", str(OUT_DIR),
        "--workers", "1",
        "-c", cfg_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
        traj = OUT_DIR / inst / f"{inst}.traj.json"
        if traj.exists():
            d = json.load(open(traj))
            info = d.get("info", {})
            has_patch = bool(info.get("submission", "").strip())
            cost = info.get("model_stats", {}).get("instance_cost", 0)
            print(f"done [{info.get('exit_status')}, {'PATCH' if has_patch else 'no patch'}, ${cost:.2f}]")
        else:
            print("no traj")
    except subprocess.TimeoutExpired:
        print("TIMEOUT (subprocess)")

# Print final C summary
print("\n=== Final C results ===")
for inst in ["astropy__astropy-7166", "astropy__astropy-13398", "astropy__astropy-13977",
             "astropy__astropy-14182", "astropy__astropy-14369"]:
    traj = OUT_DIR / inst / f"{inst}.traj.json"
    if traj.exists():
        d = json.load(open(traj))
        info = d.get("info", {})
        has_patch = bool(info.get("submission", "").strip())
        cost = info.get("model_stats", {}).get("instance_cost", 0)
        print(f"  {inst}: {info.get('exit_status')}, patch={'YES' if has_patch else 'NO'}, ${cost:.2f}")
    else:
        print(f"  {inst}: MISSING")
