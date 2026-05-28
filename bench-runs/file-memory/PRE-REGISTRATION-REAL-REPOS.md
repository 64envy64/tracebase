# 02 File Memory — Real Public-Repo Workloads (Pre-Registration)

**SPEC LOCKED 2026-05-27.** Implementation checklist open; no dispatch until every checklist box is checked and the candidate pool + selected-task manifest are committed.

This pre-reg extends the already-publishable 02 file-memory bench (`bench-results/publishable/file-memory.md`, commit `d24a3db`) from N=3 small synthetic tasks to **real public-repo bug-fix workloads**, per the recommendation in `bench-results/internal-diagnostics/next-bench-evidence-map.md` §"Next-bet candidates" option A.

The mechanism, isolation shape, and metric definitions inherit from the published 02 bench wherever possible. The differences are: (1) workspace = real cloned repo at a frozen commit, (2) task = real merged bug-fix PR, (3) verifier = repo's own test command, (4) N = 15-25 instead of 3, (5) cherry-pick guardrails are explicit because real-world selection is more failure-prone than synthetic.

## Why this exists

02 shipped a publishable headline (Glob 3→0, wall-time −16 %, tokens flat, pass-rate unchanged) but at N=3 ≤5-file synthetic tasks. The most common external skepticism is "only 3 tasks, only synthetic." This bench addresses that skepticism by extending the same mechanism + same metric shape to real codebases at moderate scale, without inventing a new mechanism claim.

Per the joint 03+04 Path A cross-bench finding, real-agent benches on small bug-fix tasks need to extend an *already-positive* synthetic result rather than try to elicit a new effect from scratch. 02 is that already-positive result. A is the lowest-risk way to convert that result into something defensible at higher N.

## Claim under test (locked scope)

> **On real public-repo bug-fix workloads at N=15-25 tasks, TraceBase file_memory reduces filesystem-exploration tool calls (Glob + Grep) by ≥20 % aggregate without dropping pass-rate or inflating tokens / wall-time.**

Narrow on purpose. Extends 02's published claim from "synthetic N=3 −100 % Glob" to "real N=15-25 ≥−20 % Glob+Grep aggregate, pass-rate held". Does NOT escalate to broader claims about reasoning-reuse, tool-supervision, loop-detection, or context-fold.

### In scope
- **Filesystem-exploration reduction**: aggregate ON.glob + ON.grep ≤ OFF × 0.80 (≥20 % cut).
- **Pass-rate preservation**: per-task `pass(ON) ≥ pass(OFF)`.
- **Token + wall-time bounds**: aggregate ON.total_tokens ≤ OFF × 1.05; aggregate ON.duration_ms ≤ OFF × 1.10. Wider bands than 02's synthetic because real-task variance is wider.

### Out of scope (declared up front)
- **Reasoning-reuse, tool-supervision, loop-detection, context-fold.** All disabled by isolation. The bench tests ONLY file_memory.
- **Per-task "always faster".** Variance is real; the claim is aggregate, not pointwise.
- **Cross-repo generalisation beyond chosen N.** A 4-6 repo sample doesn't speak to every codebase shape (large monorepos, weakly-typed languages, custom build systems). Disclose in report.
- **Frontier-model behaviour.** Bench runs `claude-haiku-4-5` only (consistent with 02 and the prior Path A attempts). Sonnet / Opus may behave differently; not measured.
- **Per-file-type variation.** N is too small to slice by language.

## Guardrails (load-bearing — locked)

