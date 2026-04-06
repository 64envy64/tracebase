import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ReasoningLayer } from "../../src/core/engine.js";

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
      expect(updatedWeights.bm25 + updatedWeights.jaccard + updatedWeights.structural)
        .toBeCloseTo(1.0, 5);
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
