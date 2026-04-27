/**
 * storeReasoningPattern — the v2 capture helper.
 *
 * The helper underpins the `store_reasoning_pattern` MCP tool. It
 * closes the capture half of the loop: without it, a resolved
 * outcome cannot seed future retrievals, because `get_reasoning_patterns`
 * reads the v2 reasoning_blocks table and the legacy `store` tool
 * writes v1 traces.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import {
  storeReasoningPattern,
  StorePatternValidationError,
} from "../../src/server/mcp-v2-helpers.js";
import { runReasoningPatternsRecall } from "../../src/server/reasoning-patterns-entry.js";

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

describe("storeReasoningPattern — happy path", () => {
  it("inserts a new active block with an origin case ref", () => {
    const store = makeStore();
    const result = storeReasoningPattern(store, {
      situation: "React effect loops when dependency array holds a fresh object each render",
      mechanism: "referential equality fails every render, so the effect re-runs indefinitely",
      unlock: "memoize the dependency with useMemo, or lift the object into module scope",
      verification: "render count stays constant after the initial mount",
      deadEnds: ["wrapping the effect in try/catch", "adding eslint-disable"],
      language: "typescript",
      framework: "react",
    });

    expect(result.isNew).toBe(true);
    expect(result.blockId).toBeTypeOf("string");

    const block = store.getBlock(result.blockId)!;
    expect(block.status).toBe("active");
    expect(block.body.deadEnds).toEqual([
      "wrapping the effect in try/catch",
      "adding eslint-disable",
    ]);
    expect(block.trigger.invariants.language).toBe("typescript");
    expect(block.trigger.invariants.framework).toBe("react");

    // Origin ref is the integrity requirement for active.
    const refs = store.listCaseRefs(result.blockId);
    expect(refs.length).toBe(1);
    expect(refs[0]!.role).toBe("origin");
  });

  it("links the origin ref back to the retrieval queryId when provided", () => {
    const store = makeStore();
    const result = storeReasoningPattern(store, {
      situation: "Python ImportError when test runner picks the wrong python path",
      mechanism: "sys.path has a shadowing module earlier than the package",
      unlock: "prepend the project root to sys.path in conftest.py",
      verification: "pytest collects the intended package",
      queryId: "q-abc-123",
    });
    const refs = store.listCaseRefs(result.blockId);
    expect(refs[0]!.traceId).toBe("q-abc-123");
  });
});

describe("storeReasoningPattern — dedupe", () => {
  it("a second call with the same fingerprint does NOT create a duplicate; returns the existing id with isNew=false", () => {
    const store = makeStore();
    const first = storeReasoningPattern(store, {
      situation: "Postgres connection exhaustion during burst traffic",
      mechanism: "pool size is below the concurrent-request count",
      unlock: "raise pool max_connections; profile long-held checkouts",
      verification: "connection_count metric stays under the ceiling",
      language: "python",
      framework: "django",
    });
    const second = storeReasoningPattern(store, {
      // Identical invariants + keyword-equivalent situation → same fingerprint.
      situation: "Postgres connection exhaustion during burst traffic",
      mechanism: "different phrasing, still same pattern",
      unlock: "different unlock phrasing",
      verification: "different verification",
      language: "python",
      framework: "django",
    });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.blockId).toBe(first.blockId);

    // Second call attaches a supporting ref rather than leaving the
    // block un-reinforced.
    const refs = store.listCaseRefs(first.blockId);
    const roles = refs.map((r) => r.role).sort();
    expect(roles).toEqual(["origin", "supporting"]);
  });
});

describe("storeReasoningPattern — idempotent retries", () => {
  it("three consecutive identical calls with the same queryId do not throw and do not accumulate supporting refs", () => {
    // Regression: the `block_case_refs` UNIQUE index on
    // (block_id, trace_id, role) previously raised on the third
    // call. MCP transports can retry tool calls; the agent also
    // sometimes retries on its own. The helper has to absorb that.
    const store = makeStore();
    const args = {
      situation: "Webhook delivery retries exceed the configured budget",
      mechanism: "exponential backoff overshoots the ceiling",
      unlock: "clamp the next delay to the ceiling before rescheduling",
      verification: "replay the trace and confirm delivery completes within budget",
      language: "typescript",
      framework: "node",
      queryId: "q-retry-xyz",
    } as const;

    const a = storeReasoningPattern(store, args);
    const b = storeReasoningPattern(store, args);
    const c = storeReasoningPattern(store, args);

    // All three resolve to the same block, only the first is new.
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(false);
    expect(c.isNew).toBe(false);
    expect(b.blockId).toBe(a.blockId);
    expect(c.blockId).toBe(a.blockId);

    // Exactly one origin ref + at most one supporting ref — the
    // third call must be a no-op, not another insert.
    const refs = store.listCaseRefs(a.blockId);
    const rolesByTrace = refs.map((r) => `${r.role}:${r.traceId}`).sort();
    expect(rolesByTrace).toEqual([
      "origin:q-retry-xyz",
      "supporting:q-retry-xyz",
    ]);
  });

  it("different queryIds still produce distinct supporting refs (we only dedupe on matching traceId)", () => {
    // This is the inverse invariant: genuinely new supporting
    // evidence from a different query must not be suppressed by the
    // retry guard.
    const store = makeStore();
    const first = storeReasoningPattern(store, {
      situation: "Same trigger for both callers",
      mechanism: "mechanism text for dedupe unit",
      unlock: "unlock text sufficient length",
      verification: "verification text",
      queryId: "q-caller-1",
    });
    const second = storeReasoningPattern(store, {
      situation: "Same trigger for both callers",
      mechanism: "caller 2 phrasing, same pattern",
      unlock: "caller 2 unlock",
      verification: "caller 2 verification",
      queryId: "q-caller-2",
    });

    expect(second.isNew).toBe(false);
    expect(second.blockId).toBe(first.blockId);

    const refs = store.listCaseRefs(first.blockId);
    const supporting = refs.filter((r) => r.role === "supporting").map((r) => r.traceId).sort();
    expect(supporting).toEqual(["q-caller-2"]);
  });
});

describe("storeReasoningPattern — validation", () => {
  it("rejects empty / whitespace-only fields rather than silently polluting the store", () => {
    const store = makeStore();
    expect(() =>
      storeReasoningPattern(store, {
        situation: "   ",
        mechanism: "mechanism",
        unlock: "unlock text",
        verification: "verify",
      }),
    ).toThrow(StorePatternValidationError);
  });

  it("rejects too-short fields (< 4 chars after trim)", () => {
    const store = makeStore();
    expect(() =>
      storeReasoningPattern(store, {
        situation: "ok situation",
        mechanism: "m",
        unlock: "ok unlock",
        verification: "ok verification",
      }),
    ).toThrow(/mechanism.*too short/i);
  });
});

describe("storeReasoningPattern — round-trip with get_reasoning_patterns", () => {
  it("a freshly-stored pattern is retrievable on the next get_reasoning_patterns call", () => {
    const store = makeStore();
    const server = new BlockServer(store);

    // 1. First retrieval returns nothing — empty store.
    const before = runReasoningPatternsRecall(
      server,
      { problem: "flaky pytest run due to import order" },
      { readHoldoutConfig: () => null },
    );
    expect(before.blocks).toEqual([]);

    // 2. Agent captures the learned pattern.
    const stored = storeReasoningPattern(store, {
      situation: "flaky pytest run due to import order",
      mechanism: "sys.path pollution from a prior test leaves a stale module cached",
      unlock: "isolate tests in a fresh subprocess, or clear sys.modules in conftest",
      verification: "pytest -p no:cacheprovider reproduces a clean collection",
      language: "python",
    });
    expect(stored.isNew).toBe(true);

    // 3. Next retrieval on a similar problem surfaces the block.
    const after = runReasoningPatternsRecall(
      server,
      { problem: "flaky pytest run due to import order" },
      { readHoldoutConfig: () => null },
    );
    expect(after.blocks.length).toBeGreaterThan(0);
    expect(after.blocks[0]!.block.id).toBe(stored.blockId);
    expect(after.shouldInject).toBe(true);
  });
});
