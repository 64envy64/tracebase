#!/usr/bin/env python3
"""Re-run condition C tasks that failed due to network/timeout."""
import json, subprocess, sys, yaml, shutil, re
from pathlib import Path

MODEL = "anthropic/claude-sonnet-4-6"
OUT_DIR = Path("eval/swebench/results-ablation/C-oracle-verify")

# Identify failed tasks (exit_status != Submitted and != LimitsExceeded-with-patch)
failed = []
for traj in OUT_DIR.glob("*/*.traj.json"):
    inst = traj.parent.name
    d = json.load(open(traj))
    info = d.get("info", {})
    exit_status = info.get("exit_status", "")
    has_patch = bool(info.get("submission", "").strip())
    if exit_status in ("InternalServerError", "ConnectionError") or exit_status.startswith("Error"):
        failed.append(inst)
    # TIMEOUT tasks don't have a traj — check missing ones below

# Find missing (TIMEOUT) tasks
expected = ["astropy__astropy-7166", "astropy__astropy-13398", "astropy__astropy-13977",
            "astropy__astropy-14182", "astropy__astropy-14369"]
existing = set(p.parent.name for p in OUT_DIR.glob("*/*.traj.json"))
missing = [i for i in expected if i not in existing]
failed.extend(missing)
failed = sorted(set(failed))

print(f"Re-running {len(failed)} failed C tasks: {failed}")

oracles = json.load(open("eval/swebench/oracle-patterns.json"))
base_config = yaml.safe_load(open("eval/swebench/config-C-oracle-verify.yaml"))

# Clean up failed task dirs (keep the successful ones)
for inst in failed:
    d = OUT_DIR / inst
    if d.exists():
        shutil.rmtree(d)

for i, inst in enumerate(failed):
    oracle = oracles.get(inst)
    if not oracle:
        print(f"  [{i+1}/{len(failed)}] {inst}: no oracle — skip")
        continue

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

    cfg_path = f"/tmp/rerun-C-{inst}.yaml"
    yaml.dump(cfg, open(cfg_path, "w"), default_flow_style=False, allow_unicode=True)

    print(f"  [{i+1}/{len(failed)}] {inst}...", end=" ", flush=True)
    cmd = [
        sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
        "--subset", "verified", "--split", "test",
        "--filter", re.escape(inst),
        "--output", str(OUT_DIR),
        "--workers", "1",
        "-c", cfg_path,
    ]
    # 20 min per task (verify loop needs more time)
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
        traj = OUT_DIR / inst / f"{inst}.traj.json"
        if traj.exists():
            d = json.load(open(traj))
            info = d.get("info", {})
            has_patch = bool(info.get("submission", "").strip())
            cost = info.get("model_stats", {}).get("instance_cost", 0)
            exit_s = info.get("exit_status", "?")
            print(f"done [{exit_s}, {'PATCH' if has_patch else 'no patch'}, ${cost:.2f}]")
        else:
            print("no traj")
    except subprocess.TimeoutExpired:
        print("TIMEOUT (subprocess)")

# Final check
print(f"\nFinal C results:")
for inst in expected:
    traj = OUT_DIR / inst / f"{inst}.traj.json"
    if traj.exists():
        d = json.load(open(traj))
        info = d.get("info", {})
        has_patch = bool(info.get("submission", "").strip())
        print(f"  {inst}: {info.get('exit_status')}, patch={'YES' if has_patch else 'NO'}")
    else:
        print(f"  {inst}: MISSING")
