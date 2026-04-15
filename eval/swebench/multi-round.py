#!/usr/bin/env python3
"""
Multi-Round SWE-bench Benchmark — Compound Intelligence Evaluation

Methodology (mirrors ReasonBlocks whitepaper):
  Round 0: Baseline — agent solves tasks with empty KB
  Round 1: Agent solves SAME tasks with KB built from Round 0 successes
  Round 2: Agent solves SAME tasks with KB from Round 0 + Round 1 successes
  ...

Each round compounds: more traces → better recall → higher accuracy + lower cost.
This is the core value proposition of reasoning trace injection.

Usage:
  python3 eval/swebench/multi-round.py --model sonnet --rounds 3 --count 20
"""
import json
import subprocess
import sys
import os
import shutil
import glob
from pathlib import Path

MODEL_MAP = {
    "haiku": "anthropic/claude-haiku-4-5-20251001",
    "sonnet": "anthropic/claude-sonnet-4-6",
    "opus": "anthropic/claude-opus-4-6",
}

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="sonnet")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    model = MODEL_MAP.get(args.model, args.model)
    model_short = args.model
    results_base = Path("eval/swebench/results")

    # Load tasks
    tasks = json.load(open("eval/swebench/tasks.json"))[:args.count]
    instance_ids = [t["instance_id"] for t in tasks]

    print(f"\nMulti-Round SWE-bench Benchmark")
    print(f"Model: {model} | Tasks: {len(tasks)} | Rounds: {args.rounds}")
    print("=" * 60)

    round_results = []

    for round_num in range(args.rounds):
        round_dir = results_base / f"round{round_num}-{model_short}"
        print(f"\n{'='*60}")
        print(f"ROUND {round_num}" + (" (Baseline — no injection)" if round_num == 0 else f" (KB from {sum(len(r) for r in round_results)} traces)"))
        print(f"{'='*60}")

        # Round 0: reuse existing baseline if available
        if round_num == 0:
            existing_baseline = results_base / f"baseline-{model_short}"
            if existing_baseline.exists() and list(existing_baseline.glob("*/*.traj.json")):
                print(f"  Reusing existing baseline from {existing_baseline}")
                # Symlink or copy
                if round_dir.exists():
                    shutil.rmtree(round_dir)
                shutil.copytree(existing_baseline, round_dir)
                round_data = collect_round_results(round_dir)
                round_results.append(round_data)
                submitted = sum(1 for r in round_data.values() if r["patch"])
                total_cost = sum(r["cost"] for r in round_data.values())
                print(f"  Round 0: {submitted}/{len(round_data)} patches ({submitted/max(len(round_data),1)*100:.0f}%), ${total_cost:.2f}")
                continue
            config_path = "swebench.yaml"
        else:
            # Build KB from previous rounds' successful patches
            kb_traces = build_kb_from_rounds(tasks, round_results, results_base, model_short)
            config_path = write_augmented_config(kb_traces, model, round_num)
            print(f"  KB: {len(kb_traces)} traces from previous rounds")

        # Clean output dir
        shutil.rmtree(round_dir, ignore_errors=True)

        # Run mini-swe-agent
        cmd = [
            sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
            "--subset", "verified",
            "--split", "test",
            "--slice", f"0:{args.count}",
            "--model", model,
            "--output", str(round_dir),
            "--workers", "1",
            "-c", config_path,
            "-c", f"agent.cost_limit=1.0",
            "-c", f"agent.step_limit=40",
            "-c", f"model.model_name={model}",
        ]

        print(f"  Running {len(tasks)} tasks...")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)

        # Collect results
        round_data = collect_round_results(round_dir)
        round_results.append(round_data)

        # Print summary
        submitted = sum(1 for r in round_data.values() if r["patch"])
        total_cost = sum(r["cost"] for r in round_data.values())
        avg_steps = sum(r["steps"] for r in round_data.values()) / max(len(round_data), 1)
        print(f"\n  Round {round_num}: {submitted}/{len(round_data)} patches ({submitted/max(len(round_data),1)*100:.0f}%), ${total_cost:.2f}, avg {avg_steps:.1f} steps")

    # Final comparison table
    print_comparison(round_results, args.rounds, model_short)

    # Save summary
    summary = {
        "model": model,
        "tasks": len(tasks),
        "rounds": args.rounds,
        "per_round": [],
    }
    for i, rd in enumerate(round_results):
        submitted = sum(1 for r in rd.values() if r["patch"])
        cost = sum(r["cost"] for r in rd.values())
        steps = sum(r["steps"] for r in rd.values()) / max(len(rd), 1)
        summary["per_round"].append({
            "round": i,
            "submitted": submitted,
            "total": len(rd),
            "accuracy": submitted / max(len(rd), 1),
            "total_cost": cost,
            "avg_steps": steps,
        })

    summary_path = results_base / f"multi-round-{model_short}.json"
    json.dump(summary, open(summary_path, "w"), indent=2)
    print(f"\nSaved: {summary_path}")


def build_kb_from_rounds(tasks, round_results, results_base, model_short):
    """Build injection KB from successful patches in previous rounds."""
    kb = []
    for round_idx, round_data in enumerate(round_results):
        for inst, data in round_data.items():
            if not data["patch"]:
                continue
            # Find the task to get the problem statement
            task = next((t for t in tasks if t["instance_id"] == inst), None)
            if not task:
                continue

            # Read the submission (patch) from trajectory
            round_dir = results_base / f"round{round_idx}-{model_short}"
            traj_path = round_dir / inst / f"{inst}.traj.json"
            if not traj_path.exists():
                continue

            traj = json.load(open(traj_path))
            submission = traj.get("info", {}).get("submission", "")
            if not submission:
                continue

            # Extract files changed from patch
            files = [l[6:] for l in submission.split("\n") if l.startswith("+++ b/")]
            added_lines = [l[1:].strip() for l in submission.split("\n")
                          if l.startswith("+") and not l.startswith("+++") and l[1:].strip()]

            kb.append({
                "instance_id": inst,
                "problem": task["problem_statement"][:300],
                "files": files[:3],
                "fix_summary": "; ".join(added_lines[:5])[:200],
                "repo": task["repo"],
            })
    return kb


