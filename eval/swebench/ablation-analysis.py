#!/usr/bin/env python3
"""
Ablation result analyzer.

Loads grader reports for all 5 conditions (A, A', B, C, D) and produces
the comparison table that answers the core question:
"Where is the bottleneck: retrieval, injection format, or verify?"
"""
import json
import glob
from pathlib import Path

# Map (label, description, pred_dir, grader_run_id_prefix)
CONDITIONS = [
    ("A",  "no inject, no verify",           "eval/swebench/results-ablation/A-no-inject-no-verify", "ablation-A"),
    ("A'", "no inject, verify",              "eval/swebench/results-v2/baseline-sonnet",              "v2-baseline-sonnet"),
    ("B",  "oracle inject, no verify",       "eval/swebench/results-ablation/B-oracle-no-verify",     "ablation-B"),
    ("C",  "oracle inject, verify",          "eval/swebench/results-ablation/C-oracle-verify",        "ablation-C"),
    ("D",  "bad-retrieval inject, verify",   "eval/swebench/results-v2/augmented-sonnet",             "v2-augmented-sonnet"),
]


def load_condition(label, desc, pred_dir, run_id_prefix):
    d = Path(pred_dir)
    if not d.exists():
        return None

    # Load per-task trajectories
    trajs = list(d.glob("*/*.traj.json"))
    by_inst = {}
    cost = 0
    steps = 0
    for t in trajs:
        inst = t.parent.name
        info = json.load(open(t)).get("info", {})
        submission = info.get("submission", "").strip()
        by_inst[inst] = {
            "submitted": bool(submission),
            "status": info.get("exit_status", "?"),
        }
        cost += info.get("model_stats", {}).get("instance_cost", 0)
        steps += info.get("model_stats", {}).get("api_calls", 0)

    # Load grader report (if present)
    resolved_ids = set()
    report_found = False
    for candidate in [
        *glob.glob(f"{pred_dir}/*{run_id_prefix}*.json"),
        *glob.glob(f"*.{run_id_prefix}*.json"),
    ]:
        try:
            rpt = json.load(open(candidate))
            if "resolved_ids" in rpt:
                resolved_ids = set(rpt["resolved_ids"])
                report_found = True
                break
        except Exception:
            pass

    n = len(by_inst)
    return {
        "label": label,
        "desc": desc,
        "n": n,
        "submitted": sum(1 for v in by_inst.values() if v["submitted"]),
        "resolved": len(resolved_ids),
        "resolved_ids": resolved_ids,
        "submitted_ids": {k for k, v in by_inst.items() if v["submitted"]},
        "cost": cost,
        "avg_steps": steps / n if n else 0,
        "report_found": report_found,
    }


def main():
    results = [load_condition(*c) for c in CONDITIONS]
    results = [r for r in results if r]

    n = max((r["n"] for r in results), default=0)

    print()
    print("=" * 82)
    print("ABLATION RESULTS — SWE-bench Verified, Sonnet 4.6")
    print(f"Holdout: {n} tasks (disjoint from train)")
    print(f"Primary metric: official grader resolved rate")
    print("=" * 82)
    print()
    print(f"  {'Cond':<4} {'Description':<34} {'Submitted':<11} {'Resolved':<11} {'Cost':<8} {'Steps'}")
    print("  " + "-" * 78)
    for r in results:
        resolved_str = f"{r['resolved']}/{r['n']}" if r["report_found"] else f"?/{r['n']}"
        sub_str = f"{r['submitted']}/{r['n']}"
        print(f"  {r['label']:<4} {r['desc']:<34} {sub_str:<11} {resolved_str:<11} ${r['cost']:<6.2f} {r['avg_steps']:.1f}")
    print()

    # Pairwise comparisons
    by_label = {r["label"]: r for r in results}
    def delta(a, b, metric):
        if a not in by_label or b not in by_label:
            return "n/a"
        ra, rb = by_label[a], by_label[b]
        if not (ra["report_found"] and rb["report_found"]) and metric == "resolved":
            return "n/a (no grade)"
        va = ra[metric] if isinstance(ra[metric], int) else ra[metric]
        vb = rb[metric] if isinstance(rb[metric], int) else rb[metric]
        return f"{va} → {vb} (Δ {vb - va:+d})"

    print("  Pairwise comparisons (resolved):")
    A_prime = "A'"
    print("    A   vs A'  (verify alone):        " + delta('A', A_prime, 'resolved'))
    print("    A   vs B   (oracle alone):        " + delta('A', 'B', 'resolved'))
    print("    B   vs C   (verify + oracle):     " + delta('B', 'C', 'resolved'))
    print("    D   vs C   (retrieval quality):   " + delta('D', 'C', 'resolved'))
    print()

    # Per-task matrix
    print("  Per-task resolved matrix:")
    all_insts = set()
    for r in results:
        all_insts |= r["submitted_ids"] | r["resolved_ids"]
    for inst in sorted(all_insts):
        cells = []
        for r in results:
            if inst in r["resolved_ids"]:
                cells.append("✓")
            elif inst in r["submitted_ids"]:
                cells.append("·")  # submitted but not resolved
            else:
                cells.append(" ")
        header = "".join(f"{r['label']:>3}" for r in results)
        line = "".join(f"{c:>3}" for c in cells)
        print(f"    {inst:<32} {line}")
    print(f"    {'':32} {header}   ✓=resolved  ·=submitted  (blank)=no patch")
    print()

    # Interpretation
    print("  Interpretation:")
    by_label = {r["label"]: r for r in results if r["report_found"]}
    if "A" in by_label and "A'" in by_label:
        d_verify = by_label["A'"]["resolved"] - by_label["A"]["resolved"]
        print(f"    - Verify alone (A → A'):   {d_verify:+d} resolved")
    if "A" in by_label and "B" in by_label:
        d_oracle = by_label["B"]["resolved"] - by_label["A"]["resolved"]
        print(f"    - Oracle alone (A → B):    {d_oracle:+d} resolved")
    if "C" in by_label and "D" in by_label:
        d_retrieval = by_label["C"]["resolved"] - by_label["D"]["resolved"]
        print(f"    - Retrieval gain (D → C):  {d_retrieval:+d} resolved (bad → good retrieval, both verify)")
    if "C" in by_label and "A'" in by_label:
        d_combined = by_label["C"]["resolved"] - by_label["A'"]["resolved"]
        print(f"    - Oracle over baseline (A' → C): {d_combined:+d} resolved (both verify)")
    print()


if __name__ == "__main__":
    main()
