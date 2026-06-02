/**
 * Hybrid retrieval substrate — RRF fusion + sparse⊕semantic union (Phase C).
 */
import { describe, it, expect } from "vitest";
import type { ReasoningBlock } from "../../src/types.js";
import {
  rrfFuse,
  fuseHybrid,
  NoopRetrievalProvider,
  RRF_K,
  type RetrievalCandidate,
} from "../../src/core/retrieval-provider.js";

const blk = (id: string): ReasoningBlock => ({ id } as unknown as ReasoningBlock);
const sparse = (...ids: string[]) => ids.map((id, i) => ({ block: blk(id), score: 1 - i * 0.1 }));
const sem = (...ids: string[]): RetrievalCandidate[] => ids.map((id, i) => ({ blockId: id, score: 1 - i * 0.1 }));

describe("RRF fusion", () => {
  it("is deterministic and dedupes by blockId", () => {
    const a = rrfFuse([{ source: "x", blockIds: ["a", "b", "c"] }, { source: "y", blockIds: ["b", "d"] }]);
    const b = rrfFuse([{ source: "x", blockIds: ["a", "b", "c"] }, { source: "y", blockIds: ["b", "d"] }]);
    expect(a).toEqual(b);
    expect(a.map((c) => c.blockId).sort()).toEqual(["a", "b", "c", "d"]); // each once
  });

  it("a block in two lists outranks a block in one (no per-list weights)", () => {
    const fused = rrfFuse([{ source: "x", blockIds: ["a", "b"] }, { source: "y", blockIds: ["b"] }]);
    // b: 1/(k+2) + 1/(k+1); a: 1/(k+1). b > a.
    expect(fused[0]!.blockId).toBe("b");
    expect(fused[0]!.ranks).toEqual({ x: 2, y: 1 });
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 9);
  });

  it("records explainable per-source ranks", () => {
    const fused = rrfFuse([{ source: "sparse", blockIds: ["p", "q"] }, { source: "semantic", blockIds: ["q", "r"] }]);
    const q = fused.find((c) => c.blockId === "q")!;
    expect(q.ranks).toEqual({ sparse: 2, semantic: 1 });
    const r = fused.find((c) => c.blockId === "r")!;
    expect(r.ranks).toEqual({ semantic: 2 });
  });
});

describe("fuseHybrid", () => {
  it("null semantic ⇒ sparse identity (fail-open)", () => {
    const s = sparse("a", "b", "c");
    const out = fuseHybrid(s, null, () => null, 5);
    expect(out.slate.map((x) => x.block.id)).toEqual(["a", "b", "c"]);
    expect(out.telemetry.semanticOnly).toBe(0);
    expect(out.telemetry.rankMovement).toBe(0);
  });

  it("surfaces a semantic-only block FTS missed (the recall lever)", () => {
    const s = sparse("a", "b");
    const semanticOnly = blk("z");
    const out = fuseHybrid(s, sem("z"), (id) => (id === "z" ? semanticOnly : null), 5);
    expect(out.slate.map((x) => x.block.id)).toContain("z");
    expect(out.telemetry.semanticOnly).toBe(1);
    expect(out.telemetry.overlap).toBe(0);
  });

  it("counts overlap and bounds the slate to topN", () => {
    const s = sparse("a", "b", "c", "d");
    const out = fuseHybrid(s, sem("b", "c"), () => null, 2);
    expect(out.slate.length).toBe(2);
    expect(out.telemetry.overlap).toBe(2); // b, c in both
    expect(out.telemetry.sparseSlateSize).toBe(4);
    expect(out.telemetry.semanticSlateSize).toBe(2);
  });

  it("drops semantic-only ids that cannot be resolved to a block", () => {
    const s = sparse("a");
    const out = fuseHybrid(s, sem("ghost"), () => null, 5); // lookup returns null
    expect(out.slate.map((x) => x.block.id)).toEqual(["a"]);
  });
});

describe("NoopRetrievalProvider", () => {
  it("always returns null (the off / absolute-fallback provider)", async () => {
    const p = new NoopRetrievalProvider();
    expect(await p.retrieve()).toBeNull();
  });
});
