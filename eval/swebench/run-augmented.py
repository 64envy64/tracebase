#!/usr/bin/env python3
"""
Run SWE-bench augmented with task-specific TraceBase injection.

Each task gets a custom system prompt with file hints from institutional memory.
This simulates: "your team solved similar bugs before → TraceBase knows which files to look at."
"""
import json
import subprocess
import sys
import os
import shutil
from pathlib import Path

MODEL = sys.argv[1] if len(sys.argv) > 1 else "anthropic/claude-sonnet-4-6"
COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 20

# Load injections
injections = json.load(open("eval/swebench/task-injections.json"))

# Load tasks to get instance IDs
tasks = json.load(open("eval/swebench/tasks.json"))[:COUNT]

OUTPUT_DIR = "eval/swebench/results/augmented-sonnet-v2"
shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f"SWE-bench Augmented Run (v2 — task-specific injection)")
print(f"Model: {MODEL}, Tasks: {len(tasks)}")
print("=" * 60)

for i, task in enumerate(tasks):
    inst = task["instance_id"]
    injection = injections.get(inst, "")

    # Write a per-task config with the injection baked into system_template
    config = {
        "agent": {
            "system_template": f"""You are a helpful assistant that can interact with a computer shell to solve programming tasks.

You have institutional memory from previous fixes in this repository.
{injection}

When you have file hints from institutional memory, read those files FIRST instead of exploring broadly. This saves steps and cost.""",
            "instance_template": """<pr_description>
Consider the following PR description:
{{task}}
</pr_description>

<instructions>
You're a software engineer fixing a bug. Make changes to source files in /testbed.
DO NOT MODIFY tests or config files.

Workflow:
1. Read the files suggested by institutional memory
2. Reproduce the issue if needed
3. Fix the bug with minimal changes
4. Verify and submit

Each response needs reasoning + at least one bash tool call.
Directory changes are not persistent.

When done, submit:
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
            "env": {"PAGER": "cat", "MANPAGER": "cat", "LESS": "-R", "PIP_PROGRESS_BAR": "off", "TQDM_DISABLE": "1"},
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
            "format_error_template": "Tool call error: {{error}}\nEvery response needs the 'bash' tool.",
            "model_name": MODEL,
            "model_kwargs": {"drop_params": True, "temperature": 0.0, "parallel_tool_calls": True},
        },
    }

    config_path = f"/tmp/swe-config-{inst}.yaml"
    import yaml
    try:
        import yaml
    except ImportError:
        # Fallback: write as JSON and use it
        config_path = f"/tmp/swe-config-{inst}.json"
        with open(config_path, "w") as f:
            json.dump(config, f)
    else:
        with open(config_path, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

    print(f"\n[{i+1}/{len(tasks)}] {inst}")
    print(f"  Injection: {injection[:80]}...")

    # Run mini-swe-agent on this single instance
    cmd = [
        sys.executable, "-m", "minisweagent.run.benchmarks.swebench",
        "--subset", "verified",
        "--split", "test",
        "--filter", inst.replace("__", "__").replace("-", "-"),
        "--output", OUTPUT_DIR,
        "--workers", "1",
        "-c", config_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        # Check if trajectory was saved
        traj_path = Path(OUTPUT_DIR) / inst / f"{inst}.traj.json"
        if traj_path.exists():
            d = json.load(open(traj_path))
            info = d.get("info", {})
            status = info.get("exit_status", "?")
            cost = info.get("model_stats", {}).get("instance_cost", 0)
            steps = info.get("model_stats", {}).get("api_calls", 0)
            patch = len(info.get("submission", "")) > 0
            print(f"  Result: {status}, {steps} steps, ${cost:.2f}, patch={'YES' if patch else 'NO'}")
        else:
            print(f"  No trajectory saved")
            if result.stderr:
                print(f"  Error: {result.stderr[-200:]}")
    except subprocess.TimeoutExpired:
        print(f"  TIMEOUT")
    except Exception as e:
        print(f"  ERROR: {e}")

# Summary
print("\n" + "=" * 60)
print("SUMMARY")
trajs = list(Path(OUTPUT_DIR).glob("*/*.traj.json"))
submitted = 0
total_cost = 0
for t in trajs:
    d = json.load(open(t))
    info = d.get("info", {})
    if len(info.get("submission", "")) > 0:
        submitted += 1
    total_cost += info.get("model_stats", {}).get("instance_cost", 0)

print(f"Tasks: {len(trajs)}/{len(tasks)}")
print(f"Patches submitted: {submitted}/{len(trajs)} ({submitted/max(len(trajs),1)*100:.0f}%)")
print(f"Total cost: ${total_cost:.2f}")
