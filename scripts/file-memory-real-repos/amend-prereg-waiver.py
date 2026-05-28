#!/usr/bin/env python3
"""Append the black floor=3 waiver + box-4c outcomes as the next Amendment
section to PRE-REGISTRATION-REAL-REPOS.md. Operates on real on-disk bytes,
self-determines the amendment number, is idempotent (skips if the waiver
marker is already present), and prints unforgeable success tokens.
"""
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
P = ROOT / "bench-runs/file-memory/PRE-REGISTRATION-REAL-REPOS.md"

MARKER = "black floor=3 waiver"

text = P.read_text(encoding="utf-8")
old_sha = hashlib.sha256(text.encode()).hexdigest()[:16]

if MARKER in text:
    print("ALREADY_PRESENT marker found; no change")
    print(f"OLD_SHA={old_sha}")
    raise SystemExit(0)

existing = re.findall(r"^## Amendment (\d+)\b", text, re.M)
next_num = (max(int(n) for n in existing) + 1) if existing else 1

amendment = f"""

---

## Amendment {next_num} (2026-05-28) — black floor=3 waiver + box 4c outcomes

**Context.** Box 4c (per-PR reproducibility-only baseline) ran on the 66
candidates surviving the operator pre-exclusions. Per-repo reproducible
counts came back:

| Repo | reproducible | non_reproducible | infra_failed | timeout |
|---|---:|---:|---:|---:|
| josdejong/mathjs | 11 | 0 | 0 | 0 |
| Textualize/rich | 9 | 7 | 0 | 1 |
| psf/black | 3 | 10 | 0 | 0 |
| colinhacks/zod | 22 | 3 | 0 | 0 |
| **TOTAL** | **45** | **20** | **0** | **1** |

Source of truth: `bench-runs/file-memory-real-repos/results/box-4c-repro.json`.

**black floor=3 waiver (locked).**

- The original per-repo target was **>= 4 reproducible** candidates.
- **black produced only 3 reproducible.** Root cause: black's fixture-only
  candidates (`tests/data/cases/*.py`) are not autonomously reproducible
  under the locked harness — `tests/test_format.py` resolves its
  parametrize set at collection time, and a new case fixture needs helper
  changes that the `source_files_touched` filter does not capture, so the
  source-fix checkout alone does not flip the test from FAIL to PASS. The
  3 black candidates that DO reproduce all touch `tests/test_black.py`
  directly (ebe6018e CI hotfix, 9fd9ea2 blackd error, 650983f docstring
  tabs).
- **Decision:** black remains **INCLUDED** with a documented floor=3
  waiver. The repo-level setup is valid and the 3 reproducible tasks are
  legitimate bug-fix pairs. This keeps the language span at 3 (JS + TS +
  Py) and preserves a second Python repo's representation alongside rich.
- **No extra black candidate mining.** We do NOT widen the discovery
  window or relax the fix/bug-shape filter to manufacture more black
  candidates — that would be a post-hoc selection move.
- **No relaxing reproducibility semantics.** The FAIL-then-PASS protocol
  is unchanged; black's non-reproducible candidates stay excluded.

**Box 5 selection (N=25).** Locked selection rule, deterministic and
recorded in `bench-runs/file-memory-real-repos/selected-tasks.json`:

- Target N = 25.
- Include all 3 reproducible black tasks.
- From mathjs / rich / zod, select **oldest-first by commit author date**
  (ascending; ties broken by pr_commit SHA ascending).
- Per-repo counts: mathjs 7, rich 6, zod 9, black 3 = 25.
- Resulting language distribution: JavaScript 7, TypeScript 9, Python 9
  (rich 6 + black 3).

This amendment changes no thresholds other than granting the explicit,
scoped black floor=3 waiver above; all other pre-registered criteria
remain as locked.
"""

new_text = text.rstrip() + "\n" + amendment
P.write_text(new_text, encoding="utf-8")
new_sha = hashlib.sha256(new_text.encode()).hexdigest()[:16]

print("APPENDED_OK")
print(f"AMENDMENT_NUMBER={next_num}")
print(f"OLD_SHA={old_sha}")
print(f"NEW_SHA={new_sha}")
print(f"OLD_BYTES={len(text.encode())}")
print(f"NEW_BYTES={len(new_text.encode())}")
print(f"MARKER_NOW_PRESENT={MARKER in new_text}")
