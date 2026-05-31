/**
 * Regression: generic runtime-capture robustness (0.9.x).
 *
 * The Phase-5 checkpoint captured 0 blocks because real trajectories carry an
 * operational preamble (working-directory + command boilerplate) and emit
 * markdown ("## Root Cause" / "## Fix"). extractPattern keyed `situation` off
 * the FIRST sentence (the abs-path boilerplate) → null / leakage rejection.
 *
 * These tests lock the GENERIC fix: skip operational scaffolding when seeding the
 * situation, distil markdown cause/fix sections, fail closed on a path-only turn,
 * and keep the privacy scanner as the final authority. No repo/benchmark phrases.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { extractPattern } from "../../src/cli/commands/capture-turn.js";
import { BlockStore } from "../../src/core/block-store.js";
import { storeReasoningPattern } from "../../src/server/mcp-v2-helpers.js";

const NATURAL_USER =
  "The pytest suite fails to collect the right package on a fresh clone because an " +
  "earlier sys.path entry shadows the intended namespace package, so imports resolve " +
  "to the wrong module and the tests error out during collection.";
const NATURAL_ASSISTANT =
  "The root cause is that an earlier sys.path entry exposes a namespace package that " +
  "shadows the intended one, so the pytest collector imports the wrong module during " +
  "collection. The first matching entry wins, which is why the intended package is " +
  "never reached.\n\n" +
  "Rename the shadowing module or remove its directory from sys.path before invoking " +
  "pytest, then run pytest collect-only to confirm the intended package is collected.";

// A real-shaped trajectory closing turn: operational preamble + markdown answer.
const PREAMBLE_USER = [
  "Working directory (operate strictly inside):",
  "/home/agent/ws/axios-axios-278041d8",
  "- Run the failing test with: npx vitest run --project unit tests/unit/axiosHeaders.test.js",
  "A unit test fails: tests/unit/axiosHeaders.test.js. There is a bug: AxiosHeaders wraps an " +
  "existing array of repeated header values in another array instead of appending, so duplicate " +
  "header fields are serialized incorrectly. Find and fix the root cause.",
].join("\n");
const MARKDOWN_ASSISTANT =
  "Perfect! All tests pass now.\n\n" +
  "## Root Cause\n" +
  "When handling repeated form field values (3+ occurrences), AxiosHeaders wrapped the " +
  "existing array in another array instead of appending to it, producing a nested array " +
  "that serialized to the wrong header value.\n\n" +
  "## Fix\n" +
  "Append to the existing array when the normalized header is already an array, rather " +
  "than re-wrapping it; only create a new array on the first duplicate.";

function freshStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}
const hasAbsPath = (s: string) => /(^|[\s"'`(])\/(home|mnt|usr|var|root|tmp|Users)\//.test(s);

describe("capture extractor robustness (0.9.x)", () => {
  it("1. a natural problem prompt still captures (legacy path preserved)", () => {
    const p = extractPattern(NATURAL_USER, NATURAL_ASSISTANT);
    expect(p).not.toBeNull();
    expect(p!.situation.toLowerCase()).toContain("pytest");
    expect(p!.mechanism.length).toBeGreaterThan(20);
    expect(p!.unlock.length).toBeGreaterThan(0);
  });

  it("2. an operational preamble captures the TASK, not the boilerplate/path", () => {
    const p = extractPattern(PREAMBLE_USER, MARKDOWN_ASSISTANT);
    expect(p).not.toBeNull();
    // situation reflects the real problem, not the working-dir/command lines.
    expect(p!.situation.toLowerCase()).toContain("axiosheaders");
    expect(p!.situation.toLowerCase()).not.toContain("working directory");
    expect(p!.situation.toLowerCase()).not.toContain("npx vitest");
    expect(hasAbsPath(p!.situation)).toBe(false);
  });

  it("3. an absolute path in the turn never reaches a stored block", () => {
    const p = extractPattern(PREAMBLE_USER, MARKDOWN_ASSISTANT);
    expect(p).not.toBeNull();
    expect(hasAbsPath(`${p!.situation}\n${p!.mechanism}\n${p!.unlock}\n${p!.verification}`)).toBe(false);
    const store = freshStore();
    try {
      const r = storeReasoningPattern(store, p!);
      expect(r.blockId).not.toBeNull(); // clean pattern stores fine
    } finally { store.close(); }
  });

  it("4. markdown Root Cause / Fix output distils into mechanism + unlock", () => {
    const p = extractPattern(PREAMBLE_USER, MARKDOWN_ASSISTANT);
    expect(p).not.toBeNull();
    expect(p!.mechanism.toLowerCase()).toContain("wrapped the existing array");
    expect(p!.mechanism).not.toContain("#");
    expect(p!.unlock.toLowerCase()).toContain("append");
  });

  it("5. a path-only / all-boilerplate prompt is rejected (fail closed)", () => {
    const pathOnly = [
      "Working directory (operate strictly inside):",
      "/home/agent/ws/proj",
      "- Run the failing test with: npx vitest run tests/unit/x.test.js",
      "- Do NOT modify the test file.",
    ].join("\n");
    expect(extractPattern(pathOnly, MARKDOWN_ASSISTANT)).toBeNull();
  });

  it("6. the privacy scanner still rejects genuine leakage (final authority)", () => {
    // A pattern whose situation carries an abs-path must be rejected at store time.
    const leaky = {
      situation: "The build breaks because /home/agent/secret/ws/config.json overrides the schema path.",
      mechanism: "An absolute path in the loader shadows the repo-relative config and wins resolution, " +
        "so the intended schema is never read and validation fails on every run.",
      unlock: "Resolve the config repo-relative and drop the absolute override before loading.",
      verification: "Re-run the build to confirm the schema validates.",
      distilledBy: "rule" as const,
    };
    const store = freshStore();
    try {
      expect(() => storeReasoningPattern(store, leaky as any)).toThrow(/leak/i);
    } finally { store.close(); }
  });
});
