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
import { runSemanticSidecarCli } from "../../src/experiments/semantic-bakeoff/service/sidecar-cli.js";

void runSemanticSidecarCli();
