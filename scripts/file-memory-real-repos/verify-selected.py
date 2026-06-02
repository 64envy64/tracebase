#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
P = ROOT / "bench-runs/file-memory-real-repos/selected-tasks.json"

raw = P.read_bytes()
# json.loads raises on ANY malformed JSON: trailing commas, dup keys via
# object_pairs_hook, [...] literals, etc.
seen_keys = []
def no_dups(pairs):
    keys = [k for k, _ in pairs]
    for k in keys:
        if keys.count(k) > 1:
            raise ValueError(f"DUPLICATE KEY DETECTED: {k}")
    return dict(pairs)

d = json.loads(raw, object_pairs_hook=no_dups)

tasks = d["tasks"]
from collections import Counter
c = Counter(t["repo"] for t in tasks)

print("INTEGRITY_OK json.loads succeeded, no duplicate keys")
print(f"sha256={hashlib.sha256(raw).hexdigest()[:16]}")
print(f"byte_len={len(raw)}")
print(f"total_tasks={len(tasks)}")
for repo in ["josdejong/mathjs", "Textualize/rich", "colinhacks/zod", "psf/black"]:
    log = d["selection_log"][repo]
    n_log = len(log["selected_oldest_first"])
    print(f"{repo}: tasks={c[repo]} log_list_len={n_log} target={log['target']} shortfall={log['shortfall']}")

# Cross-check: number of task rows per repo equals selection_log selected count
ok = all(c[r] == d["selection_log"][r]["selected"] for r in c)
print(f"task_rows_match_log={ok}")
# Assert exact targets
assert len(tasks) == 25, f"expected 25, got {len(tasks)}"
assert c["josdejong/mathjs"] == 7
assert c["Textualize/rich"] == 6
assert c["colinhacks/zod"] == 9
assert c["psf/black"] == 3
print("ASSERTS_PASSED all per-repo counts exact, total=25")
