# Semantic Sidecar Image Contract (E.2.7)

This directory contains the customer-managed semantic sidecar packaging
contract. It is for shadow-only cache warming and telemetry. It does not enable
semantic serving promotion.

## Supply Chain

- Node builder image is digest-pinned in `supply-chain.lock.json`.
- PyTorch/CUDA runtime image is digest-pinned in `supply-chain.lock.json`.
- Qwen weights are mounted at runtime and verified by the sidecar before the
  service listens.
- Python dependencies must be installed from an offline wheelhouse with hashes.
  The Dockerfile refuses network `pip install`.
- The generated wheelhouse is ignored by git but included in the Docker build
  context by `Dockerfile.dockerignore`; prepare it before building.

Prepare the wheelhouse:

```bash
npm run semantic:sidecar:prepare-wheelhouse
```

Verify the contract:

```bash
npm run semantic:sidecar:verify-supply-chain
```

Build the image from the repository root after the wheelhouse exists:

```bash
docker build \
  -f deploy/semantic-sidecar/Dockerfile \
  -t tracebase-semantic-sidecar:e2.7 \
  .
```

Run it with a mounted verified model directory:

```bash
docker run --gpus all --rm -p 8787:8787 \
  -e TRACEBASE_SEMANTIC_SIDECAR_TOKEN="$TRACEBASE_SEMANTIC_SHADOW_TOKEN" \
  -e TRACEBASE_SEMANTIC_SIDECAR_TENANT=acme \
  -v "$PWD/.models/qwen3-reranker-0.6b:/models/qwen3-reranker-0.6b:ro" \
  tracebase-semantic-sidecar:e2.7
```

Then, from the TraceBase runtime workspace:

```bash
npx tracebase-ai semantic doctor
```

## Boundaries

The image is intentionally not a hosted control-plane artifact. It is a separate
inference data plane. It receives only bounded, privacy-scanned rerank DTOs and
persists no prompt/candidate payload.
