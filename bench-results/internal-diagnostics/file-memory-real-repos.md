# 02 File Memory — Real Public-Repo Pilot (N=25) — INTERNAL

**NOT publishable.** Evaluated strictly against the locked
`PRE-REGISTRATION-REAL-REPOS.md` §"Decision rules":

| Criterion | Rule | Result | |
|---|---|---|---|
| §A.1 no ON regression | (OFF pass · ON fail) count = 0 | **0** (PP=23, PF=0, FP=0, FF=2) | ✅ |
| §A.2 filesystem-exploration cut ≥20% | Σ(ON glob+grep) ≤ 0.80 × Σ(OFF) | ON **18** vs 0.80×13 = 10.4 | ❌ |
| §A.3 no token inflation | Σ ON tokens ≤ 1.05 × OFF | ratio **0.853** | ✅ |
| §A.4 no wall-time inflation | Σ ON duration ≤ 1.10 × OFF | ratio **1.019** | ✅ |

§A requires all four → **fails on §A.2**. Because aggregate
Σ(ON glob+grep) = 18 **> ** Σ(OFF glob+grep) = 13, the locked tree lands in
**§C** ("ON does MORE filesystem exploration than OFF in total → halt,
investigate before further runs"), not §B. Honest caveat below: the §C
trigger is driven by a single high-variance task, and the related
*volume* metrics moved the other way.

Model: `claude-haiku-4-5`. ON = file_memory only (indexed_files +
indexed_symbols + UserPromptSubmit→inject-context). Run executed under WSL
with the committed `.venv`/dependency-env exclusion. Hook isolation asserted
on every ON run (8 file_memory-only events expected; all OK). Source of
truth: `bench-runs/file-memory-real-repos/results/pilot-n25.json`.

## Headline (one sentence)
On N=25 real public-repo bug-fix tasks at haiku, file_memory **held pass-rate
with zero regressions** and **cut bytes_read −23 % and tokens −15 %**, but did
**not** reduce the Glob+Grep tool-call count (ON 18 vs OFF 13) — so the
pre-registered ≥20 % filesystem-exploration-cut claim **fails**, driven by a
single outlier task.

## Clean N=25 aggregate (paired)
- Paired cells: **PP=23, PF=0, FP=0, FF=2**. Pass-rate preserved: 23/25 both
  pass; 2/25 both fail (black `01c29bd5`, `13e97b44` — hard tasks; OFF also
  failed, so NOT ON regressions).
- **Glob+Grep: OFF 13 → ON 18** (ratio 1.385) ❌ headline metric.
- Read: OFF 195 → ON 188 (−3.6 %).
- **bytes_read: OFF 900,555 → ON 696,878 (−22.6 %)** — file_memory steered
  to fewer bytes even while issuing more Glob/Grep calls.
- tokens: OFF→ON ratio **0.853** (−14.7 %). duration ratio **1.019** (+1.9 %).
- expected-source-in-ON-top-K: **21/25**. dep-junk FP: **0**. hook isolation:
  **8/8 OK** (the contamination/PowerShell issues are gone). PowerShell: 0.

## Where §A.2 fails — a single outlier
Per-repo Glob+Grep (OFF→ON): mathjs **3→3**, rich **2→2**, black **0→0**,
zod **8→13**. The entire aggregate inversion comes from zod, and within zod
from ONE task:

| task | cell | Glob+Grep OFF→ON |
|---|---|---|
| **colinhacks-zod-0e960108** | PP | **0 → 11** |
| colinhacks-zod-2f8414bc | PP | 7 → 1 |
| colinhacks-zod-b6a3b336 | PP | 0 → 1 |
| colinhacks-zod-87cf0f93 | PP | 1 → 0 |
| (mathjs/rich misc) | PP | mostly 0↔1 swings |

Remove `0e960108` (ON 0→11) and the aggregate is **13 → 7 = a 46 % cut**.
But it is a **valid model outcome** (not infra) and the pre-reg forbids
cherry-picking, so it stays in the aggregate and §A.2 fails as recorded.
The metric is also tiny and noisy: <1 Glob/Grep per task on average, many
tasks 0 — at this scale a single task swings the headline.

## Honest interpretation
- file_memory is **not harmful** here: zero regressions, pass-rate held,
  fewer bytes read, fewer tokens, ~flat wall-time, correct source recalled
  21/25, no dependency-env junk, clean isolation.
- But the **specific claim under test — a ≥20 % reduction in Glob+Grep tool
  CALLS — does not replicate** on real-repo haiku workloads at N=25. The
  navigation savings that showed on synthetic 02 (Glob 3→0) do not carry over
  as a tool-call-count reduction; if anything, file_memory's hints sometimes
  prompt a verifying Glob/Grep (the `0e960108` spike). The *volume* of reading
  (bytes/tokens) does fall, suggesting the value is "read less / read more
  targeted," not "search less."

## §C action (per locked rule)
Halt the headline claim; do NOT publish; do NOT run a larger bench on this
metric without investigating:
1. Why ON issued 11 Glob/Grep on `zod-0e960108` while OFF issued 0 (did an
   injected symbol hint trigger a confirm-by-search loop?).
2. Whether Glob+Grep *count* is the right proxy at all — bytes_read/tokens
   (which fell) may be the truer "exploration cost" signal for a navigation
   claim. Any change to the claim/metric requires a fresh pre-registration;
   it was NOT changed here.

## Retry / recovery audit (separate)
The FIRST N=25 run was **invalid** — a transient claude API failure window
returned empty envelopes (tok=0, cost=0, exit=1) for 16 trajectories (8
pairs: zod tail + all black), and one OFF trajectory hit the harness's
self-imposed $0.50 cap (artificial fail). Those 18 trajectories were purged
and **retried** under the sanctioned recovery (per-traj cap restored to the
locked **$1.00**; empty-envelope guard; stop after 3 consecutive empties);
**valid model outcomes were not retried**. Full per-trajectory audit:
`bench-runs/file-memory-real-repos/results/pilot-n25-retry-audit.json`
(18 entries: 16 infra_empty, 1 budget_cap_artifact, 1 failure_boundary). The
first run's partial-subset headline (a spurious "50 % cut" produced by the
empty ON trajectories) was **discarded and never reported as a verdict**.

