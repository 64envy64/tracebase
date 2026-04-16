#!/usr/bin/env python3
"""
Phase 2: 4-Condition Ablation (Oracle Diagnostic)
==================================================

Isolates effect of each component:
  A: no injection, no verify          (pure baseline)
  B: oracle pattern, no verify        (injection only)
  C: oracle pattern + verify           (injection + verify)
  D: (reused from v2) bad retrieval + verify  = current production simulation

Combined with already-have:
  A' (v2 baseline): no inject + verify — already have

Comparisons:
  A  vs A' = effect of verify alone
  A  vs B  = effect of injection alone
  B  vs C  = effect of verify added to good injection
  C  vs D  = effect of retrieval quality (oracle vs bad)

Primary metric: official SWE-bench grader resolved rate on each condition.

Oracle patterns are crafted to be HYPOTHESIS-form (situation/bug_mechanism/
fix_approach/avoid/verify), without leaking gold file names or exact fix lines.
Used as internal diagnostic ONLY; not a benchmark claim.
"""
import json
import subprocess
import sys
import shutil
import yaml
import re
from pathlib import Path

MODEL = "anthropic/claude-sonnet-4-6"
RESULTS = Path("eval/swebench/results-ablation")
TIMEOUT_PER_CONDITION = 3600  # 60 min per 5-task run


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--conditions", default="A,B,C", help="Which to run (A=no-inj-no-ver, B=oracle-no-ver, C=oracle-ver)")
    p.add_argument("--grade", action="store_true", help="Run official grader after completion")
    args = p.parse_args()

    RESULTS.mkdir(parents=True, exist_ok=True)
    holdout = json.load(open("eval/swebench/tasks-holdout.json"))
    oracles = json.load(open("eval/swebench/oracle-patterns.json"))

    conditions = args.conditions.split(",")
    for cond in conditions:
        cond = cond.strip()
        print(f"\n{'#'*60}")
        print(f"# CONDITION {cond}")
        print(f"{'#'*60}")
        run_condition(cond, holdout, oracles)

    # Always grade at end (cheap — only on submitted patches)
    print(f"\n{'#'*60}")
    print(f"# OFFICIAL GRADER")
    print(f"{'#'*60}")
    for cond in conditions:
        grade_condition(cond.strip())

    # Summary
    print_ablation_summary(conditions, holdout)


def run_condition(cond: str, holdout, oracles):
    """Run all holdout tasks for one condition.

    Conditions A/B/C: need fresh runs.
    Conditions A' and D: reuse existing v2 data (not run here).
    """
    if cond == "A":
        run_A(holdout)
    elif cond == "B":
        run_BC(holdout, oracles, "B", "eval/swebench/config-B-oracle-no-verify.yaml")
    elif cond == "C":
        run_BC(holdout, oracles, "C", "eval/swebench/config-C-oracle-verify.yaml")
    else:
        print(f"  Condition {cond}: reusing v2 data — no new run")


def run_A(holdout):
    out_dir = RESULTS / "A-no-inject-no-verify"
    shutil.rmtree(out_dir, ignore_errors=True)
    ids = [t["instance_id"] for t in holdout]
    filter_re = "|".join(re.escape(i) for i in ids)

    cmd = [
        sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
        "--subset", "verified", "--split", "test",
        "--filter", filter_re,
        "--output", str(out_dir),
        "--workers", "1",
        "-c", "eval/swebench/config-A-no-inject-no-verify.yaml",
        "-c", f"model.model_name={MODEL}",
    ]
    print(f"  Running {len(holdout)} tasks (A)...")
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_PER_CONDITION)
    except subprocess.TimeoutExpired:
        print("  ⚠ timed out")
    report_phase(out_dir, len(holdout))


def run_BC(holdout, oracles, label, base_config_path):
    """Run B or C: per-task oracle injection."""
    out_dir = RESULTS / f"{label}-oracle-{'no-verify' if label == 'B' else 'verify'}"
    shutil.rmtree(out_dir, ignore_errors=True)

    base_config = yaml.safe_load(open(base_config_path))

    for i, task in enumerate(holdout):
        inst = task["instance_id"]
        oracle = oracles.get(inst)
        if not oracle:
            print(f"  [{i+1}/{len(holdout)}] {inst}: no oracle pattern, SKIP")
            continue

        # Build oracle block
        oracle_block = (
            f"\nInstitutional pattern matched for this bug class:\n"
            f"  Situation: {oracle['situation']}\n"
            f"  Bug mechanism: {oracle['bug_mechanism']}\n"
            f"  Fix approach: {oracle['fix_approach']}\n"
            f"  Avoid: {oracle['avoid']}\n"
            f"  Verify: {oracle['verify']}\n"
            f"\nUse this as a starting hypothesis. Verify against the actual code before applying."
        )

        # Substitute placeholder in system prompt
        cfg = json.loads(json.dumps(base_config))  # deep copy
        cfg["agent"]["system_template"] = cfg["agent"]["system_template"].replace(
            "___ORACLE_PATTERN_PLACEHOLDER___", oracle_block
        )
        cfg["model"]["model_name"] = MODEL

        # Write per-task config
        cfg_path = f"/tmp/ablation-{label}-{inst}.yaml"
        yaml.dump(cfg, open(cfg_path, "w"), default_flow_style=False, allow_unicode=True)

        # Run single task
        cmd = [
            sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
            "--subset", "verified", "--split", "test",
            "--filter", re.escape(inst),
            "--output", str(out_dir),
            "--workers", "1",
            "-c", cfg_path,
        ]
        print(f"  [{i+1}/{len(holdout)}] {inst}... ", end="", flush=True)
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            traj = out_dir / inst / f"{inst}.traj.json"
            if traj.exists():
                d = json.load(open(traj))
                info = d.get("info", {})
                has_patch = bool(info.get("submission", "").strip())
                cost = info.get("model_stats", {}).get("instance_cost", 0)
                print(f"done ({'PATCH' if has_patch else 'no patch'}, ${cost:.2f})")
            else:
                print("no traj")
        except subprocess.TimeoutExpired:
            print("TIMEOUT")

    report_phase(out_dir, len(holdout))