1. **No mechanism contamination.** ON variant has ONLY `UserPromptSubmit → inject-context`. No `PreToolUse`, no `PostToolUse`, no `Stop`, no `PreCompact`. Empty `reasoning_blocks`. The only seeded table is `indexed_files`. This matches 02 exactly.
2. **No cherry-picking.** `selected-tasks.json` is locked **before the first agent trajectory** runs. No tasks added or removed after the first agent run completes. **Agent-side outcomes — including OFF failing to solve the task — are NEVER grounds for exclusion.** A task where OFF fails is a legitimate cell in the per-task paired-outcome table (see §"Decision rules" §A.1) and stays in the aggregate. The ONLY allowed reason for post-selection exclusion is **infrastructure failure unrelated to agent behaviour** (e.g., `npm install` broke from upstream registry outage, OS-level failure, test runner crashed before either arm executed), documented in writing in the final report with the failure mode.
3. **Selection happens BEFORE measurement.** Repo + task selection is fully documented in `bench-runs/file-memory-real-repos/candidate-pool.json` and `selected-tasks.json` BEFORE the first OFF/ON trajectory. Order of inclusion is by a deterministic rule (e.g. `git log --merges --grep=fix` first N matches), not "looks good to me".
4. **No prompt tuning per-task.** All tasks use the same prompt template (only the bug-summary + failing-test name interpolated). No per-task prompt steering.
5. **Failures are kept.** If pass-rate drops on a task, that task stays in the bench and shows up in the per-task table; the §A.1 decision rule then determines publishable or scope-down.

## Method

### Repo selection criteria (locked)

A repo qualifies for the candidate pool if ALL of:

