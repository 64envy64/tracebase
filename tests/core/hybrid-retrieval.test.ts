/**
 * Phase C hybrid retrieval — runtime integration.
 *
 * Contract:
 *   - off (default): recall() is sparse, byte-identical to pre-Phase-C.
 *   - the substrate surfaces a BODY-overlap block FTS missed into the slate
 *     (the candidate-generation recall lever) — sparse misses it, hybrid finds it;
 *   - recallHybrid fails OPEN to sparse when no provider / provider returns null;
 *   - shadow emits exactly one privacy-safe retrieval.hybrid_comparison event and
 *     never alters the served result;
 *   - the comparison embeds no raw query/body/path.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import { NoopRetrievalProvider } from "../../src/core/retrieval-provider.js";
import type { RetrievalHybridComparisonEvent } from "../../src/types.js";

// Block A's DISCRIMINATIVE tokens (undefined/dereferenced/guard/null) live ONLY
// in the mechanism, NOT the situation — so FTS (trigger-only) can't match a
// body-phrased query, but the body-aware provider can.
const A = {
  s: "a configuration merge fails when an optional key is missing",
  m: "the absent optional key yields undefined and is dereferenced without a null guard so the absent case is mishandled",
  u: "default the missing optional before dereferencing",
};
const B = {
  s: "a transient failure triggers a retry storm with no backoff",
  m: "retries fire without exponential backoff or jitter so clients synchronize and amplify load",
  u: "add exponential backoff with jitter and a budget",
};
const mk = (p: typeof A, ref: string) =>
  JSON.stringify({
    schemaVersion: V,
    pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run and confirm" },
    scope: { language: "general" },
    signals: { tags: [ref] },
    provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" },
  });

function freshStore(): { store: BlockStore; aId: string } {
  const store = new BlockStore(new Database(":memory:"));
  const summary = importPatternsFromJsonl(store, [mk(A, "null-guard"), mk(B, "retry-storm")].join("\n"), { now: 1 });
  const aId = summary.results[0]!.blockId!;
  return { store, aId };
}

// A body-phrased query: overlaps A's MECHANISM (undefined/dereferenced/guard)
// but NOT A's trigger situation/keywords, and not B at all.
const BODY_QUERY = "a property was dereferenced while it was still undefined with no guard protecting the read";

function hybridEvents(store: BlockStore): RetrievalHybridComparisonEvent[] {
  return store.readEvents({}).filter((e) => e.event === "retrieval.hybrid_comparison") as RetrievalHybridComparisonEvent[];
}

describe("phase-c hybrid retrieval", () => {
  it("default mode is off and recall() is sparse-only (FTS misses the body-phrased query)", () => {
    const { store, aId } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family" });
    expect(server.retrievalRollout).toBe("off");
    const r = server.recall({ text: BODY_QUERY });
    expect(r.blocks.map((h) => h.block.id)).not.toContain(aId); // sparse FTS missed A
    store.close();
  });

  it("hybrid surfaces the body-overlap block FTS missed (candidate-generation recall lever)", async () => {
    const { store, aId } = freshStore();
    const server = new BlockServer(store, {
      gateThreshold: 0,
      servingMode: "v2-family",
      retrievalMode: "on",
      retrievalProvider: new DeterministicLocalProvider(),
    });
    const sparse = server.recall({ text: BODY_QUERY });
    const hybrid = await server.recallHybrid({ text: BODY_QUERY });
    expect(sparse.blocks.map((h) => h.block.id)).not.toContain(aId); // sparse misses
    expect(hybrid.blocks.map((h) => h.block.id)).toContain(aId); // hybrid surfaces it
    store.close();
  });

  it("recallHybrid fails OPEN to sparse when the provider returns null (Noop)", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, {
      gateThreshold: 0,
      servingMode: "v2-family",
      retrievalMode: "on",
      retrievalProvider: new NoopRetrievalProvider(),
    });
    const q = { text: "a transient failure triggers a retry storm with no backoff" }; // matches B via FTS
    const sparse = server.recall(q);
    const hybrid = await server.recallHybrid(q);
    expect(hybrid.blocks.map((h) => h.block.id)).toEqual(sparse.blocks.map((h) => h.block.id));
    store.close();
  });

  it("shadow emits exactly one comparison and never alters the served (sparse) result", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, {
      gateThreshold: 0,
      servingMode: "v2-family",
      retrievalMode: "shadow",
      retrievalProvider: new DeterministicLocalProvider(),
    });
    const served = server.recall({ text: BODY_QUERY });
    await server.emitHybridComparison({ text: BODY_QUERY, queryId: served.queryId }, served.queryId);
    const evs = hybridEvents(store);
    expect(evs.length).toBe(1);
    const e = evs[0]!;
    expect(e.provider).toBe("deterministic-local");
    expect(e.fallback).toBe("none");
    expect(e.semanticOnly).toBeGreaterThanOrEqual(1); // A surfaced only semantically
    expect(["agree_abstain", "agree_inject_same", "agree_inject_diff", "sparse_only_inject", "hybrid_only_inject"]).toContain(e.decisionAgreement);
    expect(e.featureVersion).toBe(2);
    store.close();
  });

  it("the comparison event embeds no raw query/body/path", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, retrievalMode: "shadow", retrievalProvider: new DeterministicLocalProvider() });
    const served = server.recall({ text: BODY_QUERY });
    await server.emitHybridComparison({ text: BODY_QUERY, queryId: served.queryId }, served.queryId);
    const s = JSON.stringify(hybridEvents(store));
    expect(s).not.toContain("property was dereferenced"); // no raw query
    expect(s).not.toContain("yields undefined"); // no raw body
    expect(s).not.toContain("/"); // no path-like content
    store.close();
  });

  it("off mode emits ZERO comparison events even if a provider is wired", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, retrievalMode: "off", retrievalProvider: new DeterministicLocalProvider() });
    const served = server.recall({ text: BODY_QUERY });
    await server.emitHybridComparison({ text: BODY_QUERY }, served.queryId);
    expect(hybridEvents(store).length).toBe(0); // emitHybridComparison no-ops when mode != shadow
    store.close();
  });
});
