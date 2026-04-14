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

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch { /* ok */ }
  }
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
    cleanupDb(dbPath);
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

  it("stores with cached tokens and features", () => {
    const trace = makeTrace();
    const tokens = ["type", "error", "map", "undefined"];
    const features = { errorType: "typeerror", language: "typescript" };

    store.store(trace, tokens, features);

    // Verify cached data is returned in getByFingerprint
    const results = store.getByFingerprint(trace.problem.fingerprint);
    expect(results).toHaveLength(1);
    expect(results[0]!.cachedTokens).toEqual(tokens);
    expect(results[0]!.cachedFeatures).toEqual(features);
  });

  it("returns null for non-existent ID", () => {
    expect(store.getById("nonexistent")).toBeNull();
  });

  it("checks fingerprint existence", () => {
    const trace = makeTrace();
    expect(store.existsByFingerprint(trace.problem.fingerprint)).toBeNull();

    store.store(trace);
    expect(store.existsByFingerprint(trace.problem.fingerprint)).toBe(trace.id);
  });

  it("finds traces by fingerprint", () => {
    const fp = "unique-fingerprint-123";
    store.store(makeTrace({ problem: { ...makeTrace().problem, fingerprint: fp } }));
    store.store(makeTrace({ problem: { ...makeTrace().problem, fingerprint: fp } }));
    store.store(makeTrace({ problem: { ...makeTrace().problem, fingerprint: "other" } }));

    const results = store.getByFingerprint(fp);
    expect(results).toHaveLength(2);
  });

  it("performs full-text search with AND semantics", () => {
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

  it("pre-filters candidates by language and framework", () => {
    store.store(makeTrace({
      problem: { ...makeTrace().problem, language: "python", framework: "django", fingerprint: "py1" },
    }));
    store.store(makeTrace({
      problem: { ...makeTrace().problem, language: "typescript", framework: "react", fingerprint: "ts1" },
    }));

    const pyResults = store.getCandidatesFiltered({ language: "python" }, 10);
    expect(pyResults).toHaveLength(1);
    expect(pyResults[0]!.trace.problem.language).toBe("python");

    const tsReactResults = store.getCandidatesFiltered(
      { language: "typescript", framework: "react" },
      10,
    );
    expect(tsReactResults).toHaveLength(1);
  });

  it("records feedback with signal attribution", () => {
    const trace = makeTrace();
    store.store(trace);

    const signals = { fingerprint: 0, bm25: 0.8, jaccard: 0.3, structural: 0.2, cosine: 0, freshness: 0.5 };
    store.recordFeedback(trace.id, true, signals);
    store.recordFeedback(trace.id, true, signals);
    store.recordFeedback(trace.id, false, signals);

    const updated = store.getById(trace.id)!;
    expect(updated.quality.recallCount).toBe(3);
    expect(updated.quality.helpfulCount).toBe(2);
    expect(updated.quality.lastRecalledAt).toBeGreaterThan(0);
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

  it("prunes by quality AND enforces count limit", () => {
    // Store 5 traces, all un-recalled (recallCount=0, score=0.5)
    for (let i = 0; i < 5; i++) {
      store.store(makeTrace());
    }

    // Quality-based prune won't touch them (recallCount=0)
    const qualityPruned = store.prune(0.05);
    expect(qualityPruned).toBe(0);
    expect(store.count()).toBe(5);

    // But age-based prune WILL enforce the limit
    const agePruned = store.prune(0.05, 3);
    expect(agePruned).toBe(2);
    expect(store.count()).toBe(3);
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

  it("exports and imports traces (INSERT OR IGNORE dedup)", () => {
    const t1 = makeTrace();
    const t2 = makeTrace();
    store.store(t1);
    store.store(t2);

    const exported = store.exportAll();
    expect(exported).toHaveLength(2);

    const dbPath2 = testDbPath();
    const store2 = new TraceStore(dbPath2);
    try {
      const imported = store2.importTraces(exported);
      expect(imported).toBe(2);
      expect(store2.count()).toBe(2);

      // Re-import should skip duplicates (INSERT OR IGNORE)
      const reimported = store2.importTraces(exported);
      expect(reimported).toBe(0);
    } finally {
      store2.close();
      cleanupDb(dbPath2);
    }
  });
});
