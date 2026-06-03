# syntax=docker/dockerfile:1.7
#
# Customer-managed semantic sidecar image contract.
# Build context: repository root.
# This image is shadow-only: it warms the semantic SWR cache and emits telemetry;
# it does not promote semantic verdicts into served output.
ARG TRACEBASE_NODE_BASE=docker.io/library/node:22-bookworm-slim@sha256:32b9e321f262db540d55ac10dc529667cf4737546e097cdd36a843c62bcbf423
ARG TRACEBASE_PYTORCH_BASE=docker.io/pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime@sha256:77f17f843507062875ce8be2a6f76aa6aa3df7f9ef1e31d9d7432f4b0f563dee

FROM ${TRACEBASE_NODE_BASE} AS app-build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.check.json tsup.config.ts ./
COPY bin ./bin
COPY src ./src
COPY scripts/semantic-bakeoff/qwen-worker.py ./scripts/semantic-bakeoff/qwen-worker.py
RUN npm ci && npm run build

FROM ${TRACEBASE_PYTORCH_BASE} AS runtime
ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INDEX=1 \
    TRACEBASE_SEMANTIC_SIDECAR_BACKEND=qwen-local \
    TRACEBASE_SEMANTIC_SIDECAR_HOST=0.0.0.0 \
    TRACEBASE_SEMANTIC_SIDECAR_PORT=8787 \
    TRACEBASE_SEMANTIC_SIDECAR_QWEN_COMMAND=python \
    TRACEBASE_SEMANTIC_SIDECAR_QWEN_MODEL_DIR=/models/qwen3-reranker-0.6b \
    TRACEBASE_SEMANTIC_SIDECAR_QWEN_REVISION=e61197ed45024b0ed8a2d74b80b4d909f1255473 \
    TRACEBASE_SEMANTIC_SIDECAR_QWEN_WORKER_SCRIPT=/opt/tracebase/scripts/semantic-bakeoff/qwen-worker.py

WORKDIR /opt/tracebase
COPY --from=app-build /usr/local/bin/node /usr/local/bin/node
COPY --from=app-build /src/dist/semantic-sidecar.js /opt/tracebase/dist/semantic-sidecar.js
COPY --from=app-build /src/scripts/semantic-bakeoff/qwen-worker.py /opt/tracebase/scripts/semantic-bakeoff/qwen-worker.py
COPY deploy/semantic-sidecar/wheelhouse/ /opt/tracebase/wheelhouse/

# Production builds must prepare the wheelhouse with:
#   npm run semantic:sidecar:prepare-wheelhouse
# The image refuses to install Python dependencies from the network.
RUN test -f /opt/tracebase/wheelhouse/requirements.lock.txt \
 && python -m pip install --no-index --find-links=/opt/tracebase/wheelhouse --require-hashes -r /opt/tracebase/wheelhouse/requirements.lock.txt \
 && useradd --system --create-home --home-dir /home/tracebase --shell /usr/sbin/nologin tracebase \
 && mkdir -p /models/qwen3-reranker-0.6b \
 && chown -R tracebase:tracebase /opt/tracebase /models

USER tracebase
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD python - <<'PY'
import json, urllib.request
with urllib.request.urlopen("http://127.0.0.1:8787/v1/health", timeout=2) as r:
    body = json.load(r)
assert body == {"ok": True, "protocolVersion": 2}
PY

ENTRYPOINT ["node", "/opt/tracebase/dist/semantic-sidecar.js"]
