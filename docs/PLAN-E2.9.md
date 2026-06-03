# PLAN E.2.9 - Semantic shadow-soak dogfood runbook

Status: implemented in this branch.

## Goal

Make the E.2.8 soak gate usable as a real operator workflow:

1. start the customer-managed semantic sidecar,
2. run TraceBase with the semantic lane enabled in shadow mode,
3. collect organic local dogfood traffic,
4. freeze a privacy-safe soak report JSON artifact,
5. decide whether the shadow lane is operationally boring enough for a later
   promotion-design review.

This milestone still does **not** promote semantic verdicts into served output.

## Delivered Scope

### 1. Soak artifact output

`tracebase semantic soak-check` now supports:

```bash
npx tracebase-ai semantic soak-check \
  --path . \
  --since 24h \
  --out bench-results/internal-diagnostics/semantic-soak-YYYY-MM-DD.json
```

The `--out` file is written atomically and contains the full
`SemanticShadowSoakReport`, even when the verdict is `not-ready`. A failed soak
is still evidence and should not be lost in terminal scrollback.

The report remains privacy-safe: it contains closed enums, counters, hashes,
attestation IDs, thresholds, and blocker strings. It does not contain prompt
text, candidate bodies, credentials, cache payloads, or model input/output.

### 2. Dogfood activation workflow

Start the sidecar in a terminal controlled by the operator:

```bash
set TRACEBASE_SEMANTIC_SIDECAR_BACKEND=qwen-local
set TRACEBASE_SEMANTIC_SIDECAR_HOST=127.0.0.1
set TRACEBASE_SEMANTIC_SIDECAR_PORT=8787
set TRACEBASE_SEMANTIC_SIDECAR_TOKEN=<strong local bearer token>
set TRACEBASE_SEMANTIC_SIDECAR_TENANT=local-dogfood
set TRACEBASE_SEMANTIC_SIDECAR_QWEN_MODEL_DIR=<verified model dir>
set TRACEBASE_SEMANTIC_SIDECAR_QWEN_REVISION=e61197ed45024b0ed8a2d74b80b4d909f1255473
npx tracebase-semantic-sidecar
```

Configure the long-lived TraceBase runtime process with the matching shadow
endpoint. The MCP/SDK root reads these variables once at boot, so restart the
agent runtime after setting them:

```bash
set TRACEBASE_SEMANTIC_SHADOW_URL=http://127.0.0.1:8787
set TRACEBASE_SEMANTIC_SHADOW_TOKEN=<same bearer token>
set TRACEBASE_SEMANTIC_SHADOW_ATTESTATION={"model":"Qwen/Qwen3-Reranker-0.6B","revision":"e61197ed45024b0ed8a2d74b80b4d909f1255473","backend":"qwen-local","featureVersion":1}
```

Do **not** commit these values. Do **not** place bearer tokens in shell history
on shared machines. Prefer a local operator-managed secret store for real
customer environments.

### 3. Soak loop

After restarting the agent runtime, use TraceBase normally until the traffic
floor is reached. The sidecar warms the local SWR cache asynchronously; serving
remains deterministic baseline.

Monitor during the run:

```bash
npx tracebase-ai semantic doctor
npx tracebase-ai semantic shadow-report --path . --since 24h
```

Freeze the gate artifact:

```bash
npx tracebase-ai semantic soak-check \
  --path . \
  --since 24h \
  --out bench-results/internal-diagnostics/semantic-soak-YYYY-MM-DD.json
```

Use `--json` only when a machine consumer needs stdout. The `--out` artifact is
the durable record.

## Halt Conditions

Stop the soak and preserve the report if any blocker appears:

- sidecar doctor is not `ready`
- unpinned attestation in a production-like run
- local attestation differs from the doctor attestation
- auth, leakage, malformed, quota, timeout, overload, or backend-error counter
  is non-zero
- client-side scanner or attestation rejection is non-zero
- warm queue does not drain
- cache warming does not complete
- p95 comparison or warm latency exceeds budget
- generated report fails privacy scan

Do not compensate by lowering thresholds during the same run. If a threshold is
wrong, write a new plan/pre-registration and rerun from a clean window.

## Interpretation

`ready` means: the shadow semantic lane is operationally stable enough to justify
a later serving-promotion design review.

`ready` does **not** mean:

- semantic verdicts are serving,
- customer output changed,
- a promotion is approved,
- labels/calibration are frozen,
- a hosted GPU control plane exists.

`not-ready` means: keep the lane shadow-only, fix the named blocker, then collect
a fresh soak window.

## Verification

Run:

```bash
npx vitest run tests/cli/semantic.test.ts tests/analytics/semantic-shadow-soak.test.ts
npm run smoke:semantic-soak
npm run lint
```

The smoke covers the artifact path indirectly through the same helper and keeps
the no-token-leak invariant alive.

## Next Gate

E.2.10 should only start after a real dogfood artifact is `ready`. Its scope
would be a separate serving-promotion design review: canary shape, rollback
contract, user-visible risk budget, and exact evidence needed before any
non-shadow semantic decision influences output.
