/**
 * Phase C.2 — hybrid retrieval + ServingEvidenceV3 shadow, end to end.
 *
 * The full pipeline: hybrid retrieval surfaces a body-only lesson into the slate
 * (Phase C), the served V2 decision still abstains (lexical-conditional), but the
 * shadow V3 decision LICENSES it via body corroboration — converting candidate
 * recall into (shadow) decision recall. V3 is never served; it surfaces on
 * `shadowV3` + a local-only comparison event.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { importPatternsFromJsonl } from "../../src/ingest/import-patterns.js";
import { PATTERN_DTO_SCHEMA_VERSION as V } from "../../src/ingest/pattern-dto.js";
import { DeterministicLocalProvider } from "../../src/core/deterministic-local-provider.js";
import type { ReasoningEvidenceComparisonEvent } from "../../src/types.js";

// A: discriminative tokens (undefined/dereferenced/guard/null) ONLY in the body.
const A = {
  s: "a configuration merge fails on a missing entry",
  m: "the absent optional value yields undefined and is dereferenced without a null guard so the absent case is mishandled",
  u: "guard the access and default the undefined optional before dereferencing it",
};
const B = {
  s: "a transient failure triggers a retry storm with no backoff",
  m: "retries fire without exponential backoff or jitter so clients synchronize and amplify load",
  u: "add exponential backoff with jitter and a budget",
};
const mk = (p: typeof A, ref: string) =>
  JSON.stringify({
    schemaVersion: V,
    pattern: { situation: p.s, mechanism: p.m, unlock: p.u, verification: "re-run" },
    scope: { language: "general" },
    signals: { tags: [ref] },
    provenance: { sourceType: "import", sourceRef: `t:${ref}`, capturedAt: 1, captureVersion: "t" },
  });

function freshStore(): { store: BlockStore; aId: string } {
  const store = new BlockStore(new Database(":memory:"));
  const summary = importPatternsFromJsonl(store, [mk(A, "null-guard"), mk(B, "retry-storm")].join("\n"), { now: 1 });
  return { store, aId: summary.results[0]!.blockId! };
}

// Body-phrased: matches A's mechanism/unlock, not A's trigger situation.
const BODY_QUERY = "undefined was dereferenced without a null guard since the optional value was absent";

function evidenceEvents(store: BlockStore): ReasoningEvidenceComparisonEvent[] {
  return store.readEvents({}).filter((e) => e.event === "reasoning.evidence_comparison") as ReasoningEvidenceComparisonEvent[];
}

describe("phase-c.2 hybrid + V3 shadow", () => {
  it("default evidence mode is off; no comparison events, no shadowV3", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider() });
    expect(server.evidenceRollout).toBe("off");
    const r = await server.recallHybrid({ text: BODY_QUERY });
    expect(r.shadowV3).toBeUndefined();
    expect(evidenceEvents(store).length).toBe(0);
    store.close();
  });

  it("shadow V3 licenses the body-only block that served V2 abstains on", async () => {
    const { store, aId } = freshStore();
    const server = new BlockServer(store, {
      gateThreshold: 0,
      servingMode: "v2-family",
      retrievalMode: "on",
      retrievalProvider: new DeterministicLocalProvider(),
      evidenceMode: "shadow",
    });
    const r = await server.recallHybrid({ text: BODY_QUERY });

    // Served decision is V2 — it abstains on the body-only candidate.
    expect(r.shouldInject).toBe(false);
    // Shadow V3 licenses A (never served).
    expect(r.shadowV3).toBeDefined();
    expect(r.shadowV3!.action).toBe("inject");
    expect(r.shadowV3!.topBlockId).toBe(aId);
    expect(r.shadowV3!.lane).toBe("semantic-license");
    expect(r.shadowV3!.licenseReason).toBe("structured-corroborated");

    const evs = evidenceEvents(store);
    expect(evs.length).toBe(1);
    const e = evs[0]!;
    expect(e.servedAction).toBe("abstain");
    expect(e.v3Action).toBe("inject");
    expect(e.agreement).toBe("v3_only_inject");
    expect(e.semanticOnlyCandidates).toBeGreaterThanOrEqual(1);
    expect(e.licensedCandidates).toBeGreaterThanOrEqual(1);
    expect(e.fallback).toBe("none");
    store.close();
  });

  it("the evidence comparison event carries no raw query/body/path", async () => {
    const { store } = freshStore();
    const server = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), evidenceMode: "shadow" });
    await server.recallHybrid({ text: BODY_QUERY });
    const s = JSON.stringify(evidenceEvents(store));
    expect(s).not.toContain("dereferenced without"); // no raw query phrase
    expect(s).not.toContain("yields undefined"); // no raw body
    store.close();
  });

  it("shadow V3 does not alter the served sparse/V2 result (parity)", async () => {
    const { store } = freshStore();
    const served = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), emitEvents: false });
    const shadowed = new BlockServer(store, { gateThreshold: 0, servingMode: "v2-family", retrievalMode: "on", retrievalProvider: new DeterministicLocalProvider(), evidenceMode: "shadow", emitEvents: false });
    const a = await served.recallHybrid({ text: BODY_QUERY });
    const b = await shadowed.recallHybrid({ text: BODY_QUERY });
    expect(b.shouldInject).toBe(a.shouldInject);
    expect(b.blocks.filter((h) => h.passesGate).map((h) => h.block.id)).toEqual(a.blocks.filter((h) => h.passesGate).map((h) => h.block.id));
    store.close();
  });
});
