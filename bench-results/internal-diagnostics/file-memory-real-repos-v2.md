# 02 File Memory — Real-Repo V2 Rerun (matched-symbol payload) — INTERNAL

**NOT publishable. Lane closed as internal-only.** Evaluated against the
**fresh** locked pre-registration `PRE-REGISTRATION-REAL-REPOS-V2.md` (SHA
`9fb936f`). The V1 run was an honest negative on the Glob+Grep claim; this V2
run re-scopes the claim to **code-reading volume + token usage with pass-rate
preserved** (Glob/Grep demoted to descriptive) and tests the matched-symbol
payload fix.

## Verdict
**Internal-only.** The run **halted incomplete at 16/25 pairs** when the zod
tail hit a persistent infrastructure-hang window, and on the recorded pairs it
**fails three of six locked criteria**:

| Criterion | Rule | Result | |
|---|---|---|---|
| A1 no pass-rate regression | OFF✓ · ON✗ cells = 0 | **PF=2** | ❌ |
| A2 reads less | bytes_read ON ≤ 0.90 × OFF | **0.932** | ❌ |
| A3 fewer tokens | total_tokens ON ≤ 0.95 × OFF | **0.702** | ✅ |
| A4 no wall-time inflation | duration ON ≤ 1.10 × OFF | **0.674** | ✅ |
| A5 isolation | hook isolation 25/25 ON | **16/25** (all 16 ON OK) | ❌ |
| A6 no dependency junk | dep-junk FP = 0 | **0** | ✅ |

Model `claude-haiku-4-5`; ON = file_memory only (indexed_files +
indexed_symbols + matched-symbol payload + UserPromptSubmit→inject-context),
`.venv`/dep-env excluded, `TRACEBASE_SKIP_HOOK_SELF_HEAL=1`. Source of truth:
`bench-runs/file-memory-real-repos/results/pilot-n25-v2-progress.jsonl` (32
legs). Aggregate: `…/pilot-n25-v2.json`. Retry audit:
`…/pilot-n25-v2-retry-audit.json`.

## Headline (one sentence)
The matched-symbol payload delivered **−30 % tokens, −33 % wall-time, and a
Glob+Grep cut 15→7** (mathjs 12→3), but it did **not** reduce bytes_read to
the 0.90 bar (0.932, driven by mathjs ON reading *more*), **regressed
pass-rate on 2/16 tasks**, and the run could not finish the zod tail / black
(9 pairs) due to a persistent claude-API startup-hang window — so the V2
claim is **not met**.

## Recorded aggregate (16/25 paired)
- Cells: **PP=5, PF=2, FP=2, FF=7**.
- **FP (ON wins):** `mathjs-d1ecf44e` (OFF✗/ON✓), `zod-60ff3987` (OFF✗/ON✓).
- **PF (ON regressions):** `mathjs-837769c7` (ON tok 669 k, $0.110, exit=1 —
  partial/cut), `zod-2f8414bc` (ON tok 1.96 M, $0.277, exit=0 — genuine fail;
  OFF passed via a 4.3 M-token / 512 s exploration). Both are real model
  outcomes (tokens+cost present), so the locked rules forbid retrying them.
- bytes_read: OFF 681,534 → ON 635,354 (**0.932**).
- tokens: OFF 24.62 M → ON 17.28 M (**0.702**, −30 %).
- duration: OFF 2,122 s → ON 1,430 s (**0.674**, −33 %).
- Glob+Grep (descriptive): OFF 15 → ON 7. Read: OFF 111 → ON 103.
- src-in-ON-top-K **14/16**; isolation **16/16 ON OK**; dep-junk FP **0**; PowerShell 0.

### Per-repo (recorded)
| repo | n | OFF✓/ON✓ | Glob+Grep O→N | bytes O→N |
|---|---|---|---|---|
| josdejong/mathjs | 7 | 6/6 | **12 → 3** | 315,580 → 351,634 |
| Textualize/rich | 6 | 0/0 (all FF) | 2 → 3 | 217,122 → 149,548 |
| colinhacks/zod | 3 | 1/1 | 1 → 1 | 148,832 → 134,172 |

