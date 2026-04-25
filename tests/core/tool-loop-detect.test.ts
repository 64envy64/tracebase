/**
 * `src/core/tool-loop-detect.ts` — tool-call pattern classifier.
 *
 * Pins down the priority order (straight > pingpong > duplicate)
 * and the off-by-one edges around the minimum window sizes. The
 * detector is dependency-free and pure, so the tests just feed it
 * shaped observation arrays.
 */
import { describe, expect, it } from "vitest";
import { detectToolPattern } from "../../src/core/tool-loop-detect.js";
import type { ToolObservation } from "../../src/types.js";

function obs(
  argKey: string,
  toolName = "Read",
  ts = 0,
): ToolObservation {
  return {
    id: `id-${argKey}-${ts}`,
    ts,
    sessionId: "s1",
    batchId: null,
    batchOrder: 0,
    toolUseId: null,
    toolName,
    argSummary: `${toolName}(${argKey})`,
    argKey,
    outcome: "unknown",
    redundantOf: null,
    createdAt: ts,
  };
}

describe("detectToolPattern — empty / sparse windows", () => {
  it("returns `none` for an empty window", () => {
    expect(detectToolPattern([])).toEqual({ kind: "none", count: 0 });
  });

  it("returns `none` for a single-entry window", () => {
    expect(detectToolPattern([obs("a")])).toEqual({ kind: "none", count: 0 });
  });

  it("returns `none` when no key repeats", () => {
    const window = [obs("a"), obs("b"), obs("c"), obs("d")];
    expect(detectToolPattern(window)).toEqual({ kind: "none", count: 0 });
  });
});

describe("detectToolPattern — straight loop has top priority", () => {
  it("flags 3 consecutive identical arg_keys as straight", () => {
    const window = [obs("x"), obs("a"), obs("a"), obs("a")];
    const sig = detectToolPattern(window);
    expect(sig.kind).toBe("straight");
    expect(sig.count).toBe(3);
    expect(sig.toolName).toBe("Read");
  });

  it("requires 3 in a row, not 2 — two-in-a-row is normal flow", () => {
    const window = [obs("x"), obs("a"), obs("a")];
    const sig = detectToolPattern(window);
    // Two-in-a-row also matches the duplicate detector — that's
    // expected and useful (the agent did the same call twice). What
    // we're pinning here is that it does NOT escalate to "straight".
    expect(sig.kind).toBe("duplicate");
    expect(sig.count).toBe(2);
  });

  it("longer runs surface the full count", () => {
    const window = [obs("a"), obs("a"), obs("a"), obs("a")];
    const sig = detectToolPattern(window);
    expect(sig.kind).toBe("straight");
    expect(sig.count).toBe(4);
  });

  it("only the trailing run counts toward straight — broken runs fall back to duplicate", () => {
    // [a,a,a,b] — early consecutive run of `a` doesn't qualify as
    // straight (the trailing window must be all `a` to win), but
    // `a` still appears 3 times so the duplicate detector picks
    // up. Pins down: the priority cascade hands the signal to the
    // strictest-fit classifier, not the loudest.
    const window = [obs("a"), obs("a"), obs("a"), obs("b")];
    const sig = detectToolPattern(window);
    expect(sig.kind).toBe("duplicate");
    expect(sig.count).toBe(3);
  });

  it("tool name is the most recent matching call", () => {
    const window = [
      obs("a", "Bash"),
      obs("a", "Read"),
      obs("a", "Read"),
      obs("a", "Grep"),
    ];
    const sig = detectToolPattern(window);
    expect(sig.kind).toBe("straight");
    expect(sig.toolName).toBe("Grep");
  });
});

describe("detectToolPattern — ping-pong", () => {
  it("classifies A,B,A,B as pingpong", () => {
    const window = [obs("a"), obs("b"), obs("a"), obs("b")];
    const sig = detectToolPattern(window);
    expect(sig.kind).toBe("pingpong");
    expect(sig.count).toBe(2);
  });

  it("requires window length ≥ 4 — A,B,A is just a duplicate", () => {
    const window = [obs("a"), obs("b"), obs("a")];
    const sig = detectToolPattern(window);
    expect(sig.kind).toBe("duplicate");
  });

  it("A,B,A,A is straight (last 3 of 4 identical), not pingpong", () => {
    const window = [obs("a"), obs("b"), obs("a"), obs("a")];
    const sig = detectToolPattern(window);
    // straight wins over pingpong. The trailing run is "a","a"
    // (length 2) which doesn't reach STRAIGHT_MIN — but the AABB
    // check fails too (b !== a), so it falls through to duplicate.
    expect(sig.kind).toBe("duplicate");
  });
});

describe("detectToolPattern — duplicate is the weakest signal", () => {
  it("flags any single key appearing ≥2 times", () => {
    const window = [obs("a"), obs("b"), obs("c"), obs("a")];
    const sig = detectToolPattern(window);
    expect(sig.kind).toBe("duplicate");
    expect(sig.count).toBe(2);
  });

  it("returns the highest-count duplicate when several repeat", () => {
    const window = [obs("a"), obs("b"), obs("a"), obs("c"), obs("a"), obs("b")];
    const sig = detectToolPattern(window);
    expect(sig.kind).toBe("duplicate");
    // "a" appears 3 times, "b" twice → reports a's count
    expect(sig.count).toBe(3);
  });
});
