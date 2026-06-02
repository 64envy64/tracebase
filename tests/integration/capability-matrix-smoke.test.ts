import { describe, expect, it } from "vitest";
import { runCapabilityMatrixSmoke } from "../../scripts/capability-matrix-smoke.js";

describe("five-capability integrated workspace smoke", () => {
  it("composes all runtime arms without hook contamination or path leakage", async () => {
    const result = await runCapabilityMatrixSmoke();
    expect(result.hooks).toEqual([
      "UserPromptSubmit",
      "Stop",
      "PreCompact",
      "PostToolBatch",
      "PreToolUse",
    ]);
    expect(result.contextSections).toEqual(["<tracebase", "<file_memory>", "<context_fold>"]);
    expect(result.preToolWarned).toBe(true);
    expect(result.loopBadge).toBe(true);
    expect(result.absolutePathLeak).toBe(false);
  });
});