The **bytes A2 failure is mathjs-local**: on mathjs's small files ON reads
slightly *more* (matched span doesn't shrink already-tiny files); on rich/zod
ON reads fewer bytes. rich is entirely FF (both arms fail — hard tasks, not ON
regressions).

## Incomplete tail (9 pairs unrun)
zod `2e5b23dc 7f789def 411f6c64 b6a3b336 87cf0f93 0e960108`, black
`01c29bd5 13e97b44 650983f7`. Cause: a claude-API startup-hang window
(`exit=143` SIGTERM, **0 tokens** — claude spawned but produced nothing before
the 600 s per-trajectory timeout). `zod-2e5b23dc` hung on **every** attempt
(both arms) — un-runnable in this environment; `zod-0e960108` hung on the final
attempt. Three resume attempts recovered `60ff3987` but could not clear
`2e5b23dc`/`0e960108`; halted to avoid grinding (per the goal's hard-stop). The
black repo was never reached.

**`zod-0e960108` (the fix's motivating case) is validated OFFLINE** (Part 2,
$0): with the matched-symbol payload it recalls `classic/schemas.ts` at **rank
3 with the matched `record`/`ZodRecord` span rendered**, and now also surfaces
`mini/schemas.ts` (rank 4) — the V1 "named the file but not the span" gap is
closed offline. The live leg simply never executed.

## Product fix (Part 1 — committed `74c9b04`)
`feat(file-memory): matched-symbol payload — surface the span, not just the file`
- `recallSymbols` → `Map<relPath, { count, symbols:[{name,signature}] }>`.
- `recallFiles` threads `matchedSymbols` onto `FileHit` for **symbol-rollup
  hits only** (basename/summary hits get none).
- `build-injection-payload` renders ≤2 matched symbols
  (`matched: record — export function record<…>`), signature clamped, total
  file_memory char budget preserved, symbols deduped, existing
  leakage/injection guards applied to rendered text.
- No repo/file/task hardcodes, no gate lowering, no embeddings, no prompt tuning.

## Tests (Part 1)
Focused suite (`build-injection-payload`, `file-indexer`, `file-summarizer`,
`file-walker`, `walker-indexer-constants`): **128 passed / 128 (5 files)**. Covers:
monolithic deep matched symbol; FileHit carries matchedSymbols on a rollup hit;
basename/summary-only hit invents none; payload renders within budget; duplicate
symbols deduped; injection-like signature does not leak. lint/tsc clean (Part 1).

## Offline eval (Part 2 — committed `60434b8`)
`offline-recall-matched-symbol.json`: recall@3 **84 %**, recall@5 **88 %**
(mathjs 5/7, rich 6/6, zod 8/9); **matched span rendered for 25/25 tasks**;
file_memory chars avg 961 / max 1110 (budgeted); doc-recall FP **0**; dep-junk
FP **0**. No regression or leak → paid run gated open.

## Retry / recovery audit (separate)
Two infrastructure incidents, three resume attempts (all hosted in WSL, JSONL
resume):
1. **Transient API window (`exit=1` empties)** in the zod batch → probe
   confirmed recovery → resumed → 12 further pairs ran clean.
2. **Persistent startup-hangs (`exit=143`, 0 tokens, 600 s SIGTERM)** in the
   zod tail → `60ff3987` recovered (became an FP win); `2e5b23dc` hung every
   attempt (un-runnable); `0e960108` hung on the final attempt → halted.

Resume hosts: `b9zhm9ean` (pairs 4–15, then 3-empty self-stop), `beiq8dyhy`
(died mid-leg, host/WSL teardown during idle, 0 pairs added), `btqia16j8`
(added `60ff3987`; stopped manually at the hang wall). No valid model outcome
was retried; no tasks/prompts/product/gates/isolation changed.

## Spend
Recorded V2 legs: **$6.6421**. Plus 3 API-recovery probes (~$0.034). **Total
≈ $6.68 / $12.**

## Commit SHAs
- `74c9b04` — Part 1 matched-symbol payload (product).
- `60434b8` — Part 2 offline eval renders matched span + validates 0e960108.
- `9fb936f` — Part 3 fresh V2 pre-registration.
- (this commit) — Part 5 internal diagnostic + V2 results + retry audit + the
  V2 pilot driver (`scripts/file-memory-real-repos/pilot.ts`, A1–A6/RUN_TAG).

## Status / what this means
The matched-symbol **product fix is safe and recall-correct** (offline 88 %,
matched span 25/25, 0 junk, isolation clean, tests green) and worth keeping.
But the **V2 navigation/volume claim is not met** at the recorded scale
(pass-rate regressions + bytes barely above the bar) and the run is
infrastructure-incomplete. Per the goal's hard-stop, the file-memory
**trajectory-savings lane is closed as internal-only** — V1 was a negative on
Glob/Grep, V2 is a negative on pass-rate/bytes. No further trajectory-driven
tuning.
