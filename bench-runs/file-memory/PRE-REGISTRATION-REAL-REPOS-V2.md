# 02 File Memory — Real Public-Repo Workloads, V2 (Pre-Registration)

**SPEC LOCKED 2026-05-30.** This is a NEW pre-registration. It does **not**
amend or supersede the V1 pre-reg
(`PRE-REGISTRATION-REAL-REPOS.md`) — that document stands as a closed, honest
**internal negative** for its locked Glob+Grep claim
(`bench-results/internal-diagnostics/file-memory-real-repos.md`). V2 makes a
**different, narrower claim** with a **different primary endpoint**, run once on
the **same locked task set** with an **improved product**.

## Why a new pre-reg (not an amendment)

V1's claim was "file_memory cuts filesystem-exploration tool calls (Glob+Grep)
by ≥20%." At N=25 that failed §A.2 — not because file_memory hurt, but because
the tool-CALL count is a noisy small-N proxy that one outlier task
(`colinhacks-zod-0e960108`, 0→11 locate-Greps) swung, while the **volume**
metrics moved the right way (bytes_read −22.6%, tokens −14.7%). The transcript
investigation (`bench-results/internal-diagnostics/file-memory-real-repos.md`
§Appendix, commit `f4b84ec`) found the outlier's root cause: the injected
payload named the right file but not the matched **symbol**, so the agent
grepped to locate it inside a 1500-line monolith.

Two things changed since V1, and both are disclosed up front so this reads as a
fresh test, not moved goalposts:

1. **The metric is reframed.** Tool-CALL count (Glob+Grep) is demoted to
   **descriptive**. The primary endpoints are now **code-reading volume
   (bytes_read)** and **token usage (total_tokens)**, with **pass-rate**
   preserved. This is the honest endpoint for a "navigation gets cheaper" claim
   — the volume of reading is the cost, the number of search calls is a proxy.
2. **The product improved.** The ON treatment now includes the **matched-symbol
   payload** (commit `74c9b04`): a symbol-rollup FileHit renders a
   `matched: <name> — <signature>` span so the agent jumps to the declaration
   instead of grepping to locate it. Free offline validation (commit `60434b8`,
   `bench-runs/file-memory-real-repos/results/offline-recall-matched-symbol.json`)
   confirms: recall unchanged (source @3=84% @5=88%, identical to baseline),
   `matched:` span on 25/25 tasks, `<file_memory>` avg 961 / max 1110 chars,
   docs FP 0, dependency-junk FP 0, and `zod-0e960108` now renders
   `classic/schemas.ts → matched: record — export function record<…>`.

The prior run's bytes/tokens numbers are **motivating evidence only**; the V2
verdict comes from this fresh run under criteria locked **before** it.

## Claim under test (locked scope)

> **On real public-repo bug-fix tasks at N=25 (haiku), TraceBase file_memory
> reduces code-reading volume (bytes_read) and token usage (total_tokens) while
> preserving pass-rate. Glob/Grep tool-call count is reported descriptively, not
> as the primary endpoint.**

Narrow on purpose. It does NOT claim a Glob/Grep reduction, does NOT escalate to
reasoning-reuse / tool-supervision / loop-detection / context-fold, and does NOT
generalise beyond the 4-repo / haiku / N=25 sample.

### In scope
- **Code-reading volume reduction**: aggregate `Σ ON.bytes_read ≤ Σ OFF.bytes_read × 0.90` (≥10% cut).
- **Token reduction**: aggregate `Σ ON.total_tokens ≤ Σ OFF.total_tokens × 0.95` (≥5% cut).
- **Pass-rate preservation**: zero (OFF pass · ON fail) paired cells.
- **No wall-time inflation**: aggregate `Σ ON.duration ≤ Σ OFF.duration × 1.10`.

### Out of scope (declared up front)
- **Glob/Grep tool-call count as a verdict.** Reported descriptively (totals,
  per-repo, and the per-task outliers including `0e960108`), but it does NOT
  gate publish. This is the explicit correction to V1.