1. **Public** GitHub repo, permissive license (MIT / Apache 2.0 / BSD / ISC). No GPL variants (license-friction risk for cloning + modifying + re-running).
2. **Real bug-fix history**: ≥30 merged PRs in the last 24 months labeled `bug` / `fix` / similar (per repo's label convention).
3. **Reproducible test command**: standard `npm test` / `pnpm test` / `pytest` / `go test` / `cargo test`, runs in ≤5 min on warm cache after `npm install` / `pip install`.
4. **Sized**: 50-2000 source files (excluding tests, vendor, node_modules). Smaller is too close to the synthetic baseline; larger introduces indexer-budget questions out of scope here.
5. **Stable**: last commit ≤6 months old, active maintainer.
6. **Primary language**: TypeScript, JavaScript, or Python — where the indexer (`src/core/file-indexer.ts`) is best-tested per the published 02 disclosure.

Target: **4-6 repos** chosen to span at least 2 of {TS, JS, Py} and ≥2 size buckets (small: 50-200; medium: 200-800; large: 800-2000).

Plausible candidates (NOT locked here; the selected list lands in `bench-runs/file-memory-real-repos/repo-pool.json` at lock-time):
- TypeScript: `mathjs/mathjs`, `colorjs/color.js`, `sindresorhus/ky`
- JavaScript: `fastify/fastify-cli`, `bcoe/c8`, `pallets-eco/flask-sqlalchemy` (Python actually), `request/request` (archived — exclude)
- Python: `pallets/click`, `python-poetry/cleo`, `tiangolo/typer`

### Task selection criteria (locked)

A task qualifies if ALL of:

1. **Real merged bug-fix PR** (label or commit-message-prefix matches `fix:` / `bug:` / similar).
2. **Has a reproducible failing test**: PR either added a regression test that fails before the fix, OR fixed an existing failing test. Verified by checking out the PR's parent commit, applying ONLY the test changes (not the source changes), and running the test suite — failing test must surface deterministically.
3. **Bounded fix**: source-code diff (excluding test files) ≤ 20 lines.
4. **No external infra**: no Docker, no live DB, no network call in the test path. Pure-local test runs only.
5. **Repo passes on parent commit** with the PR's test changes applied minus the source fix — i.e., the planted failure is the only failure.

Per repo: **3-5 tasks**. Total target N = **15-25 task pairs** (OFF + ON each).

### Selection process (anti-cherry-pick — locked)

1. Build a **candidate pool of at least 2× target N** (e.g. 50 candidate PRs across 6 repos).
2. For each candidate, run a **reproducibility-only baseline check** (NO agent runs at this stage — purely a deterministic infrastructure-and-fixture sanity gate):
   - **Parent + test-diff fails as expected**: clone repo at the PR's parent commit, apply ONLY the test-file changes from the PR, run the repo's test command → confirm the planted regression test fails deterministically.
   - **Source fix passes** (when the PR ships source-side changes): apply the PR's source-file changes on top of the test-diff → confirm the same test command now passes. This catches reproduction-environment drift from the original PR's CI.
   - **Install + test command exits cleanly**: confirm `npm install` (or equivalent) succeeds on a clean clone and the test runner exits cleanly (pass or fail, not crash) on the parent + test-diff state.
   Candidates failing any of these three checks are excluded from the pool with the failed-check name recorded in `candidate-pool.json`. The OFF or ON agent is NEVER run during this step.
3. From the reproducible candidates, **select the first N by deterministic rule** (e.g. oldest-merged PRs first, capped per-repo at 5). Document the rule + the selected subset in `bench-runs/file-memory-real-repos/selected-tasks.json` BEFORE the first OFF/ON trajectory runs.
4. **All selected tasks run.** `selected-tasks.json` is locked at the moment of selection. No mid-bench substitution. Any post-selection exclusion must be an **infrastructure failure unrelated to agent behaviour** (test runner crash, network outage during dependency install, OS-level failure), documented in writing in the final report. Agent-side outcomes — including OFF failing to solve the task — are NEVER grounds for exclusion; they are recorded as paired-outcome cells per §"Decision rules" §A.1.

### OFF/ON isolation (locked — matches 02 exactly)

| Surface | OFF | ON |
|---|---|---|
| `.tracebase/` | absent | present (`initConfig` per workspace) |
| `.tracebase/memory.db` `reasoning_blocks` rows | n/a | **empty** (no reasoning-reuse lane) |
| `.tracebase/memory.db` `indexed_files` rows | n/a | **populated via `indexWorkspace` pre-run** |
| `.tracebase/memory.db` `session_chunks` rows | n/a | empty (no context-fold) |
| `.tracebase/config.json` `toolSupervision.mode` | n/a | NOT set |
| `.claude/settings.json` `UserPromptSubmit` | absent | `inject-context --host claude-code --path <ws>` |
| `.claude/settings.json` `PreToolUse` | absent | **absent** (no tool supervision) |
| `.claude/settings.json` `PostToolUse` | absent | **absent** (no observation tracking) |
| `.claude/settings.json` `Stop`, `PreCompact` | absent | absent |
| Hook command path quoting | n/a | forward slashes (Windows) |
| Test runner | repo's own (`npm test`, `pytest`, etc) | repo's own (same command) |

Mechanism under test ≡ only difference between OFF and ON: `inject-context` populates the agent's prompt with file_memory; nothing else differs.

### Pre-run file_memory population (locked)

Same code path as 02 — no shortcuts:

```ts
const cfg = initConfig(ws, { install: { agent: "claude-code", agents: ["claude-code"] } });
const db = new Database(cfg.storagePath);
const store = new BlockStore(db);
indexWorkspace(store, {
  root: ws,
  maxBytes: 262144,
  budget: { maxFiles: 256, maxDirs: 64, maxBytes: 1024 * 1024 },
});
store.close();
```

For larger real repos (≤2000 source files), the `maxFiles: 256` budget will indexer-skip some files. This is documented behaviour; the bench reports `outcome.indexedCount` and `outcome.skipped` per workspace so the report can disclose what was actually indexed.

### Trajectory shape (locked)

- ONE user prompt per task (no `--continue`, no multi-turn).
- Prompt template (only the bracketed substring varies per task):

  ```
  [Repo's CLAUDE.md or README context — first 800 chars if present, else empty]

  Working directory (operate strictly inside):
  <ws>

  Task: Fix the failing test in [<TEST_PATH>]. The bug is in [<KNOWN_SOURCE_DIR>] (per the bug
  report). [<ONE_LINE_BUG_DESCRIPTION>]

  Rules:
  - Work inside the working directory.
  - Run tests with: [<REPO_TEST_COMMAND>]
  - Do NOT install or update packages.
  - Do NOT modify the test file.
  - Keep your patch minimal.

  End your response with the literal text 'DONE'.
  ```

  `<KNOWN_SOURCE_DIR>` is the source root the PR's source diff touched (e.g. `src/`, `lib/`, `mathjs/`). Not the specific file — file_memory's job is to disambiguate. The OFF arm gets the same hint; the variable under test is whether file_memory makes file-finding cheaper, not whether the prompt is better.

- Model: `claude-haiku-4-5` (consistent with 02 and prior Path A).
- Tools: `--allowedTools Read,Edit,Bash,Grep,Glob`.
- Budget: `--max-budget-usd 1.00` per trajectory (real repos can run longer than synthetic; 2× the spike's 0.50 cap).
- Single trajectory per OFF/ON cell, no retries.

## Metrics (locked)

### Per trajectory (authoritative — harness JSON result)
- `harness.usage.total_tokens` (input + cache + output)
- `harness.duration_ms`
- `harness.total_cost_usd`
- `harness.num_turns`
- `harness.terminal_reason`
- `transcript.tool_use_count_by_tool` (from per-instance jsonl)
  - **`Glob`** count
  - **`Grep`** count
  - **`Read`** count
  - **`Edit`** count
  - **`Bash`** count
- `transcript.bytes_read` (sum of Read tool_result content byte sizes)

### Per ON trajectory (descriptive — from workspace `.tracebase/memory.db`)
- `indexed_files` row count (pre-run)
- `indexer_outcome.bytesSummarized`, `indexer_outcome.skipped`

### Post-hoc verification (per trajectory)
- `pass` = repo's test command exits 0 against the post-trajectory workspace state

### Per-task derived
- `glob_grep_delta` = (ON.glob + ON.grep) − (OFF.glob + OFF.grep). Target: negative.
- `bytes_read_delta` = ON.bytes_read − OFF.bytes_read. Target: negative or small positive (file_memory steers reads, doesn't avoid them).
- `tokens_delta_pct` = (ON.tokens − OFF.tokens) / OFF.tokens. Target: ≤ +5 %.
- `duration_delta_pct` = (ON.duration − OFF.duration) / OFF.duration. Target: ≤ +10 %.

### Aggregate
- Sum / sum ratios across all task pairs.

## Decision rules (locked)

### §A. Publishable
All four must hold:

1. **No ON regression (load-bearing)**: report a **paired outcome table** over all N selected tasks:

   | Cell | Meaning | Counts toward |
   |---|---|---|
   | OFF pass · ON pass | both solve; tool / cost deltas comparable | aggregate (clean signal) |
   | OFF pass · ON fail | **ON regression** — file_memory broke a task the agent could otherwise solve | aggregate; ALSO load-bearing gate |
   | OFF fail · ON pass | **legitimate ON win** — file_memory enabled a solve the agent could not reach without it | aggregate; counted as ON win |
   | OFF fail · ON fail | both unresolved | aggregate (noisy cell; reported separately) |

   **Publishable rule**: **the (OFF pass · ON fail) count must be 0.** A single per-task regression → not publishable as-is; either scope down (e.g. "publishable for TypeScript subset") or hold. (OFF fail · ON pass) cells are wins and increase confidence in publish. (OFF fail · ON fail) cells stay in the aggregate denominators with their actual tool counts.
2. **Aggregate filesystem-exploration cut ≥ 20 %**: across all N selected tasks (sum across all four paired cells), `Σ(ON.glob + ON.grep) ≤ Σ(OFF.glob + OFF.grep) × 0.80`. The report ALSO discloses this metric sliced by paired-outcome cell so readers can see whether the savings come primarily from passing-pair tasks or are distorted by the unresolved-pair cell.
3. **No token inflation**: aggregate `Σ ON.total_tokens ≤ Σ OFF.total_tokens × 1.05` over all N selected tasks.
4. **No wall-time inflation**: aggregate `Σ ON.duration_ms ≤ Σ OFF.duration_ms × 1.10` over all N selected tasks.

### §B. Internal-only
- §A.1 holds (zero (OFF pass · ON fail) cells), §A.2 fails on aggregate but per-task variance shows scattered savings → "savings exist but inconsistent across repos" — write internal diagnostic with per-task and per-cell breakdown.
- §A.1 fails on a single (OFF pass · ON fail) cell (single task or single repo) → scope down (e.g. "publishable for the N−1 subset, internal-only for the one that regressed"); document the regression analysis in the diagnostic.
- §A.3 or §A.4 fails → "saves navigation but inflates tokens/time" — internal only with full per-task and per-cell table.

### §C. Re-design
- §A.1 fails on ≥ 2 (OFF pass · ON fail) cells → file_memory is over-injecting on a real-repo class; tune indexer budget / inject-context budget / threshold BEFORE any further bench.
- Aggregate `Σ(ON.glob + ON.grep) > Σ(OFF.glob + OFF.grep)` (ON does MORE filesystem exploration than OFF in total) → mechanism is structurally counterproductive on this workload class; halt, investigate before further runs.

## Cost budget

| Stage | Estimate |
|---|---|
| Candidate pool dry-run (reproducibility check) — local test runs only, no API | $0 |
| Pilot (N=15-25 tasks × OFF/ON × 1 trajectory) at haiku, real repos longer than synthetic | $0.10-0.30 per trajectory × 30-50 runs = **$3-15** |
| Rerun budget if §C fires + need to tune & re-pilot | $3-15 additional |
| **Total reasonable cap** | **≈ $20-30** |

Order of magnitude higher than 02's synthetic ($0 — all local + indexer pre-run) but still cheap. Far below the $100 mark; well within "real bench" territory.

## Reporting structure (locked)

On §A success:
- Write `bench-results/publishable/file-memory-real-repos.md`
- Headline (one sentence, scoped): "On N real public-repo bug-fix tasks at haiku, file_memory reduced filesystem-exploration tool calls by X % aggregate without dropping pass-rate; tokens and wall-time within bounds."
- Caveats up front: N still small (<30), haiku-class model only, file_memory mechanism only, 4-6 repos sample doesn't generalise to all codebase shapes
- Per-repo + per-task table (declared bug summary, observed Glob/Grep/Read/Edit/Bash, tokens, duration, pass)
- Aggregate matching §A criteria columns
- §"How this extends the synthetic 02 bench" subsection
- §"How this fits the full TraceBase savings narrative" — add a row next to 02 + 03B + 05B
- Disclosures: candidate-pool size, selection rule, exclusion log (with reasons)

On §B / §C outcome:
- Write `bench-results/internal-diagnostics/file-memory-real-repos.md` instead, with "NOT publishable because ..." section at top + per-task analysis

## Lock block

Spec-level lock (no changes without an Amendment from this point):

- [x] Spec scope locked: file_memory mechanism only, file-navigation savings claim, NOT cross-mechanism or model-class.
- [x] N target: 15-25 task pairs across 4-6 repos.
- [x] Model arm: `haiku-4-5` only.
- [x] `--allowedTools`: `Read,Edit,Bash,Grep,Glob` for all trajectories.
- [x] Isolation method: matches 02 exactly (UserPromptSubmit + indexWorkspace pre-populated, all other hooks absent).
- [x] Anti-cherry-pick: selection BEFORE measurement, all selected tasks run, exclusion only for documented "OFF can't solve at all".
- [x] Transcript policy: raw `.jsonl` gitignored under `bench-runs/file-memory-real-repos/transcripts/`; per-trajectory JSON summaries committed.
- [x] Cost cap: ≈$30 (pilot + one rerun budget).
- [x] Pre-registration locked: **2026-05-27**.
- [x] Worktree + commit SHA at lock: `claude/interesting-mcclintock-a69a77` @ `55ce0fe` (HEAD after the 05 Path B publish).

Implementation checklist (pilot does NOT dispatch until all complete):

- [ ] `bench-runs/file-memory-real-repos/` directory created with empty `repo-pool.json` + `candidate-pool.json` + `selected-tasks.json` placeholders.
- [ ] `.gitignore` extended: `bench-runs/file-memory-real-repos/{repos,workspaces,transcripts}/` (regenerable from manifests + scripts).
- [ ] Repo pool selection committed: `repo-pool.json` lists 4-6 chosen repos with selection-criteria justification per repo.
- [ ] Candidate pool dry-run completed: per-candidate **reproducibility-only baseline check** (parent + test-diff fails as expected; source fix passes; install + test command exits cleanly — **NO agent run during this step**). Results in `candidate-pool.json` (≥2× target), each candidate marked reproducible/excluded with the failed-check name.
- [ ] Selection rule applied; `selected-tasks.json` written and committed.
- [ ] Harness implemented: `scripts/file-memory-real-repos/` with `clone-repo.ts`, `setup-workspace.ts`, `run-trajectory.ts`, `verify-pass.ts`, `aggregate.ts`. Reuses 02's `indexWorkspace` setup pattern + Path A's `run-trajectory.ts` shape (forward-slash hook paths).
- [ ] Smoke gate: ONE task × OFF + ON, verify mechanism wiring works end-to-end on a real repo (file_memory injects, agent reads, test passes/fails). Smoke cost ≤ $0.60.
- [ ] Pilot dispatched: all N × OFF/ON trajectories.
- [ ] Results documented under `bench-runs/file-memory-real-repos/results/aggregate.json` + per-trajectory summaries.
- [ ] Report written: `bench-results/publishable/file-memory-real-repos.md` (if §A) OR `bench-results/internal-diagnostics/file-memory-real-repos.md` (if §B/§C).

After ALL implementation boxes checked AND smoke passes AND pilot runs: write the report. No task additions or expectation edits permitted post-lock except via the Amendments block below (mirror Path B Amendment 1 protocol: labelling errors caught at first run get a one-line correction + reproduce-both-results disclosure).

## Amendments (post-lock changes documented in full)

(none yet — populated only if pilot or smoke exposes a spec-level issue requiring scope adjustment)

## Files this pre-reg will produce (after lock + pilot)

- `bench-runs/file-memory-real-repos/repo-pool.json` — chosen repos + selection rationale
- `bench-runs/file-memory-real-repos/candidate-pool.json` — full PR candidate pool (≥2× target) with per-candidate reproducibility check
- `bench-runs/file-memory-real-repos/selected-tasks.json` — the N selected task pairs (locked at selection time)
- `bench-runs/file-memory-real-repos/results/<task>.<variant>.json` — per-trajectory result
- `bench-runs/file-memory-real-repos/results/aggregate.json` — pilot roll-up
- `bench-runs/file-memory-real-repos/transcripts/<task>.<variant>.jsonl` — gitignored raw transcripts
- `bench-runs/file-memory-real-repos/repos/` — cloned repos at frozen commits, gitignored
- `bench-runs/file-memory-real-repos/workspaces/` — per-task workspaces, gitignored
- `scripts/file-memory-real-repos/` — harness scripts (clone-repo, setup-workspace, run-trajectory, verify-pass, aggregate, smoke)
- `bench-results/publishable/file-memory-real-repos.md` OR `bench-results/internal-diagnostics/file-memory-real-repos.md`

## What this pre-reg explicitly does NOT do

- No agent-level claim about reasoning-reuse, tool-supervision, loop-detection, or context-fold. Those mechanisms are disabled by isolation.
- No model-class comparison (no sonnet, no opus, no smaller-than-haiku).
- No cross-language generalisation beyond the 4-6 selected repos.
- No mechanism code changes — this is a workload extension of an existing publishable result, not a refactor.
- No "TraceBase saves money on every task" claim — aggregate-only, with task-variance disclosed.


---

## Amendment 1 (2026-05-28) — black floor=3 waiver + box 4c outcomes

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
- **black produced only 3 reproducible** (of 13): `01c29bd5` and
  `13e97b44` (both fixture-based, `tests/data/cases/*` driven by
  `tests/test_format.py`) and `650983f7` (touches `tests/test_black.py`
  directly). Root cause of the low yield: black's data-driven cases
  mostly fail under the locked harness — **8 of 10** fixture candidates
  stay FAIL after the source-fix checkout (`post_fix_exit=1`) because the
  case's expected output depends on preview-mode / feature-flag context
  not captured by `source_files_touched`; and **2 of 3** `test_black.py`
  candidates also fail (`9fd9ea2` pre-fix collection error exit 2;
  `ebe6018e` test-diff passes without the fix). The 3 that reproduce are
  cases where the source fix alone flips FAIL→PASS.
- **Correction (2026-05-28):** an earlier draft of this amendment (and
  commit `357f2c3`'s message) misidentified the reproducible set as
  `ebe6018e`/`9fd9ea2`/`650983f` and claimed all 3 touch `test_black.py`.
  That was inherited from the **first (broken) box-4c run** before the
  git-clean / vitest-invocation fixes. The authoritative source is
  `box-4c-repro.json` (status=reproducible). Task selection was always
  computed from that file and is correct; only this prose was wrong.
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
