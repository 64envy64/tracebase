# E.2.6 - Semantic Shadow Deployment Contract and Organic Evidence Operations

## Goal

Turn the semantic applicability R&D substrate into an operator-usable,
customer-managed **shadow-only** sidecar workflow without promoting semantic
verdicts into served output.

The deterministic runtime remains authoritative. The sidecar warms a local SWR
cache asynchronously and emits privacy-safe comparison telemetry. A cold,
unreachable, slow, malformed, mismatched, or absent sidecar still produces the
same served bytes as the deterministic baseline.

## Delivered Scope

### 1. Customer-managed sidecar composition root

`scripts/semantic-bakeoff/serve-sidecar.ts` starts the existing HTTP data-plane
service using strict environment config:

- a single-tenant bearer authenticator that stores only a SHA-256 digest and
  compares fixed-size digests in constant time
- explicit loopback or wildcard bind address
- bounded per-tenant quota
- `qwen-local` as the deployable backend
- `fake` only with an explicit test flag for zero-cost smoke coverage
- pinned Qwen revision and startup SHA-256 verification of `model.safetensors`
- eager worker handshake before the service listens
- graceful `SIGINT` / `SIGTERM` shutdown

This is the runtime contract for a future container image. Publishing a CUDA
image remains a separate supply-chain boundary: the base image, Python package
lock, model mount, GPU runtime, and registry provenance must be pinned and
reviewed rather than guessed in this milestone.

### 2. Explicit endpoint doctor

```bash
npx tracebase-ai semantic doctor
npx tracebase-ai semantic doctor --json
```

The doctor runs only when the operator asks. It checks:

- public protocol-compatible liveness
- authenticated admin health
- strict response shape
- pinned attestation equality

The report contains endpoint, telemetry counters, in-flight count, and a
privacy-safe attestation hash. It never prints or returns the bearer token.

### 3. Privacy-safe observation skeleton export

```bash
npx tracebase-ai semantic export-observations \
  --path . \
  --since 7d \
  --out ./semantic-observations.json
```

The export is an operator labeling queue, not a calibration registry and not an
inferred label. It includes only query IDs/hashes, timestamps, closed enums,
bounded numerics, opaque winner IDs, provider metadata, and attestation hashes.
It excludes prompt text, query text, candidate tokens, bodies, file paths,
credentials, and cache content.

Operators review the skeletons, curate bounded DTO labels separately, then use
the E.2.5 `semantic export-registry` command to freeze the privacy-scanned,
content-addressed organic registry.

## Boundaries

- Shadow-only: no sidecar or CLI code path can promote semantic verdicts.
- Local-first: cache, events, observation skeletons, and registries stay local
  unless the operator deliberately moves a file.
- Two-plane separation: the semantic inference endpoint is not the Next.js
  usage-sync control plane.
- No mandatory client model download: hosted mode remains the intended default
  opt-in; the sidecar is for customer-managed enterprise deployment and local
  R&D.
- No fake production packaging: CUDA container publication remains blocked on a
  separately reviewed pinned image and dependency lock.

## Verification

```bash
npm run lint
npm run build
npm test
npm run smoke:semantic-ops
npm run smoke:capabilities
```

## Exit Gate

E.2.6 is complete when the sidecar process, doctor, observation export, strict
decoders, supply-chain refusal paths, and shadow-only capability smoke are green.

The next milestone may package a reviewed GPU container and run an organic
shadow soak. It still must not promote semantic verdicts without a separately
reviewed calibration and canary gate.
