/**
 * `src/runtime/tool-family.ts` — local tool-name normaliser
 * (PLAN-0.5.4 §6 amendment).
 *
 * Privacy gate: an unknown tool name MUST map to `"other"`.
 * Literal Claude tool names never reach the cloud.
 */
import { describe, expect, it } from "vitest";
import {
  emptyToolFamilyCounts,
  toolFamily,
  toolFamilyOf,
  TOOL_FAMILIES,
  type ToolFamily,
} from "../../src/runtime/tool-family.js";
import { sanitizeForCloud, USAGE_SAMPLE_ALLOWLIST } from "../../src/cli/cloud-allowlist.js";

describe("toolFamily — known mappings", () => {
  it.each([
    ["Read", "read"],
    ["Grep", "search"],
    ["Glob", "search"],
    ["Bash", "shell"],
    ["Edit", "edit"],
    ["NotebookEdit", "edit"],
    ["Write", "write"],
    ["WebFetch", "web"],
    ["WebSearch", "web"],
    ["Task", "task"],
    ["Skill", "task"],
  ])("%s → %s", (input, expected) => {
    expect(toolFamily(input)).toBe(expected);
  });
});

// 0.7.0-rc.1 §Ground — additional non-Claude-Code aliases so
// LangChain / LangGraph / Agent SDK tools collapse to the same
// frozen family vocabulary as Claude Code does. The eight family
// slots stay the same; only the alias surface widens.
describe("toolFamily — 0.7.0-rc.1 cross-host aliases", () => {
  it.each([
    ["Cat", "read"],
    ["MultiRead", "read"],
    ["ripgrep", "search"],
    ["ag", "search"],
    ["findstr", "search"],
    ["Shell", "shell"],
    ["Exec", "shell"],
    ["Run", "shell"],
    ["MultiEdit", "edit"],
    ["Patch", "edit"],
    ["Create", "write"],
    ["HttpGet", "web"],
    ["HttpPost", "web"],
  ])("%s → %s", (input, expected) => {
    expect(toolFamily(input)).toBe(expected);
  });

  it("toolFamilyOf is an alias for toolFamily — same contract", () => {
    // Spec spells the function as `toolFamilyOf`; the existing
    // export is `toolFamily`. Both must return identical values
    // including the privacy invariant on unknown names.
    for (const name of [
      "Read",
      "Grep",
      "Bash",
      "Cat",
      "ripgrep",
      "FuturisticMystery",
      "MyCompany.SecretInternalProbe",
      "",
    ]) {
      expect(toolFamilyOf(name)).toBe(toolFamily(name));
    }
  });
});

describe("toolFamily — privacy invariant", () => {
  it("unknown tool names map to `other` — literal name NEVER returned", () => {
    expect(toolFamily("FuturisticMystery")).toBe("other");
    expect(toolFamily("CompanySpecificTool")).toBe("other");
    expect(toolFamily("")).toBe("other");
    expect(toolFamily("read")).toBe("other"); // case-sensitive — lowercase 'read' is the family slot, not a tool
  });

  it("the eight families are the complete vocabulary", () => {
    expect(new Set(TOOL_FAMILIES)).toEqual(
      new Set(["read", "search", "shell", "edit", "write", "web", "task", "other"]),
    );
  });
});

describe("emptyToolFamilyCounts", () => {
  it("returns every family slot at zero", () => {
    const counts = emptyToolFamilyCounts();
    for (const f of TOOL_FAMILIES as readonly ToolFamily[]) {
      expect(counts[f]).toBe(0);
    }
  });
});

describe("cloud allowlist — toolBatch privacy regression (PLAN-0.5.4 §6.3)", () => {
  it("strips literal Claude tool names from toolFamilyCounts", () => {
    const payload = {
      installationId: "inst",
      windowStart: "2026-04-01T00:00:00Z",
      windowEnd: "2026-05-01T00:00:00Z",
      cliVersion: "0.5.4",
      metrics: {
        scope: "workspace" as const,
        window: { afterTs: 1, beforeTs: 2 },
        observed: {
          eligibleRuns: 0,
          recalledRuns: 0,
          injectedRuns: 0,
          usedRuns: 0,
          helpfulRuns: 0,
          resolvedRateWithMemory: null,
        },
        estimated: {
          tokensSaved: { value: 0, sampleSize: 0, formula: "noop" },
          latencySavedMs: { value: 0, sampleSize: 0, formula: "noop" },
        },
        integrity: { shadowControlMismatches: 0, outcomesWithoutRetrieval: 0 },
        toolBatch: {
          duplicateCount: 3,
          loopCount: 1,
          // Literal Claude tool names + an unknown future name —
          // every one of these MUST be dropped at the wire.
          toolFamilyCounts: {
            read: 5,
            search: 2,
            // forbidden literal tool names:
            Read: 99,
            Grep: 99,
            Bash: 99,
            FuturisticMystery: 999,
          },
          errorClassCounts: {
            "abs-path-posix": 2,
            // forbidden non-enumerated class:
            "made-up-class": 99,
          },
        },
      },
    };
    const safe = sanitizeForCloud(payload, USAGE_SAMPLE_ALLOWLIST) as Record<string, unknown>;
    const tb = (safe.metrics as Record<string, unknown>).toolBatch as Record<string, unknown>;
    const families = tb.toolFamilyCounts as Record<string, unknown>;
    expect(families.read).toBe(5);
    expect(families.search).toBe(2);
    // CRITICAL — literal tool names are stripped.
    expect(families.Read).toBeUndefined();
    expect(families.Grep).toBeUndefined();
    expect(families.Bash).toBeUndefined();
    expect(families.FuturisticMystery).toBeUndefined();
    // The whole serialized payload must contain ZERO literal tool names.
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("FuturisticMystery");
    expect(serialized).not.toContain("\"Read\"");
    expect(serialized).not.toContain("\"Grep\"");
    expect(serialized).not.toContain("\"Bash\"");

    const errors = tb.errorClassCounts as Record<string, unknown>;
    expect(errors["abs-path-posix"]).toBe(2);
    expect(errors["made-up-class"]).toBeUndefined();
  });

  it("keeps the four enumerated toolBatch fields, drops anything extra", () => {
    const payload = {
      metrics: {
        toolBatch: {
          duplicateCount: 1,
          loopCount: 1,
          toolFamilyCounts: { read: 1 },
          errorClassCounts: { "abs-path-posix": 1 },
          // NOT in the allowlist — must be dropped.
          rawObservations: [{ argSummary: "Read(secret.ts)", argKey: "abc" }],
          arbitraryAddedField: "should-not-ship",
        },
      },
    };
    const safe = sanitizeForCloud(payload, USAGE_SAMPLE_ALLOWLIST) as Record<string, unknown>;
    const tb = (safe.metrics as Record<string, unknown>).toolBatch as Record<string, unknown>;
    expect(Object.keys(tb).sort()).toEqual([
      "duplicateCount",
      "errorClassCounts",
      "loopCount",
      "toolFamilyCounts",
    ]);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("rawObservations");
    expect(serialized).not.toContain("arbitraryAddedField");
    expect(serialized).not.toContain("argSummary");
    expect(serialized).not.toContain("argKey");
  });
});