## Spend
- Clean N=25 (pilot-n25.json) total: **$10.157** (within the $12 cap).
- Plus discarded first-run overhead on purged-but-charged trajectories
  (fb76ac41 OFF $0.50 + 2e5b23dc ON $0.099; empties $0) ≈ $0.60, and two
  $0.012 WSL auth probes. **Total API ≈ $10.78**, under the $12 cap.

## Status
Internal-only. The pre-registered publishable claim is **not met** at N=25.
file_memory's recall quality and safety are validated (offline recall@5 88 %;
zero regressions; no junk; isolation clean), but the navigation-tool-call
savings headline does not hold on this workload class.

---

## Appendix — zod-0e960108 investigation ($0, transcript-only, no reruns)

Task `record()` overload fix; source = `packages/zod/src/v4/classic/schemas.ts`
+ `mini/schemas.ts`; field-derived query = "record". OFF pass / ON pass.

**1. Injected `<file_memory>` (ON), ranked:**
1. `core/util.ts` — generic util types (noise)
2. `core/schemas.ts` — `defines: ParseContext, $ZodTypeDef, …`
3. `classic/schemas.ts` — `defines: ZodStandardSchemaWithJSON, ZodType, _ZodString, ZodString, …`

**2. Expected source in top-K?** YES — `classic/schemas.ts` at **rank 3**
(`core/schemas.ts` rank 2 is also schema-relevant; `mini/schemas.ts` was
NOT injected; `util.ts` rank 1 is noise).

