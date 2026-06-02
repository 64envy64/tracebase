import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockStore } from "../../src/core/block-store.js";
import { initConfig, loadConfig } from "../../src/core/config.js";
import {
  runSemanticObservationExport,
  runSemanticRegistryExport,
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
