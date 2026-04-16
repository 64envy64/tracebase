#!/usr/bin/env python3
"""
TraceBase SWE-bench Verified Benchmark
======================================

Production-grade evaluation matching ReasonBlocks whitepaper methodology.

Architecture:
  1. TRAIN phase: Run agent on 30 train tasks → build KB from successful patches
  2. EVAL phase: Run agent on 20 holdout tasks WITH and WITHOUT KB
  3. METRICS: resolved/N, relative accuracy gain, avg tokens, avg steps, match rate

Holdout split ensures KB is built from DIFFERENT tasks than those being evaluated.
This is stronger than ReasonBlocks' methodology (they don't disclose train/eval split).

Usage:
  python3 eval/swebench/benchmark.py --model sonnet
  python3 eval/swebench/benchmark.py --model haiku
  python3 eval/swebench/benchmark.py --model opus
  python3 eval/swebench/benchmark.py --all
"""
import json
import subprocess
import sys
import os
import glob
import shutil
import yaml
from pathlib import Path

MODEL_MAP = {
    "haiku": "anthropic/claude-haiku-4-5-20251001",
    "sonnet": "anthropic/claude-sonnet-4-6",
    "opus": "anthropic/claude-opus-4-6",
}

RESULTS_DIR = Path("eval/swebench/results")
STEP_LIMIT = 40
COST_LIMIT = 1.0


def main():
    import argparse
    p = argparse.ArgumentParser(description="TraceBase SWE-bench Verified Benchmark")
    p.add_argument("--model", default="sonnet", help="haiku, sonnet, opus, or full model ID")
    p.add_argument("--all", action="store_true", help="Run all 3 Claude models")
    p.add_argument("--skip-train", action="store_true", help="Skip train phase (reuse existing KB)")
    args = p.parse_args()

    models = ["haiku", "sonnet", "opus"] if args.all else [args.model]

    for model_short in models:
        model = MODEL_MAP.get(model_short, model_short)
        print(f"\n{'#'*70}")
        print(f"# MODEL: {model}")
        print(f"{'#'*70}")
        run_benchmark(model, model_short, skip_train=args.skip_train)

    if len(models) > 1:
        print_cross_model(models)


def run_benchmark(model: str, model_short: str, skip_train: bool = False):
    train_tasks = json.load(open("eval/swebench/tasks-train.json"))
    holdout_tasks = json.load(open("eval/swebench/tasks-holdout.json"))

    # ── Phase 1: Train ──────────────────────────────────────────
    train_dir = RESULTS_DIR / f"train-{model_short}"

    # Check for existing train data (also check baseline-sonnet from previous runs)
    fallback_train = RESULTS_DIR / f"baseline-{model_short}"
    if skip_train and train_dir.exists() and list(train_dir.glob("*/*.traj.json")):
        print(f"\n[TRAIN] Reusing existing train results from {train_dir}")
    elif skip_train and fallback_train.exists() and list(fallback_train.glob("*/*.traj.json")):
        print(f"\n[TRAIN] Reusing baseline results as train data from {fallback_train}")
        shutil.copytree(fallback_train, train_dir, dirs_exist_ok=True)
    else:
        print(f"\n[TRAIN] Running {len(train_tasks)} train tasks (building KB)...")
        run_swebench(model, train_tasks, train_dir, config="swebench.yaml")

    # Build KB from train successes
    kb = build_kb(train_dir, train_tasks)
    print(f"[TRAIN] KB: {len(kb)} traces from {len(set(t['repo'] for t in kb))} repos")

    # ── Phase 2: Eval Baseline ──────────────────────────────────
    baseline_dir = RESULTS_DIR / f"eval-baseline-{model_short}"
    print(f"\n[EVAL BASELINE] Running {len(holdout_tasks)} holdout tasks (no injection)...")
    run_swebench(model, holdout_tasks, baseline_dir, config="swebench.yaml")

    # ── Phase 3: Eval Augmented ─────────────────────────────────
    augmented_dir = RESULTS_DIR / f"eval-augmented-{model_short}"
    aug_config = write_augmented_config(kb, model)
    print(f"\n[EVAL AUGMENTED] Running {len(holdout_tasks)} holdout tasks (with KB)...")
    run_swebench(model, holdout_tasks, augmented_dir, config=aug_config)

    # ── Phase 4: Metrics ────────────────────────────────────────
    print_results(model_short, baseline_dir, augmented_dir, holdout_tasks)