**3. Glob/Grep sequence.** OFF = **0** (navigated by 6 Reads). ON = **11**:
1 Glob `classic/**/record.ts` (no such file) · 2 Glob `classic/**/*.ts` ·
3 Grep `export.*record` → classic/schemas.ts · 4 Grep `function record` →
line 1507 · 5–6 Grep record variants · 7–8 Grep `string` overloads (studying
the sibling pattern) · 9 Glob `mini/**/*.ts` · 10 Grep `function record` →
mini line 1164 · 11 Grep `string` overloads in mini.

**4. Cause.** PRIMARY = **correct recall but missing symbol-span detail in
the payload**: the injection named the right file (`classic/schemas.ts`) but
its visible `defines:` list (first ~12 symbols) was `ZodType/ZodString/…` and
did NOT include `record`/`ZodRecord` — the very symbol that *caused* the
recall (the symbol index matched it, but `recallFiles` rolls symbols up to
files and discards which symbol matched). So the agent had to grep to LOCATE
`record` inside the 1500-line monolith (×2 for classic+mini). SECONDARY =
genuine investigation (the fix mirrors the `string()` overload structure;
OFF did this via Read) + haiku Read-vs-Grep variance.

**5. Recurrence.** The "ON issues 1 confirm-locate search" pattern is mild and
general — `b6a3b336` (Glob json-schema file), `837769c7` (Glob import.js),
`e5bb6465` (Grep getToken|parseNumber), `dc7a195a` (Grep def loop_last) each
ON +1. The MAGNITUDE (11) is unique to `0e960108` (monolith × 2 + matched
symbol absent from visible defines + sibling-overload study). Counter-example:
`2f8414bc` OFF **7** → ON **1** — when file_memory surfaces the right area,
it cuts searches hard. So this is not a structural "ON searches more"; it's a
payload-detail gap that usually costs +1 and occasionally (monolith) more.

**6. General fix justified? YES** (no repo/task hardcode). The symbol index
already knows the matched symbol + signature; the payload throws it away.

### Proposed smallest principled fix (NOT implemented — pending review)
Surface the **matched symbol** on symbol-rollup hits so the agent jumps to it
instead of grepping to locate it:
- `recallSymbols` (file-indexer.ts): return `Map<rel_path, {count, symbols:[{name,signature}]}>`
  instead of `Map<rel_path, count>` (the FTS rows already carry name+signature).
- `recallFiles`: thread the matched symbols onto the `FileHit` as an optional
  `matchedSymbols` field (only for files surfaced via the symbol rollup, not
  basename/summary hits).
- `build-injection-payload`: for a hit with `matchedSymbols`, render e.g.
  `• classic/schemas.ts (typescript). matched: record — export function record<…>. defines: …`
  (signature already clamped ≤140 chars; cap 1–2 matched symbols; existing
  char-budget walk unchanged).
- Deterministic tests: (1) recallSymbols returns the matched symbol name for a
  concept query on a monolithic file; (2) recallFiles exposes `matchedSymbols`
  on a symbol-rollup hit and NOT on a basename hit; (3) build-injection-payload
  renders `matched:` + signature within budget; (4) no `matched:` line on a
  file recalled only via summary/basename.

This is general (helps every monolithic-file recall), no thresholds/gates/
prompts/embeddings touched, and directly removes the locate-grep the agent did
on `0e960108`. Whether it would have changed the aggregate is untested (no
reruns); it is justified on the transcript evidence, not on chasing the metric.

**Not pure model variance** — a real payload gap exists — but the Glob/Grep
*count* remains a noisy small-N proxy (one task swung the headline; bytes/
tokens fell). A future bench should treat Glob/Grep as descriptive with
pass-rate / bytes_read / tokens as the primary bounded outcomes — that change
requires a fresh pre-registration (not drafted here, per instruction).
