/**
 * Privacy harness — diff / patch / pytest-id shapes never reach
 * storage.
 *
 * The block-side guard `detectLeakage` (`src/core/block.ts`) covers
 * three concrete code-block-shaped leaks that flag distillation
 * accidents:
 *
 *   • `diff-header`  — `--- a/foo.ts` / `+++ b/foo.ts`
 *   • `patch-hunk`   — `@@ -10,5 +10,7 @@`
 *   • `pytest-id`    — `tests/foo.py::test_bar`
 *
 * These are conservative, high-precision shapes. Generic fenced
 * code blocks (` ```python\nprint(1)\n``` `) are NOT explicitly
 * rejected — fenced code is sometimes the cleanest way to write a
 * `body.unlock` ("`pip install -U pytest`"), and an over-broad
 * fenced-code reject would block legitimate writes. A *fenced
 * block whose contents match a leakage shape* IS rejected because
 * the inner regex still fires; this file locks both ends.
 *
 * No CoT / "thinking…" prose guard yet — see `no-cot.test.ts` for
 * the documented gap. A future rc that introduces a chain-of-
 * thought scrubber will add positive cases here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore, LeakageError } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import type { StoreBlockInput } from "../../src/types.js";

let store: BlockStore;
beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

const baseInput: StoreBlockInput = {
  trigger: {
    situation: "Some generic situation without any code-block content",
    invariants: { language: "python" },
  },
  body: {
    mechanism: "explanation that has no fences",
    deadEnds: [],
    unlock: "fix expressed in plain prose",
    verification: "verify in prose",
  },
  provenance: {
    sourceTaskId: "demo-1",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

describe("privacy: no-code-block — diff / patch / pytest shapes", () => {
  it("rejects unified-diff headers in body.mechanism", () => {
    const block = createBlock({
      ...baseInput,
      body: {
        ...baseInput.body,
        mechanism: "before this fix\n--- a/src/foo.ts\n+++ b/src/foo.ts\nafter",
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).toThrow(LeakageError);
  });

  it("rejects patch hunks in body.mechanism", () => {
    const block = createBlock({
      ...baseInput,
      body: {
        ...baseInput.body,
        // The patch-hunk regex anchors `@@` to start-of-line, so a
        // realistic patch artifact (line begins with `@@ -10,5 +10,7
        // @@`) is what we plant.
        mechanism: "before the change\n@@ -10,5 +10,7 @@\nafter the change",
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).toThrow(LeakageError);
  });

  it("rejects pytest test ids", () => {
    const block = createBlock({
      ...baseInput,
      body: {
        ...baseInput.body,
        mechanism: "fails on tests/cli/foo.py::test_collects_correctly",
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).toThrow(LeakageError);
  });

  it("rejects fenced code that itself wraps a diff", () => {
    const block = createBlock({
      ...baseInput,
      body: {
        ...baseInput.body,
        unlock:
          "```diff\n--- a/src/foo.ts\n+++ b/src/foo.ts\n+ added line\n```",
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).toThrow(LeakageError);
  });

  it("accepts generic fenced code when it carries no leakage shape (current behavior)", () => {
    // Documented current gap: a fenced shell-install hint is a
    // legitimate `unlock` and is allowed today. If a future rc
    // tightens this, the test should flip to expect rejection and
    // the guard rationale gets documented in this file's header.
    const block = createBlock({
      ...baseInput,
      body: {
        ...baseInput.body,
        unlock: "Run `pip install -U pytest`",
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).not.toThrow();
  });
});
