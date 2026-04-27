import { describe, it, expect } from "vitest";
import { validateCandidate, failedChecks, SCHEMA_LIMITS } from "../../src/distillation/validator.ts";
import type { ReasoningBlock } from "../../src/types.js";

function candidate(
  over: Partial<ReasoningBlock["trigger"]> = {},
  body: Partial<ReasoningBlock["body"]> = {},
  kind?: ReasoningBlock["kind"],
): Pick<ReasoningBlock, "trigger" | "body"> & Partial<Pick<ReasoningBlock, "kind">> {
  return {
    ...(kind ? { kind } : {}),
    trigger: {
      situation: "metaclass iterates members using inspect isfunction skipping properties",
      invariants: { language: "python" },
      keywords: [],
      fingerprint: "fp",
      ...over,
    },
    body: {
      mechanism: "property objects are descriptors not functions",
      deadEnds: ["add property-specific branch"],
      unlock: "use inspect.isdatadescriptor to cover both",
      verification: "class with method and property inherits docstrings from parent",
      ...body,
    },
  };
}

describe("validator — happy path", () => {
  it("returns passed=true on a clean, well-formed block", () => {
    const report = validateCandidate(candidate());
    expect(report.passed).toBe(true);
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(typeof report.checkedAt).toBe("number");
  });

  it("records the `now` override verbatim", () => {
    const report = validateCandidate(candidate(), { now: 42 });
    expect(report.checkedAt).toBe(42);
  });

  it("reports every check even when all pass", () => {
    const report = validateCandidate(candidate());
    const names = report.checks.map((c) => c.name);
    // Spot-check presence of each family.
    expect(names).toContain("leakage");
    expect(names).toContain("schema:situation-nonempty");
    expect(names).toContain("schema:mechanism-length");
    expect(names).toContain("schema:dead-ends-count");
  });
});

describe("validator — leakage", () => {
  it("fails when body contains a diff header", () => {
    const c = candidate({}, { unlock: "Apply: --- a/x.py\n+++ b/x.py" });
    const report = validateCandidate(c);
    expect(report.passed).toBe(false);
    expect(failedChecks(report).some((n) => n.startsWith("leakage"))).toBe(true);
  });

  it("fails when body contains a pytest id", () => {
    const c = candidate({}, { verification: "run test_rst.py::test_header_rows" });
    const report = validateCandidate(c);
    expect(report.passed).toBe(false);
    expect(failedChecks(report).some((n) => n.startsWith("leakage"))).toBe(true);
  });

  it("reason names the leakage type", () => {
    const c = candidate({}, { unlock: "Apply: --- a/x.py\n+++ b/x.py" });
    const report = validateCandidate(c);
    const leakCheck = report.checks.find((c) => c.name.startsWith("leakage"))!;
    expect(leakCheck.reason).toContain("diff-header");
  });
});

describe("validator — schema", () => {
  it("fails when situation exceeds word limit", () => {
    const long = Array(SCHEMA_LIMITS.situationMaxWords + 5).fill("w").join(" ");
    const report = validateCandidate(candidate({ situation: long }));
    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain("schema:situation-length");
  });

  it("fails when unlock exceeds word limit", () => {
    const long = Array(SCHEMA_LIMITS.unlockMaxWords + 2).fill("w").join(" ");
    const report = validateCandidate(candidate({}, { unlock: long }));
    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain("schema:unlock-length");
  });

  it("fails on empty required field", () => {
    const report = validateCandidate(candidate({}, { mechanism: "   " }));
    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain("schema:mechanism-nonempty");
  });

  it("fails when dead ends count exceeds the cap", () => {
    const tooMany = Array(SCHEMA_LIMITS.deadEndsMax + 1).fill("word");
    const report = validateCandidate(candidate({}, { deadEnds: tooMany }));
    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain("schema:dead-ends-count");
  });

  it("fails when an individual dead end exceeds its per-item word cap", () => {
    const long = Array(SCHEMA_LIMITS.deadEndMaxWords + 2).fill("w").join(" ");
    const report = validateCandidate(candidate({}, { deadEnds: [long] }));
    expect(report.passed).toBe(false);
    expect(failedChecks(report).some((n) => n.startsWith("schema:dead-end-"))).toBe(true);
  });

  it("accepts an empty deadEnds array (allowed by schema)", () => {
    const report = validateCandidate(candidate({}, { deadEnds: [] }));
    expect(report.passed).toBe(true);
  });

  it("accepts custom limits override", () => {
    const shortUnlock = "a b c d e";
    // With a 3-word limit, this fails.
    const fail = validateCandidate(candidate({}, { unlock: shortUnlock }), {
      limits: { unlockMaxWords: 3 },
    });
    expect(fail.passed).toBe(false);
    // With a 10-word limit, this passes.
    const pass = validateCandidate(candidate({}, { unlock: shortUnlock }), {
      limits: { unlockMaxWords: 10 },
    });
    expect(pass.passed).toBe(true);
  });
});

