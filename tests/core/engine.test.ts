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
    try {
      unlinkSync(dbPath);
      unlinkSync(dbPath + "-wal");
      unlinkSync(dbPath + "-shm");
    } catch {
      // OK
    }
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
  });

  describe("recall", () => {
    it("finds exact fingerprint matches", () => {
      // Store a trace with context
      layer.storeTrace({
        problem: {
          description: "TypeError: Cannot read property 'map' of undefined",
          errorType: "TypeError",
          language: "typescript",
          tags: [],
        },
        solution: {
          summary: "Added null check",
          steps: [],
          outcome: "success",
        },
      });

      // Recall with the same description AND context for exact match
      const results = layer.recall({
        problem: "TypeError: Cannot read property 'map' of undefined",
        context: {
          errorType: "TypeError",
          language: "typescript",
        },
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.matchType).toBe("exact");
      expect(results[0]!.score).toBeCloseTo(1.0, 1);
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
        problem: {
          description: "CSS grid layout broken in Safari",
          language: "css",
          tags: [],
        },
        solution: {
          summary: "Added -webkit prefix",
          steps: [],
          outcome: "success",
        },
      });

      const results = layer.recall({
        problem: "Kubernetes pod keeps crashing with OOM",
        minScore: 0.5,
      });

      expect(results.length).toBe(0);
    });
  });

  describe("search", () => {
    it("searches by text content", () => {
      layer.storeTrace({
        problem: {
          description: "Memory leak in the WebSocket handler",
          tags: [],
        },
        solution: {
          summary: "Closed connections on cleanup",
          steps: [],
          outcome: "success",
        },
      });

      const results = layer.search("WebSocket memory");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.problem.description).toContain("WebSocket");
    });
  });

  describe("feedback", () => {
    it("updates quality metrics", () => {
      const trace = layer.storeTrace({
        problem: { description: "test", tags: [] },
        solution: { summary: "test fix", steps: [], outcome: "success" },
      });

      layer.feedback(trace.id, true);
      layer.feedback(trace.id, true);
      layer.feedback(trace.id, false);

      const updated = layer.getTrace(trace.id)!;
      expect(updated.quality.recallCount).toBe(3);
      expect(updated.quality.helpfulCount).toBe(2);
    });
  });

  describe("events", () => {
    it("emits trace:stored events", () => {
      const events: string[] = [];
      layer.on("trace:stored", (e) => events.push(e.type));

      layer.storeTrace({
        problem: { description: "test", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      expect(events).toEqual(["trace:stored"]);
    });

    it("supports wildcard listener", () => {
      const events: string[] = [];
      layer.on("*", (e) => events.push(e.type));

      layer.storeTrace({
        problem: { description: "wildcard test problem", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      // recall() emits trace:recalled
      layer.recall({ problem: "wildcard test problem" });

      expect(events).toContain("trace:stored");
      expect(events).toContain("trace:recalled");
    });

    it("unsubscribe works", () => {
      const events: string[] = [];
      const unsub = layer.on("trace:stored", (e) => events.push(e.type));

      layer.storeTrace({
        problem: { description: "test 1", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      unsub();

      layer.storeTrace({
        problem: { description: "test 2", tags: [] },
        solution: { summary: "fix", steps: [], outcome: "success" },
      });

      expect(events).toHaveLength(1);
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
        problem: { description: "problem 1", tags: ["a"] },
        solution: { summary: "fix 1", steps: [], outcome: "success" },
      });
      layer.storeTrace({
        problem: { description: "problem 2", tags: ["b"] },
        solution: { summary: "fix 2", steps: [], outcome: "failure" },
      });

      const exported = layer.exportAll();
      expect(exported).toHaveLength(2);

      // Create a new layer and import
      const config2 = testConfig();
      const layer2 = new ReasoningLayer(config2);
      try {
        const imported = layer2.importTraces(exported);
        expect(imported).toBe(2);
        expect(layer2.count()).toBe(2);
      } finally {
        layer2.close();
        try { unlinkSync(config2.storagePath); } catch { /* ok */ }
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
