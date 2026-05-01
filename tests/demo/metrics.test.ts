/**
 * Pure-function unit tests for the YC demo harness metric pipeline.
 *
 * The runner script and the report script both lean on
 * `computeComparison`; this is where the contract for net-savings
 * accounting and verifier-agreement classification gets pinned.
 */
import { describe, it, expect } from "vitest";
import {
  computeComparison,
  renderComparisonMarkdown,
} from "../../src/demo/metrics.js";
import type { RunArtifact, Variant } from "../../src/demo/types.js";

function baseRun(variant: Variant, overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    task: "demo-task",
    variant,
    source: "synthetic",
    timestamp: 1735689600000,
    model: "claude-haiku-4-5-20251001",
    wallClockMs: 5000,
    tokens: { input: 1000, output: 200, total: 1200, source: "estimate" },
    toolCalls: { total: 10, duplicates: 2, byName: { Read: 6, Bash: 4 } },
    tracebase:
      variant === "on"
        ? { injectedTokens: 0, overheadMs: 0, queryIds: [], blockedToolCalls: 0 }
        : null,
    verifier: { command: "exit 0", exitCode: 0, pass: true, outputExcerpt: "" },
    ...overrides,
  };
}

describe("computeComparison — primary deltas", () => {
  it("computes time / tokens / tool-calls / duplicates in the off-minus-on direction", () => {
    const off = baseRun("off", {
      wallClockMs: 5000,
      tokens: { input: 1500, output: 300, total: 1800, source: "estimate" },
      toolCalls: { total: 12, duplicates: 4, byName: { Read: 12 } },
    });
    const on = baseRun("on", {
      wallClockMs: 3000,
      tokens: { input: 800, output: 200, total: 1000, source: "estimate" },
      toolCalls: { total: 7, duplicates: 0, byName: { Read: 7 } },
      tracebase: {
        injectedTokens: 100,
        overheadMs: 50,
        queryIds: ["q1"],
        blockedToolCalls: 2,
      },
    });
    const r = computeComparison(off, on);
    expect(r.delta.timeMs).toBe(2000);
    expect(r.delta.tokensTotal).toBe(800);
    expect(r.delta.toolCalls).toBe(5);
    expect(r.delta.duplicates).toBe(4);
  });
});

describe("computeComparison — net token savings subtract injected tokens", () => {
  it("net = (off.total − on.total) − on.tracebase.injectedTokens", () => {
    const off = baseRun("off", {
      tokens: { input: 5000, output: 1000, total: 6000, source: "estimate" },
    });
    const on = baseRun("on", {
      tokens: { input: 1000, output: 200, total: 1200, source: "estimate" },
      tracebase: {
        injectedTokens: 300,
        overheadMs: 0,
        queryIds: [],
        blockedToolCalls: 0,
      },
    });
    const r = computeComparison(off, on);
    expect(r.delta.tokensTotal).toBe(4800);
    expect(r.delta.tokensTotalNet).toBe(4500);
  });

  it("net is negative when injected tokens exceed apparent savings", () => {
    const off = baseRun("off");
    const on = baseRun("on", {
      tracebase: {
        injectedTokens: 200,
        overheadMs: 0,
        queryIds: [],
        blockedToolCalls: 0,
      },
    });
    const r = computeComparison(off, on);
    expect(r.delta.tokensTotal).toBe(0);
    expect(r.delta.tokensTotalNet).toBe(-200);
  });
});

describe("computeComparison — blocked tool calls require an actual on-side event", () => {
  it("delta.blockedToolCalls reflects only the on-side count", () => {
    const off = baseRun("off");
    const on = baseRun("on", {
      tracebase: {
        injectedTokens: 0,
        overheadMs: 0,
        queryIds: [],
        blockedToolCalls: 3,
      },
    });
    expect(computeComparison(off, on).delta.blockedToolCalls).toBe(3);
  });

  it("zero when on has no blocks", () => {
    const off = baseRun("off");
    const on = baseRun("on");
    expect(computeComparison(off, on).delta.blockedToolCalls).toBe(0);
  });

  it("zero when on.tracebase is null (defensive — no telemetry, no claim)", () => {
    const off = baseRun("off");
    const on = baseRun("on", { tracebase: null });
    const r = computeComparison(off, on);
    expect(r.delta.blockedToolCalls).toBe(0);
    expect(r.delta.injectedTokens).toBe(0);
    expect(r.delta.overheadMs).toBe(0);
  });
});

