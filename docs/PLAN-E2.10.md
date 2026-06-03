# PLAN E.2.10 - Semantic dogfood preflight

Status: implemented in this branch.

## Goal

Close the gap between the E.2.9 runbook and a real shadow-soak run.

Before an operator spends time collecting semantic shadow traffic, they need one
command that answers:

- is this project initialized?
- is the shadow endpoint configured?
- is the sidecar reachable and pinned?
- are sidecar counters clean enough to start a fresh soak window?
- what exact next action should I take?

This milestone still does **not** promote semantic verdicts into served output
and does **not** start a model or generate traffic.

## Delivered Scope

### 1. Operator preflight command

```bash
npx tracebase-ai semantic dogfood-preflight --path .
npx tracebase-ai semantic dogfood-preflight --path . --json
npx tracebase-ai semantic dogfood-preflight \
  --path . \
  --out bench-results/internal-diagnostics/semantic-dogfood-preflight.json
```

The command is intentionally safe before `tracebase init`: it reports
`project.initialized=false` instead of crashing. The output is a privacy-safe
artifact: no prompt text, cache payloads, model inputs/outputs, bearer tokens, or
absolute project paths.

### 2. Verdict

`ready-to-collect` means:

- project is initialized,
- shadow URL/token/attestation are configured,
- sidecar doctor returns `ready`,
- pinned attestation is enforced unless explicitly allowed for local dev,
- sidecar error/auth/leak/quota/timeout/overload counters are still clean.

`blocked` means: do not start collecting dogfood traffic yet. Follow
`nextActions` in the report.

### 3. Relationship to `soak-check`

`dogfood-preflight` is the **start gate**.

`soak-check` is the **end gate** after enough traffic has accumulated.

Preflight can be green while `soak-check` is still `not-ready` because no
traffic has been collected yet. That is expected.

## Boundaries

- No serving promotion.
- No hidden threshold tuning.
- No model startup side effects.
- No network except the explicit semantic doctor probe.
- No secrets in output; env is summarized as booleans.
- Failed preflight artifacts are useful and should be preserved.

## Verification

Run:

```bash
npx vitest run tests/cli/semantic.test.ts tests/analytics/semantic-shadow-soak.test.ts
npm run smoke:semantic-soak
npm run lint
```

## Next Gate

Run `semantic dogfood-preflight` in the real dogfood workspace. If it is
`ready-to-collect`, restart the long-lived MCP/SDK runtime with semantic shadow
env, collect local traffic, then freeze a `semantic soak-check --out` artifact.

Only a `ready` soak artifact justifies E.2.11: a separate semantic serving
promotion design review.
