# Evaluation-Design Audit — why Phase-5 precision-ready is unreachable on this corpus

$0 offline audit (no paid agents) over the frozen 98-task manifest, using the REAL
serving policy (`BlockServer`). Resolves the v2 all-axios confound and answers the
"is it coverage, retrieval, or policy?" question. Full data:
`results/offline-corpus-audit.json`.

## Headline
The 98-task corpus is **arbitrary distinct bug-fixes with NO genuinely recurring
problem classes**, so reasoning-reuse recall has essentially nothing to reuse:
- **`familiesWithMultipleCaptures: 0`** — all 56 capture tasks are distinct problem
  areas (56 distinct families). There is no problem class with ≥2 captured examples.
- **Fire-rate 7/42 = 16.7%** (offline *optimistic* proxy; the v2 real-block
  checkpoint fired **0/10**). The true rate sits in **[0, 16.7%]** — all far below
  the ~71% (30/42) needed for ≥30 precision-ready.
- **precision@fire ≈ 0.43** — only 3 of the 7 offline fires are same-family; the
  other 4 are *cross-family false positives*. Well below the locked ≥0.90. So the
  few fires that happen are mostly wrong — the gate SHOULD abstain, and it mostly
  does.

## Family structure (Step 2)
| metric | value |
|---|---|
| distinct capture families | 56 (= capture count) |
| families with ≥2 captures (recurring problem classes) | **0** |
| matched families (recall family has a capture) | 16 |
| recall tasks in a matched family | 42 (coarse source-dir match) |
| genuinely recurring problem classes with distinct fixes | **~0** |

The 16 "matched families" share only a coarse source-DIRECTORY label (e.g.
`axios:http`); the underlying bugs are different problems, not the same recurring
class. So Step-2 bucket (b) "genuinely recurring problem classes" is essentially
empty; bucket (a) "unrelated bugs, abstention correct" covers the corpus.

## Gate-fit (Step 3) — binding issue
- abstention reasons: **`ambiguous_margin` ×35**, `injected` ×7.
- of the 35 matched-family non-fires, **26 DID retrieve the same-family block** as a
  candidate but the gate abstained (top-vs-second margin too small among several
  weakly-similar blocks); 9 did not retrieve it.
- **Binding issue = (a) insufficient repeated-family coverage**, secondarily (c) the
  evidence policy correctly abstaining on weakly-similar distinct bugs. **NOT (b)
  weak retrieval** — the relevant blocks are surfaced; there is just no genuinely
  similar prior to fire on.

## Verdict
**NOT READY**, and a paid re-run would not change it: the locked ≥30-precision-ready
gate is unreachable from a corpus of arbitrary distinct bug-fixes, because
precision-safe reuse needs *recurring* problems and this corpus has none. Capture
(volume) is proven (≥50 reachable, 90% live yield); precision-ready (reuse) is not.

## Recommendation (Step 4/5) — no fresh pre-registration is justified
A new pre-registration would require enough real **recurring-family holdouts** to
target ≥30 precision-ready; this corpus has ~0, and **mining more random bugs would
only inflate N without adding recurring classes** (explicitly disallowed). The
honest next evidence sources are:
1. **Runtime dogfood accumulation** — let genuinely repeated problems accumulate
   from real TraceBase usage over time (the Stop-hook capture path is now proven
   live), then evaluate precision when recurring classes actually exist.
2. **Disclosed bootstrap-import evaluation** — evaluate reuse on an imported corpus
   that *contains* recurring problem classes, reported separately and never counted
   as organic readiness.

Either path needs a separately-budgeted decision; neither is dispatched here.
No gates were lowered; no thresholds/prompts tuned to flatter; v1/v2 preserved.

## Caveat (honesty)
Offline fire-rate is an *estimate* via proxy capture blocks (situation faithful to
the extractor's firstSentence; mechanism approximate, slightly optimistic). The
empirical anchor is the v2 checkpoint with REAL blocks → 0 fired. Both point the
same way: precision-ready ≪ 30.
