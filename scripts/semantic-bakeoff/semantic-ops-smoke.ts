/**
 * $0 semantic operations smoke. Runs the deployable sidecar composition root
 * with the explicit fake backend, then verifies the real operator doctor path.
 */
import { probeSemanticShadow } from "../../src/experiments/semantic-bakeoff/service/doctor.js";
import {
  diagnoseSemanticSidecarConfig,
  startSemanticSidecar,
} from "../../src/experiments/semantic-bakeoff/service/sidecar.js";

const token = "semantic-smoke-token-123456";
async function main(): Promise<void> {
  const diagnosed = diagnoseSemanticSidecarConfig({
    TRACEBASE_SEMANTIC_SIDECAR_BACKEND: "fake",
    TRACEBASE_SEMANTIC_SIDECAR_ALLOW_FAKE: "1",
    TRACEBASE_SEMANTIC_SIDECAR_TOKEN: token,
    TRACEBASE_SEMANTIC_SIDECAR_TENANT: "smoke",
    TRACEBASE_SEMANTIC_SIDECAR_PORT: "0",
  });
  if (diagnosed.status !== "configured") throw new Error(diagnosed.reasons.join("; "));
  const sidecar = await startSemanticSidecar(diagnosed.config);
  try {
    const report = await probeSemanticShadow({
      TRACEBASE_SEMANTIC_SHADOW_URL: sidecar.url,
      TRACEBASE_SEMANTIC_SHADOW_TOKEN: token,
      TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: JSON.stringify({
        model: "fake",
        revision: "sidecar-fake-v1",
        backend: "fake",
        featureVersion: 1,
      }),
    });
    if (report.status !== "ready") throw new Error(`semantic doctor failed: ${JSON.stringify(report)}`);
    const tokenLeaked = JSON.stringify(report).includes(token);
    if (tokenLeaked) throw new Error("semantic doctor leaked its bearer token");
    console.log(JSON.stringify({
      smoke: "semantic-ops.v1",
      status: report.status,
      backend: sidecar.backend,
      attestationId: report.attestationId,
      tokenLeaked,
    }, null, 2));
  } finally {
    await sidecar.close();
  }
}

void main();
