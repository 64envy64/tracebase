# Pre-Registration (DRAFT) — Bootstrap / Cold-Start Import Evaluation

**Status: DRAFT. No dispatch.** Separate from organic readiness. Its purpose is to
measure whether the serving policy *can* fire usefully when the corpus actually
contains **recurring reasoning families** — the precondition the arbitrary
distinct-bug capture run lacked (`CAPTURE-RUN-AUDIT.md`: 0 recurring families).
This is **BOOTSTRAP / COLD-START evidence only — it NEVER counts toward organic
Phase-5 readiness.**

## Why (and why it is honestly separate)
The capture run proved: capture works (90% live), privacy holds, the gate abstains
correctly. The unanswered question is whether reuse fires **precisely** when a
problem genuinely recurs. Organic recurrence will take real dogfood time to
accumulate; a disclosed imported corpus lets us answer the *mechanism* question
now, clearly labelled as cold-start, not organic.

## Boundary (reuse existing infra; no new product surface)
- Imported patterns enter via the existing generic `ReasoningPatternDTO →
  ingestPattern` boundary (`src/ingest/import-patterns.ts`) — the SAME validator
  the runtime capture path uses, so imported and runtime blocks are
  indistinguishable to retrieval but carry **import provenance**.
- `evaluatePrecision` already tags every query `organic | bootstrap` and the
  readiness gate counts ONLY organic. Imported evidence is reported in the
  `bootstrap` subset and is structurally barred from the organic gate.
- No webhooks, no sync, no daemon, no UI, no serving-gate changes.

## Corpus (frozen before any eval)
A small public corpus deliberately built around **genuinely recurring reasoning
families** — each family = one root-cause class with **≥3 distinct instances**
(different files/repos/commits). Candidate sources (public, license-clean,
disclosed): curated common-bug-class collections (e.g. categorized CWE/lint
fix-pattern sets, or a hand-curated set of repeated fix classes such as
"missing-null-guard", "off-by-one-in-range", "unawaited-promise",
"cache-invalidation-race"). NO random-PR mining.
- **N:** ~10 families × ~4 instances ≈ **40 imported patterns**, plus **~30
  leakage-safe holdout recall tasks** (a *different* instance of an imported
  family — never the imported instance's own fix).
- Each imported record + each holdout task gets a `familyId` and provenance.

## Leakage controls (deterministic audit before eval)
- A holdout recall task is a DIFFERENT instance than every imported pattern in its
  family (no own-fix; disjoint refs — same `freezeManifest`-style disjointness
  assertion).
- Imported patterns carry the reusable *reasoning*, never the holdout's answer
  patch; holdout fixes are excluded from imported content.
- Include **unrelated-bug negative controls** (holdout tasks whose family is NOT
  imported) to verify the gate still abstains (precision guard).
- Run the deterministic leakage audit + freeze familyId selection BEFORE eval.

## Method
- **Phase 1 — offline ($0):** seed the imported corpus, run the real
  `BlockServer` policy over all holdout queries (reuse the
  `offline-corpus-audit.ts` harness), report fire-rate, precision@fire (family-
  labelled), Wilson-LB, FP (incl. negative controls), within-family fire-rate.
- **Phase 2 — small paid confirmation (ONLY if Phase 1 is promising):** run the
  holdout recall tasks as real haiku trajectories to confirm fire→use→resolve
  attribution. Proposed only here; **not dispatched by this draft.**

## Metrics (all reported as BOOTSTRAP)
fire-rate (overall + within-family), precision@fire, precision Wilson-LB,
false-positive rate (negative controls), recall@useful, latency p50/p95,
calibrator coverage. Plus the explicit label: **organic readiness unchanged.**

## Model & budget (proposal only — no dispatch)
- Phase 1: **$0** (offline).
- Phase 2 (if justified): `claude-haiku-4-5`, ~30 holdout trajectories,
  est. ~$6–10, within the remaining ~$25.6 of the $30 envelope. **Requires a
  separate explicit go.**

## Success criterion (what it would show)
If, on a corpus that DOES contain recurring families, offline fire-rate within
families is healthy AND precision@fire ≥0.90 with FP ≤0.05 on negative controls,
then the serving mechanism is sound and the organic blocker is purely
corpus-recurrence (validating the dogfood path). If precision is poor even with
recurring families, that points to retrieval/policy work — still bootstrap-only,
never an organic readiness claim.

## Hard rules
No organic-readiness credit for imported evidence. No serving-gate changes. No
random-bug mining. No SWE-bench. No paid dispatch from this draft.
