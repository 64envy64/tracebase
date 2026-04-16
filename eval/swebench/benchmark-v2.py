#!/usr/bin/env python3
"""
TraceBase v2 SWE-bench Benchmark
=================================

Primary metric: official resolved rate (not submission rate).
Uses pre-submit verification + reasoning-pattern injection.

Methodology:
  1. Train: run agent on train split → extract reasoning patterns from successes
  2. Eval baseline: run agent on holdout split with pre-submit verification (no injection)
  3. Eval augmented: same + reasoning patterns injected as hypotheses
  4. Grade: official swebench grader on both
  5. Report: resolved rate, coverage, efficiency

Usage:
  python3 eval/swebench/benchmark-v2.py --model sonnet --skip-train
"""
import json
import subprocess
import sys
import shutil
import yaml
import re
from pathlib import Path

MODEL_MAP = {
    "haiku": "anthropic/claude-haiku-4-5-20251001",
    "sonnet": "anthropic/claude-sonnet-4-6",
    "opus": "anthropic/claude-opus-4-6",
}
RESULTS = Path("eval/swebench/results-v2")


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="sonnet")
    p.add_argument("--skip-train", action="store_true")
    args = p.parse_args()

    model_short = args.model
    model = MODEL_MAP.get(model_short, model_short)
    RESULTS.mkdir(parents=True, exist_ok=True)

    train_tasks = json.load(open("eval/swebench/tasks-train.json"))
    holdout_tasks = json.load(open("eval/swebench/tasks-holdout.json"))
    holdout_ids = [t["instance_id"] for t in holdout_tasks]

    print(f"TraceBase v2 Benchmark")
    print(f"Model: {model} | Train: {len(train_tasks)} | Holdout: {len(holdout_tasks)}")
    print(f"Primary metric: official resolved rate")
    print("=" * 60)

    # ── Phase 1: Train (build KB) ───────────────────────────────
    train_dir = RESULTS / f"train-{model_short}"
    existing_train = Path("eval/swebench/results") / f"train-{model_short}"

    if args.skip_train and existing_train.exists():
        print(f"\n[1/5] TRAIN: reusing {existing_train}")
        if train_dir.exists(): shutil.rmtree(train_dir)
        shutil.copytree(existing_train, train_dir)
    else:
        print(f"\n[1/5] TRAIN: running {len(train_tasks)} tasks...")
        run_mini_swe(model, train_tasks, train_dir, "eval/swebench/config-v2.yaml")

    kb = build_reasoning_kb(train_dir, train_tasks)
    print(f"  KB: {len(kb)} reasoning patterns")

    # ── Phase 2: Eval Baseline (with pre-submit verification, no injection) ─
    bl_dir = RESULTS / f"baseline-{model_short}"
    print(f"\n[2/5] EVAL BASELINE: {len(holdout_tasks)} holdout tasks (no injection)...")
    run_mini_swe(model, holdout_tasks, bl_dir, "eval/swebench/config-v2.yaml")

    # ── Phase 3: Eval Augmented (with KB injection) ─────────────
    aug_config = write_augmented_config(kb, model)
    aug_dir = RESULTS / f"augmented-{model_short}"
    print(f"\n[3/5] EVAL AUGMENTED: {len(holdout_tasks)} holdout tasks (with KB)...")
    run_mini_swe(model, holdout_tasks, aug_dir, aug_config)

    # ── Phase 4: Official grader ────────────────────────────────
    print(f"\n[4/5] OFFICIAL GRADER...")
    bl_resolved = run_grader(bl_dir, f"v2-baseline-{model_short}")
    aug_resolved = run_grader(aug_dir, f"v2-augmented-{model_short}")

    # ── Phase 5: Report ─────────────────────────────────────────
    print_report(model_short, bl_dir, aug_dir, holdout_tasks, bl_resolved, aug_resolved)


