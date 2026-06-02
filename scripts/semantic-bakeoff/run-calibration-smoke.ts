/**
 * $0 calibration plumbing smoke. Uses a frozen fixture registry and deterministic
 * scorer to exercise the SAME auditable runner/validator as a future organic run.
 * It can only HOLD: fixture-smoke registries are structurally non-promotable.
 *
 * Run: npx tsx scripts/semantic-bakeoff/run-calibration-smoke.ts
 */
import { evaluatePromotion, validateCalibrationManifest } from "../../src/experiments/semantic-bakeoff/calibration/manifest.js";
import { runOfflineCalibration } from "../../src/experiments/semantic-bakeoff/calibration/runner.js";
import type { CalibrationDatasetRegistry, CalibrationDatasetRow } from "../../src/experiments/semantic-bakeoff/calibration/registry.js";

const candidate = (id: string) => ({
  blockId: id,
  tokens: { situation: ["balance"], mechanism: ["rounding"], unlock: ["kahan"], invariants: [] },
  signals: { isPitfall: false, helpful: 1, harmful: 0, unresolved: 0, familySupport: 1, sourceDiversity: 1 },
});
const row = (rowId: string, familyKey: string, label: "applicable" | "inapplicable", hardNegative = false): CalibrationDatasetRow => ({
  rowId,
  familyKey,
  query: { literalText: `fixture query ${rowId}` },
  candidate: candidate(`fixture-block-${rowId}`),
  label,
  hardNegative,
  provenance: { sourceType: "fixture", sourceRef: `fixture:${rowId}` },
});
const registry: CalibrationDatasetRegistry = {
  datasetVersion: 1,
  kind: "fixture-smoke",
  frozenAt: "2026-06-02T00:00:00.000Z",
  rows: Array.from({ length: 8 }, (_, f) => [
    row(`f${f}-positive`, `family-${f}`, "applicable"),
    ...Array.from({ length: 10 }, (_x, i) => row(`f${f}-hard-${i}`, `family-${f}`, "inapplicable", true)),
  ]).flat().concat(
    Array.from({ length: 4 }, (_x, i) => ({
      ...row(`adversarial-${i}`, `adversarial-${i}`, "inapplicable", true),
      adversarialFixture: true,
    })),
  ),
};

async function main(): Promise<void> {
  const manifest = await runOfflineCalibration({
    registry,
    preregText: "E.2.4 fixture-smoke: plumbing only; never promotable",
    model: { model: "fixture-scorer", revision: "v1", backend: "fixture", featureVersion: 1 },
    gate: { minWilsonLbPrecision: 0.9, maxHarmfulApplyRate: 0.05, minCacheHitRate: 0.6, maxWarmLatencyP95Ms: 5000, minValidationN: 20 },
    gitSha: "fixture-smoke",
    splitSeed: 42,
    thresholdCandidates: [0.4, 0.6, 0.8],
    minTrainPrecision: 0.9,
    scorer: async (r) => ({
      verdict: r.label,
      confidence: r.label === "applicable" ? 0.95 : 0.1,
      latencyMs: 1,
      cacheState: "fresh",
      warmCompleted: true,
      warmLatencyMs: 2,
    }),
  });
  const validation = validateCalibrationManifest(manifest);
  const decision = evaluatePromotion(manifest);
  console.log(JSON.stringify({
    smoke: "semantic-calibration-audit.v1",
    valid: validation.ok,
    datasetHash: manifest.datasetHash,
    provenanceHash: manifest.provenanceHash,
    splitHash: manifest.split.splitHash,
    rows: manifest.registry.rows.length,
    validation: manifest.metrics?.validation,
    cache: manifest.metrics?.cache,
    adversarialRegression: manifest.metrics?.adversarialRegression,
    decision,
  }, null, 2));
  if (!validation.ok || decision.decision !== "hold") process.exitCode = 1;
}

void main();
