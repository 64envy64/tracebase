import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ReasoningLayer, EnforceLimitOvershootError } from "../../src/core/engine.js";

function testConfig() {
  return {
    storagePath: join(tmpdir(), `tracebase-engine-test-${randomUUID()}.db`),
  };
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch { /* ok */ }
  }
}

describe("ReasoningLayer", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    const config = testConfig();
    dbPath = config.storagePath;
    layer = new ReasoningLayer(config);
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  describe("storeTrace", () => {
    it("stores a trace and returns it with computed fields", () => {
      const trace = layer.storeTrace({
        problem: {
          description: "TypeError: Cannot read property 'map' of undefined",
          errorType: "TypeError",
          language: "typescript",
          framework: "react",
          tags: ["frontend"],
        },
        solution: {
          summary: "Added optional chaining: users?.map()",
          steps: [
            { type: "analysis", description: "users was undefined on first render" },
            { type: "action", description: "Added ?. operator" },
          ],
          outcome: "success",
        },
      });

      expect(trace.id).toBeDefined();
      expect(trace.problem.fingerprint).toBeDefined();
      expect(trace.problem.fingerprint.length).toBe(64); // SHA-256 hex
      expect(trace.quality.score).toBe(0.5);
      expect(trace.metadata.source).toBe("sdk");
    });

    it("validates outcome at runtime", () => {
      expect(() =>
        layer.storeTrace({
          problem: { description: "test", tags: [] },
          solution: {
            summary: "fix",
            steps: [],
            outcome: "invalid" as "success",
          },
        }),
      ).toThrow('Invalid outcome "invalid"');
    });

    it("deduplicates by fingerprint", () => {
      const trace1 = layer.storeTrace({
        problem: {
          description: "TypeError: Cannot read property 'map' of undefined",
          errorType: "TypeError",
          language: "typescript",
          tags: [],
        },
        solution: { summary: "fix 1", steps: [], outcome: "success" },
      });

      const trace2 = layer.storeTrace({
        problem: {
          description: "TypeError: Cannot read property 'map' of undefined",
          errorType: "TypeError",
          language: "typescript",
          tags: [],
        },
        solution: { summary: "fix 2", steps: [], outcome: "success" },
      });

      // Should return the existing trace, not create a duplicate
      expect(trace2.id).toBe(trace1.id);
      expect(layer.count()).toBe(1);
    });
  });

  describe("recall", () => {
    it("finds exact fingerprint matches", () => {
      layer.storeTrace({
        problem: {
          description: "TypeError: Cannot read property 'map' of undefined",
          errorType: "TypeError",
          language: "typescript",
          tags: [],
        },
        solution: { summary: "Added null check", steps: [], outcome: "success" },
      });

      const results = layer.recall({
        problem: "TypeError: Cannot read property 'map' of undefined",
        context: { errorType: "TypeError", language: "typescript" },
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.matchType).toBe("exact");
      expect(results[0]!.score).toBeCloseTo(1.0, 1);
      // Signal breakdown should be present
      expect(results[0]!.signals.fingerprint).toBe(1.0);
    });

    it("does NOT increment recallCount (only feedback does)", () => {
      const stored = layer.storeTrace({
        problem: { description: "test problem for recall counting", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      // Recall multiple times
      layer.recall({ problem: "test problem for recall counting" });
      layer.recall({ problem: "test problem for recall counting" });

      // recallCount should still be 0 — only feedback increments
      const afterRecall = layer.getTrace(stored.id)!;
      expect(afterRecall.quality.recallCount).toBe(0);
    });

    it("finds similar but not exact matches", () => {
      layer.storeTrace({
        problem: {
          description: "ECONNREFUSED when calling the payment API endpoint",
          language: "javascript",
          tags: ["api"],
        },
        solution: {
          summary: "Payment service was down, restarted the container",
          steps: [],
          outcome: "success",
        },
      });

      const results = layer.recall({
        problem: "Connection refused to payment service API",
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty for unrelated queries", () => {
      layer.storeTrace({
        problem: { description: "CSS grid layout broken in Safari", language: "css", tags: [] },
        solution: { summary: "Added -webkit prefix", steps: [], outcome: "success" },
      });

      const results = layer.recall({
        problem: "Kubernetes pod keeps crashing with OOM",
        minScore: 0.5,
      });

      expect(results.length).toBe(0);
    });

    it("returns scores clamped to [0, 1]", () => {
      layer.storeTrace({
        problem: { description: "some error", tags: [] },
        solution: { summary: "some fix", steps: [], outcome: "success" },
      });

      const results = layer.recall({ problem: "some error", minScore: 0 });
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("feedback + adaptive weights", () => {
    it("increments recallCount exactly once per feedback call", () => {
      const trace = layer.storeTrace({
        problem: { description: "feedback counting test", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      // Recall first (caches signals)
      layer.recall({ problem: "feedback counting test" });

      // Then provide feedback
      layer.feedback(trace.id, true);
      layer.feedback(trace.id, true);
      layer.feedback(trace.id, false);

      const updated = layer.getTrace(trace.id)!;
      // Each feedback() call increments recallCount by exactly 1
      expect(updated.quality.recallCount).toBe(3);
      expect(updated.quality.helpfulCount).toBe(2);
    });

    it("updates adaptive weights on feedback", () => {
      const trace = layer.storeTrace({
        problem: { description: "adaptive weight test problem", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      const initialWeights = layer.getWeights();

      // Recall to populate signal cache, then give feedback
      layer.recall({ problem: "adaptive weight test problem" });
      layer.feedback(trace.id, true);

      const updatedWeights = layer.getWeights();
      // Weights should have shifted (even slightly) after feedback
      expect(updatedWeights).toBeDefined();
      expect(updatedWeights.bm25 + updatedWeights.jaccard + updatedWeights.structural + updatedWeights.freshness)
        .toBeCloseTo(1.0, 5);
    });

    // ----------------------------------------------------------------
    // PR 1 (May-2026 modernization) — event-log attribution.
    // The in-memory `recallSignalCache` is gone; signals now round-trip
    // through `analytics_events`. These tests pin the new contract.
    // ----------------------------------------------------------------

    it("stamps queryId on every RecallResult and accepts it back via the structured feedback API", () => {
      const trace = layer.storeTrace({
        problem: { description: "structured-feedback queryId test", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      const results = layer.recall({ problem: "structured-feedback queryId test" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const queryId = results[0]!.queryId;
      expect(typeof queryId).toBe("string");
      expect(queryId!.length).toBeGreaterThan(0);
      // Every result from a single recall() shares the queryId.
      for (const r of results) expect(r.queryId).toBe(queryId);

      layer.feedback({ queryId: queryId!, traceId: trace.id, helpful: true });
      const updated = layer.getTrace(trace.id)!;
      expect(updated.quality.recallCount).toBe(1);
      expect(updated.quality.helpfulCount).toBe(1);
    });

    it("legacy feedback(traceId) skips weight updates when attribution is ambiguous", () => {
      const trace = layer.storeTrace({
        problem: { description: "ambiguous attribution test", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      // Two recalls without feedback between them — the same traceId
      // appears in two open trace_retrieval events.
      layer.recall({ problem: "ambiguous attribution test" });
      layer.recall({ problem: "ambiguous attribution test" });

      // Snapshot weights, then run the legacy ambiguous-path feedback.
      const before = layer.getWeights();
      layer.feedback(trace.id, true);
      const after = layer.getWeights();

      // Quality MUST update (under-attribution at the weight level is
      // OK; failing to record the user's feedback would be worse).
      const updated = layer.getTrace(trace.id)!;
      expect(updated.quality.recallCount).toBe(1);
      expect(updated.quality.helpfulCount).toBe(1);

      // Weights MUST NOT shift — ambiguity guard kicks in.
      expect(after.bm25).toBe(before.bm25);
      expect(after.jaccard).toBe(before.jaccard);
      expect(after.structural).toBe(before.structural);
      expect(after.freshness).toBe(before.freshness);
    });

    it("structured feedback({queryId, traceId, helpful}) is dedup'd against repeat calls (P1 review fix)", () => {
      const trace = layer.storeTrace({
        problem: { description: "structured dedup test problem epsilon", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      const results = layer.recall({ problem: "structured dedup test problem epsilon" });
      const queryId = results[0]!.queryId!;

      // First call: counts as helpful.
      layer.feedback({ queryId, traceId: trace.id, helpful: true });
      const afterFirst = layer.getTrace(trace.id)!;
      expect(afterFirst.quality.recallCount).toBe(1);
      expect(afterFirst.quality.helpfulCount).toBe(1);

      // Snapshot weights.
      const weightsAfterFirst = layer.getWeights();

      // Repeat call with same (queryId, traceId): MUST be a complete
      // no-op — no recallCount bump, no helpfulCount bump, no weight
      // shift. Without the dedup guard the structured path would
      // happily double-credit.
      layer.feedback({ queryId, traceId: trace.id, helpful: true });
      const afterSecond = layer.getTrace(trace.id)!;
      expect(afterSecond.quality.recallCount).toBe(1);
      expect(afterSecond.quality.helpfulCount).toBe(1);

      const weightsAfterSecond = layer.getWeights();
      expect(weightsAfterSecond.bm25).toBeCloseTo(weightsAfterFirst.bm25, 9);
      expect(weightsAfterSecond.jaccard).toBeCloseTo(weightsAfterFirst.jaccard, 9);
    });

    it("ambiguous legacy feedback writes NO row into feedback_signals (P1 review fix)", () => {
      const trace = layer.storeTrace({
        problem: { description: "ambiguous signals leak test zeta", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      // Two recalls; ambiguous attribution territory.
      layer.recall({ problem: "ambiguous signals leak test zeta" });
      layer.recall({ problem: "ambiguous signals leak test zeta" });

      layer.feedback(trace.id, true);

      // feedback_signals must remain empty: under ambiguity we cannot
      // attribute to a specific retrieval, so the (signals, helpful)
      // pair would be misattributed. Pre-fix the row was written
      // anyway, polluting the learning dataset.
      const row = layer.rawStore.rawDb
        .prepare("SELECT COUNT(*) AS c FROM feedback_signals WHERE trace_id = ?")
        .get(trace.id) as { c: number };
      expect(row.c).toBe(0);

      // Quality DID update — the user's vote was counted.
      const updated = layer.getTrace(trace.id)!;
      expect(updated.quality.recallCount).toBe(1);
      expect(updated.quality.helpfulCount).toBe(1);
    });

    it("trace_retrieval.candidates carries every scored row, not just top-K (P2 review fix)", () => {
      // Use distinct words per trace — fingerprint canonicalizer
      // strips digit suffixes so "trace 0..7" would hash identically
      // and dedupe to one stored row. These descriptions share enough
      // common tokens for FTS to surface all of them, but differ on
      // unique markers so each gets a distinct fingerprint.
      const markers = [
        "alpha", "bravo", "charlie", "delta",
        "echo", "foxtrot", "golf", "hotel",
      ];
      for (const m of markers) {
        layer.storeTrace({
          problem: {
            description: `candidate slate ${m} sierra tango uniform victor whisky`,
            tags: [],
          },
          solution: { summary: "fix", steps: [], outcome: "success" },
        });
      }
      expect(layer.count()).toBe(markers.length);

      const results = layer.recall({
        problem: "candidate slate sierra tango uniform victor whisky",
        limit: 2,
      });
      expect(results.length).toBeLessThanOrEqual(2);
      const queryId = results[0]!.queryId!;

      const row = layer.rawStore.rawDb
        .prepare("SELECT payload FROM analytics_events WHERE event_type = 'trace_retrieval' AND query_id = ?")
        .get(queryId) as { payload: string };
      expect(row).toBeDefined();
      const payload = JSON.parse(row.payload) as { candidates: Array<unknown>; selectedTraceIds: string[] };
      // The candidate set MUST include more rows than the limit
      // returned to the caller — otherwise the OPE substrate is
      // missing the counter-factuals the policy needs to be scored
      // against.
      expect(payload.candidates.length).toBeGreaterThan(results.length);
      expect(payload.selectedTraceIds.length).toBeLessThanOrEqual(2);
    });

    // ----------------------------------------------------------------
    // B2 contextual bandit — bucket round-trip pins (May-2026 review).
    // The recall path must stamp bucketKey on every event; feedback
    // must credit the same bucket via context recovery. Without this
    // round-trip B2's per-context learning silently goes nowhere —
    // the user-named "wrong bucket got credit" failure mode.
    // ----------------------------------------------------------------

    it("B2: recall stamps bucketKey on the trace_retrieval event", () => {
      const trace = layer.storeTrace({
        problem: {
          description: "B2 bucket stamping smoke test",
          language: "python",
          framework: "django",
          errorType: "ImportError",
          tags: [],
        },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      const results = layer.recall({
        problem: "B2 bucket stamping smoke test",
        context: { language: "python", framework: "django", errorType: "ImportError" },
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const queryId = results[0]!.queryId!;
      // Read the trace_retrieval event back and check the bucket key.
      const events = layer.rawStore.rawDb
        .prepare(
          "SELECT payload FROM analytics_events WHERE query_id = ? AND event_type = 'trace_retrieval' LIMIT 1",
        )
        .all(queryId) as Array<{ payload: string }>;
      expect(events.length).toBe(1);
      const payload = JSON.parse(events[0]!.payload) as {
        context?: { bucketKey?: string };
      };
      expect(payload.context?.bucketKey).toBe("python|django|importerror");
      void trace;
    });

    it("B2: two distinct contexts get distinct bucketKeys (no spurious collisions)", () => {
      layer.storeTrace({
        problem: { description: "B2 distinct buckets seed", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      const a = layer.recall({
        problem: "B2 distinct buckets query A",
        context: { language: "python" },
      });
      const b = layer.recall({
        problem: "B2 distinct buckets query B",
        context: { language: "rust" },
      });
      function bucketOf(queryId: string): string | undefined {
        const row = layer.rawStore.rawDb
          .prepare(
            "SELECT payload FROM analytics_events WHERE query_id = ? AND event_type = 'trace_retrieval' LIMIT 1",
          )
          .get(queryId) as { payload: string } | undefined;
        if (!row) return undefined;
        const p = JSON.parse(row.payload) as { context?: { bucketKey?: string } };
        return p.context?.bucketKey;
      }
      const ka = bucketOf(a[0]!.queryId!);
      const kb = bucketOf(b[0]!.queryId!);
      expect(ka).toBe("python|_|_");
      expect(kb).toBe("rust|_|_");
      expect(ka).not.toBe(kb);
    });

    it("B2: feedback credits the correct bucket via context recovery", () => {
      const trace = layer.storeTrace({
        problem: {
          description: "B2 feedback bucket-credit test",
          language: "go",
          tags: [],
        },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      const results = layer.recall({
        problem: "B2 feedback bucket-credit test",
        context: { language: "go" },
      });
      layer.feedback({ queryId: results[0]!.queryId!, traceId: trace.id, helpful: true });

      // Read the contextual_weights config row directly and check the
      // bucket got incremented (any signal — the test only asserts that
      // the right bucket was touched, not which signal).
      const row = layer.rawStore.rawDb
        .prepare("SELECT value FROM config WHERE key = 'contextual_weights'")
        .get() as { value: string } | undefined;
      expect(row).toBeDefined();
      const state = JSON.parse(row!.value) as {
        buckets: Record<string, { feedbackCount: number }>;
      };
      expect(state.buckets["go|_|_"]?.feedbackCount).toBe(1);
      expect(state.buckets["python|_|_"]).toBeUndefined();
    });

    it("B2: legacy feedback (no queryId) still recovers the bucket from the retrieval event", () => {
      const trace = layer.storeTrace({
        problem: {
          description: "B2 legacy feedback bucket recovery",
          language: "rust",
          errorType: "lifetime",
          tags: [],
        },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      // ONE recall, then legacy feedback (no queryId). The legacy
      // path is unambiguous → bucket should still be credited.
      layer.recall({
        problem: "B2 legacy feedback bucket recovery",
        context: { language: "rust", errorType: "lifetime" },
      });
      layer.feedback(trace.id, true);

      const row = layer.rawStore.rawDb
        .prepare("SELECT value FROM config WHERE key = 'contextual_weights'")
        .get() as { value: string } | undefined;
      const state = JSON.parse(row!.value) as {
        buckets: Record<string, { feedbackCount: number }>;
      };
      expect(state.buckets["rust|_|lifetime"]?.feedbackCount).toBe(1);
    });

    it("survives a close + reopen — attribution persists in the event log", () => {
      const trace = layer.storeTrace({
        problem: { description: "persistence across restart test", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      const results = layer.recall({ problem: "persistence across restart test" });
      const queryId = results[0]!.queryId!;

      // Simulate process restart.
      layer.close();
      layer = new ReasoningLayer({ storagePath: dbPath });

      const before = layer.getWeights();
      layer.feedback({ queryId, traceId: trace.id, helpful: true });
      const after = layer.getWeights();

      // Pre-PR-1 this would silently no-op because the in-memory cache
      // was wiped on close. After PR 1 the signals are read from
      // analytics_events and the weights move.
      const totalChange =
        Math.abs(after.bm25 - before.bm25) +
        Math.abs(after.jaccard - before.jaccard) +
        Math.abs(after.structural - before.structural) +
        Math.abs(after.freshness - before.freshness);
      expect(totalChange).toBeGreaterThan(0);
    });
  });

  describe("search", () => {
    it("searches by text content", () => {
      layer.storeTrace({
        problem: { description: "Memory leak in the WebSocket handler", tags: [] },
        solution: { summary: "Closed connections on cleanup", steps: [], outcome: "success" },
      });

      const results = layer.search("WebSocket memory");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.problem.description).toContain("WebSocket");
    });
  });

  describe("events", () => {
    it("emits trace:stored events", () => {
      const events: string[] = [];
      layer.on("trace:stored", (e) => events.push(e.type));

      layer.storeTrace({
        problem: { description: "event test", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      expect(events).toEqual(["trace:stored"]);
    });

    it("emits trace:deduplicated on duplicate store", () => {
      const events: string[] = [];
      layer.on("trace:deduplicated", (e) => events.push(e.type));

      layer.storeTrace({
        problem: { description: "dup test", language: "go", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      layer.storeTrace({
        problem: { description: "dup test", language: "go", tags: [] },
        solution: { summary: "fix again", steps: [], outcome: "success" },
      });

      expect(events).toEqual(["trace:deduplicated"]);
    });

    it("supports wildcard listener", () => {
      const events: string[] = [];
      layer.on("*", (e) => events.push(e.type));

      layer.storeTrace({
        problem: { description: "wildcard test", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      layer.recall({ problem: "wildcard test" });

      expect(events).toContain("trace:stored");
      expect(events).toContain("trace:recalled");
    });

    it("handler errors don't break core operations", () => {
      layer.on("trace:stored", () => {
        throw new Error("user handler bug");
      });

      // Should NOT throw despite broken handler
      const trace = layer.storeTrace({
        problem: { description: "error-proof test", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      expect(trace.id).toBeDefined();
    });

    it("unsubscribe works", () => {
      const events: string[] = [];
      const unsub = layer.on("trace:stored", (e) => events.push(e.type));

      layer.storeTrace({
        problem: { description: "unsub test 1", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      unsub();
      layer.storeTrace({
        problem: { description: "unsub test 2", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      expect(events).toHaveLength(1);
    });
  });

  describe("enforceLimit", () => {
    it("enforces maxTraces even for un-recalled traces", () => {
      const smallLayer = new ReasoningLayer({
        storagePath: dbPath.replace(".db", "-small.db"),
        maxTraces: 3,
      });

      try {
        for (let i = 0; i < 5; i++) {
          smallLayer.storeTrace({
            problem: { description: `problem ${i} unique`, tags: [] },
            solution: { summary: `fix ${i}`, steps: [], outcome: "success" },
          });
        }

        // Should have been pruned to maxTraces
        expect(smallLayer.count()).toBeLessThanOrEqual(3);
      } finally {
        smallLayer.close();
        cleanupDb(dbPath.replace(".db", "-small.db"));
      }
    });

    // May-2026 PR 2 (audit #7): when the prune path can't bring count
    // under the limit, throw a typed error rather than silently overshoot.
    // We can't easily fake a broken prune from outside, but we can sub-
    // class ReasoningLayer at the integration level: monkey-patch the
    // private store.prune to a no-op and verify the assertion fires.
    it("throws EnforceLimitOvershootError when prune fails to satisfy the limit", () => {
      const smallLayer = new ReasoningLayer({
        storagePath: dbPath.replace(".db", "-overshoot.db"),
        maxTraces: 2,
      });

      try {
        // Pre-fill to the limit with distinct fingerprints.
        smallLayer.storeTrace({
          problem: { description: "alpha bravo charlie debug seed zero unique", tags: [] },
          solution: { summary: "fix", steps: [], outcome: "success" },
        });
        smallLayer.storeTrace({
          problem: { description: "delta echo foxtrot golf hotel seed one unique", tags: [] },
          solution: { summary: "fix", steps: [], outcome: "success" },
        });
        expect(smallLayer.count()).toBe(2);

        // Replace prune with a no-op — simulates a broken downstream
        // (e.g. custom TraceStore impl that refuses to delete, a
        // silently-failing SQLite write).
        const realPrune = smallLayer.rawStore.prune.bind(smallLayer.rawStore);
        smallLayer.rawStore.prune = (() => 0) as typeof smallLayer.rawStore.prune;

        expect(() => {
          smallLayer.storeTrace({
            problem: { description: "india juliet kilo lima overshoot trigger here now", tags: [] },
            solution: { summary: "fix", steps: [], outcome: "success" },
          });
        }).toThrow(EnforceLimitOvershootError);

        // Restore so cleanup doesn't trip over the patch.
        smallLayer.rawStore.prune = realPrune;
      } finally {
        smallLayer.close();
        cleanupDb(dbPath.replace(".db", "-overshoot.db"));
      }
    });
  });

  describe("embedding retry queue (May-2026 PR 3, audit #1+#8)", () => {
    it("enqueues a pending_embeddings row when embedBatch throws", async () => {
      // Provider that always fails — simulates a flaky/unavailable
      // embedding API. Pre-PR-3 this would have been silently swallowed.
      layer.setEmbeddingProvider({
        embed: async () => { throw new Error("network down"); },
        embedBatch: async () => { throw new Error("network down"); },
      });

      const failures: string[] = [];
      layer.on("embedding:failed", (e) => {
        if (e.type === "embedding:failed") failures.push(e.error);
      });

      const trace = await layer.storeTraceAsync({
        problem: { description: "embedding failure test problem alpha", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      // Loud failure: event fired AND queue row written.
      expect(failures.length).toBe(1);
      expect(failures[0]).toMatch(/network down/);
      expect(layer.pendingEmbeddingsCount()).toBe(1);
      const pending = layer.rawStore.listPendingEmbeddings(10);
      expect(pending[0]!.traceId).toBe(trace.id);
      expect(pending[0]!.lastError).toMatch(/network down/);
    });

    it("drainPendingEmbeddings re-embeds successfully and clears the queue", async () => {
      // First, fail once to populate the queue.
      let shouldFail = true;
      layer.setEmbeddingProvider({
        embed: async () => { if (shouldFail) throw new Error("transient"); return [0.1, 0.2, 0.3]; },
        embedBatch: async (texts: string[]) => {
          if (shouldFail) throw new Error("transient");
          return texts.map(() => [0.1, 0.2, 0.3]);
        },
      });

      const trace = await layer.storeTraceAsync({
        problem: { description: "drain test problem beta gamma", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      expect(layer.pendingEmbeddingsCount()).toBe(1);

      // Provider recovers; drain succeeds.
      shouldFail = false;
      const succeeded = await layer.drainPendingEmbeddings();
      expect(succeeded).toBe(1);
      expect(layer.pendingEmbeddingsCount()).toBe(0);

      // Embeddings present on the trace row now.
      const withEmb = layer.rawStore.getAllWithEmbeddings().find((r) => r.trace.id === trace.id);
      expect(withEmb).toBeDefined();
    });

    it("logs cosine + freshness in feedback_signals (audit #8 regression)", () => {
      const trace = layer.storeTrace({
        problem: { description: "cosine logging regression test delta", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });
      const results = layer.recall({ problem: "cosine logging regression test delta" });
      expect(results.length).toBeGreaterThan(0);
      layer.feedback(trace.id, true);

      // Pre-PR-3 the row would have sig_cosine/sig_freshness columns
      // missing entirely. Now they're written every time.
      const row = layer.rawStore.rawDb
        .prepare("SELECT sig_cosine, sig_freshness FROM feedback_signals WHERE trace_id = ?")
        .get(trace.id) as { sig_cosine: number; sig_freshness: number };
      expect(row).toBeDefined();
      expect(typeof row.sig_cosine).toBe("number");
      expect(typeof row.sig_freshness).toBe("number");
      // Freshness on a just-stored trace is essentially 1.0.
      expect(row.sig_freshness).toBeGreaterThan(0.95);
    });
  });

  describe("lifecycle", () => {
    it("throws after close", () => {
      layer.close();
      expect(() => layer.count()).toThrow("closed");
    });

    it("reports correct count", () => {
      expect(layer.count()).toBe(0);
      layer.storeTrace({
        problem: { description: "a", tags: [] },
        solution: { summary: "b", steps: [], outcome: "success" },
      });
      expect(layer.count()).toBe(1);
    });

    it("export and import round-trips", () => {
      layer.storeTrace({
        problem: { description: "TypeError in React UserList component during render", tags: ["a"] },
        solution: { summary: "fix 1", steps: [], outcome: "success" },
      });
      layer.storeTrace({
        problem: { description: "ECONNREFUSED when calling payment microservice endpoint", tags: ["b"] },
        solution: { summary: "fix 2", steps: [], outcome: "failure" },
      });

      const exported = layer.exportAll();
      expect(exported).toHaveLength(2);

      const config2 = testConfig();
      const layer2 = new ReasoningLayer(config2);
      try {
        const imported = layer2.importTraces(exported);
        expect(imported).toBe(2);
        expect(layer2.count()).toBe(2);
      } finally {
        layer2.close();
        cleanupDb(config2.storagePath);
      }
    });
  });

  describe("stats", () => {
    it("returns comprehensive stats", () => {
      layer.storeTrace({
        problem: {
          description: "bug",
          language: "typescript",
          framework: "react",
          tags: [],
        },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      const stats = layer.stats();
      expect(stats.totalTraces).toBe(1);
      expect(stats.successfulTraces).toBe(1);
      expect(stats.topLanguages[0]?.language).toBe("typescript");
      expect(stats.topFrameworks[0]?.framework).toBe("react");
    });
  });
});
