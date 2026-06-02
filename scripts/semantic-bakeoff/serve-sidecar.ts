/**
 * Run the customer-managed semantic sidecar.
 *
 * Example:
 *   TRACEBASE_SEMANTIC_SIDECAR_BACKEND=qwen-local \
 *   TRACEBASE_SEMANTIC_SIDECAR_TOKEN=... \
 *   TRACEBASE_SEMANTIC_SIDECAR_TENANT=acme \
 *   TRACEBASE_SEMANTIC_SIDECAR_QWEN_MODEL_DIR=.models/qwen3-reranker-0.6b \
 *   npx tsx scripts/semantic-bakeoff/serve-sidecar.ts
 */
import {
  diagnoseSemanticSidecarConfig,
  startSemanticSidecar,
} from "../../src/experiments/semantic-bakeoff/service/sidecar.js";

async function main(): Promise<void> {
  const diagnosed = diagnoseSemanticSidecarConfig();
  if (diagnosed.status !== "configured") {
    console.error("semantic sidecar configuration invalid:");
    for (const reason of diagnosed.reasons) console.error(`  - ${reason}`);
    process.exitCode = 1;
    return;
  }

  const sidecar = await startSemanticSidecar(diagnosed.config);
  console.log(`semantic sidecar ready: ${sidecar.url} backend=${sidecar.backend} tenant=${sidecar.tenant}`);

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await sidecar.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void close().finally(() => process.exit(0)));
  }
}

void main();