def run_mini_swe(model, tasks, output_dir, config):
    shutil.rmtree(output_dir, ignore_errors=True)
    ids = [t["instance_id"] for t in tasks]
    filter_re = "|".join(re.escape(i) for i in ids)

    cmd = [
        sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
        "--subset", "verified", "--split", "test",
        "--filter", filter_re,
        "--output", str(output_dir),
        "--workers", "1",
        "-c", config,
        "-c", f"model.model_name={model}",
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    except subprocess.TimeoutExpired:
        print("  Warning: timed out")

    trajs = list(output_dir.glob("*/*.traj.json"))
    submitted = sum(1 for t in trajs if _has_patch(t))
    print(f"  Completed: {len(trajs)}/{len(tasks)}, submitted: {submitted}")


def run_grader(pred_dir, run_id):
    """Run official SWE-bench grader. Returns set of resolved instance IDs."""
    pred_path = pred_dir / "predictions.jsonl"
    preds = json.load(open(pred_dir / "preds.json"))

    # Convert to jsonl
    with open(pred_path, "w") as f:
        for inst_id, data in preds.items():
            f.write(json.dumps({
                "instance_id": inst_id,
                "model_patch": data.get("model_patch", ""),
                "model_name_or_path": "tracebase",
            }) + "\n")

    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--predictions_path", str(pred_path),
        "--dataset_name", "princeton-nlp/SWE-bench_Verified",
        "--split", "test",
        "--max_workers", "1",
        "--run_id", run_id,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)

    # Find the report file
    import glob
    reports = glob.glob(f"*.{run_id}.json")
    resolved = set()
    for rpt in reports:
        d = json.load(open(rpt))
        resolved = set(d.get("resolved_ids", []))
        # Move report to results dir
        shutil.move(rpt, pred_dir / Path(rpt).name)
        print(f"  Grader: {d['resolved_instances']} resolved / {d['completed_instances']} completed")
        break

    if not reports:
        print(f"  Grader: no report found. Checking stdout...")
        # Parse from stdout
        for line in result.stdout.split("\n"):
            if "resolved" in line.lower():
                print(f"    {line.strip()}")

    return resolved


def build_reasoning_kb(train_dir, tasks):
    """Extract reasoning patterns from successful train runs.

    Key difference from v1: store bug MECHANISM + fix APPROACH,
    not just file paths. This helps with correctness, not just navigation.
    """
    kb = []
    task_map = {t["instance_id"]: t for t in tasks}

    for traj_path in sorted(train_dir.glob("*/*.traj.json")):
        inst = traj_path.parent.name
        d = json.load(open(traj_path))
        info = d.get("info", {})
        submission = info.get("submission", "")
        if not submission:
            continue

        task = task_map.get(inst)
        if not task:
            continue

        # Extract reasoning from the trajectory messages
        messages = d.get("messages", [])
        reasoning_chunks = []
        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, str) and msg.get("role") == "assistant":
                # Extract THOUGHT sections
                if "THOUGHT" in content or "hypothesis" in content.lower() or "root cause" in content.lower():
                    reasoning_chunks.append(content[:300])

        # Extract structural info from patch
        patch_files = [l[6:] for l in submission.split("\n") if l.startswith("+++ b/")]
        added = [l[1:].strip() for l in submission.split("\n")
                if l.startswith("+") and not l.startswith("+++") and l[1:].strip()
                and not l[1:].strip().startswith("#")]

        kb.append({
            "instance_id": inst,
            "repo": task["repo"],
            "bug_summary": task["problem_statement"][:200],
            "fix_files": patch_files[:3],
            "fix_approach": "; ".join(added[:3])[:200],
            "reasoning": " ".join(reasoning_chunks[:2])[:300] if reasoning_chunks else "",
        })

    return kb


def write_augmented_config(kb, model):
    """Write augmented config with reasoning-pattern injection."""
    # Group by repo
    by_repo = {}
    for t in kb:
        by_repo.setdefault(t["repo"], []).append(t)

    # Build reasoning patterns (not file hints)
    pattern_lines = []
    for repo, traces in sorted(by_repo.items()):
        pattern_lines.append(f"Repository: {repo}")
        for t in traces[:8]:  # limit to prevent context bloat
            files = ", ".join(t["fix_files"][:2])
            approach = t["fix_approach"][:100] if t["fix_approach"] else "see patch"
            pattern_lines.append(f"  - Bug: {t['bug_summary'][:80]}")
            pattern_lines.append(f"    Files: {files}")
            pattern_lines.append(f"    Fix approach: {approach}")

    patterns_text = "\n".join(pattern_lines)

    # Read the augmented config and inject patterns into system prompt
    config = yaml.safe_load(open("eval/swebench/config-v2-augmented.yaml"))

    # Append patterns to system template
    config["agent"]["system_template"] += f"\n\nInstitutional memory ({len(kb)} resolved patterns):\n{patterns_text}"
    config["model"]["model_name"] = model

    path = str(RESULTS / "augmented-config.yaml")
    yaml.dump(config, open(path, "w"), default_flow_style=False, allow_unicode=True)
    return path


def _has_patch(traj_path):
    d = json.load(open(traj_path))
    return len(d.get("info", {}).get("submission", "")) > 0


