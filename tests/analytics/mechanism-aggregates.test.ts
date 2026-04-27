/**
 * Mechanism aggregates emit-site — tests (PLAN-0.7 §6 stable §2).
 *
 * Pin the round-trip:
 *   raw events
 *      → computeAggregates(store)        // tally over event walk
 *      → computeUsageMetrics(agg)        // copy to UsageMetrics.mechanisms
 *      → sanitizeForCloud(payload)       // drop anything outside the spec
 *
 * What MUST land on the wire:
 *   - per-event-kind counts (completedCount, recallCount, warnCount, …)
 *   - closed-enum histograms (bySummarizer, byFamily, byKind, byReason,
 *     bySurface, byPattern)
 *
 * What must NEVER land on the wire:
 *   - paths, fileIds, sessionId, argKey, raw toolName, summary text,
 *     chunkRange, anchorId, patternName text outside the closed enum.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { computeAggregates } from "../../src/core/analytics.js";
import { computeUsageMetrics } from "../../src/analytics/usage-metrics.js";
import {
  sanitizeForCloud,
  USAGE_SAMPLE_ALLOWLIST,
} from "../../src/cli/cloud-allowlist.js";

let store: BlockStore;

beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// 1) Tally correctness — every mechanism event-kind lands in its bucket
// ---------------------------------------------------------------------------

describe("computeAggregates.mechanisms — counts + closed-enum tallies", () => {
  it("file_index.completed sums counts/bytes/durations and bins by summarizer", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "file_index.completed",
      fileCount: 12, bytesSummarized: 4_000, durationMs: 50, summarizer: "heuristic", pending: 0,
    });
    store.appendEvent({
      ts: 200, queryId: "q2", event: "file_index.completed",
      fileCount: 8, bytesSummarized: 2_000, durationMs: 30, summarizer: "embedding", pending: 5,
    });
    const agg = computeAggregates(store);
    expect(agg.mechanisms.fileIndex.completedCount).toBe(2);
    expect(agg.mechanisms.fileIndex.bytesSummarized).toBe(6_000);
    expect(agg.mechanisms.fileIndex.durationMs).toBe(80);
    expect(agg.mechanisms.fileIndex.pending).toBe(5); // last-write wins
    expect(agg.mechanisms.fileIndex.bySummarizer).toEqual({
      heuristic: 1, embedding: 1, llm: 0,
    });
  });

  it("file_index.skipped just bumps the count (reason set is open-ended)", () => {
    store.appendEvent({ ts: 100, queryId: "q1", event: "file_index.skipped", reason: "binary" });
    store.appendEvent({ ts: 200, queryId: "q2", event: "file_index.skipped", reason: "future-reason-x" });
    const agg = computeAggregates(store);
    expect(agg.mechanisms.fileIndex.skippedCount).toBe(2);
  });

  it("file_memory.recalled sums tokensInjected + bytesAvoided, never reads fileIds", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "file_memory.recalled",
      fileIds: ["src/a.ts", "src/b.ts"], tokensInjected: 200, bytesAvoided: 4_000,
    });
    store.appendEvent({
      ts: 200, queryId: "q2", event: "file_memory.recalled",
      fileIds: ["src/c.ts"], tokensInjected: 100, bytesAvoided: 1_500,
    });
    const agg = computeAggregates(store);
    expect(agg.mechanisms.fileMemory.recallCount).toBe(2);
    expect(agg.mechanisms.fileMemory.tokensInjected).toBe(300);
    expect(agg.mechanisms.fileMemory.bytesAvoided).toBe(5_500);
    // Sanity: the aggregate carries no list-shaped surface that
    // could leak fileIds.
    expect(JSON.stringify(agg.mechanisms.fileMemory)).not.toContain("src/");
  });

  it("tool_supervision events tally warn/suppressed counts and family histogram", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "tool_supervision.warned",
      argKey: "k1", toolName: "Read", mode: "warn",
    });
    store.appendEvent({
      ts: 110, queryId: "q2", event: "tool_supervision.warned",
      argKey: "k2", toolName: "WebFetch", mode: "block",
    });
    store.appendEvent({
      ts: 120, queryId: "q3", event: "tool_supervision.suppressed",
      argKey: "k1", toolName: "Read", blocked: true,
    });
    store.appendEvent({
      ts: 130, queryId: "q4", event: "tool_supervision.suppressed",
      argKey: "k4", toolName: "FuturisticMystery", blocked: false,
    });
    const agg = computeAggregates(store);
    expect(agg.mechanisms.toolSupervision.warnCount).toBe(2);
    expect(agg.mechanisms.toolSupervision.suppressedCount).toBe(2);
    expect(agg.mechanisms.toolSupervision.byFamily.read).toBe(2);   // 1 warn + 1 suppressed
    expect(agg.mechanisms.toolSupervision.byFamily.web).toBe(1);    // WebFetch
    expect(agg.mechanisms.toolSupervision.byFamily.other).toBe(1);  // unknown → other
    // Sanity: argKey + raw toolName never reach the aggregate.
    const json = JSON.stringify(agg.mechanisms.toolSupervision);
    expect(json).not.toContain("k1");
    expect(json).not.toContain("Read");
    expect(json).not.toContain("WebFetch");
    expect(json).not.toContain("FuturisticMystery");
  });

  it("loop.redirected / loop.fallback split into redirect+fallback counts and byKind", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "loop.redirected",
      signal: "duplicate", anchorId: "block-abc", anchorKind: "block", confidence: 0.8,
    });
    store.appendEvent({
      ts: 110, queryId: "q2", event: "loop.redirected",
      signal: "pingpong", anchorId: "src/a.ts", anchorKind: "file", confidence: 0.7,
    });
    store.appendEvent({
      ts: 120, queryId: "q3", event: "loop.fallback",
      signal: "straight", reason: "no-hit",
    });
    const agg = computeAggregates(store);
    expect(agg.mechanisms.loopRedirect.redirectCount).toBe(2);
    expect(agg.mechanisms.loopRedirect.fallbackCount).toBe(1);
    expect(agg.mechanisms.loopRedirect.byKind).toEqual({ block: 1, file: 1 });
    // Sanity: anchorId never reaches the aggregate.
    const json = JSON.stringify(agg.mechanisms.loopRedirect);
    expect(json).not.toContain("block-abc");
    expect(json).not.toContain("src/a.ts");
  });

  it("context.folded / context.fold_skipped split into chunk/skip counts and reason histogram", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "context.folded",
      sessionId: "s1", chunkRange: "0-7",
      tokensBefore: 1200, tokensAfter: 200, summarizer: "heuristic",
    });
    store.appendEvent({
      ts: 110, queryId: "q2", event: "context.folded",
      sessionId: "s1", chunkRange: "8-15",
      tokensBefore: 4000, tokensAfter: 600, summarizer: "embedding",
    });
    store.appendEvent({
      ts: 120, queryId: "q3", event: "context.fold_skipped", reason: "leakage",
    });
    store.appendEvent({
      ts: 130, queryId: "q4", event: "context.fold_skipped", reason: "below-threshold",
    });
    const agg = computeAggregates(store);
    expect(agg.mechanisms.contextFold.chunkCount).toBe(2);
    expect(agg.mechanisms.contextFold.tokensBeforeSum).toBe(5200);
    expect(agg.mechanisms.contextFold.tokensAfterSum).toBe(800);
    expect(agg.mechanisms.contextFold.skipCount).toBe(2);
    expect(agg.mechanisms.contextFold.bySummarizer).toEqual({
      heuristic: 1, embedding: 1, llm: 0,
    });
    expect(agg.mechanisms.contextFold.byReason.leakage).toBe(1);
    expect(agg.mechanisms.contextFold.byReason["below-threshold"]).toBe(1);
    // Sanity: sessionId + chunkRange never reach the aggregate.
    const json = JSON.stringify(agg.mechanisms.contextFold);
    expect(json).not.toContain("s1");
    expect(json).not.toContain("0-7");
  });

  it("store.injection_rejected tallies by closed-enum patternName", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "store.injection_rejected",
      surface: "block", patternName: "role-override",
    });
    store.appendEvent({
      ts: 110, queryId: "q2", event: "store.injection_rejected",
      surface: "fact", patternName: "tool-coercion",
    });
    // Unknown pattern name — counted but NOT bucketed.
    store.appendEvent({
      ts: 120, queryId: "q3", event: "store.injection_rejected",
      surface: "indexer", patternName: "future-pattern-xyz",
    });
    const agg = computeAggregates(store);
    expect(agg.mechanisms.injectionRejected.rejectCount).toBe(3);
    expect(agg.mechanisms.injectionRejected.byPattern["role-override"]).toBe(1);
    expect(agg.mechanisms.injectionRejected.byPattern["tool-coercion"]).toBe(1);
    // Unknown pattern doesn't widen the histogram.
    const json = JSON.stringify(agg.mechanisms.injectionRejected.byPattern);
    expect(json).not.toContain("future-pattern-xyz");
  });

  it("cache.prompt_hit sums tokensSavedSum and bins bySurface", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "cache.prompt_hit",
      surface: "anthropic", tokensSaved: 1500,
    });
    store.appendEvent({
      ts: 200, queryId: "q2", event: "cache.prompt_hit",
      surface: "openai", tokensSaved: 800,
    });
    const agg = computeAggregates(store);
    expect(agg.mechanisms.promptCache.hitCount).toBe(2);
    expect(agg.mechanisms.promptCache.tokensSavedSum).toBe(2300);
    expect(agg.mechanisms.promptCache.bySurface).toEqual({ anthropic: 1, openai: 1 });
  });
});

// ---------------------------------------------------------------------------
// 2) UsageMetrics.mechanisms — derives from agg.mechanisms verbatim
// ---------------------------------------------------------------------------

describe("computeUsageMetrics.mechanisms — passthrough from EventAggregates", () => {
  it("UsageMetrics.mechanisms equals agg.mechanisms (no renames, no shape drift)", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "context.folded",
      sessionId: "s1", chunkRange: "0-7",
      tokensBefore: 1000, tokensAfter: 200, summarizer: "heuristic",
    });
    store.appendEvent({
      ts: 110, queryId: "q2", event: "cache.prompt_hit",
      surface: "anthropic", tokensSaved: 600,
    });
    const agg = computeAggregates(store);
    const metrics = computeUsageMetrics(agg);
    expect(metrics.mechanisms).toEqual(agg.mechanisms);
  });
});

// ---------------------------------------------------------------------------
// 3) Cloud sanitiser — every documented field survives, free-form drops
// ---------------------------------------------------------------------------

describe("sanitizeForCloud(metrics) — mechanism aggregates pass + free-form drops", () => {
  it("declared mechanisms.* fields survive the sanitiser", () => {
    store.appendEvent({
      ts: 100, queryId: "q1", event: "context.folded",
      sessionId: "s1", chunkRange: "0-7",
      tokensBefore: 1200, tokensAfter: 200, summarizer: "heuristic",
    });
    store.appendEvent({
      ts: 110, queryId: "q2", event: "cache.prompt_hit",
      surface: "anthropic", tokensSaved: 1500,
    });
    store.appendEvent({
      ts: 120, queryId: "q3", event: "tool_supervision.warned",
      argKey: "kA", toolName: "Read", mode: "block",
    });
    const agg = computeAggregates(store);
    const metrics = computeUsageMetrics(agg);
    const sanitized = sanitizeForCloud(
      {
        installationId: "inst-1",
        windowStart: "2026-04-26T00:00:00Z",
        windowEnd: "2026-04-27T00:00:00Z",
        cliVersion: "0.7.0",
        metrics,
      },
      USAGE_SAMPLE_ALLOWLIST,
    ) as { metrics?: { mechanisms?: Record<string, unknown> } };

    const mech = sanitized.metrics?.mechanisms ?? {};
    const fold = (mech as { contextFold?: Record<string, unknown> }).contextFold ?? {};
    expect(fold.chunkCount).toBe(1);
    expect(fold.tokensBeforeSum).toBe(1200);
    expect(fold.tokensAfterSum).toBe(200);
    expect(fold.bySummarizer).toEqual({ heuristic: 1, embedding: 0, llm: 0 });
    const cache = (mech as { promptCache?: Record<string, unknown> }).promptCache ?? {};
    expect(cache.hitCount).toBe(1);
    expect(cache.tokensSavedSum).toBe(1500);
    expect(cache.bySurface).toEqual({ anthropic: 1, openai: 0 });
    const tools = (mech as { toolSupervision?: Record<string, unknown> }).toolSupervision ?? {};
    expect(tools.warnCount).toBe(1);
    expect((tools.byFamily as Record<string, number>).read).toBe(1);
  });

  it("free-form values that sneak into the aggregate are stripped at the wire", () => {
    // Hand-craft a mechanisms object with extra junk fields the
    // aggregator doesn't normally produce. The sanitiser must drop
    // them — that's the sole defence against a future refactor that
    // accidentally emits raw paths or sessionIds into the aggregate.
    const metrics = {
      scope: "workspace",
      window: { afterTs: 0, beforeTs: 1000 },
      observed: {
        eligibleRuns: 1, recalledRuns: 1, injectedRuns: 1,
        usedRuns: 0, helpfulRuns: 0, resolvedRateWithMemory: null,
      },
      estimated: {
        tokensSaved: { value: null, sampleSize: 0, formula: "" },
        latencySavedMs: { value: null, sampleSize: 0, formula: "" },
        heuristicTokensSaved: { value: 0, sampleSize: 0, formula: "" },
        heuristicLatencySavedMs: { value: 0, sampleSize: 0, formula: "" },
      },
      integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
      totalInjectedTokensEstimate: 0,
      mechanisms: {
        fileIndex: {
          completedCount: 1, bytesSummarized: 100, durationMs: 5,
          pending: 0, skippedCount: 0,
          bySummarizer: { heuristic: 1, embedding: 0, llm: 0 },
          // Junk leaf — must drop.
          rawPath: "/Users/me/secret-project/src/secret.ts",
        },
        toolSupervision: {
          warnCount: 1, suppressedCount: 0,
          byFamily: { read: 1, search: 0, shell: 0, edit: 0, write: 0, web: 0, task: 0, other: 0 },
          // Junk leaf — must drop.
          argKey: "secret-arg-key-123",
        },
      },
    };
    const sanitized = sanitizeForCloud(
      {
        installationId: "i", windowStart: "2026-04-26T00:00:00Z",
        windowEnd: "2026-04-27T00:00:00Z", cliVersion: "0.7.0",
        metrics,
      },
      USAGE_SAMPLE_ALLOWLIST,
    ) as { metrics?: { mechanisms?: Record<string, Record<string, unknown>> } };
    const mech = sanitized.metrics?.mechanisms ?? {};
    expect(mech.fileIndex?.rawPath).toBeUndefined();
    expect(mech.toolSupervision?.argKey).toBeUndefined();
    // Sanity: the JSON form has no eye-catchers.
    const json = JSON.stringify(sanitized);
    expect(json).not.toContain("secret-project");
    expect(json).not.toContain("secret-arg-key-123");
  });
});
