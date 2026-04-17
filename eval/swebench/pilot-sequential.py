#!/usr/bin/env python3
"""
Sequential single-task runner for pilot.
Runs one task at a time, prunes disk between tasks.
Needed because Docker VM disk fills up with multiple new images.
"""
import json, subprocess, sys, shutil, re, glob
from pathlib import Path

MODEL = "anthropic/claude-sonnet-4-6"


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--budget", choices=["40", "80"], default="40")
    p.add_argument("--only-missing", action="store_true",
                   help="Skip tasks that already have traj.json")
    args = p.parse_args()

    out_dir = Path(f"eval/swebench/results-pilot/baseline-{args.budget}")
    out_dir.mkdir(parents=True, exist_ok=True)
    config = f"eval/swebench/config-baseline-{args.budget}.yaml"
    holdout = json.load(open("eval/swebench/tasks-easy-holdout.json"))

    # Identify missing
    to_run = []
    for t in holdout:
        inst = t["instance_id"]
        existing = out_dir / inst / f"{inst}.traj.json"
        if args.only_missing and existing.exists():
            continue
        to_run.append(t)

    print(f"[sequential] Budget={args.budget}, running {len(to_run)}/{len(holdout)} tasks\n")

    for i, task in enumerate(to_run):
        inst = task["instance_id"]
        repo = task["repo"]
        img = f"docker.io/swebench/sweb.eval.x86_64.{repo.replace('/', '_1776_').replace('-', '_')}-{inst.split('-')[-1]}:latest"

        # Disk check
        df = subprocess.run(["df", "-h", "/"], capture_output=True, text=True).stdout.split("\n")[1]
        print(f"[{i+1}/{len(to_run)}] {inst}  ({df.split()[3]} free)")

        # Clean any dead docker containers
        subprocess.run(["docker", "container", "prune", "-f"], capture_output=True)

        cmd = [
            sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
            "--subset", "verified", "--split", "test",
            "--filter", re.escape(inst),
            "--output", str(out_dir),
            "--workers", "1",
            "-c", config,
            "-c", f"model.model_name={MODEL}",
        ]
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=1500)
            traj = out_dir / inst / f"{inst}.traj.json"
            if traj.exists():
                d = json.load(open(traj))
                info = d.get("info", {})
                has_patch = bool(info.get("submission", "").strip())
                cost = info.get("model_stats", {}).get("instance_cost", 0)
                steps = info.get("model_stats", {}).get("api_calls", 0)
                print(f"    → {info.get('exit_status','?'):20} steps={steps}  ${cost:.2f}  patch={'YES' if has_patch else 'NO'}")
            else:
                print(f"    → no traj (container start failed?)")
        except subprocess.TimeoutExpired:
            print(f"    → TIMEOUT")

        # Prune this task's image to free disk for next one
        # Keep the image only if this is one of first 2 tasks (for quick rerun)
        if i >= 1:
            # Remove images not actively used by kept tasks
            repo_key = repo.split("/")[0]
            inst_num = inst.split("-")[-1]
            # Use docker images filter and remove specifically this task's image
            try:
                full_img = f"swebench/sweb.eval.x86_64.{repo.replace('/', '_1776_').replace('-', '_')}-{inst_num}"
                subprocess.run(["docker", "rmi", "-f", full_img], capture_output=True, timeout=30)
            except Exception:
                pass

    print("\n[sequential] Done")
    # Final summary
    completed = list(out_dir.glob("*/*.traj.json"))
    submitted = sum(1 for t in completed if json.load(open(t)).get("info", {}).get("submission", "").strip())
    cost = sum(json.load(open(t)).get("info", {}).get("model_stats", {}).get("instance_cost", 0) for t in completed)
    print(f"[sequential] {len(completed)}/{len(holdout)} completed, {submitted} submitted, ${cost:.2f}")


if __name__ == "__main__":
    main()