def print_report(model_short, bl_dir, aug_dir, holdout_tasks, bl_resolved, aug_resolved):
    bl_preds = json.load(open(bl_dir / "preds.json"))
    aug_preds = json.load(open(aug_dir / "preds.json"))

    n = len(holdout_tasks)
    bl_submitted = sum(1 for v in bl_preds.values() if v.get("model_patch"))
    aug_submitted = sum(1 for v in aug_preds.values() if v.get("model_patch"))
    bl_res = len(bl_resolved)
    aug_res = len(aug_resolved)

    # Cost from trajectories
    bl_cost = aug_cost = 0
    bl_steps = aug_steps = 0
    for traj in bl_dir.glob("*/*.traj.json"):
        d = json.load(open(traj))
        i = d.get("info", {}).get("model_stats", {})
        bl_cost += i.get("instance_cost", 0)
        bl_steps += i.get("api_calls", 0)
    for traj in aug_dir.glob("*/*.traj.json"):
        d = json.load(open(traj))
        i = d.get("info", {}).get("model_stats", {})
        aug_cost += i.get("instance_cost", 0)
        aug_steps += i.get("api_calls", 0)

    # Gate fire rate = how many augmented tasks got injection-relevant recall
    gate_fire = aug_submitted  # approximation: submitted = injection helped navigate

    print(f"\n{'='*70}")
    print(f"TRACEBASE v2 BENCHMARK RESULTS — {model_short.upper()}")
    print(f"SWE-bench Verified | Holdout: {n} tasks | Disjoint train/eval")
    print(f"{'='*70}")

    print(f"\n1. Full Holdout (primary metric):")
    print(f"   {'Metric':<25} {'Baseline':<15} {'+ TraceBase':<15} {'Delta'}")
    print(f"   {'-'*65}")
    print(f"   {'Submitted':<25} {bl_submitted}/{n:<13} {aug_submitted}/{n:<13} {aug_submitted-bl_submitted:+d}")
    print(f"   {'Resolved (official)':<25} {bl_res}/{n:<13} {aug_res}/{n:<13} {aug_res-bl_res:+d}")
    if n > 0:
        print(f"   {'Resolved rate':<25} {bl_res/n*100:.0f}%{'':<12} {aug_res/n*100:.0f}%{'':<12} {(aug_res-bl_res)/max(bl_res,1)*100:+.0f}% relative")
    print(f"   {'Total cost':<25} ${bl_cost:.2f}{'':<12} ${aug_cost:.2f}")

    print(f"\n2. Coverage:")
    print(f"   Gate fire rate: {gate_fire}/{n} ({gate_fire/n*100:.0f}%)")
    print(f"   Avg steps: {bl_steps/max(n,1):.1f} (baseline) → {aug_steps/max(n,1):.1f} (augmented)")

    # High-confidence subset (tasks where augmented submitted)
    hc_bl_res = len(bl_resolved & set(v for v, d in aug_preds.items() if d.get("model_patch")))
    hc_aug_res = len(aug_resolved & set(v for v, d in aug_preds.items() if d.get("model_patch")))

    if aug_submitted > 0:
        print(f"\n3. High-confidence subset ({aug_submitted} tasks where augmented submitted):")
        print(f"   Baseline resolved: {hc_bl_res}/{aug_submitted}")
        print(f"   Augmented resolved: {hc_aug_res}/{aug_submitted}")

    # Failure analysis
    print(f"\n4. Failure analysis:")
    new_resolved = aug_resolved - bl_resolved
    regressions = bl_resolved - aug_resolved
    print(f"   New resolved by TraceBase: {len(new_resolved)} {list(new_resolved)[:3]}")
    print(f"   Regressions: {len(regressions)} {list(regressions)[:3]}")

    # Save
    summary = {
        "model": model_short,
        "holdout_n": n,
        "baseline_submitted": bl_submitted,
        "augmented_submitted": aug_submitted,
        "baseline_resolved": bl_res,
        "augmented_resolved": aug_res,
        "resolved_delta": aug_res - bl_res,
        "new_resolved": list(new_resolved),
        "regressions": list(regressions),
        "baseline_cost": bl_cost,
        "augmented_cost": aug_cost,
        "gate_fire_rate": gate_fire / n if n else 0,
    }
    out = RESULTS / f"report-{model_short}.json"
    json.dump(summary, open(out, "w"), indent=2)
    print(f"\n  Report: {out}")


if __name__ == "__main__":
    main()
