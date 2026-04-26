/**
 * Privacy harness — absolute paths never reach storage.
 *
 * The store-time guard is `detectLeakageExtended` (`src/core/guard.ts`),
 * which runs the seven extended-leakage regexes — including
 * `abs-path-posix` and `abs-path-windows` — over every concatenated
 * field of an incoming block / fact. The store rejects on a positive
 * match with `LeakageError`. This file locks that behavior at every
 * write entry point that exists today.
 *
 * NOT enforced by this primitive (intentionally, for now):
 *   - tool_observations rows. Those use `sanitizeToolArgs` on the
 *     hook side to project arg paths to repo-relative; the structural
 *     test in `no-tool-input-bodies.test.ts` covers that surface.
 *
 * When a future rc adds a new free-form-text storage path (file
 * indexer summary write in rc.2, chunk summary in rc.6), it extends
 * this file with the new entry point.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore, LeakageError } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import type { StoreBlockInput, StoreProjectFactInput } from "../../src/types.js";

let store: BlockStore;
beforeEach(() => {
  store = new BlockStore(new Database(":memory:"));
});

const PLANTED_ABS_PATHS = [
  // POSIX shapes that the extended pattern catches.
  "/Users/me/secret/project/keys.env",
  "/home/alice/.ssh/id_rsa",
  "/etc/passwd",
  "/var/log/private.txt",
  "/tmp/tracebase-secret.json",
  "/private/var/folders/abc/T/secret",
  "/root/.aws/credentials",
  // Windows shapes.
  "C:\\Users\\me\\AppData\\secret.json",
  "D:/work/private/leak.csv",
];

const baseBlockInput: StoreBlockInput = {
  trigger: {
    situation: "Generic situation that does not leak paths",
    invariants: { language: "python" },
  },
  body: {
    mechanism: "explanation that is path-free",
    deadEnds: [],
    unlock: "fix that mentions no paths",
    verification: "verify with pytest --collect-only",
  },
  provenance: {
    sourceTaskId: "demo-1",
    extractedFrom: "trajectory",
    distilledBy: "llm",
  },
};

const baseFactInput: StoreProjectFactInput = {
  scope: "global",
  factType: "convention",
  statement: "tests live under tests/cli",
  invariants: {},
  source: { origin: "declared" },
};

describe("privacy: no-abs-path — BlockStore.storeBlock", () => {
  it.each(PLANTED_ABS_PATHS)("rejects when block.body.mechanism contains %s", (planted) => {
    const block = createBlock({
      ...baseBlockInput,
      body: {
        ...baseBlockInput.body,
        // Planted in prose so it doesn't trigger any other guard
        // (no diff header, no patch hunk, no api key).
        mechanism: `the issue surfaced near ${planted} which we should not leak`,
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).toThrow(LeakageError);
  });

  it("rejects when block.body.unlock contains an absolute path", () => {
    const block = createBlock({
      ...baseBlockInput,
      body: {
        ...baseBlockInput.body,
        unlock: "edit /Users/me/secret/project/keys.env directly",
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).toThrow(LeakageError);
  });

  it("rejects when block.body.deadEnds carries a planted abs-path", () => {
    const block = createBlock({
      ...baseBlockInput,
      body: {
        ...baseBlockInput.body,
        deadEnds: ["tried touching /home/alice/.ssh/id_rsa"],
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).toThrow(LeakageError);
  });

  it("accepts repo-relative paths (control case)", () => {
    const block = createBlock({
      ...baseBlockInput,
      body: {
        ...baseBlockInput.body,
        mechanism: "the issue is in src/foo.ts under tests/cli/foo.test.ts",
      },
    });
    block.status = "candidate";
    expect(() => store.storeBlock(block)).not.toThrow();
    expect(store.getBlock(block.id)).toBeTruthy();
  });
});

describe("privacy: no-abs-path — BlockStore.storeFact", () => {
  it.each(PLANTED_ABS_PATHS)("rejects when fact.statement contains %s", (planted) => {
    expect(() =>
      store.storeFact({
        ...baseFactInput,
        statement: `the secret config sits near ${planted}`,
      }),
    ).toThrow(LeakageError);
  });

  it("accepts repo-relative paths in fact.statement", () => {
    expect(() =>
      store.storeFact({
        ...baseFactInput,
        statement: "the canonical config sits at config/tracebase.toml",
      }),
    ).not.toThrow();
  });
});
