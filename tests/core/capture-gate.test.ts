/**
 * Pure-function unit tests for the capture gate.
 *
 * The gate is also wired into storeReasoningPattern (covered in
 * tests/server/store-pattern.test.ts); this file isolates the
 * heuristic itself so it can evolve without dragging the storage
 * harness along, and it doubles as documentation for which content
 * shapes are blocked.
 */
import { describe, it, expect } from "vitest";
import { classifyForCapture } from "../../src/core/capture-gate.js";

const baseGood = {
  situation: "React effect loops when the dependency array holds a fresh object each render",
  mechanism: "referential equality fails every render so the effect re-runs indefinitely",
  unlock: "memoize the dependency with useMemo, or lift the object into module scope",
  verification: "render count stays constant after the initial mount",
};

describe("classifyForCapture", () => {
  it("accepts a clean reusable pattern", () => {
    expect(classifyForCapture(baseGood).kind).toBe("accept");
  });

  it("rejects tracebase-ai@N version markers in the situation", () => {
    const out = classifyForCapture({ ...baseGood, situation: "Implement 0.6.0 with tracebase-ai@0.6.0 latest" });
    expect(out.kind).toBe("reject");
    if (out.kind === "reject") expect(out.reason).toBe("release-noise");
  });

  it("rejects 'git pushed' in the mechanism", () => {
    const out = classifyForCapture({ ...baseGood, mechanism: "git pushed (ec34fc5..8b2587b) 1093 tests pass" });
    expect(out.kind).toBe("reject");
  });

  it("rejects 'N tests pass' in the unlock", () => {
    const out = classifyForCapture({ ...baseGood, unlock: "shipped — 22 tests pass" });
    expect(out.kind).toBe("reject");
    if (out.kind === "reject") expect(out.reason).toBe("release-noise");
  });

  it("rejects pushed-sha markers", () => {
    const out = classifyForCapture({
      ...baseGood,
      mechanism: "Pushed `31e9d47` to main; nothing surprising",
    });
    expect(out.kind).toBe("reject");
  });

  it("rejects the canned Re-run-the-failing-step verification boilerplate", () => {
    const out = classifyForCapture({
      ...baseGood,
      verification: "Re-run the failing step or relevant tests to confirm the fix holds.",
    });
    expect(out.kind).toBe("reject");
    if (out.kind === "reject") expect(out.reason).toBe("template-verify");
  });

  it("does NOT reject genuinely concise fixes (length is not gated here)", () => {
    const out = classifyForCapture({
      situation: "an async race in form submit handler causes double-post on slow networks",
      mechanism: "the submit button is not disabled while the request is in flight",
      unlock: "disable the button",
      verification: "rapid double-click no longer produces two requests",
    });
    expect(out.kind).toBe("accept");
  });

  it("matches case-insensitively for release-noise patterns", () => {
    const out = classifyForCapture({ ...baseGood, situation: "TraceBase-AI@0.6.1 health verification" });
    expect(out.kind).toBe("reject");
  });
});
