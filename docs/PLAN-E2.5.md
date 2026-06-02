# E.2.5 - Semantic Shadow Operations and Capability Matrix

## Goal

Operate the semantic applicability overlay as an auditable **shadow-only** lane
while proving that TraceBase's five public runtime capabilities coexist in one
workspace:

1. reasoning reuse
2. semantic file memory
3. loop detection
4. tool supervision
5. context compression

The semantic overlay is not a sixth serving arm. It observes residual
reasoning-reuse cases and remains unable to change injected output.

## Boundaries

- Local-first: telemetry and calibration registries stay in the workspace store
  or an operator-selected local file.
- Shadow-only: the HTTP sidecar, local provider, and operator commands cannot
  enable serving.
- Privacy-safe: shadow events carry hashes, bounded counters, verdicts, provider
  metadata, and latency. They do not carry prompts, candidate bodies, paths, or
  credentials.
- Explicit labels only: the exporter never guesses whether a result was useful.
- Fail-open: sidecar miss, timeout, scanner block, or attestation mismatch leave
  the established V4 decision unchanged.

## Operator Workflow

### 1. Inspect local shadow traffic

```bash
npx tracebase-ai semantic shadow-report --path . --since 7d
npx tracebase-ai semantic shadow-report --path . --since 7d --json
```

The report summarizes:

- V4 inject/abstain baseline
- semantic verdict counts
- residual recovery among V4 abstentions
- fallback miss/timeout/error counts
- latency p50/p95
- provider and attestation IDs
- latest health and warm-queue snapshot
- explicit readiness blockers

### 2. Curate labels without exporting raw prompts

Labels are operator-reviewed bounded DTOs. They contain the scrubbed query views
and candidate tokens accepted by the applicability reranker, plus the observed
`queryId`, family key, and explicit label. They must not contain raw prompts,
paths, credentials, or candidate bodies.

```json
[
  {
    "rowId": "runtime-row-001",
    "queryId": "observed-query-id",
    "familyKey": "pytest-shadow-import",
    "query": {
      "literalText": "fix pytest shadow import",
      "causalText": "sys path precedence resolves local package"
    },
    "candidate": {
      "blockId": "observed-semantic-winner-id",
      "tokens": {
        "situation": ["pytest", "shadow", "import"],
        "mechanism": ["sys", "path", "precedence"],
        "unlock": ["remove", "shadow", "path"],
        "invariants": ["stable", "import"]
      },
      "signals": {
        "isPitfall": false,
        "helpful": 2,
        "harmful": 0,
        "unresolved": 0,
        "familySupport": 2,
        "sourceDiversity": 1
      }
    },
    "label": "applicable",
    "hardNegative": false
  }
]
```

### 3. Freeze an auditable organic registry

```bash
npx tracebase-ai semantic export-registry \
  --path . \
  --labels ./semantic-labels.json \
  --out ./semantic-organic-registry.json
```

The exporter rejects:

- labels without an observed local shadow event
- labels for a candidate other than the observed semantic winner
- duplicate/invalid registry rows
- any row rejected by the shared leakage scanner

It prints a dataset hash and a separate provenance hash for review.

## Integrated Runtime Smoke

```bash
npm run smoke:capabilities
```

The smoke creates one temporary workspace, installs the canonical Claude Code
hook graph, and drives the real hook helpers. It asserts:

- all five managed hooks are canonical before and after the turn
- reasoning reuse, file memory, and context compression compose in one payload
- loop detection surfaces a straight-loop badge
- tool supervision warns before a repeated safe read
- injected context contains no workspace absolute path

## Exit Gate to E.2.6

E.2.5 is complete when:

- local shadow reporting works against real `reasoning.semantic_comparison`
  events
- explicitly labeled organic exports are frozen and privacy-scanned
- the five-capability workspace smoke passes
- lint, build, and the relevant tests pass

E.2.6 may then focus on organic calibration evidence and deployment packaging.
It must not promote the semantic lane into serving without a separately reviewed
gate.