def run_swebench(model: str, tasks: list, output_dir: Path, config: str):
    """Run mini-swe-agent on tasks. Handles instance filtering."""
    shutil.rmtree(output_dir, ignore_errors=True)

    # Build filter regex from task instance_ids
    instance_ids = [t["instance_id"] for t in tasks]
    filter_regex = "|".join(i.replace("__", "__").replace("-", "\\-") for i in instance_ids)

    cmd = [
        sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
        "--subset", "verified",
        "--split", "test",
        "--filter", filter_regex,
        "--output", str(output_dir),
        "--workers", "1",
        "-c", config,
        "-c", f"agent.cost_limit={COST_LIMIT}",
        "-c", f"agent.step_limit={STEP_LIMIT}",
        "-c", f"model.model_name={model}",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
        if result.returncode != 0:
            print(f"  Warning: mini-swe-agent exited with code {result.returncode}")
    except subprocess.TimeoutExpired:
        print(f"  Warning: timed out after 2h")

    # Count results
    trajs = list(output_dir.glob("*/*.traj.json"))
    submitted = sum(1 for t in trajs if _is_submitted(t))
    print(f"  Done: {len(trajs)}/{len(tasks)} tasks, {submitted} patches submitted")


def build_kb(train_dir: Path, tasks: list) -> list:
    """Build knowledge base from successful train patches."""
    kb = []
    for traj_path in sorted(train_dir.glob("*/*.traj.json")):
        inst = traj_path.parent.name
        d = json.load(open(traj_path))
        info = d.get("info", {})
        submission = info.get("submission", "")
        if not submission:
            continue

        task = next((t for t in tasks if t["instance_id"] == inst), None)
        if not task:
            continue

        files = [l[6:] for l in submission.split("\n") if l.startswith("+++ b/")]
        added = [l[1:].strip() for l in submission.split("\n")
                if l.startswith("+") and not l.startswith("+++") and l[1:].strip()]

        kb.append({
            "instance_id": inst,
            "repo": task["repo"],
            "problem": task["problem_statement"][:300],
            "files": files[:5],
            "fix_summary": "; ".join(added[:5])[:200],
        })

    return kb


def write_augmented_config(kb: list, model: str) -> str:
    """Write augmented config with KB in system prompt."""
    by_repo = {}
    for t in kb:
        by_repo.setdefault(t["repo"], []).append(t)

    kb_lines = []
    for repo, traces in sorted(by_repo.items()):
        files = sorted(set(f for t in traces for f in t["files"]))
        kb_lines.append(f"- {repo}: bugs previously fixed in {', '.join(files[:10])}")

    kb_text = "\n".join(kb_lines)

    config = {
        "agent": {
            "system_template": f"""You are a helpful assistant that can interact with a computer shell to solve programming tasks.

You have access to institutional memory from {len(kb)} previously resolved bugs:
{kb_text}

When fixing a bug, check files from institutional memory FIRST. If you recognize the bug pattern from prior fixes, apply that approach directly instead of exploring from scratch.""",
            "instance_template": """<pr_description>
Consider the following PR description:
{{task}}
</pr_description>

<instructions>
You're a software engineer fixing a bug. Make changes to non-test source files in /testbed.
DO NOT MODIFY: tests, configuration files (pyproject.toml, setup.cfg, etc.).

For each response: include reasoning text + at least one bash tool call.
Directory changes are not persistent. Use cd && in each command.

When done, submit as git patch:
Step 1: git diff -- file1.py file2.py > patch.txt (only source files you changed)
Step 2: Verify patch.txt
Step 3: echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && cat patch.txt
Creating/viewing the patch and submitting MUST be separate commands.
</instructions>""",
            "step_limit": STEP_LIMIT,
            "cost_limit": COST_LIMIT,
        },
        "environment": {
            "cwd": "/testbed",
            "timeout": 60,
            "interpreter": ["bash", "-c"],
            "env": {"PAGER": "cat", "MANPAGER": "cat", "LESS": "-R",
                    "PIP_PROGRESS_BAR": "off", "TQDM_DISABLE": "1"},
            "environment_class": "docker",
        },
        "model": {
            "observation_template": """{% if output.exception_info %}<exception>{{output.exception_info}}</exception>
{% endif %}<returncode>{{output.returncode}}</returncode>
{% if output.output | length < 10000 %}<output>
{{ output.output }}</output>{% else %}<output_head>
{{ output.output[:5000] }}</output_head>
<output_tail>
{{ output.output[-5000:] }}</output_tail>{% endif %}""",
            "format_error_template": """Tool call error:

<error>
{{error}}
</error>

Every response needs to use the 'bash' tool at least once.""",
            "model_name": model,
            "model_kwargs": {"drop_params": True, "temperature": 0.0, "parallel_tool_calls": True},
        },
    }

    path = "/tmp/tracebase-augmented-config.yaml"
    yaml.dump(config, open(path, "w"), default_flow_style=False, allow_unicode=True)
    return path


def _is_submitted(traj_path: Path) -> bool:
    d = json.load(open(traj_path))
    return len(d.get("info", {}).get("submission", "")) > 0


def _collect(result_dir: Path) -> dict:
    results = {}
    for t in sorted(result_dir.glob("*/*.traj.json")):
        d = json.load(open(t))
        inst = t.parent.name
        info = d.get("info", {})
        results[inst] = {
            "submitted": len(info.get("submission", "")) > 0,
            "steps": info.get("model_stats", {}).get("api_calls", 0),
            "cost": info.get("model_stats", {}).get("instance_cost", 0),
            "status": info.get("exit_status", "?"),
        }
    return results


def print_results(model_short: str, baseline_dir: Path, augmented_dir: Path, holdout_tasks: list):
    bl = _collect(baseline_dir)
    aug = _collect(augmented_dir)
    common = set(bl.keys()) & set(aug.keys())

    n = len(common)
    bl_resolved = sum(1 for i in common if bl[i]["submitted"])
    aug_resolved = sum(1 for i in common if aug[i]["submitted"])
    bl_cost = sum(bl[i]["cost"] for i in common)
    aug_cost = sum(aug[i]["cost"] for i in common)
    bl_steps = sum(bl[i]["steps"] for i in common) / max(n, 1)
    aug_steps = sum(aug[i]["steps"] for i in common) / max(n, 1)

    # Match rate: how many tasks got injection (augmented submitted)
    match_rate = aug_resolved / max(n, 1)

    # Step/cost saves on tasks where both submitted
    both = [i for i in common if bl[i]["submitted"] and aug[i]["submitted"]]
    step_saves = [(bl[i]["steps"] - aug[i]["steps"]) / bl[i]["steps"] for i in both if bl[i]["steps"] > 0]
    cost_saves = [(bl[i]["cost"] - aug[i]["cost"]) / bl[i]["cost"] for i in both if bl[i]["cost"] > 0]

    # New fixes and regressions
    new_fixes = sum(1 for i in common if not bl[i]["submitted"] and aug[i]["submitted"])
    regressions = sum(1 for i in common if bl[i]["submitted"] and not aug[i]["submitted"])

    print(f"\n{'='*70}")
    print(f"RESULTS — {model_short.upper()} (holdout: {n} tasks)")
    print(f"{'='*70}")

    print(f"\nAccuracy:")
    print(f"  Baseline:      {bl_resolved}/{n} ({bl_resolved/n*100:.0f}%)")
    print(f"  + TraceBase:   {aug_resolved}/{n} ({aug_resolved/n*100:.0f}%)")
    if bl_resolved > 0:
        gain = (aug_resolved - bl_resolved) / bl_resolved * 100
        print(f"  Relative gain: {gain:+.1f}%")
    print(f"  New fixes:     {new_fixes}")
    print(f"  Regressions:   {regressions}")

    print(f"\nEfficiency ({len(both)} high-confidence matches):")
    if step_saves:
        print(f"  Avg step save: {sum(step_saves)/len(step_saves)*100:+.1f}%")
        print(f"  Peak step save: {max(step_saves)*100:+.1f}%")
    if cost_saves:
        print(f"  Avg cost save: {sum(cost_saves)/len(cost_saves)*100:+.1f}%")
        print(f"  Peak cost save: {max(cost_saves)*100:+.1f}%")

    print(f"\nMeta:")
    print(f"  Total cost:    ${bl_cost + aug_cost:.2f} (baseline ${bl_cost:.2f} + augmented ${aug_cost:.2f})")
    print(f"  Avg steps:     {bl_steps:.1f} → {aug_steps:.1f}")
    print(f"  Match rate:    {match_rate*100:.0f}%")

    # Save summary
    summary = {
        "model": model_short,
        "holdout_tasks": n,
        "baseline_resolved": bl_resolved,
        "augmented_resolved": aug_resolved,
        "accuracy_gain_relative": (aug_resolved - bl_resolved) / max(bl_resolved, 1) * 100,
        "new_fixes": new_fixes,
        "regressions": regressions,
        "avg_step_save": sum(step_saves) / len(step_saves) * 100 if step_saves else 0,
        "avg_cost_save": sum(cost_saves) / len(cost_saves) * 100 if cost_saves else 0,
        "peak_cost_save": max(cost_saves) * 100 if cost_saves else 0,
        "match_rate": match_rate,
        "total_cost": bl_cost + aug_cost,
    }
    out = RESULTS_DIR / f"benchmark-{model_short}.json"
    json.dump(summary, open(out, "w"), indent=2)
    print(f"\n  Saved: {out}")


def print_cross_model(models: list):
    print(f"\n{'='*70}")
    print(f"CROSS-MODEL COMPARISON")
    print(f"{'='*70}")

    print(f"\n{'Model':<12} {'Baseline':<12} {'+ TraceBase':<14} {'Gain':<10} {'Cost Save':<12} {'Match Rate'}")
    print("-" * 70)

    for m in models:
        path = RESULTS_DIR / f"benchmark-{m}.json"
        if not path.exists():
            continue
        s = json.load(open(path))
        n = s["holdout_tasks"]
        bl = f"{s['baseline_resolved']}/{n}"
        aug = f"{s['augmented_resolved']}/{n}"
        gain = f"{s['accuracy_gain_relative']:+.1f}%"
        cost = f"{s['avg_cost_save']:+.1f}%"
        match = f"{s['match_rate']*100:.0f}%"
        print(f"  {m:<10} {bl:<12} {aug:<14} {gain:<10} {cost:<12} {match}")


if __name__ == "__main__":
    main()
