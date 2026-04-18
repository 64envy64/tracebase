import { describe, it, expect } from "vitest";
import {
  extractTrajectory,
  findUnlockStep,
  mineDeadEnds,
  summarizeDeadEnd,
  type ExtractedTrajectory,
} from "../../src/distillation/heuristics.js";
import type { ReasoningTrace, SolutionStep } from "../../src/types.js";

function traceFromSteps(
  steps: SolutionStep[],
  outcome: "success" | "failure" | "partial" = "success",
): ReasoningTrace {
  return {
    id: "t",
    createdAt: 1,
    updatedAt: 1,
    problem: {
      description: "example problem",
      tags: [],
      fingerprint: "fp-1",
    },
    solution: {
      summary: "summary",
      steps,
      outcome,
    },
    metadata: { agent: "test" },
    quality: { recallCount: 0, helpfulCount: 0, score: 0.5 },
    provenance: { origin: "local", appliedCount: 0 },
  };
}

// ---------------------------------------------------------------------------
// extractTrajectory
// ---------------------------------------------------------------------------

describe("heuristics — extractTrajectory", () => {
  it("maps SolutionStep[] to TrajectoryStep[] preserving type + description", () => {
    const trace = traceFromSteps([
      { type: "analysis", description: "think about the problem" },
      { type: "action", description: "edit file" },
      { type: "verification", description: "run tests" },
    ]);
    const t = extractTrajectory(trace);
    expect(t.steps.length).toBe(3);
    expect(t.steps[0].type).toBe("analysis");
    expect(t.steps[0].description).toBe("think about the problem");
    expect(t.steps[0].index).toBe(0);
    expect(t.outcome).toBe("success");
    expect(t.problemDescription).toBe("example problem");
  });

  it("preserves toolCall on action steps", () => {
    const trace = traceFromSteps([
      {
        type: "action",
        description: "edit",
        toolCall: { tool: "editFile", input: { path: "x.py" }, output: "ok" },
      },
    ]);
    const t = extractTrajectory(trace);
    expect(t.steps[0].toolCall?.tool).toBe("editFile");
  });
});

// ---------------------------------------------------------------------------
// findUnlockStep
// ---------------------------------------------------------------------------

describe("heuristics — findUnlockStep", () => {
  it("returns the last analysis preceding a verification on success", () => {
    const trace = traceFromSteps([
      { type: "analysis", description: "first idea" },
      { type: "action", description: "edit 1" },
      { type: "analysis", description: "actual unlock: descriptors are not functions" },
      { type: "action", description: "edit 2" },
      { type: "verification", description: "tests pass" },
    ]);
    const unlock = findUnlockStep(extractTrajectory(trace));
    expect(unlock?.description).toContain("descriptors are not functions");
  });

  it("falls back to the last analysis when no verification follows", () => {
    const trace = traceFromSteps([
      { type: "analysis", description: "first idea" },
      { type: "analysis", description: "a later idea" },
      { type: "action", description: "edit" },
    ]);
    const unlock = findUnlockStep(extractTrajectory(trace));
    expect(unlock?.description).toBe("a later idea");
  });

  it("returns null on non-success trajectory", () => {
    const trace = traceFromSteps(
      [{ type: "analysis", description: "idea" }],
      "failure",
    );
    expect(findUnlockStep(extractTrajectory(trace))).toBeNull();
  });

  it("returns null on a trajectory with no analysis steps", () => {
    const trace = traceFromSteps([
      { type: "action", description: "edit" },
      { type: "verification", description: "tests pass" },
    ]);
    expect(findUnlockStep(extractTrajectory(trace))).toBeNull();
  });

  it("is deterministic — same trajectory yields the same unlock", () => {
    const trace = traceFromSteps([
      { type: "analysis", description: "first" },
      { type: "analysis", description: "second" },
      { type: "action", description: "edit" },
      { type: "verification", description: "pass" },
    ]);
    const a = findUnlockStep(extractTrajectory(trace));
    const b = findUnlockStep(extractTrajectory(trace));
    expect(a?.index).toBe(b?.index);
    expect(a?.description).toBe(b?.description);
  });
});

// ---------------------------------------------------------------------------
// mineDeadEnds
// ---------------------------------------------------------------------------

describe("heuristics — mineDeadEnds", () => {
  function tFromAnalyses(...descs: string[]): ExtractedTrajectory {
    return extractTrajectory(
      traceFromSteps(descs.map((d) => ({ type: "analysis" as const, description: d }))),
    );
  }

  it("flags an earlier analysis when a later one shows negative signal", () => {
    const t = tFromAnalyses(
      "metaclass iterates via inspect.isfunction which skips properties",
      "hmm, that didn't work, try something else",
      "use inspect.isdatadescriptor to cover both branches",
    );
    const ends = mineDeadEnds(t);
    expect(ends.length).toBeGreaterThan(0);
    // The flagged dead end is the FIRST analysis (that the next one dismissed).
    expect(ends[0]).toContain("isfunction");
  });

  it("returns empty when no negative signals are present", () => {
    const t = tFromAnalyses(
      "hypothesis A",
      "also B applies",
      "therefore C fixes it",
    );
    expect(mineDeadEnds(t)).toEqual([]);
  });

  it("dedupes identical dead ends", () => {
    const t = tFromAnalyses(
      "tweak the regex for delimiter line",
      "doesn't work",
      "tweak the regex for delimiter line",
      "that's not it either",
      "pass header_rows explicitly instead",
    );
    const ends = mineDeadEnds(t);
    expect(ends.length).toBe(1);
  });

  it("caps output at max entries", () => {
    const steps: string[] = [];
    for (let i = 0; i < 20; i++) {
      steps.push(`candidate hypothesis number ${i}`);
      steps.push("that didn't work");
    }
    const t = tFromAnalyses(...steps);
    expect(mineDeadEnds(t, 3).length).toBeLessThanOrEqual(3);
    expect(mineDeadEnds(t).length).toBeLessThanOrEqual(5);
  });

  it("truncates each dead end to ≤ 20 words", () => {
    const long = Array(40).fill("x").join(" ");
    const t = tFromAnalyses(long, "that didn't work");
    const ends = mineDeadEnds(t);
    expect(ends.length).toBe(1);
    expect(ends[0].split(/\s+/).length).toBeLessThanOrEqual(20);
  });

  it("is deterministic across repeated runs", () => {
    const t = tFromAnalyses(
      "idea A",
      "doesn't work",
      "idea B",
      "revert that",
      "actual fix",
    );
    const a = mineDeadEnds(t);
    const b = mineDeadEnds(t);
    expect(a).toEqual(b);
  });

  it("does not get confused by analysis with embedded 'not' in normal prose", () => {
    // This must NOT trigger the negative-signal regex ("not" alone isn't a backout).
    const t = tFromAnalyses(
      "the bug is that the cache is not invalidated",
      "adding a cache-invalidation call fixes it",
    );
    expect(mineDeadEnds(t)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// summarizeDeadEnd
// ---------------------------------------------------------------------------

describe("heuristics — summarizeDeadEnd", () => {
  it("truncates to the word limit and trims whitespace", () => {
    const s = summarizeDeadEnd("  one two three four five   ", 3);
    expect(s).toBe("one two three");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(summarizeDeadEnd("   \n  \t ")).toBe("");
  });

  it("default limit is 20 words", () => {
    const input = Array(30).fill("w").join(" ");
    const out = summarizeDeadEnd(input);
    expect(out.split(" ").length).toBe(20);
  });
});
