# PLAN E.2.8 - Semantic shadow-soak readiness gate

Status: implemented in this branch.

## Goal

Add an operator-grade go/no-go gate for the semantic sidecar while it remains
strictly shadow-only.

E.2.8 does not promote semantic verdicts into served output. It answers a
different question: has the sidecar been dogfooded long enough, cleanly enough,
and with stable enough telemetry that a future serving-promotion design would be
worth reviewing?

## Delivered Scope

### 1. Unified soak decision layer

`src/analytics/semantic-shadow-soak.ts` combines:

- explicit endpoint doctor status
- pinned sidecar attestation
- sidecar admin telemetry counters
- local `reasoning.semantic_comparison` aggregation
- cache-warm health snapshots
- warm-queue state
- client-side scanner and attestation counters
- p95 shadow latency
- a final privacy scan over the report object

The output is a typed `SemanticShadowSoakReport` with a deterministic verdict:
`ready` or `not-ready`. Every failing check carries a blocker string.

### 2. Operator CLI

```bash
npx tracebase-ai semantic soak-check --path . --since 7d
npx tracebase-ai semantic soak-check --path . --since 7d --json
```

The command exits non-zero on `not-ready`, so it can run in CI, cron, or an
operator runbook. It never starts a sidecar, warms a cache, writes a registry, or
changes serving behavior.

Useful local overrides:

```bash
npx tracebase-ai semantic soak-check \
  --path . \
  --since 24h \
  --min-traffic 100 \
  --min-v4-abstain 20 \
  --min-residual-recovery 1 \
  --min-warm-completions 1 \
  --max-latency-p95-ms 50
```

`--allow-unpinned-dev-mode` exists only for local development. Production-like
soaks should leave it unset.

### 3. Zero-cost smoke

```bash
npm run smoke:semantic-soak
```

The smoke starts the deployable sidecar composition root with the explicit fake
backend, writes privacy-safe local shadow telemetry into a temporary TraceBase
project, runs the real soak helper, requires `ready`, and verifies the bearer
token is absent from the report.

## Default Readiness Contract

The default gate is conservative:

- sidecar doctor must be `ready`
- sidecar must use pinned attestation
- exactly one attestation must appear in local shadow telemetry
- local attestation must match the doctor attestation
- traffic floor: at least 100 semantic comparison events
- residual coverage: at least 20 V4-abstain observations
- recovery signal: at least 1 semantic-applicable residual
- cache warming must complete at least once
- warm queue must be drained at sample time
- comparison p95 latency must be <= 50 ms
- warm p95 latency must be <= 2000 ms
- provider fallbacks, client scanner blocks, attestation rejects, warm errors,
  warm aborts, warming suppression, sidecar auth rejects, leakage rejects,
  malformed requests, quota rejects, timeouts, overloads, and backend errors
  must all be zero
- generated report must pass the local leakage scanner
- serving promotion must remain false

These are operator thresholds, not benchmark-fit knobs. A failed soak is useful:
it tells the operator which part of the shadow lane is not yet operationally
boring.

## Boundaries

- Shadow-only: this milestone cannot change injected output.
- Local-first: the report reads local events plus the operator-configured
  sidecar health endpoint; it exports no payloads.
- No model download: the smoke uses the explicit fake backend; Qwen deployment
  remains the E.2.7 customer-managed sidecar artifact.
- No registry freeze: labeling and calibration registry export remain separate
  E.2.5/E.2.6 operations.
- No serving promotion: a future promotion gate needs a separate review after
  soak evidence is stable.

## Verification

Run:

```bash
npx vitest run tests/analytics/semantic-shadow-soak.test.ts tests/cli/semantic.test.ts
npm run smoke:semantic-soak
npm run lint
```

For release confidence, also keep the E.2.7 checks green:

```bash
npm run semantic:sidecar:verify-supply-chain
npm run smoke:semantic-ops
```

## Next Gate

E.2.9 should be a shadow-soak dogfood runbook:

1. enable the semantic sidecar in a local dogfood workspace,
2. collect at least the default traffic floor,
3. run `semantic soak-check --since <window>`,
4. preserve the JSON report as an internal artifact,
5. only then decide whether a serving-promotion design review is justified.

Promotion remains out of scope until this soak gate is boringly green.
