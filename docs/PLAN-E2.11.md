# PLAN E.2.11 - Semantic serving promotion design review

Status: planned. Do not implement serving promotion until this plan is
converted into code with tests and a real ready soak artifact is attached.

## Goal

Define the smallest safe architecture by which the semantic lane could later
influence served output.

E.2.10 proved the operational shadow path:

```text
init -> fake sidecar -> dogfood-preflight -> runtime shadow events -> soak-check
```

E.2.11 is not "turn semantic on". It is the promotion boundary review: where the
decision could happen, what evidence must exist, how rollback works, and how the
runtime proves semantic serving is impossible unless every gate is satisfied.

## Non-goals

- No default semantic serving.
- No hidden threshold or prompt tuning.
- No model download on normal install.
- No network call on the hot served path.
- No hosted GPU dependency for local-first users.
- No weakening of the shadow-only invariants from E.2.3-E.2.10.
- No customer-facing claim based only on fake-backend smoke.

## Required Evidence Before Any Promotion Work

Promotion work may be coded behind a hard-off flag, but it may not be enabled
for real output until all of the following exist:

1. `semantic dogfood-preflight` returns `ready-to-collect` in the target
   workspace.
2. A real sidecar/provider soak artifact from `semantic soak-check --out ...`
   returns `ready`.
3. The artifact uses pinned attestation and clean sidecar/client counters.
4. The artifact is privacy-safe and preserved in internal diagnostics.
5. The runtime smoke proves OFF vs shadow remains byte-identical.

The current `$0` E2E smoke is necessary plumbing evidence. It is not sufficient
promotion evidence because it uses the fake backend.

## Architecture Shape

### 1. Serving mode state machine

Introduce an explicit semantic serving mode with closed states:

```text
off -> shadow -> canary -> on
```

Initial implementation should support only:

- `off`
- `shadow`
- `canary-blocked`

`canary` and `on` must be rejected until a ready soak artifact verifier exists.
This prevents config typos or environment drift from silently enabling semantic
serving.

### 2. Promotion receipt

Define a privacy-safe promotion receipt, separate from the soak report:

```ts
interface SemanticPromotionReceipt {
  v: 1;
  createdAt: string;
  soakArtifactHash: string;
  attestationId: string;
  mode: "canary";
  scope: "local-dogfood" | "workspace";
  expiresAt: string;
  checks: Array<{ name: string; status: "pass" | "fail" }>;
}
```

The receipt must not contain prompts, candidate bodies, cache payloads, tokens,
absolute paths, or model inputs/outputs.

### 3. Runtime arbiter

Add a single runtime arbiter that decides whether semantic output is allowed to
affect serving. It should consume:

- configured semantic serving mode,
- doctor/preflight state,
- promotion receipt,
- breaker state,
- latest sidecar/client health counters.

The arbiter returns a typed decision:

```ts
type SemanticServingDecision =
  | { action: "shadow-only"; reason: string }
  | { action: "eligible-canary"; receiptHash: string; attestationId: string };
```

All runtime call sites must depend on this arbiter rather than reading env flags
directly.

### 4. Fail-open contract

If anything is missing, malformed, stale, slow, unauthorized, mismatched, or
privacy-blocked, the runtime must serve the deterministic baseline and emit a
diagnostic event. Semantic must not throw into user output.

### 5. Observability

Extend telemetry with separate labels for:

- `shadow_only`
- `eligible_canary`
- `served_by_semantic`
- `blocked_by_preflight`
- `blocked_by_receipt`
- `blocked_by_breaker`
- `blocked_by_health`
- `blocked_by_privacy`

Shadow and served semantics must never be conflated in reports.

## First Implementation Slice

This is the next code-agent task. Keep it small and reviewable.

1. Add the typed serving-mode parser.
   - Env/config accepts only `off`, `shadow`, `canary`.
   - `on` is deliberately not accepted yet.
   - Invalid values produce a doctor/preflight warning and fall back to shadow or
     off, never canary.

2. Add the promotion receipt DTO and validator.
   - Validate shape, expiry, attestation id, soak artifact hash, and privacy.
   - Do not wire it into serving yet.

3. Add the semantic serving arbiter as a pure module.
   - Inputs are plain objects.
   - Outputs are closed typed decisions.
   - Unit tests cover every block reason.

4. Add CLI doctor/preflight surfacing.
   - Report the configured serving mode.
   - Report why canary is blocked.
   - Keep existing `dogfood-preflight` start gate behavior stable.

5. Add a `$0` smoke for the blocked-canary path.
   - Fake sidecar may be used.
   - It must prove `canary` config without a valid receipt remains shadow-only.
   - It must prove `shadow` behavior remains byte-identical.

## Acceptance Criteria

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run smoke:semantic-dogfood`
- New focused tests for parser, receipt validator, arbiter, and CLI surfacing.
- No serving output changes.
- No semantic verdict changes user-visible content.
- No token/path/prompt leakage in new reports.

## Handoff Prompt For The Next Code Agent

Implement E.2.11 first slice only. Read `docs/PLAN-E2.11.md`,
`docs/PLAN-E2.10.md`, `src/experiments/semantic-bakeoff/semantic-shadow.ts`,
`src/analytics/semantic-shadow-soak.ts`, and
`scripts/semantic-bakeoff/semantic-dogfood-e2e-smoke.ts`.

Build the semantic serving-mode parser, promotion receipt DTO/validator, pure
serving arbiter, doctor/preflight surfacing, and a `$0` blocked-canary smoke.
Do not enable semantic serving. Do not accept `on`. Do not lower thresholds. Do
not add model downloads or hot-path network calls. Keep shadow byte-identical.
Run full verification and commit as one coherent E.2.11 slice.

## Next Gate

Only after this slice exists should E.2.12 consider a real promotion receipt
generator from a ready soak artifact. Even then, the first live mode is canary,
not on.