describe("validator — pitfall kind", () => {
  it("rejects a pitfall block with no deadEnds", () => {
    const report = validateCandidate(candidate({}, { deadEnds: [] }, "pitfall"));
    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain("schema:dead-ends-count");
  });

  it("accepts a pitfall block with exactly one deadEnd", () => {
    const report = validateCandidate(
      candidate({}, { deadEnds: ["single trap signature"] }, "pitfall"),
    );
    expect(report.passed).toBe(true);
  });

  it("still enforces the max deadEnds cap on pitfall blocks", () => {
    const tooMany = Array(SCHEMA_LIMITS.deadEndsMax + 1).fill("trap");
    const report = validateCandidate(candidate({}, { deadEnds: tooMany }, "pitfall"));
    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain("schema:dead-ends-count");
  });
});

describe("validator — guardrails", () => {
  it("accepts an absent guardrails array", () => {
    const report = validateCandidate(candidate());
    expect(report.passed).toBe(true);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("schema:guardrails-count");
  });

  it("accepts up to the guardrails cap", () => {
    const report = validateCandidate(
      candidate({}, { guardrails: ["g1", "g2", "g3"] }),
    );
    expect(report.passed).toBe(true);
  });

  it("fails when guardrails count exceeds the cap", () => {
    const report = validateCandidate(
      candidate({}, { guardrails: ["g1", "g2", "g3", "g4"] }),
    );
    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain("schema:guardrails-count");
  });

  it("fails when an individual guardrail exceeds the per-item cap", () => {
    const long = Array(SCHEMA_LIMITS.guardrailMaxWords + 2).fill("w").join(" ");
    const report = validateCandidate(candidate({}, { guardrails: [long] }));
    expect(report.passed).toBe(false);
    expect(failedChecks(report).some((n) => n.startsWith("schema:guardrail-"))).toBe(true);
  });

  it("applies the leakage regex to guardrails", () => {
    const report = validateCandidate(
      candidate({}, { guardrails: ["stop if you run tests.py::test_bad"] }),
    );
    expect(report.passed).toBe(false);
    expect(failedChecks(report).some((n) => n.startsWith("leakage"))).toBe(true);
  });
});

describe("validator — report shape", () => {
  it("failedChecks lists only failing check names", () => {
    const c = candidate({ situation: "" }, { mechanism: "" });
    const report = validateCandidate(c);
    const failed = failedChecks(report);
    expect(failed).toContain("schema:situation-nonempty");
    expect(failed).toContain("schema:mechanism-nonempty");
    // The leakage check still passed (empty string has no patterns).
    expect(failed).not.toContain("leakage");
  });

  it("is pure — multiple calls with the same input are identical", () => {
    const c = candidate();
    const a = validateCandidate(c, { now: 100 });
    const b = validateCandidate(c, { now: 100 });
    expect(a).toEqual(b);
  });
});
