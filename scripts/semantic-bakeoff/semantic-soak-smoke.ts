/**
 * $0 semantic soak smoke. Starts the deployable sidecar composition root with
 * the explicit fake backend, writes privacy-safe local shadow telemetry, then
 * runs the same soak gate the operator uses from `tracebase semantic soak-check`.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSemanticShadowSoakCheck } from "../../src/cli/commands/semantic.js";
import { BlockStore } from "../../src/core/block-store.js";
import { initConfig } from "../../src/core/config.js";
import { startSemanticSidecar, diagnoseSemanticSidecarConfig } from "../../src/experiments/semantic-bakeoff/service/sidecar.js";
import { attestationHash, type ModelAttestation } from "../../src/experiments/semantic-bakeoff/service/protocol.js";
import type { ReasoningSemanticComparisonEvent } from "../../src/types.js";

const token = "semantic-soak-smoke-token-123456";
const attestation: ModelAttestation = {
  model: "fake",
  revision: "sidecar-fake-v1",
  backend: "fake",
  featureVersion: 1,
};

function event(overrides: Partial<ReasoningSemanticComparisonEvent> = {}): ReasoningSemanticComparisonEvent {
  return {
    event: "reasoning.semantic_comparison",
    ts: Date.now(),
    queryId: "soak-smoke-q1",
    queryHash: "soak-smoke-h1",
    corpusSize: 8,
    candidateCount: 3,
    v4Action: "abstain",
    semanticProvider: "http",
    semanticFeatureVersion: 1,
    semanticAttestationId: attestationHash(attestation),
    semanticVerdict: "applicable",
    semanticTopBlockId: "soak-smoke-block",
    semanticConfidence: 0.9,
    changedDecision: "reranker_only_apply",
    verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 2 },
    fallback: "none",
    latencyMs: 5,
    semanticHealth: {
      servedCalls: 2,
      cacheFresh: 1,
      cacheStale: 0,
      cacheMiss: 1,
      warmsScheduled: 1,
      warmsCompleted: 1,
      warmErrors: 0,
      warmAborted: 0,
      warmingSuppressed: 0,
      warmLatencyP95Ms: 15,
      scannerBlocked: 0,
      attestationRejected: 0,
    },
    warmQueue: {
      active: 0,
      pending: 0,
      dropped: 0,
      coalesced: 0,
      scheduled: 1,
      cancelled: 0,
      accepting: true,
    },
    ...overrides,
  };
}

async function main(): Promise<void> {
  const projectDir = mkdtempSync(join(tmpdir(), "tb-semantic-soak-smoke-"));
  const diagnosed = diagnoseSemanticSidecarConfig({
    TRACEBASE_SEMANTIC_SIDECAR_BACKEND: "fake",
    TRACEBASE_SEMANTIC_SIDECAR_ALLOW_FAKE: "1",
    TRACEBASE_SEMANTIC_SIDECAR_TOKEN: token,
    TRACEBASE_SEMANTIC_SIDECAR_TENANT: "soak-smoke",
    TRACEBASE_SEMANTIC_SIDECAR_PORT: "0",
  });
  if (diagnosed.status !== "configured") throw new Error(diagnosed.reasons.join("; "));
  const sidecar = await startSemanticSidecar(diagnosed.config);
  try {
    const cfg = initConfig(projectDir);
    const store = new BlockStore(new Database(cfg.storagePath));
    store.appendEvent(event());
    store.appendEvent(event({ ts: Date.now() + 1, queryId: "soak-smoke-q2", queryHash: "soak-smoke-h2", v4Action: "inject", semanticVerdict: "inapplicable", changedDecision: "none" }));
    store.close();

    const report = await runSemanticShadowSoakCheck({
      path: projectDir,
      env: {
        TRACEBASE_SEMANTIC_SHADOW_URL: sidecar.url,
        TRACEBASE_SEMANTIC_SHADOW_TOKEN: token,
        TRACEBASE_SEMANTIC_SHADOW_ATTESTATION: JSON.stringify(attestation),
      },
      thresholds: {
        minTraffic: 2,
        minV4Abstain: 1,
        minSemanticResidualRecovery: 1,
        minWarmCompletions: 1,
        maxLatencyP95Ms: 20,
        maxWarmLatencyP95Ms: 50,
      },
    });
    if (report.verdict !== "ready") throw new Error(`semantic soak smoke failed: ${JSON.stringify(report.blockers)}`);
    const tokenLeaked = JSON.stringify(report).includes(token);
    if (tokenLeaked) throw new Error("semantic soak report leaked its bearer token");
    console.log(JSON.stringify({
      smoke: "semantic-soak.v1",
      verdict: report.verdict,
      traffic: report.shadow.traffic,
      blockers: report.blockers,
      tokenLeaked,
    }, null, 2));
  } finally {
    await sidecar.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
}

void main();