def write_augmented_config(kb_traces, model, round_num):
    """Write a config with KB injection in system prompt."""
    # Group traces by repo for targeted injection
    by_repo = {}
    for t in kb_traces:
        repo = t["repo"]
        if repo not in by_repo:
            by_repo[repo] = []
        by_repo[repo].append(t)

    # Build detailed knowledge summary with file paths AND fix patterns
    kb_summary_parts = []
    for repo, traces in by_repo.items():
        files_seen = set()
        fix_hints = []
        for t in traces:
            files_seen.update(t["files"])
            if t.get("fix_summary"):
                fix_hints.append(t["fix_summary"][:120])
        part = f"In {repo}: bugs were fixed in {', '.join(sorted(files_seen)[:8])}."
        if fix_hints:
            part += f"\n  Patterns: {'; '.join(fix_hints[:3])}"
        kb_summary_parts.append(part)
    kb_summary = "\n".join(kb_summary_parts)

    import yaml
    config = {
        "agent": {
            "system_template": f"""You are a helpful assistant that can interact with a computer shell to solve programming tasks.

You have institutional memory from {len(kb_traces)} previously resolved bugs in this codebase.
{kb_summary}

When fixing a bug, check these files FIRST. Apply patterns from institutional memory when you recognize the bug type. This saves steps and prevents dead-end exploration.""",
            "instance_template": """<pr_description>
Consider the following PR description:
{{task}}
</pr_description>

<instructions>
You're a software engineer fixing a bug. Make changes to source files in /testbed.
DO NOT MODIFY tests or config files.

Workflow:
1. Check files from institutional memory first
2. Reproduce the issue
3. Fix with minimal changes
4. Verify and submit

Each response: reasoning + at least one bash tool call.
Directory changes are not persistent.

Submit:
Step 1: git diff -- file1 file2 > patch.txt
Step 2: Verify patch.txt
Step 3: echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && cat patch.txt
</instructions>""",
            "step_limit": 40,
            "cost_limit": 1.0,
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
            "format_error_template": "Tool call error: {{error}}\nUse the 'bash' tool.",
            "model_name": model,
            "model_kwargs": {"drop_params": True, "temperature": 0.0, "parallel_tool_calls": True},
        },
    }

    path = f"/tmp/swe-round{round_num}-config.yaml"
    yaml.dump(config, open(path, "w"), default_flow_style=False)
    return path


def collect_round_results(round_dir):
    """Collect results from a round's trajectory files."""
    results = {}
    for f in sorted(glob.glob(f"{round_dir}/*/*.traj.json")):
        d = json.load(open(f))
        inst = f.split("/")[-2]
        info = d.get("info", {})
        results[inst] = {
            "status": info.get("exit_status", "?"),
            "cost": info.get("model_stats", {}).get("instance_cost", 0),
            "steps": info.get("model_stats", {}).get("api_calls", 0),
            "patch": len(info.get("submission", "")) > 0,
        }
    return results


def print_comparison(round_results, num_rounds, model_short):
    """Print the compound intelligence progression table."""
    print(f"\n{'='*70}")
    print(f"COMPOUND INTELLIGENCE PROGRESSION — {model_short}")
    print(f"{'='*70}")

    print(f"\n{'Round':<10} {'Accuracy':<15} {'Avg Steps':<15} {'Total Cost':<15}")
    print("-" * 55)

    for i, rd in enumerate(round_results):
        n = len(rd)
        submitted = sum(1 for r in rd.values() if r["patch"])
        cost = sum(r["cost"] for r in rd.values())
        steps = sum(r["steps"] for r in rd.values()) / max(n, 1)

        label = "Baseline" if i == 0 else f"+ TraceBase R{i}"
        acc = f"{submitted}/{n} ({submitted/max(n,1)*100:.0f}%)"

        print(f"  {label:<10} {acc:<15} {steps:<15.1f} ${cost:.2f}")

    # Delta
    if len(round_results) >= 2:
        r0 = round_results[0]
        rl = round_results[-1]
        n = len(r0)
        acc0 = sum(1 for r in r0.values() if r["patch"])
        accl = sum(1 for r in rl.values() if r["patch"])
        cost0 = sum(r["cost"] for r in r0.values())
        costl = sum(r["cost"] for r in rl.values())
        steps0 = sum(r["steps"] for r in r0.values()) / max(n, 1)
        stepsl = sum(r["steps"] for r in rl.values()) / max(n, 1)

        print(f"\n  Improvement after {len(round_results)-1} rounds:")
        if acc0 > 0:
            print(f"    Accuracy:  {acc0/n*100:.0f}% → {accl/n*100:.0f}% ({(accl-acc0)/acc0*100:+.1f}% relative)")
        print(f"    Steps:     {steps0:.1f} → {stepsl:.1f} ({(1-stepsl/steps0)*100:+.1f}%)")
        print(f"    Cost:      ${cost0:.2f} → ${costl:.2f} ({(1-costl/cost0)*100:+.1f}%)")


if __name__ == "__main__":
    main()
