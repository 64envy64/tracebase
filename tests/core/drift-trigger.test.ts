import { describe, it, expect } from "vitest";
import {
  buildDriftAugmentation,
  applyDriftAugmentation,
} from "../../src/core/drift-trigger.js";
import { DEFAULT_DRIFT_GATE_THRESHOLD, DEFAULT_GATE_THRESHOLD } from "../../src/core/block-serving.js";
import type { ToolObservation } from "../../src/types.js";

function obs(toolName: string, argSummary: string, argKey: string): ToolObservation {
  return {
    toolName,
    argSummary,
    argKey,
    outcome: "ok",
    ts: 1_000_000,
  };
}

describe("buildDriftAugmentation", () => {
  it("returns null when the signal kind is none", () => {
    const r = buildDriftAugmentation({
      baseText: "fix the test",
      signal: { kind: "none", count: 0 },
      observations: [obs("Read", "src/x.ts", "k1"), obs("Bash", "ls", "k2")],
    });
    expect(r).toBeNull();
  });

  it("widens the query with up to maxArgFragments newest-first", () => {
    const r = buildDriftAugmentation({
      baseText: "fix bug",
      signal: { kind: "straight", count: 3, toolName: "Read" },
      observations: [
        obs("Read", "src/old.ts", "k1"),
        obs("Read", "src/mid.ts", "k2"),
        obs("Read", "src/new.ts", "k3"),
      ],
      maxArgFragments: 2,
    });
    expect(r).not.toBeNull();
    // Newest first: new, mid; then old is dropped because maxFragments=2.
    expect(r!.text).toBe("fix bug src/new.ts src/mid.ts");
    expect(r!.observationsUsed).toBe(2);
  });

  it("defaults to DEFAULT_DRIFT_GATE_THRESHOLD which is below production gate", () => {
    const r = buildDriftAugmentation({
      baseText: "stuck",
      signal: { kind: "duplicate", count: 2, toolName: "Grep" },
      observations: [obs("Grep", "abc", "k1"), obs("Grep", "abc", "k1")],
    });
    expect(r!.gateOverride).toBe(DEFAULT_DRIFT_GATE_THRESHOLD);
    expect(r!.gateOverride).toBeLessThan(DEFAULT_GATE_THRESHOLD);
  });

  it("respects a caller-supplied driftGate override", () => {
    const r = buildDriftAugmentation({
      baseText: "",
      signal: { kind: "pingpong", count: 2, toolName: "Edit" },
      observations: [obs("Edit", "a", "k1"), obs("Read", "a", "k2")],
      driftGate: 0.1,
    });
    expect(r!.gateOverride).toBe(0.1);
  });

  it("skips observations with empty argSummary", () => {
    const r = buildDriftAugmentation({
      baseText: "anchor",
      signal: { kind: "straight", count: 3, toolName: "Bash" },
      observations: [
        obs("Bash", "", "k1"),
        obs("Bash", "second", "k2"),
        obs("Bash", "", "k3"),
      ],
    });
    expect(r!.text).toBe("anchor second");
    expect(r!.observationsUsed).toBe(1);
  });

  it("returns a tool-arg-only query when baseText is empty", () => {
    const r = buildDriftAugmentation({
      baseText: "",
      signal: { kind: "straight", count: 3, toolName: "Read" },
      observations: [
        obs("Read", "src/a.ts", "k1"),
        obs("Read", "src/b.ts", "k1"),
      ],
    });
    expect(r!.text).toBe("src/b.ts src/a.ts");
  });
});

describe("applyDriftAugmentation", () => {
  it("preserves invariants, scope, runId, and shadow flag from the base query", () => {
    const aug = {
      text: "widened",
      gateOverride: 0.15,
      signal: { kind: "straight" as const, count: 3, toolName: "Read" },
      observationsUsed: 2,
    };
    const result = applyDriftAugmentation(
      {
        text: "original",
        invariants: { language: "typescript", framework: "react" },
        scope: "project.session.abcd1234",
        runId: "run-1",
        shadow: true,
      },
      aug,
    );
    expect(result.text).toBe("widened");
    expect(result.gateOverride).toBe(0.15);
    expect(result.invariants).toEqual({ language: "typescript", framework: "react" });
    expect(result.scope).toBe("project.session.abcd1234");
    expect(result.runId).toBe("run-1");
    expect(result.shadow).toBe(true);
  });

  it("does not mutate the input query", () => {
    const base = { text: "original" };
    const aug = {
      text: "widened",
      gateOverride: 0.2,
      signal: { kind: "duplicate" as const, count: 2 },
      observationsUsed: 1,
    };
    applyDriftAugmentation(base, aug);
    expect(base.text).toBe("original");
    expect((base as { gateOverride?: number }).gateOverride).toBeUndefined();
  });
});
