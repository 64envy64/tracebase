import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { TraceStore } from "../../src/core/store.js";
import type { ReasoningTrace } from "../../src/types.js";

function testDbPath(): string {
  return join(tmpdir(), `tracebase-test-${randomUUID()}.db`);
}

function makeTrace(overrides?: Partial<ReasoningTrace>): ReasoningTrace {
  const now = Date.now();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    problem: {
      description: "TypeError: Cannot read property 'map' of undefined",
      errorType: "TypeError",
      errorMessage: "Cannot read property 'map' of undefined",
      filePath: "src/components/UserList.tsx",
      language: "typescript",
      framework: "react",
      tags: ["frontend", "runtime-error"],
      fingerprint: "abc123",
    },
    solution: {
      summary: "Add null check before mapping over the array",
      steps: [
        {
          type: "analysis",
          description: "The users array was undefined on initial render",
        },
        {
          type: "action",
          description: "Added optional chaining: users?.map()",
        },
      ],
      outcome: "success",
      explanation: "The API response hadn't loaded yet on first render",
    },
    metadata: {
      agent: "test-agent",
      model: "gpt-4",
      tokensUsed: 500,
      durationMs: 2000,
      source: "test",
    },
    quality: {
      recallCount: 0,
      helpfulCount: 0,
      score: 0.5,
    },
    ...overrides,
  };
}

describe("TraceStore", () => {
  let dbPath: string;
  let store: TraceStore;

  beforeEach(() => {
    dbPath = testDbPath();
    store = new TraceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      unlinkSync(dbPath);
      unlinkSync(dbPath + "-wal");
      unlinkSync(dbPath + "-shm");
    } catch {
      // OK if files don't exist
    }
  });

  it("stores and retrieves a trace by ID", () => {
    const trace = makeTrace();
    store.store(trace);

    const retrieved = store.getById(trace.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(trace.id);
    expect(retrieved!.problem.description).toBe(trace.problem.description);
    expect(retrieved!.solution.summary).toBe(trace.solution.summary);
    expect(retrieved!.problem.tags).toEqual(["frontend", "runtime-error"]);
    expect(retrieved!.solution.steps).toHaveLength(2);
  });

  it("stores with storeNew and generates ID", () => {
    const trace = store.storeNew(
      {
        description: "test problem",
        tags: [],
        fingerprint: "fp1",
      },
      {
        summary: "test solution",
        steps: [],
        outcome: "success",
      },
      { agent: "test" },
    );

    expect(trace.id).toBeDefined();
    expect(trace.createdAt).toBeGreaterThan(0);
    expect(store.getById(trace.id)).not.toBeNull();
  });

  it("returns null for non-existent ID", () => {
    expect(store.getById("nonexistent")).toBeNull();
  });

  it("finds traces by fingerprint", () => {
    const fp = "unique-fingerprint-123";
    store.store(makeTrace({ problem: { ...makeTrace().problem, fingerprint: fp } }));
    store.store(makeTrace({ problem: { ...makeTrace().problem, fingerprint: fp } }));
    store.store(makeTrace({ problem: { ...makeTrace().problem, fingerprint: "other" } }));

    const results = store.getByFingerprint(fp);
    expect(results).toHaveLength(2);
  });

  it("performs full-text search", () => {
    store.store(
      makeTrace({
        problem: {
          ...makeTrace().problem,
          description: "Connection refused when calling the payment API",
          fingerprint: "fp1",
        },
        solution: {
          ...makeTrace().solution,
          summary: "The payment service was down, restarted it",
        },
      }),
    );
    store.store(
      makeTrace({
        problem: {
          ...makeTrace().problem,
          description: "Memory leak in the React component",
          fingerprint: "fp2",
        },
        solution: {
          ...makeTrace().solution,
          summary: "Added cleanup in useEffect return",
        },
      }),
    );

    const paymentResults = store.searchFts("payment API");
    expect(paymentResults.length).toBeGreaterThanOrEqual(1);
    expect(paymentResults[0]!.trace.problem.description).toContain("payment");

    const reactResults = store.searchFts("React memory leak");
    expect(reactResults.length).toBeGreaterThanOrEqual(1);
  });

  it("tracks quality metrics", () => {
    const trace = makeTrace();
    store.store(trace);

    store.recordRecall(trace.id, true);
    store.recordRecall(trace.id, true);
    store.recordRecall(trace.id, false);

    const updated = store.getById(trace.id)!;
    expect(updated.quality.recallCount).toBe(3);
    expect(updated.quality.helpfulCount).toBe(2);
    expect(updated.quality.lastRecalledAt).toBeGreaterThan(0);
    expect(updated.quality.score).toBeGreaterThan(0);
  });

  it("deletes a trace", () => {
    const trace = makeTrace();
    store.store(trace);
    expect(store.delete(trace.id)).toBe(true);
    expect(store.getById(trace.id)).toBeNull();
  });

  it("counts traces", () => {
    expect(store.count()).toBe(0);
    store.store(makeTrace());
    store.store(makeTrace());
    expect(store.count()).toBe(2);
  });

  it("lists recent traces with pagination", () => {
    for (let i = 0; i < 5; i++) {
      store.store(makeTrace());
    }

    const page1 = store.listRecent(2, 0);
    expect(page1).toHaveLength(2);

    const page2 = store.listRecent(2, 2);
    expect(page2).toHaveLength(2);

    const page3 = store.listRecent(2, 4);
    expect(page3).toHaveLength(1);
  });

  it("prunes low-quality traces", () => {
    // Store traces with varying quality
    const t1 = makeTrace();
    t1.quality.score = 0.01;
    t1.quality.recallCount = 5; // Only prune recalled traces
    store.store(t1);

    const t2 = makeTrace();
    t2.quality.score = 0.9;
    t2.quality.recallCount = 10;
    store.store(t2);

    const pruned = store.prune(0.05);
    expect(pruned).toBe(1);
    expect(store.count()).toBe(1);
    expect(store.getById(t2.id)).not.toBeNull();
  });

  it("computes storage stats", () => {
    store.store(
      makeTrace({ solution: { ...makeTrace().solution, outcome: "success" } }),
    );
    store.store(
      makeTrace({ solution: { ...makeTrace().solution, outcome: "failure" } }),
    );

    const stats = store.stats();
    expect(stats.totalTraces).toBe(2);
    expect(stats.successfulTraces).toBe(1);
    expect(stats.failedTraces).toBe(1);
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });

  it("exports and imports traces", () => {
    const t1 = makeTrace();
    const t2 = makeTrace();
    store.store(t1);
    store.store(t2);

    const exported = store.exportAll();
    expect(exported).toHaveLength(2);

    // Import into a new store
    const dbPath2 = testDbPath();
    const store2 = new TraceStore(dbPath2);
    try {
      const imported = store2.importTraces(exported);
      expect(imported).toBe(2);
      expect(store2.count()).toBe(2);

      // Re-import should skip duplicates
      const reimported = store2.importTraces(exported);
      expect(reimported).toBe(0);
    } finally {
      store2.close();
      try { unlinkSync(dbPath2); } catch { /* ok */ }
    }
  });
});
