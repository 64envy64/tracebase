/**
 * storeReasoningPattern — the v2 capture helper.
 *
 * The helper underpins the `store_reasoning_pattern` MCP tool. It
 * closes the capture half of the loop: without it, a resolved
 * outcome cannot seed future retrievals, because `get_reasoning_patterns`
 * reads the v2 reasoning_blocks table and the legacy `store` tool
 * writes v1 traces.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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
  it("inserts a new active block with an origin case ref", async () => {
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

  it("links the origin ref back to the retrieval queryId when provided", async () => {
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
  it("a second call with the same fingerprint does NOT create a duplicate; returns the existing id with isNew=false", async () => {
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
  it("three consecutive identical calls with the same queryId do not throw and do not accumulate supporting refs", async () => {
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

  it("different queryIds still produce distinct supporting refs (we only dedupe on matching traceId)", async () => {
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
  it("rejects empty / whitespace-only fields rather than silently polluting the store", async () => {
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

  it("rejects too-short fields (< 4 chars after trim)", async () => {
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
  it("a freshly-stored pattern is retrievable on the next get_reasoning_patterns call", async () => {
    const store = makeStore();
    const server = new BlockServer(store);

    // 1. First retrieval returns nothing — empty store.
    const before = await runReasoningPatternsRecall(
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
    const after = await runReasoningPatternsRecall(
      server,
      { problem: "flaky pytest run due to import order" },
      { readHoldoutConfig: () => null },
    );
    expect(after.blocks.length).toBeGreaterThan(0);
    expect(after.blocks[0]!.block.id).toBe(stored.blockId);
    expect(after.shouldInject).toBe(true);
  });
});

describe("storeReasoningPattern — capture gate", () => {
  // Refuses the two largest junk classes measured in the dogfood store
  // (release-progress chat captured as patterns, and template-verify
  // boilerplate). Length-only thinness is intentionally still allowed
  // through MIN_FIELD_LEN — gate logic shouldn't false-positive on
  // genuinely concise fixes.
  it("rejects bodies that contain release-progress version markers", async () => {
    const store = makeStore();
    expect(() =>
      storeReasoningPattern(store, {
        situation: "Bug in 0.5.7 memory prune over-prunes valid reusable blocks.",
        mechanism: "tracebase-ai@0.5.8 is latest. git pushed (ec34fc5..8b2587b).",
        unlock: "set the candidate filter to skip no-problem-signal patterns",
        verification: "1093 tests pass after the fix",
      }),
    ).toThrow(/capture gate.*release-noise/);
  });

  it("rejects when verification is the canned 'Re-run the failing step' boilerplate", async () => {
    const store = makeStore();
    expect(() =>
      storeReasoningPattern(store, {
        situation: "fixture about a real reusable bug pattern with adequate detail",
        mechanism: "the underlying mechanism is genuinely useful and explained well",
        unlock: "the fix is to apply a guard at the boundary",
        verification: "Re-run the failing step or relevant tests to confirm the fix holds.",
      }),
    ).toThrow(/capture gate.*template-verify/);
  });

  it("accepts a real reusable pattern with no junk markers", async () => {
    const store = makeStore();
    const result = storeReasoningPattern(store, {
      situation: "React effect loops when the dependency array holds a fresh object each render",
      mechanism: "referential equality fails every render so the effect re-runs indefinitely",
      unlock: "memoize the dependency with useMemo, or lift the object into module scope",
      verification: "render count stays constant after the initial mount",
    });
    expect(result.isNew).toBe(true);
  });
});

describe("storeReasoningPattern — atomicity", () => {
  // The promote sequence (storeBlock → attachCaseRef → updateBlockStatus)
  // must roll back as a unit. Without the surrounding transaction, a
  // mid-sequence failure leaves a candidate-status block invisible to
  // the read path but still occupying the (fingerprint, kind) dedupe
  // slot, blocking future captures.
  function countBlocks(store: BlockStore): number {
    return (store.rawDb.prepare("SELECT COUNT(*) AS c FROM reasoning_blocks").get() as { c: number }).c;
  }
  function countCaseRefs(store: BlockStore): number {
    return (store.rawDb.prepare("SELECT COUNT(*) AS c FROM block_case_refs").get() as { c: number }).c;
  }

  const validInput = {
    situation: "atomicity test — distinct trigger phrase",
    mechanism: "the three-step promote sequence must be all-or-nothing",
    unlock: "wrap storeBlock + attachCaseRef + updateBlockStatus in a single transaction",
    verification: "after a forced mid-sequence throw, no block or case ref persists",
  };

  it("rolls back the candidate block when attachCaseRef fails", async () => {
    const store = makeStore();
    const spy = vi.spyOn(store, "attachCaseRef").mockImplementation(() => {
      throw new Error("simulated attachCaseRef failure");
    });

    expect(() => storeReasoningPattern(store, validInput)).toThrow(/simulated attachCaseRef/);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    expect(countBlocks(store)).toBe(0);
    expect(countCaseRefs(store)).toBe(0);
  });

  it("rolls back the block AND the origin ref when updateBlockStatus fails", async () => {
    const store = makeStore();
    const spy = vi.spyOn(store, "updateBlockStatus").mockImplementation(() => {
      throw new Error("simulated updateBlockStatus failure");
    });

    expect(() => storeReasoningPattern(store, validInput)).toThrow(/simulated updateBlockStatus/);

    spy.mockRestore();
    // Both the candidate block and the (already-attached) origin ref
    // must be gone — partial state would leave the next capture
    // colliding on the fingerprint-kind dedupe index.
    expect(countBlocks(store)).toBe(0);
    expect(countCaseRefs(store)).toBe(0);
  });

  it("does not block subsequent captures of the same fingerprint after a rolled-back failure", async () => {
    const store = makeStore();
    const spy = vi.spyOn(store, "updateBlockStatus").mockImplementation(() => {
      throw new Error("simulated updateBlockStatus failure");
    });
    expect(() => storeReasoningPattern(store, validInput)).toThrow();
    spy.mockRestore();

    // Now retry — same logical pattern, same fingerprint. Without
    // rollback, the orphaned candidate would trigger the (fingerprint,
    // kind) dedupe path and we'd attach a `supporting` ref to a stuck
    // candidate instead of cleanly inserting a fresh active block.
    const retry = storeReasoningPattern(store, validInput);
    expect(retry.isNew).toBe(true);

    const block = store.getBlock(retry.blockId)!;
    expect(block.status).toBe("active");
    const refs = store.listCaseRefs(retry.blockId);
    expect(refs.length).toBe(1);
    expect(refs[0]!.role).toBe("origin");
  });
});
