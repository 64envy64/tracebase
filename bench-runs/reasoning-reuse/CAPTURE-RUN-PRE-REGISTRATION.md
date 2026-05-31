# Sanctioned Capture-Run Pre-Registration — seed the organic reasoning-reuse corpus

**Status: DRAFT — awaiting explicit budget approval before any paid trajectory.**
This is NOT SWE-bench. Its only purpose is to accumulate a real, runtime-captured
corpus large enough to *honestly evaluate* the Phase 5 precision gate. No public
claim is made from it.

## Why
The serving precision infrastructure is built, proven on the loop, and green
(telemetry, contract, capture loop, importer, defect fixes, evaluator). The one
thing missing for the Phase 5 readiness gate is **organic evidence**: the gate
requires ≥50 labelled organic queries and ≥30 fired high-confidence cases, and
no real captures have accumulated yet. Synthetic/authored patterns are forbidden
from counting (they are bootstrap-only). So we must generate genuine captures.

## What (frozen design)
**Runtime capture path ONLY.** Patterns enter exclusively via the Stop-hook /
SDK `captureTurnFromTexts` → `storeReasoningPattern` path (provenance
`extractedFrom: "trajectory"`, `distilledBy: "rule"`). No synthetic or imported
pattern is counted toward the gate.

Two-phase, paired tasks:
- **Phase A — capture batch (~60 tasks).** Real, independently-verifiable coding
  tasks (small bug-fixes with a passing test as the verification oracle), drawn
  from a frozen task manifest. TraceBase capture ON. Each solved task may yield
  ≤1 block. Target: ≈50 active runtime blocks.
- **Phase B — recall batch (~40 tasks).** A *different* set of tasks in the same
  problem classes as Phase A. TraceBase recall ON. Target: ≥30 fired
  high-confidence injections, each attributed to a real verification outcome
  (pass/fail), feeding calibration. Recall queries are then labelled
  useful / weak / generic / unrelated / ambiguous by inspecting whether the
  injected block was genuinely relevant.

**Frozen before any agent runs:** policy constants (serving floor/margin/gate),
calibrator featureVersion, evaluator fixtures, the task manifest with provenance,
and the labelling rubric. No benchmark-specific gate tuning at any point.

## Leakage controls
- Phase B tasks must be distinct tasks from Phase A (no same-task capture→recall).
- Capture stores only the distilled, leakage-scanned trigger; the manifest
  exports only `situationHash` + `queryHash` (no raw prompts/secrets).
- This run is isolated from any future SWE-bench corpus; its blocks are tagged
  and must be auditable/excludable before SWE-bench (target-specific patterns
  never enter a SWE-bench serving store).

## Model & budget (proposal — cheapest first)
- **Model:** `claude-haiku-4-5` (cheapest relevant). Do not escalate to Sonnet/
  Opus during this run.
- **Trajectories:** ≈100 (≈60 capture + ≈40 recall).
- **Est. cost:** ≈$0.15–0.30 / haiku trajectory → **~$15–25 expected**.
- **Hard budget cap:** **$30** (stop immediately at cap).
- **Est. wall-clock:** ~2–4 hours of agent runtime.

## Stop conditions (any → halt)
1. Corpus target reached: ≥50 active runtime blocks **and** ≥30 fired+attributed
   high-confidence cases (precision-ready, per `dogfood-status`).
2. Hard budget cap $30 reached.
3. Capture or attribution pipeline breaks (≥3 consecutive capture errors, or
   injections not attributing) — halt and diagnose, do not paper over.
4. A privacy regression (any raw prompt/secret reaches a block or the manifest).

## Success criterion (what "done" means for this run)
`scripts/reasoning-precision/dogfood-status` reports ≥50 captured runtime blocks
and ≥30 precision-ready cases, and the frozen manifest feeds
`evaluatePrecision` so the Phase 5 gate can be evaluated. The run does **not**
itself decide readiness — it only produces the evidence the gate consumes.

## Expected distance to SWE-bench readiness after this run
If the gate then passes (precision@fire ≥90%, Wilson-LB ≥80%, FP ≤5%, weak/
ambiguous abstain) on the organic corpus, the next step is the SWE-bench Verified
pre-registration (Phase 7) — a separate, separately-budgeted decision. If the
gate fails, diagnose the product mechanism and improve general infrastructure
only (never lower gates or cherry-pick queries), then re-run.

---
**Approval required:** running Phases A+B spends real API budget. Per the goal,
this pauses for explicit budget approval. Proposed cap: **$30, haiku-only.**
