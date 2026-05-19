/**
 * record_reasoning_outcome cascade-provenance tests — May-2026 B1.6.
 *
 * Pins the contract that `lookupCascadeProvenance` recovers the
 * arm + reranker + fallback fields from a retrieval event, and that
 * absent / malformed retrieval events collapse to `null` (the
 * MCP handler then omits the cascade line — never throws).
 *
 * The agent reads this in the outcome response and decides whether
 * to trust the recalled pattern more (reranker-assisted hit) or less
 * (BM25 fallback). Anything we get wrong here directly misinforms
 * the agent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { lookupCascadeProvenance } from "../../src/server/mcp-v2-helpers.js";

let store: BlockStore;

beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

afterEach(() => {
  store.close();
});

function seedRetrieval(queryId: string, extras: Record<string, unknown> = {}): void {
  store.appendEvent({
    ts: Date.now(),
    queryId,
    event: "retrieval",
    candidates: [{ blockId: "b-1", score: 0.5 }],
    shadow: false,
    ...extras,
  } as never);
}

describe("lookupCascadeProvenance", () => {
  it("returns null when no retrieval event exists for the queryId", () => {
    expect(lookupCascadeProvenance(store, "missing-qid")).toBeNull();
  });

  it("recovers viaCascade=false for a sync-arm retrieval", () => {
    seedRetrieval("q-sync");
    const out = lookupCascadeProvenance(store, "q-sync");
    expect(out).toEqual({ viaCascade: false });
  });

  it("recovers full cascade provenance when reranker succeeded", () => {
    seedRetrieval("q-cascade", {
      cascadePolicyId: "linear+rerank+mmr.v1",
      rerankerName: "minilm",
      mmrLambda: 0.7,
      rerankerFellBack: false,
    });
    const out = lookupCascadeProvenance(store, "q-cascade");
    expect(out).toEqual({
      viaCascade: true,
      policyId: "linear+rerank+mmr.v1",
      rerankerName: "minilm",
      fellBack: false,
    });
  });

  it("recovers fallback reason when the reranker collapsed (timeout)", () => {
    seedRetrieval("q-timeout", {
      cascadePolicyId: "linear+rerank+mmr.v1",
      rerankerName: "minilm",
      rerankerFellBack: true,
      rerankerFallbackReason: "timeout",
    });
    const out = lookupCascadeProvenance(store, "q-timeout");
    expect(out).toEqual({
      viaCascade: true,
      policyId: "linear+rerank+mmr.v1",
      rerankerName: "minilm",
      fellBack: true,
      fallbackReason: "timeout",
    });
  });

  it("filters fallback reason to the closed union and drops unknown values", () => {
    // Defensive — if a future server stamps a reason we don't know,
    // we drop the field rather than letting an unknown string leak
    // into the agent-facing response.
    seedRetrieval("q-bad-reason", {
      cascadePolicyId: "linear+rerank+mmr.v1",
      rerankerName: "minilm",
      rerankerFellBack: true,
      rerankerFallbackReason: "asteroid-impact",
    });
    const out = lookupCascadeProvenance(store, "q-bad-reason");
    expect(out?.viaCascade).toBe(true);
    expect(out?.fellBack).toBe(true);
    expect(out?.fallbackReason).toBeUndefined();
  });

  it("never throws when the event log read fails — returns null", () => {
    // Close the store under us; readEvents will throw, lookupCascadeProvenance
    // must catch and return null so MCP handler stays robust.
    store.close();
    expect(lookupCascadeProvenance(store, "any")).toBeNull();
    // re-open a fresh store for afterEach cleanup
    store = new BlockStore(new Database(":memory:"));
  });

  it("returns viaCascade=false when only rerankerName is stamped but cascadePolicyId is missing", () => {
    // The discriminator is cascadePolicyId (B1.1 contract). A rogue
    // event with rerankerName only is treated as sync — better to
    // under-credit than mis-credit.
    seedRetrieval("q-orphan", { rerankerName: "minilm" });
    const out = lookupCascadeProvenance(store, "q-orphan");
    expect(out?.viaCascade).toBe(false);
    expect(out?.policyId).toBeUndefined();
  });
});
