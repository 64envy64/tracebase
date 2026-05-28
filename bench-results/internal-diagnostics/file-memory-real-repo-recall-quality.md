# File-memory real-repo smoke — recall-quality finding (internal)

**Status:** harness-PASS / treatment-quality-FAIL, root-caused. NOT pilot-ready.
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

## What this means for the pilot

A pilot at N=25 under this configuration would most likely show file_memory
**not helping** (and on some tasks hurting via injected-but-irrelevant
context inflating tokens/turns, as the N=1 ON arm already showed:
+27% tokens, +62% duration). Publishing a "file_memory reduces
file-navigation by ≥20%" headline is not supportable on this evidence.

## Options (require operator decision — NOT taken unilaterally)

- **A — Report null/negative honestly.** Run the pilot anyway and report
  whatever it shows (likely null/negative), or shelve the real-repo
  expansion with this diagnostic as the reason. Faithful to shipped product.
- **B — Switch summarizer to `embedding`.** Semantic recall instead of
  lexical FTS may surface `derivative.js` for behavioural queries. But
  this CHANGES the configuration under test (product default is heuristic),
  may need embedding infra/keys/cost, and must be disclosed as "file_memory
  (embedding mode)" not "file_memory (as shipped)".
- **C — Investigate the gate default.** Confirm what real Claude Code
  installs use for the serving gate; if the product default differs from
  the bench, match it. Do **not** lower the gate purely to make the bench
  look better (operator guardrail: "don't lower thresholds to fit data").

## Guardrails honored

- Did NOT lower the serving gate or alter the summarizer to force recall.
- Did NOT run the N=25 pilot.
- Did NOT change the selected task.
- The only change made was Amendment 2 (drop README prefix from the prompt),
  which is a prompt-hygiene improvement valid regardless of the recall finding.
