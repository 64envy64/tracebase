import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockStore } from "../../src/core/block-store.js";
import { initConfig, loadConfig } from "../../src/core/config.js";
import {
  runSemanticDogfoodPreflight,
  runSemanticObservationExport,
  runSemanticRegistryExport,
  runSemanticShadowSoakExport,
  runSemanticShadowSoakCheck,
  runSemanticShadowReport,
} from "../../src/cli/commands/semantic.js";
import type { ReasoningSemanticComparisonEvent } from "../../src/types.js";

let projectDir: string;

const observed: ReasoningSemanticComparisonEvent = {
  event: "reasoning.semantic_comparison",
  ts: 42,
  queryId: "semantic-cli-q1",
  queryHash: "semantic-cli-hash",
  corpusSize: 8,
  candidateCount: 2,
  v4Action: "abstain",
  semanticProvider: "http",
  semanticFeatureVersion: 1,
  semanticVerdict: "applicable",
  semanticTopBlockId: "semantic-cli-block",
  semanticConfidence: 0.9,
  changedDecision: "reranker_only_apply",
  verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 1 },
  fallback: "none",
  latencyMs: 3,
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tb-semantic-cli-"));
  const cfg = initConfig(projectDir);
  const store = new BlockStore(new Database(cfg.storagePath));
  store.appendEvent(observed);
  store.close();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("semantic operator CLI helpers", () => {
  it("aggregates local semantic shadow events", () => {
    const report = runSemanticShadowReport({ path: projectDir });
    expect(report.traffic).toBe(1);
    expect(report.residual.recoveryRate).toBe(1);
    expect(report.providers).toEqual(["http"]);
  });

  it("preflights dogfood collection before init and writes a privacy-safe blocker artifact", async () => {
    const uninitializedDir = mkdtempSync(join(tmpdir(), "tb-semantic-preflight-"));
    try {
      const outPath = join(uninitializedDir, "out", "preflight.json");
      const report = await runSemanticDogfoodPreflight({
        path: uninitializedDir,
        env: { TRACEBASE_SEMANTIC_SHADOW_TOKEN: "not-a-secret-in-report-123456" },
        outPath,
      });

      expect(report.verdict).toBe("blocked");
      expect(report.project).toEqual({ initialized: false, storageExists: false });
      expect(report.env).toEqual({
        shadowUrlSet: false,
        shadowTokenSet: true,
        shadowAttestationSet: false,
        allowUnpinnedDevMode: false,
      });
      expect(report.blockers).toContain("project is not initialized");
      expect(report.blockers).toContain("TRACEBASE_SEMANTIC_SHADOW_URL is not set");
      expect(report.blockers).toContain("TRACEBASE_SEMANTIC_SHADOW_ATTESTATION is not set");
      expect(report.blockers).toContain("semantic sidecar doctor is invalid");
      expect(report.nextActions.length).toBeGreaterThan(0);
      expect(report.privacyTelemetrySafe).toBe(true);

      const raw = readFileSync(outPath, "utf8");
      expect(raw).not.toContain(uninitializedDir);
      expect(raw).not.toContain("not-a-secret-in-report");
      expect(JSON.parse(raw)).toEqual(report);
    } finally {
      rmSync(uninitializedDir, { recursive: true, force: true });
    }
  });

  it("combines doctor status and local events into a conservative soak verdict", async () => {
    const report = await runSemanticShadowSoakCheck({
      path: projectDir,
      env: {},
      thresholds: { minTraffic: 1, minV4Abstain: 1, minWarmCompletions: 0 },
    });
    expect(report.verdict).toBe("not-ready");
    expect(report.doctor.status).toBe("off");
    expect(report.shadow.traffic).toBe(1);
    expect(report.shadowOnly).toBe(true);
    expect(report.servingPromoted).toBe(false);
    expect(JSON.stringify(report)).not.toContain("literalText");
    expect(JSON.stringify(report)).not.toContain("credential");
  });

  it("writes a privacy-safe soak artifact even when the gate is not ready", async () => {
    const outPath = join(projectDir, "out", "semantic-soak.json");
    const report = await runSemanticShadowSoakExport({
      path: projectDir,
      env: {},
      outPath,
      thresholds: { minTraffic: 1, minV4Abstain: 1, minWarmCompletions: 0 },
    });

    const saved = JSON.parse(readFileSync(outPath, "utf8")) as typeof report;
    expect(saved.verdict).toBe("not-ready");
    expect(saved.doctor.status).toBe("off");
    expect(saved.shadowOnly).toBe(true);
    expect(saved.servingPromoted).toBe(false);
    expect(saved.blockers).toEqual(report.blockers);
    const raw = readFileSync(outPath, "utf8");
    expect(raw).not.toContain("literalText");
    expect(raw).not.toContain("candidate");
    expect(raw).not.toContain("credential");
  });

  it("exports privacy-safe observation skeletons without payload content", () => {
    const outPath = join(projectDir, "out", "observations.json");
    const observations = runSemanticObservationExport({ path: projectDir, outPath });
    expect(observations).toEqual([
      {
        queryId: "semantic-cli-q1",
        queryHash: "semantic-cli-hash",
        observedAt: 42,
        v4Action: "abstain",
        semanticProvider: "http",
        semanticFeatureVersion: 1,
        semanticVerdict: "applicable",
        semanticTopBlockId: "semantic-cli-block",
        semanticConfidence: 0.9,
        changedDecision: "reranker_only_apply",
        fallback: "none",
      },
    ]);
    const exported = readFileSync(outPath, "utf8");
    expect(exported).not.toContain("literalText");
    expect(exported).not.toContain("candidate");
    expect(exported).not.toContain("tokens");
    expect(exported).not.toContain("credential");
  });

  it("fails closed when an event contains a path-like winner id", () => {
    const cfg = loadConfig(projectDir);
    const store = new BlockStore(new Database(cfg.storagePath));
    store.appendEvent({
      ...observed,
      queryId: "semantic-cli-q2",
      semanticTopBlockId: "/home/alice/private-block",
    });
    store.close();
    const outPath = join(projectDir, "out", "unsafe-observations.json");
    expect(() => runSemanticObservationExport({ path: projectDir, outPath })).toThrow(
      "unsafe semantic observation identifier: semanticTopBlockId",
    );
    expect(() => readFileSync(outPath, "utf8")).toThrow();
  });

  it("freezes an explicitly labeled observed winner to an auditable registry", () => {
    const labelsPath = join(projectDir, "labels.json");
    const outPath = join(projectDir, "out", "registry.json");
    writeFileSync(
      labelsPath,
      JSON.stringify([
        {
          rowId: "semantic-cli-row",
          queryId: "semantic-cli-q1",
          familyKey: "pytest-shadow",
          query: { literalText: "fix pytest shadow import", causalText: "sys path precedence" },
          candidate: {
            blockId: "semantic-cli-block",
            tokens: {
              situation: ["pytest", "shadow"],
              mechanism: ["sys", "path", "precedence"],
              unlock: ["remove", "shadow", "path"],
              invariants: ["stable", "import"],
            },
            signals: {
              isPitfall: false,
              helpful: 1,
              harmful: 0,
              unresolved: 0,
              familySupport: 2,
              sourceDiversity: 1,
            },
          },
          label: "applicable",
          hardNegative: false,
        },
      ]),
      "utf8",
    );
    const frozen = runSemanticRegistryExport({
      path: projectDir,
      labelsPath,
      outPath,
      frozenAt: "2026-06-02T00:00:00.000Z",
    });

    expect(frozen.registry.rows).toHaveLength(1);
    expect(frozen.datasetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(frozen.registry);
    runSemanticRegistryExport({
      path: projectDir,
      labelsPath,
      outPath,
      frozenAt: "2026-06-02T00:00:00.000Z",
    });
    expect(readdirSync(join(projectDir, "out"))).toEqual(["registry.json"]);
  });

  it("rejects malformed label JSON before writing an output file", () => {
    const labelsPath = join(projectDir, "labels.json");
    const outPath = join(projectDir, "out", "registry.json");
    writeFileSync(labelsPath, JSON.stringify([{ rowId: "row", queryId: "semantic-cli-q1", candidate: { blockId: "semantic-cli-block" } }]), "utf8");
    expect(() => runSemanticRegistryExport({ path: projectDir, labelsPath, outPath })).toThrow(
      "label row query must be an object",
    );
    expect(() => readFileSync(outPath, "utf8")).toThrow();
  });
});
