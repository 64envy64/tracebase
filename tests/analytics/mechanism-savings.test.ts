/**
 * Estimated mechanism savings (PLAN-0.7 §rc.7) — tests.
 *
 * Spec'd contract:
 *   - context_compression_saved = Σ (tokens_before - tokens_after)
 *     over `context.folded` events
 *   - file_memory_avoided       = Σ (bytesAvoided/4 - tokensInjected)
 *     over `file_memory.recalled` events, clamped to 0
 *   - tool_supervision_avoided  = Σ per_family_estimate over
 *     ACTUAL BLOCKS:
 *       - `tool_supervision.warned { mode: "block" }` — first
 *         duplicate hit in strict mode for safe-read families
 *       - `tool_supervision.suppressed { blocked: true }` —
 *         subsequent duplicate hits in strict mode (warn-once
 *         dedupe + block decision both fire)
 *     Warn-mode events (the duplicate Read still ran) contribute
 *     ZERO — counting them would overstate savings for zero-config
 *     users.
 *   - prompt_cache_saved        = Σ tokensSaved over `cache.prompt_hit`
 *     events (provider-reported only)
 *   - total                     = sum of the four
 *
 * Components MUST never be conflated with verified causal lift
 * (the holdout block lives elsewhere); this aggregator never
 * produces a "saved" number that could be misread as causal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  computeMechanismSavings,
  TOOL_FAMILY_TOKEN_ESTIMATE,
} from "../../src/analytics/mechanism-savings.js";

let store: BlockStore;

beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// Empty / no events
// ---------------------------------------------------------------------------

describe("computeMechanismSavings — empty store", () => {
  it("returns zeros across all four components", () => {
    const out = computeMechanismSavings(store);
    expect(out.contextCompressionSaved).toBe(0);
    expect(out.fileMemoryAvoided).toBe(0);
    expect(out.toolSupervisionAvoided).toBe(0);
    expect(out.promptCacheSaved).toBe(0);
    expect(out.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// context_compression_saved
// ---------------------------------------------------------------------------

describe("computeMechanismSavings — context.folded", () => {
  it("sums (tokens_before - tokens_after) across folded events", () => {
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "0-7",
      tokensBefore: 1200,
      tokensAfter: 200,
      summarizer: "heuristic",
    });
    store.appendEvent({
      ts: 200,
      queryId: "q2",
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "8-15",
      tokensBefore: 4000,
      tokensAfter: 600,
      summarizer: "heuristic",
    });
    const out = computeMechanismSavings(store);
    expect(out.contextCompressionSaved).toBe(1000 + 3400);
    expect(out.total).toBe(1000 + 3400);
  });

  it("ignores rows where tokens_before <= tokens_after (no negative savings)", () => {
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "0-7",
      tokensBefore: 200,
      tokensAfter: 250, // pathological — summary somehow longer
      summarizer: "heuristic",
    });
    const out = computeMechanismSavings(store);
    expect(out.contextCompressionSaved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// file_memory_avoided
// ---------------------------------------------------------------------------

describe("computeMechanismSavings — file_memory.recalled", () => {
  it("sums (bytesAvoided/4 - tokensInjected) across recalled events", () => {
    // bytesAvoided=8000 → 2000 tokens; tokensInjected=300 → saved 1700.
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "file_memory.recalled",
      fileIds: ["src/a.ts", "src/b.ts"],
      tokensInjected: 300,
      bytesAvoided: 8_000,
    });
    // bytesAvoided=4000 → 1000 tokens; tokensInjected=200 → saved 800.
    store.appendEvent({
      ts: 200,
      queryId: "q2",
      event: "file_memory.recalled",
      fileIds: ["src/c.ts"],
      tokensInjected: 200,
      bytesAvoided: 4_000,
    });
    const out = computeMechanismSavings(store);
    expect(out.fileMemoryAvoided).toBe(1700 + 800);
  });

  it("clamps to 0 when injection cost exceeded full-file tokens (rare wordy summary)", () => {
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "file_memory.recalled",
      fileIds: ["tiny.ts"],
      tokensInjected: 500,
      bytesAvoided: 800, // 200 tokens — less than injection cost
    });
    const out = computeMechanismSavings(store);
    expect(out.fileMemoryAvoided).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tool_supervision_avoided
// ---------------------------------------------------------------------------

describe("computeMechanismSavings — tool_supervision (block-mode only)", () => {
  it("counts `warned { mode: 'block' }` and `suppressed { blocked: true }` per-family", () => {
    // First-block hits surface as warned(mode='block'). Repeat
    // duplicates in strict mode surface as suppressed(blocked=true).
    // Both represent ACTUAL blocked tool executions and are
    // weighted by the per-family token estimate.
    //
    //   warned mode=block:
    //     1× Read   → 1500
    //     1× Grep   →  800
    //   suppressed blocked=true:
    //     1× Read   → 1500  (subsequent duplicate Read in strict)
    //     1× WebFetch → 2000 (web family, was 'fetch' pre-hardening)
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "tool_supervision.warned",
      argKey: "k1",
      toolName: "Read",
      mode: "block",
    });
    store.appendEvent({
      ts: 110,
      queryId: "q2",
      event: "tool_supervision.warned",
      argKey: "k2",
      toolName: "Grep",
      mode: "block",
    });
    store.appendEvent({
      ts: 120,
      queryId: "q3",
      event: "tool_supervision.suppressed",
      argKey: "k1",
      toolName: "Read",
      blocked: true,
    });
    store.appendEvent({
      ts: 130,
      queryId: "q4",
      event: "tool_supervision.suppressed",
      argKey: "k4",
      toolName: "WebFetch",
      blocked: true,
    });
    const out = computeMechanismSavings(store);
    expect(out.toolSupervisionAvoided).toBe(1500 + 800 + 1500 + 2000);
  });

  it("warn-mode events contribute ZERO (the duplicate tool still ran)", () => {
    // warned with mode='warn' — duplicate Read still executed.
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "tool_supervision.warned",
      argKey: "k1",
      toolName: "Read",
      mode: "warn",
    });
    // suppressed with blocked=false — duplicate Read still executed.
    store.appendEvent({
      ts: 110,
      queryId: "q2",
      event: "tool_supervision.suppressed",
      argKey: "k1",
      toolName: "Read",
      blocked: false,
    });
    const out = computeMechanismSavings(store);
    expect(out.toolSupervisionAvoided).toBe(0);
  });

  it("legacy suppressed events without `blocked` field are treated as warn-mode (zero savings)", () => {
    // Pre-hardening DBs may carry suppressed events that don't
    // have the `blocked` field. The aggregator must NOT credit
    // them as savings — when in doubt, the honest answer is zero.
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "tool_supervision.suppressed",
      argKey: "k1",
      toolName: "Read",
      // intentionally NO blocked field — simulates pre-hardening row
    } as Parameters<typeof store.appendEvent>[0]);
    const out = computeMechanismSavings(store);
    expect(out.toolSupervisionAvoided).toBe(0);
  });

  it("unknown tool names map to the 'other' family", () => {
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "tool_supervision.suppressed",
      argKey: "kA",
      toolName: "FuturisticMystery",
      blocked: true,
    });
    const out = computeMechanismSavings(store);
    expect(out.toolSupervisionAvoided).toBe(TOOL_FAMILY_TOKEN_ESTIMATE.other);
  });

  it("WebFetch maps to the canonical 'web' family (not 'fetch')", () => {
    // Pre-hardening, the local mirror keyed on 'fetch' while the
    // canonical vocabulary said 'web'. This regression pins the
    // alignment: WebFetch + the 'web' bucket value, not 'fetch'.
    store.appendEvent({
      ts: 100,
      queryId: "q-web",
      event: "tool_supervision.suppressed",
      argKey: "kW",
      toolName: "WebFetch",
      blocked: true,
    });
    const out = computeMechanismSavings(store);
    expect(out.toolSupervisionAvoided).toBe(TOOL_FAMILY_TOKEN_ESTIMATE.web);
    // Sanity-check: the map carries 'web' not 'fetch'.
    expect((TOOL_FAMILY_TOKEN_ESTIMATE as Record<string, unknown>).web).toBe(2000);
    expect((TOOL_FAMILY_TOKEN_ESTIMATE as Record<string, unknown>).fetch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// prompt_cache_saved (provider-reported only)
// ---------------------------------------------------------------------------

describe("computeMechanismSavings — cache.prompt_hit", () => {
  it("sums tokensSaved across both surfaces", () => {
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "cache.prompt_hit",
      surface: "anthropic",
      tokensSaved: 1500,
    });
    store.appendEvent({
      ts: 200,
      queryId: "q2",
      event: "cache.prompt_hit",
      surface: "openai",
      tokensSaved: 800,
    });
    const out = computeMechanismSavings(store);
    expect(out.promptCacheSaved).toBe(1500 + 800);
  });

  it("zero when no cache.prompt_hit events landed (NEVER estimates from model name)", () => {
    // Nothing appended for cache.prompt_hit. Even if other
    // mechanism events fired, prompt cache stays zero — this is
    // the spec's "we surface what the provider reports, never
    // estimate" contract.
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "0-7",
      tokensBefore: 1000,
      tokensAfter: 100,
      summarizer: "heuristic",
    });
    const out = computeMechanismSavings(store);
    expect(out.promptCacheSaved).toBe(0);
    expect(out.contextCompressionSaved).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// Total + window
// ---------------------------------------------------------------------------

describe("computeMechanismSavings — total + window", () => {
  it("total equals the sum of all four components", () => {
    store.appendEvent({
      ts: 100,
      queryId: "q1",
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "0-7",
      tokensBefore: 1200,
      tokensAfter: 200,
      summarizer: "heuristic",
    });
    store.appendEvent({
      ts: 110,
      queryId: "q2",
      event: "file_memory.recalled",
      fileIds: ["src/a.ts"],
      tokensInjected: 100,
      bytesAvoided: 2_000,
    });
    store.appendEvent({
      ts: 120,
      queryId: "q3",
      event: "tool_supervision.suppressed",
      argKey: "kA",
      toolName: "Read",
      blocked: true,
    });
    store.appendEvent({
      ts: 130,
      queryId: "q4",
      event: "cache.prompt_hit",
      surface: "anthropic",
      tokensSaved: 600,
    });
    const out = computeMechanismSavings(store);
    expect(out.contextCompressionSaved).toBe(1000);
    expect(out.fileMemoryAvoided).toBe(500 - 100); // 2000/4=500, -100 = 400
    expect(out.toolSupervisionAvoided).toBe(1500);
    expect(out.promptCacheSaved).toBe(600);
    expect(out.total).toBe(1000 + 400 + 1500 + 600);
  });

  it("filters by [afterTs, beforeTs)", () => {
    store.appendEvent({
      ts: 100,
      queryId: "q-old",
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "0-7",
      tokensBefore: 1000,
      tokensAfter: 100,
      summarizer: "heuristic",
    });
    store.appendEvent({
      ts: 500,
      queryId: "q-mid",
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "8-15",
      tokensBefore: 2000,
      tokensAfter: 200,
      summarizer: "heuristic",
    });
    store.appendEvent({
      ts: 900,
      queryId: "q-new",
      event: "context.folded",
      sessionId: "s1",
      chunkRange: "16-23",
      tokensBefore: 3000,
      tokensAfter: 300,
      summarizer: "heuristic",
    });
    // Window [400, 800) → only q-mid (ts=500) qualifies.
    const out = computeMechanismSavings(store, { afterTs: 400, beforeTs: 800 });
    expect(out.contextCompressionSaved).toBe(1800); // 2000 - 200
  });
});