describe("computeComparison — verifier agreement", () => {
  function withVerifier(variant: Variant, pass: boolean): RunArtifact {
    return baseRun(variant, {
      verifier: {
        command: "x",
        exitCode: pass ? 0 : 1,
        pass,
        outputExcerpt: "",
      },
    });
  }
  it("both pass", () => {
    const r = computeComparison(withVerifier("off", true), withVerifier("on", true));
    expect(r.delta.verifierAgreement).toBe("both-pass");
  });
  it("both fail", () => {
    const r = computeComparison(
      withVerifier("off", false),
      withVerifier("on", false),
    );
    expect(r.delta.verifierAgreement).toBe("both-fail");
  });
  it("off pass, on fail (regression — never claim a win on this)", () => {
    const r = computeComparison(withVerifier("off", true), withVerifier("on", false));
    expect(r.delta.verifierAgreement).toBe("off-pass-on-fail");
  });
  it("off fail, on pass (lift — the demo's goal)", () => {
    const r = computeComparison(withVerifier("off", false), withVerifier("on", true));
    expect(r.delta.verifierAgreement).toBe("off-fail-on-pass");
  });
});

describe("computeComparison — defensive checks against mis-pairing", () => {
  it("throws when the two artifacts disagree on task", () => {
    const off = baseRun("off", { task: "task-a" });
    const on = baseRun("on", { task: "task-b" });
    expect(() => computeComparison(off, on)).toThrow(/task mismatch/);
  });
  it("throws when the variant arguments are swapped", () => {
    const offShape = baseRun("on");
    const onShape = baseRun("off");
    expect(() => computeComparison(offShape, onShape)).toThrow(/variant mismatch/);
  });
  it("throws when off is synthetic and on is real (must never mix)", () => {
    const off = baseRun("off", { source: "synthetic" });
    const on = baseRun("on", { source: "real" });
    expect(() => computeComparison(off, on)).toThrow(/source mismatch/);
  });
  it("throws when off is real and on is synthetic", () => {
    const off = baseRun("off", { source: "real" });
    const on = baseRun("on", { source: "synthetic" });
    expect(() => computeComparison(off, on)).toThrow(/source mismatch/);
  });
});

describe("renderComparisonMarkdown — source-tagged header", () => {
  it("labels synthetic runs as illustrative-only", () => {
    const off = baseRun("off", { source: "synthetic" });
    const on = baseRun("on", { source: "synthetic" });
    const md = renderComparisonMarkdown(computeComparison(off, on));
    expect(md).toContain("Synthetic fixture");
    expect(md).toContain("illustrative");
  });
  it("labels real runs as real-agent recording", () => {
    const off = baseRun("off", { source: "real" });
    const on = baseRun("on", { source: "real" });
    const md = renderComparisonMarkdown(computeComparison(off, on));
    expect(md).toContain("Real-agent recording");
    expect(md).not.toContain("Synthetic fixture");
  });
});

describe("renderComparisonMarkdown", () => {
  it("renders a comparison table with signed deltas and the verifier verdict", () => {
    const off = baseRun("off", {
      wallClockMs: 5000,
      tokens: { input: 1500, output: 300, total: 1800, source: "estimate" },
      verifier: { command: "exit 1", exitCode: 1, pass: false, outputExcerpt: "" },
    });
    const on = baseRun("on", {
      wallClockMs: 3000,
      tokens: { input: 800, output: 200, total: 1000, source: "estimate" },
      tracebase: {
        injectedTokens: 100,
        overheadMs: 50,
        queryIds: ["q1"],
        blockedToolCalls: 2,
      },
      verifier: { command: "exit 0", exitCode: 0, pass: true, outputExcerpt: "" },
    });
    const md = renderComparisonMarkdown(computeComparison(off, on));
    expect(md).toContain("## demo-task");
    expect(md).toContain("Wall-clock (ms) | 5000 | 3000 | +2000");
    expect(md).toContain("Net tokens saved");
    expect(md).toContain("+700"); // 800 - 100 = 700
    expect(md).toContain("off-fail-on-pass");
  });
});

describe("char/4 token estimate — labelled, never confused with provider", () => {
  it("a token usage with source=estimate must surface that string in the rendered header", () => {
    const off = baseRun("off", {
      source: "real",
      tokens: { input: 800, output: 200, total: 1000, source: "estimate" },
    });
    const on = baseRun("on", {
      source: "real",
      tokens: { input: 600, output: 200, total: 800, source: "provider" },
    });
    const md = renderComparisonMarkdown(computeComparison(off, on));
    expect(md).toContain("token source: off=estimate / on=provider");
  });
});
