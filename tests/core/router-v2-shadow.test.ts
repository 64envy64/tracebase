/**
 * Router V2 SHADOW mode — runtime integration.
 *
 * Asserts the production-safety contract:
 *   - shadow mode serves the V1 decision UNCHANGED (injected context identical
 *     to off mode);
 *   - it computes the V2-family decision side-by-side on the SAME slate and
 *     persists a privacy-safe `router.shadow_comparison` event;
 *   - the comparison records both decisions, the agreement kind, family stats,
 *     latencies, feature versions, and a redaction count;
 *   - the comparison persists on BOTH recall() and recallAsync();
 *   - the comparison is a distinct stream — it persists even when the V1
 *     retrieval/injection events are suppressed (emitEvents:false);
 *   - the event carries no raw prompt/body/path (privacy).
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION } from "../../src/ingest/pattern-dto.js";
import type { RouterShadowComparisonEvent } from "../../src/types.js";

const NULL_GUARD = {
  situation: "a config merge crashes when an optional key is absent and the undefined value is dereferenced",
  mechanism: "an absent optional key yields undefined and the code dereferences it without a null guard so the absent case is indistinguishable",
  unlock: "guard the access: default or skip undefined before dereferencing",
};
const RETRY_STORM = {
  situation: "a transient failure triggers a retry storm because retries lack exponential backoff or jitter",
  mechanism: "retries fire immediately without exponential backoff or jitter so clients synchronize and amplify load into a storm",
  unlock: "add exponential backoff with jitter and a budget so retries spread out",
};

function corpusJsonl(): string {
  const mk = (p: typeof NULL_GUARD, ref: string) => ({
    schemaVersion: PATTERN_DTO_SCHEMA_VERSION,
    pattern: { situation: p.situation, mechanism: p.mechanism, unlock: p.unlock, verification: "re-run the failing scenario and confirm the symptom is gone" },
    scope: { language: "general" },
    signals: { tags: [ref] },
    provenance: { sourceType: "import", sourceRef: `test:${ref}`, capturedAt: 1, captureVersion: "test-1" },
  });
  return [mk(NULL_GUARD, "null-guard"), mk(RETRY_STORM, "retry-storm")].map((d) => JSON.stringify(d)).join("\n");
}

function freshStore(): BlockStore {
  const store = new BlockStore(new Database(":memory:"));
  importPatternsFromJsonl(store, corpusJsonl(), { now: 1 });
  return store;
}

// A retry-storm holdout: V1 abstains (margin collapse), V2-family injects.
const DISAGREE_QUERY = "a queue consumer melts the database during a blip because retries lack jitter and exponential backoff, synchronizing the load";

function shadowEvents(store: BlockStore): RouterShadowComparisonEvent[] {
  return store.readEvents({}).filter((e) => e.event === "router.shadow_comparison") as RouterShadowComparisonEvent[];
}

describe("router-v2 shadow mode", () => {
  it("serves the V1 decision and the comparison faithfully records both V1 and V2", () => {
    const store = freshStore();
    const v1 = new BlockServer(store, { gateThreshold: 0, servingMode: "v1", emitEvents: false });
    const v2 = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", emitEvents: false });
    const shadow = new BlockServer(store, { gateThreshold: 0, shadowEvaluate: "v2-family" });
    const q = { text: DISAGREE_QUERY };
    const r1 = v1.recall(q);
    const r2 = v2.recall(q);
    const rs = shadow.recall(q);

    // Shadow serves EXACTLY the V1 decision.
    expect(rs.servingDecision.action).toBe(r1.servingDecision.action);
    expect(rs.shouldInject).toBe(r1.shouldInject);

    const e = shadowEvents(store)[0]!;
    // The comparison records the same decisions the dedicated servers produced.
    expect(e.v1Action).toBe(r1.servingDecision.action);
    expect(e.v2Action).toBe(r2.servingDecision.action);
    // Agreement classifier is consistent with the two actions.
    if (e.v1Action === "abstain" && e.v2Action === "abstain") expect(e.agreement).toBe("agree_abstain");
    if (e.v1Action === "inject" && e.v2Action === "abstain") expect(e.agreement).toBe("v1_only_inject");
    if (e.v1Action === "abstain" && e.v2Action === "inject") expect(e.agreement).toBe("v2_only_inject");
    // Metadata + family telemetry present.
    expect(e.v1FeatureVersion).toBe(1);
    expect(e.v2FeatureVersion).toBe(2);
    expect(e.resolverName).toBe("structured-signature.v2");
    expect(e.familyCount).toBeGreaterThanOrEqual(1);
    expect(e.candidateCount).toBeGreaterThanOrEqual(1);
    expect(typeof e.queryHash).toBe("string");
    expect(e.v2OverheadMs).toBeGreaterThanOrEqual(0);
    store.close();
  });

  it("does NOT alter injected context vs off mode (same served blocks for every query)", () => {
    const store = freshStore();
    const off = new BlockServer(store, { gateThreshold: 0, emitEvents: false });
    const shadow = new BlockServer(store, { gateThreshold: 0, shadowEvaluate: "v2-family", emitEvents: false });
    const queries = [
      DISAGREE_QUERY,
      "a request handler throws on a missing optional header whose undefined value is dereferenced with no null guard",
      "a flexbox row overflows because the child has no min-width", // unrelated
    ];
    for (const text of queries) {
      const a = off.recall({ text });
      const b = shadow.recall({ text });
      expect(b.shouldInject).toBe(a.shouldInject);
      expect(b.blocks.filter((h) => h.passesGate).map((h) => h.block.id)).toEqual(
        a.blocks.filter((h) => h.passesGate).map((h) => h.block.id),
      );
      expect(b.servingDecision.action).toBe(a.servingDecision.action);
    }
    store.close();
  });

  it("emits a comparison on BOTH sync recall() and async recallAsync()", async () => {
    const store = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, shadowEvaluate: "v2-family" });
    server.recall({ text: DISAGREE_QUERY });
    await server.recallAsync({ text: DISAGREE_QUERY });
    expect(shadowEvents(store).length).toBe(2);
    store.close();
  });

  it("comparison persists even when V1 events are suppressed (distinct stream)", () => {
    const store = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, shadowEvaluate: "v2-family", emitEvents: false });
    server.recall({ text: DISAGREE_QUERY });
    const all = store.readEvents({});
    // No retrieval/injection events (emitEvents:false) ...
    expect(all.some((e) => e.event === "retrieval")).toBe(false);
    expect(all.some((e) => e.event === "injection")).toBe(false);
    // ... but the shadow comparison stream still landed.
    expect(all.filter((e) => e.event === "router.shadow_comparison").length).toBe(1);
    store.close();
  });

  it("off mode (no shadowEvaluate) emits ZERO comparison events", () => {
    const store = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0 });
    server.recall({ text: DISAGREE_QUERY });
    expect(shadowEvents(store).length).toBe(0);
    store.close();
  });

  it("the comparison event embeds no raw prompt/body text (privacy)", () => {
    const store = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, shadowEvaluate: "v2-family" });
    server.recall({ text: DISAGREE_QUERY });
    const serialized = JSON.stringify(shadowEvents(store)[0]);
    expect(serialized).not.toContain("melts the database"); // no raw prompt
    expect(serialized).not.toContain("exponential backoff"); // no body text
    store.close();
  });
});
