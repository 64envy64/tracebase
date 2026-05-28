# File-memory real-repo smoke — recall-quality finding (internal)

**Status:** harness-PASS / treatment-quality-FAIL, root-caused. NOT pilot-ready.
Operator decision **A + C** taken: shipped-default match verified (C), result
recorded as internal negative + real-repo expansion shelved (A). Not published
positive; N=25 pilot not run.
**Date:** 2026-05-28
**Task:** `josdejong-mathjs-d1ecf44e` (fix #3253 — special chars in `derivative`).
**Scope:** file_memory mechanism only, `claude-haiku-4-5`, N=1 smoke.

## Headline

On a real repo (mathjs, 684 source files), file_memory **as shipped**
(heuristic summarizer + lexical serving gate) does **not** surface the
bug's source files for a natural-language bug-fix query. Recall either
returns nothing (concise query) or spuriously matches verbose docs
(README/CONTRIBUTING) when the prompt contains generic words like
"bug/report/test/run". The mechanism wiring works end-to-end; the
*treatment quality* does not clear the bar of "recall the files the
agent actually needs."

This is a mechanism-level finding, not a harness or prompt-hygiene bug.
The query-hygiene fix (removing the README prefix) was necessary but
insufficient.

## Evidence (all from $0 dry probes against the ON workspace)

Initial smoke (N=1, paid, before fix) — both arms PASS, but ON was
slower/heavier and file_memory recalled README.md + docs/index.md +
package.json:

| metric | OFF | ON |
|---|---:|---:|
| pass | ✅ | ✅ |
| Glob+Grep | 1 | 0 |
| Read / bytes_read | 3 / 51285 | 4 / 47763 |
| tokens | 755432 | 957635 (+27%) |
| duration | 121.7s | 197.2s (+62%) |
| cost | $0.2512 | $0.2208 |

After Amendment 2 (README prefix removed from prompt, both arms),
recall on the amended prompt: `CONTRIBUTING.md`, `test/benchmark/README.md`,
`examples/code editor/README.md` — **still docs**, because the remaining
prompt boilerplate ("bug report", "run tests") lexically matches verbose
prose docs.

Concise / source-focused queries recall **nothing**:

| query | recalled |
|---|---|
| `fix derivative special characters identifiers` | (none) |
| `derivative function algebra symbolnode parse` | (none) |
| `src/function/algebra/derivative.js typed special characters` | (none) |
| `derivative.test.js Too few arguments derivative SymbolNode` | (none) |
| `createDerivative isConstantNode typeOf` (derivative.js's own summary tokens) | (none) |
| `derivative` (bare) | (none) |
| `typed-function checks types arguments match` (typed.js's summary vocab) | 3 files (intermittent) |

## Root cause

1. **The bug's source files ARE indexed.** The ON workspace DB has 296
   `indexed_files` rows; `src/function/algebra/derivative.js` and
   `src/core/function/typed.js` are both present (src/ = 128 indexed).
   So this is NOT an indexer-budget/coverage gap.

2. **Heuristic summaries are thin.** `derivative.js`'s summary is
   `"derivative.js (javascript). First line: import { isConstantNode, typeOf }
   from '../../utils/is.js' exports: createDerivative…"` — i.e. filename +
   first import line + exports list. There is no natural-language
   description of what the file *does*, so a query about the *behaviour*
   ("special characters in identifiers") has almost no lexical overlap.

3. **The serving gate suppresses thin-overlap matches.** The FTS recall +
   lexical-confidence gate (production default ~0.4) only serves a file
   when the query strongly overlaps that file's summary vocabulary.
   Natural bug queries don't overlap thin code summaries → empty recall.
   Verbose prose docs (CONTRIBUTING/README) DO overlap generic prompt
   words ("bug", "report", "test", "run") → spurious doc recall.

4. **Shipped default = heuristic.** `file-indexer.ts:98` and
   `init.ts:420` both default `summarizer` to `"heuristic"`. The bench
   used the same config the product ships with, so the finding represents
   file_memory as installed, not a mis-set knob.

## Shipped-default verification (operator step C)

Goal: confirm the bench used the exact gate + summarizer the product ships
with — i.e. the negative is real, not a mis-set bench knob. **Result: the
bench matches shipped defaults exactly; no mismatch.** Therefore no paid
post-fix OFF/ON re-run was warranted (operator rule: re-run only on mismatch).

| setting | shipped default | what the bench used | match |
|---|---|---|---|
| summarizer | `heuristic` (`file-indexer.ts:98` `?? "heuristic"`; `init.ts:420`) | `heuristic` (indexWorkspace called with no `summarizer` arg) | ✅ |
| serving gate | `DEFAULT_GATE_THRESHOLD = 0.4` (`block-serving.ts:239`) via `resolveProductionGateThreshold()` | same — `inject-context.ts:594` calls `resolveProductionGateThreshold()` | ✅ |
| gate env override | `TRACEBASE_GATE_THRESHOLD` (unset → 0.4; `block-serving.ts:252`) | **unset** in the bench shell (verified `env | grep -i tracebase` → none) | ✅ |
| calibrator | fresh install = none fitted → raw 0.4 gate (`calibrator.ts:174`) | fresh per-task workspace, 0 outcomes → no calibrator | ✅ |
| injection path | production MCP/SDK use `resolveProductionGateThreshold()` (`mcp.ts:130`, `runtime.ts:202`, `contextual-runtime-provider.ts:259`) | inject-context uses the identical resolver | ✅ |

Note: `vitest.config.mts:31` sets `TRACEBASE_GATE_THRESHOLD="0"` for the unit
suite (serve-everything, for deterministic tests). The smoke ran via `tsx`,
not vitest, and the env var was unset — so the smoke used the **production**
0.4 gate, not the test 0 gate. (Independently corroborated by behaviour: a
gate of 0 would have served derivative.js for the bare query "derivative";
recall returned nothing, which is only consistent with a non-zero gate.)

## Negative/null conclusion

- **Harness works** end-to-end on a real repo (materialize → run → verify;
  OFF bare, ON indexed_files-only).
- **file_memory rendered** (inject-context fired, `<file_memory>` block injected).
- **Glob/Grep reduced on N=1** (OFF 1 → ON 0).
- **But recall selected docs/README**, not source/test-adjacent files
  (README.md, docs/index.md, package.json — then CONTRIBUTING.md +
  benchmark/example READMEs after the prompt fix).
- **README removal did not fix it** — prompt boilerplate still matched docs.
- **Concise source-focused queries recall nothing** — the heuristic file
  summaries are too thin (filename + first import + exports) and the lexical
  serving gate (0.4) suppresses the weak-overlap source matches.
- **Verdict:** under the **shipped** heuristic summarizer + lexical gate,
  real-repo file_memory is **not pilot-ready**. The N=1 ON arm was also
  net-negative (+27% tokens, +62% duration) from injecting irrelevant docs.
  This is a faithful negative on the product as installed — NOT a harness or
  prompt artifact.

**This is recorded as an internal negative/null result. The bench is NOT
published as positive, and the N=25 pilot is NOT run under this configuration.**

## What this means for the pilot

A pilot at N=25 under this configuration would most likely show file_memory
**not helping** (and on some tasks hurting via injected-but-irrelevant
context inflating tokens/turns, as the N=1 ON arm already showed:
+27% tokens, +62% duration). Publishing a "file_memory reduces
file-navigation by ≥20%" headline is not supportable on this evidence.

## Decision taken (operator): A + C

- **C (done):** verified the bench used shipped defaults (table above) — no
  mismatch, so no paid post-fix re-run.
- **A (done):** this document is the internal negative/null result; the
  real-repo file_memory expansion is **shelved as not-pilot-ready under the
  shipped heuristic-summarizer + 0.4-lexical-gate configuration**, with this
  diagnostic as the recorded reason.
- **B explicitly rejected:** do NOT switch the summarizer to `embedding`
  (would test a non-default config). If embedding-mode recall is ever
  benched, it must be pre-registered and disclosed separately as
  "file_memory (embedding mode)", not as the shipped product.

### If/when this is revisited (not now, requires fresh pre-reg)

The blocker is recall quality on code, not the harness. A future iteration
would need a mechanism change (not a bench knob): richer code summaries
(symbol/behaviour text, not just imports+exports) and/or a recall path that
matches behavioural queries against code — then re-pre-register. Lowering the
0.4 gate is explicitly off the table (re-introduces the single-hit-1.0
pathology the gate exists to prevent).

## Guardrails honored

- Did NOT lower the serving gate or alter the summarizer to force recall.
- Did NOT run the N=25 pilot.
- Did NOT change the selected task.
- The only change made was Amendment 2 (drop README prefix from the prompt),
  which is a prompt-hygiene improvement valid regardless of the recall finding.
