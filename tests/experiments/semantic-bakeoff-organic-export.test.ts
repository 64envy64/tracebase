import { describe, expect, it } from "vitest";
import { freezeOrganicCalibrationRegistry } from "../../src/experiments/semantic-bakeoff/calibration/organic-export.js";
import type { SemanticOrganicLabel } from "../../src/experiments/semantic-bakeoff/calibration/organic-export.js";
import type { ReasoningSemanticComparisonEvent } from "../../src/types.js";

const observed: ReasoningSemanticComparisonEvent = {
  event: "reasoning.semantic_comparison",
  ts: 42,
  queryId: "q1",
  queryHash: "privacy-safe-hash",
  corpusSize: 10,
  candidateCount: 3,
  v4Action: "abstain",
  semanticProvider: "http",
  semanticFeatureVersion: 1,
  semanticVerdict: "applicable",
  semanticTopBlockId: "b1",
  semanticConfidence: 0.88,
  changedDecision: "reranker_only_apply",
  verdictCounts: { applicable: 1, uncertain: 0, inapplicable: 2 },
  fallback: "none",
  latencyMs: 4,
};

function label(overrides: Partial<SemanticOrganicLabel> = {}): SemanticOrganicLabel {
  return {
    rowId: "row-1",
    queryId: "q1",
    familyKey: "pytest-shadow-import",
    query: {
      literalText: "fix pytest shadow import ImportError",
      causalText: "python tests resolve a local shadow package",
    },
    candidate: {
      blockId: "b1",
      tokens: {
        situation: ["pytest", "imports", "local", "shadow", "package"],
        mechanism: ["sys", "path", "precedence", "wrong", "module"],
        unlock: ["remove", "shadow", "path", "before", "collection"],
        invariants: ["import", "target", "stable"],
      },
      signals: {
        isPitfall: false,
        helpful: 2,
        harmful: 0,
        unresolved: 0,
        familySupport: 2,
        sourceDiversity: 1,
      },
    },
    label: "applicable",
    hardNegative: false,
    ...overrides,
  };
}

describe("freezeOrganicCalibrationRegistry", () => {
  it("freezes explicit labels only when they match an observed semantic winner", () => {
    const frozen = freezeOrganicCalibrationRegistry([observed], [label()], {
      frozenAt: "2026-06-02T00:00:00.000Z",
    });
    expect(frozen.registry.kind).toBe("organic-calibration");
    expect(frozen.registry.rows).toHaveLength(1);
    expect(frozen.registry.rows[0]?.provenance).toEqual({
      sourceType: "runtime",
      sourceRef: "semantic:privacy-safe-hash:b1",
      capturedAt: 42,
    });
    expect(frozen.datasetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen.provenanceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects labels without a matching observed semantic shadow event", () => {
    expect(() => freezeOrganicCalibrationRegistry([], [label()])).toThrow(
      "has no observed semantic shadow event",
    );
  });

  it("rejects labels for a different candidate than the observed winner", () => {
    expect(() =>
      freezeOrganicCalibrationRegistry([observed], [label({ candidate: { ...label().candidate, blockId: "b2" } })]),
    ).toThrow("does not match observed semantic winner");
  });

  it("rejects curated rows that fail the shared privacy scanner", () => {
    expect(() =>
      freezeOrganicCalibrationRegistry(
        [observed],
        [label({ query: { ...label().query, literalText: "token sk-ant-api03-secret-value" } })],
      ),
    ).toThrow("organic calibration export rejected");
  });
});
