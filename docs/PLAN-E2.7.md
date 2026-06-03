# PLAN E.2.7 - Semantic sidecar supply-chain packaging

Status: implemented in this branch.

## Goal

Turn the shadow-only Qwen semantic sidecar from a repo-script prototype into a
verifiable, customer-managed runtime artifact.

This milestone does not promote semantic serving. The sidecar remains an
out-of-process data plane for stale-while-revalidate cache warming and telemetry.

## Senior-Level Contract

- Container bases are digest-pinned, not tag-pinned.
- Python dependencies are installed only from a generated offline wheelhouse with
  hash-locked requirements.
- The Qwen model revision and weight hash remain the single source of truth from
  the R&D supply-chain manifest.
- The sidecar has a packaged Node entrypoint:
  `tracebase-semantic-sidecar -> dist/semantic-sidecar.js`.
- The packaged entrypoint does not depend on `tsx` or source-tree layout.
- The runtime runs as a non-root user.
- Public health remains liveness-only: no tenant, model, queue, or telemetry
  detail leaks through `/v1/health`.
- Semantic serving promotion remains disabled by contract.

## Files

- `deploy/semantic-sidecar/Dockerfile`
- `deploy/semantic-sidecar/Dockerfile.dockerignore`
- `deploy/semantic-sidecar/supply-chain.lock.json`
- `deploy/semantic-sidecar/python-requirements.in`
- `deploy/semantic-sidecar/README.md`
- `bin/semantic-sidecar.ts`
- `src/experiments/semantic-bakeoff/service/sidecar-cli.ts`
- `src/experiments/semantic-bakeoff/service/supply-chain.ts`
- `scripts/semantic-bakeoff/prepare-sidecar-wheelhouse.ts`
- `scripts/semantic-bakeoff/verify-sidecar-supply-chain.ts`

## Verification

Run:

```bash
npm run semantic:sidecar:verify-supply-chain
npx vitest run tests/experiments/semantic-sidecar-supply-chain.test.ts tests/experiments/semantic-sidecar-ops.test.ts
npm run build
npm run lint
```

The verifier is intentionally part of the product tree, not a one-off note. A
future base-image, wheelhouse, healthcheck, package-bin, Qwen revision, or
runtime-policy drift should fail the contract before release.

## Non-Goals

- No hosted GPU control-plane deployment.
- No semantic serving promotion.
- No remote-code model loading.
- No network `pip install` inside the runtime image.
- No committed wheels or model weights.

## Next Gate

E.2.8 should be an organic shadow-soak gate: run the sidecar in shadow mode long
enough to measure cache warming, attestation drift, latency, error budget, and
zero-payload-leak telemetry under real local dogfood traffic. Promotion remains
out of scope until the shadow soak produces a stable evidence trail.