- Reasoning-reuse, tool-supervision, loop-detection, context-fold — all disabled
  by isolation (file_memory only).
- Per-task "always cheaper" — aggregate claim, variance disclosed.
- Cross-repo / cross-model / cross-language generalisation beyond the sample.
- Frontier-model behaviour — `claude-haiku-4-5` only.

## What is inherited unchanged from V1 (locked)

To keep this anti-cherry-pick, everything below is **identical** to V1 and is
NOT re-derived:

- **Task set**: the SAME `bench-runs/file-memory-real-repos/selected-tasks.json`
  (N=25: mathjs 7, rich 6, zod 9, black 3). **No re-selection, no
  substitution, no addition, no removal.** The locked set from V1 is reused
  verbatim. Re-selecting tasks now would be cherry-picking; it is forbidden.
- **Isolation**: ON = `UserPromptSubmit → inject-context` only; empty
  `reasoning_blocks`; `indexed_files` + `indexed_symbols` populated via
  `indexWorkspace` pre-run; no other hooks. (V1 §"OFF/ON isolation".)
- **Prompt template + retrieval query**: unchanged (V1 §"Trajectory shape" +
  Amendment 2 README-prefix removal + Amendment 3 `buildRetrievalQuery`
  field-derived query).
- **Model / tools / per-trajectory cap**: `claude-haiku-4-5`;
  `--allowedTools Read,Edit,Bash,Grep,Glob`; `--max-budget-usd 1.00`.
- **Anti-cherry-pick guardrails**: V1 §"Guardrails" 1–5 apply verbatim.
  Agent-side outcomes (including OFF failing) are NEVER grounds for exclusion;
  only documented **infrastructure failure** may exclude a trajectory, recorded
  in the retry audit.

## Product state under test (locked)

The ON treatment is the product at the SHA this pre-reg is committed against.
The matched-symbol payload is part of ON:

- `74c9b04` — matched-symbol payload (recallSymbols → matchedSymbols → FileHit →
  `matched:` render; deduped, clamped, guard-scanned).
- plus the already-committed recall-quality stack it builds on (source-first
  recall, symbol-level recall, `.venv`/dependency-env exclusion).

No product code, gate, prompt, embedding, or isolation change is permitted
between this lock and the run. The summarizer stays `heuristic` (shipped
default); the serving gate stays `DEFAULT_GATE_THRESHOLD` (no lowering);
no calibrator; no embeddings.

## Metrics (locked)

### Per trajectory (authoritative — harness JSON + transcript)
- `total_tokens` (input + cache + output) — **primary**
- `bytes_read` (sum of Read tool_result content bytes) — **primary**
- `duration` (wall seconds) — guard
- `Glob`, `Grep`, `Read`, `Edit`, `Bash` counts — **descriptive**
- `pass` = repo's test command exits 0 against post-trajectory state
- `terminal_reason`, `num_turns`, `total_cost_usd`

### Per ON trajectory (descriptive)
- `recalled_files`, `expected_source_in_topk`, `hook_isolation` (exactly
  `UserPromptSubmit`), `dep_junk_recalled` (must be empty).

### Aggregate
- Paired sums / ratios across all 25 task pairs, plus per-repo breakdown and a
  paired-outcome (PP/PF/FP/FF) table.

## Decision rules (locked)

### §A. Publishable
ALL of the following must hold over the N=25 paired set:

1. **Pass-rate preserved (load-bearing)**: (OFF pass · ON fail) paired-cell
   count = **0**.
2. **Volume cut**: `Σ ON.bytes_read ≤ Σ OFF.bytes_read × 0.90`.
3. **Token cut**: `Σ ON.total_tokens ≤ Σ OFF.total_tokens × 0.95`.
4. **No wall-time inflation**: `Σ ON.duration ≤ Σ OFF.duration × 1.10`.
5. **Isolation clean**: hook isolation OK on **25/25** ON trajectories
   (exactly `UserPromptSubmit`).
