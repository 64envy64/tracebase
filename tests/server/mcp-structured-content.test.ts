/**
 * 0.7.1 Contextual Runtime — structured MCP output contract.
 *
 * Verifies that the four tools migrated to `registerTool` plus the
 * new `delete_project_fact` produce a `structuredContent` payload
 * tagged with the stable `tracebase.contextual_runtime.v1`
 * protocol id and the field shapes integrators rely on.
 *
 * The test does NOT spin up the MCP SDK transport. The structured
 * payload comes from the same helpers the MCP handler returns, so
 * the contract is asserted at the data layer where it lives —
 * faster, hermetic, and not dependent on the SDK's internal
 * marshaling. The `doctor` selftest exercises tool-registration
 * separately.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { createBlock } from "../../src/core/block.js";
import {
  CONTEXTUAL_RUNTIME_PROTOCOL,
  collectInjectedFromQuery,
  deletePattern,
  deleteProjectFact,
  resolveUsedItems,
  storeReasoningPattern,
  toReasoningPatternsStructured,
  toMcpStructured,
} from "../../src/server/mcp-v2-helpers.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";
import { emitOutcome } from "../../src/core/analytics.js";
import type { StoreBlockInput } from "../../src/types.js";

const SEED: StoreBlockInput = {
  trigger: {
    situation: "form validation conflates 0 with no input via if (!value)",
    invariants: { language: "typescript", framework: "react", errorType: "operator-misuse" },
  },
  body: {
    mechanism: "truthiness check treats falsy non-empty values as missing",
    deadEnds: ["String coercion still leaves '0' falsy"],
    unlock: "switch to value == null to distinguish missing from intentional zero",
    verification: "input value of 0 no longer triggers required-field error",
  },
  provenance: { sourceTaskId: "trace-zero", extractedFrom: "trajectory", distilledBy: "llm" },
};

function makeStoreWithSeed(): { store: BlockStore; server: BlockServer; blockId: string } {
  const store = new BlockStore(new Database(":memory:"));
  const b = createBlock(SEED);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  store.updateBlockStatus(b.id, "active");
  const server = new BlockServer(store);
  return { store, server, blockId: b.id };
}

describe("toReasoningPatternsStructured — get_reasoning_patterns shape", () => {
  it("emits the protocol literal and required envelope fields", () => {
    const { server } = makeStoreWithSeed();
    const result = runReasoningPatternsRecall(
      server,
      { problem: "input value of 0 incorrectly flagged as missing in form validation" },
      { readHoldoutConfig: () => null },
    );
    const out = toReasoningPatternsStructured(result);
    expect(out.protocol).toBe(CONTEXTUAL_RUNTIME_PROTOCOL);
    expect(typeof out.queryId).toBe("string");
    expect(out.queryId.length).toBeGreaterThan(0);
    expect(typeof out.shouldInject).toBe("boolean");
    expect(typeof out.shadow).toBe("boolean");
    expect(Array.isArray(out.blocks)).toBe(true);
    expect(Array.isArray(out.facts)).toBe(true);
  });

  it("populates the injected summary only when shouldInject is true", () => {
    const { server } = makeStoreWithSeed();
    const result = runReasoningPatternsRecall(
      server,
      { problem: "form validation flags 0 as missing input" },
      { readHoldoutConfig: () => null },
    );
    const out = toReasoningPatternsStructured(result);
    if (out.shouldInject) {
      expect(out.injected).toBeDefined();
      expect(Array.isArray(out.injected!.blockIds)).toBe(true);
      expect(typeof out.injected!.tokensEstimate).toBe("number");
      expect(out.injected!.tokensEstimate).toBeGreaterThanOrEqual(0);
    } else {
      expect(out.injected).toBeUndefined();
    }
  });

  it("on shadow runs, returns blocks/facts but no injected payload and shouldInject=false", () => {
    const { server } = makeStoreWithSeed();
    const result = runReasoningPatternsRecall(
      server,
      { problem: "form validation flags 0 as missing input", shadow: true },
      { readHoldoutConfig: () => null },
    );
    const out = toReasoningPatternsStructured(result);
    expect(out.shadow).toBe(true);
    expect(out.shouldInject).toBe(false);
    expect(out.injected).toBeUndefined();
  });

  it("each block carries id / situation / calibratedProb / evidenceRefs", () => {
    const { server, blockId } = makeStoreWithSeed();
    const result = runReasoningPatternsRecall(
      server,
      { problem: "form validation flags 0 as missing input" },
      { readHoldoutConfig: () => null },
    );
    const out = toReasoningPatternsStructured(result);
    expect(out.blocks.length).toBeGreaterThan(0);
    const b = out.blocks[0]!;
    expect(b.id).toBe(blockId);
    expect(typeof b.situation).toBe("string");
    expect(typeof b.calibratedProb).toBe("number");
    expect(Array.isArray(b.evidenceRefs)).toBe(true);
    if (b.evidenceRefs.length > 0) {
      expect(typeof b.evidenceRefs[0]!.traceId).toBe("string");
      expect(typeof b.evidenceRefs[0]!.role).toBe("string");
    }
  });
});

describe("storeReasoningPattern — structured-content envelope", () => {
  it("isNew=true on first capture, false on a same-fingerprint reinforcement", () => {
    const store = new BlockStore(new Database(":memory:"));
    const args = {
      situation: "form validation flags 0 as missing input via if (!value)",
      mechanism: "truthiness conflates 0 / '' / false with missing",
      unlock: "use value == null to distinguish missing from intentional zero",
      verification: "an input of 0 no longer raises a required-field error",
      language: "typescript",
    };
    const a = storeReasoningPattern(store, args);
    expect(a.isNew).toBe(true);
    const b = storeReasoningPattern(store, { ...args, queryId: "q2" });
    expect(b.isNew).toBe(false);
    expect(b.blockId).toBe(a.blockId);
  });
});

describe("delete_pattern + delete_project_fact — structured deletion shape", () => {
  it("delete_pattern returns ok:true, deleted:true on hit and false on miss", () => {
    const store = new BlockStore(new Database(":memory:"));
    const stored = storeReasoningPattern(store, {
      situation: "react state update batching causes stale read in event handler",
      mechanism: "the scheduled state is not visible synchronously",
      unlock: "read the latest state via the functional updater form",
      verification: "the handler now sees the updated value within the same tick",
      language: "typescript",
    });
    const hit = deletePattern(store, {
      id: stored.blockId,
      reason: "user-requested erasure for compliance test",
      requestingPrincipal: "test:mcp:delete_pattern",
    });
    expect(hit).toEqual({ ok: true, deleted: true, id: stored.blockId });
    const miss = deletePattern(store, {
      id: "nonexistent-id",
      reason: "user-requested erasure for compliance test",
    });
    expect(miss).toEqual({ ok: true, deleted: false, id: "nonexistent-id" });
  });

  it("delete_project_fact mirrors the contract for the L4 substrate", () => {
    const store = new BlockStore(new Database(":memory:"));
    const fact = store.storeFact({
      factType: "convention",
      scope: "repo:test/app",
      statement: "TypeScript strict mode is enabled in tsconfig.json",
      confidence: 0.9,
      source: { origin: "observed" },
      invariants: {},
    });
    const hit = deleteProjectFact(store, {
      id: fact.id,
      reason: "user-requested erasure (test fact)",
      requestingPrincipal: "test:mcp:delete_project_fact",
    });
    expect(hit).toEqual({ ok: true, deleted: true, id: fact.id });
    expect(store.getFact(fact.id)).toBeNull();
    const miss = deleteProjectFact(store, {
      id: "nonexistent-fact",
      reason: "user-requested erasure (test fact)",
    });
    expect(miss).toEqual({ ok: true, deleted: false, id: "nonexistent-fact" });
  });

  it("delete_project_fact writes the audit row with no body content", () => {
    const store = new BlockStore(new Database(":memory:"));
    const secret = "REPO_API_TOKEN_SHOULD_NEVER_LEAK";
    const fact = store.storeFact({
      factType: "convention",
      scope: "repo:test/app",
      statement: secret,
      confidence: 0.5,
      source: { origin: "observed" },
      invariants: {},
    });
    deleteProjectFact(store, {
      id: fact.id,
      reason: "purge-secrets test",
      requestingPrincipal: "test:audit",
    });
    const audit = (
      store as unknown as {
        db: { prepare: (s: string) => { all: (...p: unknown[]) => unknown[] } };
      }
    )
      .db.prepare("SELECT * FROM audit_fact_deletes WHERE fact_id = ?")
      .all(fact.id) as Array<Record<string, unknown>>;
    expect(audit.length).toBe(1);
    const row = audit[0]!;
    expect(row["fact_id"]).toBe(fact.id);
    expect(row["reason"]).toBe("purge-secrets test");
    // The audit row must not preserve the deleted statement.
    for (const v of Object.values(row)) {
      expect(typeof v === "string" ? v : "").not.toContain(secret);
    }
  });
});

describe("toMcpStructured — boundary coercion is a no-op on values", () => {
  it("returns the same shape; only the static type widens", () => {
    const { server } = makeStoreWithSeed();
    const result = runReasoningPatternsRecall(
      server,
      { problem: "form validation flags 0 as missing input" },
      { readHoldoutConfig: () => null },
    );
    const structured = toReasoningPatternsStructured(result);
    const widened = toMcpStructured(structured);
    expect(widened["protocol"]).toBe(CONTEXTUAL_RUNTIME_PROTOCOL);
    expect(widened["queryId"]).toBe(structured.queryId);
    expect(widened["shouldInject"]).toBe(structured.shouldInject);
  });
});

describe("integration with outcome ledger", () => {
  it("collectInjectedFromQuery + resolveUsedItems credit only injected ids", () => {
    const { store, server } = makeStoreWithSeed();
    const result = runReasoningPatternsRecall(
      server,
      { problem: "form validation flags 0 as missing input" },
      { readHoldoutConfig: () => null },
    );
    const injected = collectInjectedFromQuery(store, result.queryId);
    const usedAll = resolveUsedItems(injected, { usedPattern: true });
    expect(usedAll.usedBlockIds).toEqual(injected.blockIds);
    const usedNone = resolveUsedItems(injected, { usedPattern: false });
    expect(usedNone.usedBlockIds).toEqual([]);
    const usedFiltered = resolveUsedItems(injected, {
      usedBlocks: ["bogus-id"],
    });
    expect(usedFiltered.usedBlockIds).toEqual([]);
  });

  it("durationMs round-trips through emitOutcome", () => {
    const { store, server } = makeStoreWithSeed();
    const result = runReasoningPatternsRecall(
      server,
      { problem: "form validation flags 0 as missing input" },
      { readHoldoutConfig: () => null },
    );
    emitOutcome(store, {
      queryId: result.queryId,
      resolved: true,
      control: false,
      durationMs: 4321,
    });
    const events = store.readEvents({ queryId: result.queryId, limit: 100 });
    const outcomeEvents = events.filter((e) => e.event === "outcome");
    expect(outcomeEvents.length).toBe(1);
    const oe = outcomeEvents[0]! as { durationMs?: number };
    expect(oe.durationMs).toBe(4321);
  });
});