def report_phase(out_dir: Path, n_total: int):
    trajs = list(out_dir.glob("*/*.traj.json"))
    submitted = sum(1 for t in trajs if _has_patch(t))
    total_cost = 0
    for t in trajs:
        d = json.load(open(t))
        total_cost += d.get("info", {}).get("model_stats", {}).get("instance_cost", 0)
    print(f"  Summary: {len(trajs)}/{n_total} completed, {submitted} patches, ${total_cost:.2f}")


def grade_condition(cond: str):
    # Map condition to its directory and predictions
    if cond == "A":
        pred_dir = RESULTS / "A-no-inject-no-verify"
    elif cond == "B":
        pred_dir = RESULTS / "B-oracle-no-verify"
    elif cond == "C":
        pred_dir = RESULTS / "C-oracle-verify"
    elif cond == "A_prime":
        pred_dir = Path("eval/swebench/results-v2/baseline-sonnet")
    elif cond == "D":
        pred_dir = Path("eval/swebench/results-v2/augmented-sonnet")
    else:
        return

    preds_path = pred_dir / "preds.json"
    if not preds_path.exists():
        print(f"  {cond}: no preds.json")
        return

    preds = json.load(open(preds_path))
    jsonl = pred_dir / "predictions.jsonl"
    with open(jsonl, "w") as f:
        for inst_id, data in preds.items():
            f.write(json.dumps({
                "instance_id": inst_id,
                "model_patch": data.get("model_patch", ""),
                "model_name_or_path": "tracebase",
            }) + "\n")

    run_id = f"ablation-{cond}"
    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--predictions_path", str(jsonl),
        "--dataset_name", "princeton-nlp/SWE-bench_Verified",
        "--split", "test",
        "--max_workers", "1",
        "--run_id", run_id,
    ]
    print(f"\n  Grading {cond}...")
    subprocess.run(cmd, capture_output=True, text=True, timeout=3600)

    # Find report
    import glob
    for rpt in glob.glob(f"*.{run_id}.json"):
        d = json.load(open(rpt))
        print(f"  {cond}: resolved {d['resolved_instances']}/{d['completed_instances']} (submitted {d['submitted_instances']})")
        shutil.move(rpt, pred_dir / Path(rpt).name)


def print_ablation_summary(conditions, holdout):
    """Summary table across all conditions."""
    n = len(holdout)
    print(f"\n\n{'='*70}")
    print("ABLATION SUMMARY — SWE-bench Verified, Sonnet 4.6")
    print(f"Holdout: {n} tasks (disjoint from train)")
    print(f"{'='*70}\n")

    rows = [
        ("A",  "no inject, no verify",          RESULTS / "A-no-inject-no-verify"),
        ("A'", "no inject, verify (v2 base)",   Path("eval/swebench/results-v2/baseline-sonnet")),
        ("B",  "oracle inject, no verify",      RESULTS / "B-oracle-no-verify"),
        ("C",  "oracle inject, verify",         RESULTS / "C-oracle-verify"),
        ("D",  "bad retrieval, verify (v2 aug)", Path("eval/swebench/results-v2/augmented-sonnet")),
    ]

    print(f"  {'Condition':<35} {'Submitted':<12} {'Resolved':<12}  Cost")
    print("  " + "-" * 70)
    for label, desc, d in rows:
        if not d.exists():
            print(f"  {label:>3}  {desc:<30}   [not run]")
            continue
        trajs = list(d.glob("*/*.traj.json"))
        submitted = sum(1 for t in trajs if _has_patch(t))
        cost = sum(json.load(open(t)).get("info", {}).get("model_stats", {}).get("instance_cost", 0) for t in trajs)

        # Find resolved count from any grader report in that dir
        import glob as _glob
        resolved = "?"
        for rpt in _glob.glob(str(d / "*.json")):
            name = Path(rpt).name
            if name.startswith("tracebase.ablation-") or name.startswith("anthropic__") or name.startswith("tracebase.v2-"):
                try:
                    r = json.load(open(rpt))
                    if "resolved_instances" in r:
                        resolved = r["resolved_instances"]
                        break
                except Exception:
                    pass

        print(f"  {label:>3}  {desc:<30} {submitted:>2}/{n:<9} {resolved}/{n:<9}  ${cost:.2f}")

    print(f"\n{'='*70}")
    print("Comparisons:")
    print("  A  vs A': effect of verify alone")
    print("  A  vs B : effect of injection alone (oracle)")
    print("  B  vs C : effect of verify added to good injection")
    print("  C  vs D : effect of retrieval quality (oracle vs bad)")
    print(f"{'='*70}\n")


def _has_patch(traj_path):
    try:
        d = json.load(open(traj_path))
        return len(d.get("info", {}).get("submission", "").strip()) > 0
    except Exception:
        return False


if __name__ == "__main__":
    main()
