/**
 * Phase 5 evaluator mechanics + honest-gate test.
 *
 * Validates the metric machinery on a small AUTHORED corpus and proves the
 * readiness gate correctly FAILS it (too few organic queries) — the evaluator
 * never lets a bootstrap set masquerade as organic readiness.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { ingestPattern, type ReasoningPatternDTO } from "../../src/ingest/pattern-dto.js";
import { evaluatePrecision, type LabeledQuery } from "../../src/eval/precision-evaluator.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}
function dto(situation: string, sourceType: "runtime" | "import"): ReasoningPatternDTO {
  return {
    schemaVersion: 1,
    pattern: {
      situation,
      mechanism: `the ${situation} stems from an ordering assumption that does not hold at runtime`,
      deadEnds: [],
      unlock: "reorder the operations so the invariant holds before first use",
      verification: "the previously failing case now passes deterministically",
    },
    provenance: { sourceType, capturedAt: 1, captureVersion: "v1" },
  };
}

describe("evaluatePrecision", () => {
  it("computes metrics and the gate FAILS a tiny bootstrap corpus", () => {
    const store = makeStore();
    const a = ingestPattern(store, dto("metaclass registration conflict in abstract base class", "runtime")).blockId!;
    const b = ingestPattern(store, dto("pandas groupby apply drops the index name on empty frames", "import")).blockId!;
    const server = new BlockServer(store);

    const blocks = [
      { id: a, sourceType: "runtime" as const },
      { id: b, sourceType: "import" as const },
    ];
    const queries: LabeledQuery[] = [
      { text: "metaclass registration conflict abstract base class", label: "useful", expectBlockId: a, provenanceClass: "organic" },
      { text: "pandas groupby apply drops index name empty frames", label: "useful", expectBlockId: b, provenanceClass: "bootstrap" },
      { text: "color related thoughts from the wider team today", label: "weak", provenanceClass: "organic" },
      { text: "fix the function value handling in the config code", label: "generic", provenanceClass: "organic" },
      { text: "how do I center a div in css flexbox layout", label: "unrelated", provenanceClass: "organic" },
    ];

    const rep = evaluatePrecision(server, blocks, queries, { organicCaptureWorks: true });

    // Mechanics.
    expect(rep.corpus).toEqual({ blocks: 2, runtimeBlocks: 1, importBlocks: 1 });
    expect(rep.queries.total).toBe(5);
    expect(rep.queries.organic).toBe(4);
    expect(rep.queries.bootstrap).toBe(1);
    expect(rep.precisionAtFire).toBe(1); // both fires correct
    expect(rep.falsePositiveRate).toBe(0); // no non-useful fired
    expect(rep.recallAtUseful).toBe(1);
    expect(rep.precisionWilsonLB).toBeLessThan(1); // Wilson LB < point estimate on n=2
    expect(rep.precisionWilsonLB).toBeGreaterThan(0);
    expect(rep.latencyMsP50).toBeGreaterThanOrEqual(0);
    expect(Object.keys(rep.abstentionByReason).length).toBeGreaterThan(0);

    // Honest gate: too few organic queries ⇒ NOT ready, even with perfect precision.
    expect(rep.readiness.overall).toBe(false);
    expect(rep.readiness.minLabeledQueries.pass).toBe(false);
    expect(rep.readiness.minLabeledQueries.value).toBe(4); // organic only, not the bootstrap one
    expect(rep.readiness.weakAmbiguousAbstain.pass).toBe(true);

    // Organic precision computed separately from the bootstrap subset.
    expect(rep.organic.precisionAtFire).toBe(1);
  });

  it("flags a real false positive (a useless query that fired) in the FP rate", () => {
    const store = makeStore();
    const a = ingestPattern(store, dto("kubernetes pod stuck in crashloopbackoff after a config rollout", "runtime")).blockId!;
    const server = new BlockServer(store);
    const blocks = [{ id: a, sourceType: "runtime" as const }];
    // Label a STRONG match as "unrelated" to simulate a wrong-but-confident fire.
    const queries: LabeledQuery[] = [
      { text: "kubernetes pod stuck in crashloopbackoff after config rollout", label: "unrelated", provenanceClass: "organic" },
    ];
    const rep = evaluatePrecision(server, blocks, queries, { organicCaptureWorks: true });
    expect(rep.fireRate).toBe(1);
    expect(rep.falsePositiveRate).toBe(1); // fired on a non-useful query
    expect(rep.precisionAtFire).toBe(0);
  });
});