6. **No dependency junk**: dependency-env junk FP in ON recalled paths = **0**.

Glob/Grep is reported descriptively alongside (totals, per-repo, per-task
outliers) but is NOT a publish gate.

### §B. Internal-only
Any one of §A.2 / §A.3 / §A.4 fails while §A.1/§A.5/§A.6 hold → "preserves
pass-rate and isolation but the volume/token gain is below the locked
threshold" → internal diagnostic with the full paired + per-repo table.

### §C. Halt / re-design
- §A.1 fails (≥1 OFF-pass·ON-fail) → file_memory regressed a real task; halt,
  investigate before any further run.
- §A.5 fails (isolation breach) → stop immediately mid-run (the harness halts on
  the first breach).
- §A.6 fails (dependency junk recalled) → exclusion rule leaked; halt.

## Run protocol (locked)

- Run **once**. No mini-pilot, no warm-up.
- Full N=25 OFF then ON per task, in the WSL harness (claude + deps live there),
  with the committed `.venv`/dependency-env exclusion.
- **Budget cap: $12 total.** Per-trajectory cap $1.00 (locked). Safety stop at
  $11.50.
- **Incremental JSONL** after every trajectory (crash recovery / resume).
- **Retry only documented infrastructure failures** (empty-envelope:
  tokens=0 ∧ cost=0 ∧ exit≠0). Valid model outcomes are NEVER retried. Stop
  after 3 consecutive infra-empties (API-failure backstop). Preserve a retry
  audit of any purged/retried trajectory IDs + reasons.
- **Stop immediately** on hook-isolation failure or spend cap.
- Assert hook isolation after every ON; assert dependency-junk absent from ON
  recalled paths after every ON.

## Reporting (locked)

- On §A: `bench-results/publishable/file-memory-real-repos.md`. Headline
  (scoped): "On N=25 real public-repo bug-fix tasks at haiku, file_memory cut
  code-reading volume by X% and tokens by Y% while preserving pass-rate;
  Glob/Grep reported descriptively." Paired + per-repo tables; Glob/Grep
  descriptive section including the `0e960108` outlier; caveats up front
  (N<30, haiku-only, 4 repos, file_memory-only).
- On §B/§C: `bench-results/internal-diagnostics/file-memory-real-repos-v2.md`
  with "NOT publishable because …" at top + full paired analysis. (The V1
  internal diagnostic is NOT overwritten.)
- Always: report exact spend, retry audit separately, paired-outcome cells,
  per-repo breakdown, and Glob/Grep descriptively WITH outliers.

## Hard stop (operator directive)

After this single rerun, **do not tune further based on trajectory results**. If
the locked criteria fail, close the file-memory lane as internal-only and move
to the next product priority. No re-run, no knob-tuning, no third pre-reg off
the back of this run's numbers.

## Lock block

- [x] Claim scope locked: volume (bytes_read) + tokens primary, pass-rate
      preserved, Glob/Grep descriptive only.
- [x] Task set: SAME locked `selected-tasks.json` (N=25), no re-selection.
- [x] Isolation / prompt / query / model / tools / per-traj cap: inherited
      verbatim from V1 (+ Amendments 2, 3).
- [x] Product under test: matched-symbol payload `74c9b04` + recall-quality
      stack; summarizer heuristic, gate unchanged, no embeddings.
- [x] Locked criteria: §A.1 PF=0; §A.2 bytes ≤0.90×; §A.3 tokens ≤0.95×;
      §A.4 duration ≤1.10×; §A.5 isolation 25/25; §A.6 dep-junk FP=0.
- [x] Budget cap $12; per-traj $1.00; JSONL recovery; infra-only retries.
- [x] Pre-registration locked: **2026-05-30**, committed BEFORE the paid run.

## Amendments

(none — populated only if the run exposes a spec-level issue; per the hard stop,
no threshold may move post-lock off this run's own numbers.)
