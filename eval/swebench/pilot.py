#!/usr/bin/env python3
"""
Phase 3 Capability Pilot
=========================

Research question: does Sonnet 4.6 have headroom on easy SWE-bench tasks?
Decision rule:
  - Run 1: baseline @ 40 steps / $1  (standard budget)
  - Run 2: baseline @ 80 steps / $2  (doubled budget, control)
  - If BOTH resolve < 30% of holdout → model/budget bottleneck, TraceBase-side
    changes are unlikely to help. Stop here.
  - If either resolves ≥ 30% → there IS headroom; run A/B/C ablation at that budget.

Holdout: 10 tasks, difficulty="<15 min fix", 5 repos (disjoint from train).

NOT a benchmark claim. Internal capability diagnostic.
"""
import json, subprocess, sys, shutil, re, glob
from pathlib import Path

MODEL = "anthropic/claude-sonnet-4-6"
RESULTS = Path("eval/swebench/results-pilot")


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--run", choices=["40", "80", "grade", "all"], default="all")
    args = p.parse_args()

    RESULTS.mkdir(parents=True, exist_ok=True)
    holdout = json.load(open("eval/swebench/tasks-easy-holdout.json"))

    if args.run in ("40", "all"):
        print("#" * 60)
        print("# RUN 1: baseline @ 40 steps / $1")
        print("#" * 60)
        run_one(holdout, "eval/swebench/config-baseline-40.yaml",
                RESULTS / "baseline-40", label="40")

    if args.run in ("80", "all"):
        print("\n" + "#" * 60)
        print("# RUN 2: baseline @ 80 steps / $2 (control)")
        print("#" * 60)
        run_one(holdout, "eval/swebench/config-baseline-80.yaml",
                RESULTS / "baseline-80", label="80")

    if args.run in ("grade", "all"):
        grade_all(holdout)


def run_one(holdout, config_path, out_dir, label):
    shutil.rmtree(out_dir, ignore_errors=True)
    ids = [t["instance_id"] for t in holdout]
    filter_re = "|".join(re.escape(i) for i in ids)

    cmd = [
        sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
        "--subset", "verified", "--split", "test",
        "--filter", filter_re,
        "--output", str(out_dir),
        "--workers", "1",
        "-c", config_path,
        "-c", f"model.model_name={MODEL}",
    ]
    print(f"  Running {len(holdout)} tasks...")
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=14400)
    except subprocess.TimeoutExpired:
        print("  ⚠ outer timeout")

    trajs = list(out_dir.glob("*/*.traj.json"))
    submitted = sum(1 for t in trajs if _has_patch(t))
    cost = sum(json.load(open(t)).get("info", {}).get("model_stats", {}).get("instance_cost", 0) for t in trajs)
    print(f"  Done: {len(trajs)}/{len(holdout)} completed, {submitted} submitted, ${cost:.2f}")


def grade_all(holdout):
    print("\n" + "#" * 60)
    print("# GRADING")
    print("#" * 60)

    for label in ["40", "80"]:
        out_dir = RESULTS / f"baseline-{label}"
        if not out_dir.exists():
            continue

        # Build predictions.jsonl
        preds = json.load(open(out_dir / "preds.json"))
        jsonl = out_dir / "predictions.jsonl"
        with open(jsonl, "w") as f:
            for inst_id, data in preds.items():
                f.write(json.dumps({
                    "instance_id": inst_id,
                    "model_patch": data.get("model_patch", ""),
                    "model_name_or_path": "tracebase",
                }) + "\n")

        run_id = f"pilot-baseline-{label}"
        cmd = [
            sys.executable, "-m", "swebench.harness.run_evaluation",
            "--predictions_path", str(jsonl),
            "--dataset_name", "princeton-nlp/SWE-bench_Verified",
            "--split", "test",
            "--max_workers", "1",
            "--run_id", run_id,
        ]
        print(f"\n  Grading @ {label}...")
        subprocess.run(cmd, capture_output=True, text=True, timeout=7200)

        for rpt in glob.glob(f"*.{run_id}.json"):
            d = json.load(open(rpt))
            print(f"  {label}: resolved {d['resolved_instances']}/{d['completed_instances']} "
                  f"(submitted {d['submitted_instances']}, empty {d['empty_patch_instances']})")
            shutil.move(rpt, out_dir / Path(rpt).name)

    # Summary + decision
    print_decision(holdout)


def print_decision(holdout):
    n = len(holdout)
    print("\n" + "=" * 70)
    print(f"CAPABILITY PILOT RESULTS — Sonnet 4.6, {n} easy holdout tasks, 5 repos")
    print("=" * 70)

    for label in ["40", "80"]:
        out_dir = RESULTS / f"baseline-{label}"
        if not out_dir.exists():
            continue
        # Load grader report
        resolved_ids = set()
        for rpt in glob.glob(str(out_dir / "tracebase.pilot-*.json")):
            d = json.load(open(rpt))
            resolved_ids = set(d.get("resolved_ids", []))
        # Load submission info
        preds = json.load(open(out_dir / "preds.json")) if (out_dir / "preds.json").exists() else {}
        submitted = sum(1 for v in preds.values() if v.get("model_patch", "").strip())
        cost = sum(json.load(open(t)).get("info", {}).get("model_stats", {}).get("instance_cost", 0)
                   for t in out_dir.glob("*/*.traj.json"))

        print(f"\n  budget={label}(steps/$):")
        print(f"    submitted: {submitted}/{n}")
        print(f"    resolved:  {len(resolved_ids)}/{n} ({len(resolved_ids)/n*100:.0f}%)")
        print(f"    cost:      ${cost:.2f}")
        print(f"    resolved_ids: {sorted(resolved_ids)}")

    # Decision
    reports = {}
    for label in ["40", "80"]:
        for rpt in glob.glob(str(RESULTS / f"baseline-{label}/tracebase.pilot-*.json")):
            d = json.load(open(rpt))
            reports[label] = len(set(d.get("resolved_ids", [])))

    print("\n" + "-" * 70)
    print("  DECISION:")
    print("-" * 70)
    r40 = reports.get("40", 0) / n if n else 0
    r80 = reports.get("80", 0) / n if n else 0
    if r40 >= 0.3 or r80 >= 0.3:
        which = "40" if r40 >= 0.3 else "80"
        print(f"    ✓ Headroom found at budget {which} ({reports.get(which)}/{n}).")
        print(f"    → Run A/B/C ablation at budget {which}.")
    else:
        print(f"    ✗ No headroom: both budgets under 30% resolved.")
        print(f"    → Bottleneck is model/budget, not TraceBase components.")
        print(f"    → Do NOT run more TraceBase-side ablations on this sample.")


def _has_patch(traj_path):
    try:
        d = json.load(open(traj_path))
        return len(d.get("info", {}).get("submission", "").strip()) > 0
    except Exception:
        return False


if __name__ == "__main__":
    main()
