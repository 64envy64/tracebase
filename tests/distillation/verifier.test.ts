import { describe, it, expect } from "vitest";
import { noopVerifier, type Verifier } from "../../src/distillation/verifier.js";
import { createBlock } from "../../src/core/block.js";
import type { StoreBlockInput } from "../../src/types.js";

const SAMPLE_INPUT: StoreBlockInput = {
  trigger: {
    situation: "example",
    invariants: { language: "python" },
  },
  body: {
    mechanism: "m", deadEnds: [], unlock: "u", verification: "v",
  },
  provenance: {
    sourceTaskId: "t-1", extractedFrom: "trajectory", distilledBy: "llm",
  },
};

describe("noopVerifier", () => {
  it("has name 'noop' so verdict rows stay correlatable", () => {
    expect(noopVerifier.name).toBe("noop");
  });

  it("returns status=inconclusive with a placeholder reason", async () => {
    const block = createBlock(SAMPLE_INPUT);
    const result = await noopVerifier.verify(block);
    expect(result.status).toBe("inconclusive");
    expect(result.verifier).toBe("noop");
    expect(result.reason).toBeTruthy();
    expect(result.reason?.toLowerCase()).toContain("phase");
  });

  it("does not mutate the input block", async () => {
    const block = createBlock(SAMPLE_INPUT);
    const snapshot = JSON.stringify(block);
    await noopVerifier.verify(block);
    expect(JSON.stringify(block)).toBe(snapshot);
  });

  it("ignores options", async () => {
    const block = createBlock(SAMPLE_INPUT);
    const r1 = await noopVerifier.verify(block);
    const r2 = await noopVerifier.verify(block, { taskId: "x", timeoutMs: 500 });
    expect(r1.status).toBe(r2.status);
  });
});

describe("Verifier interface (custom impl for Phase 4.5 readiness)", () => {
  it("allows a user-supplied verifier to be plugged in", async () => {
    const myVerifier: Verifier = {
      name: "held-out-runner@v1",
      async verify(_block, opts) {
        return {
          status: "verified",
          verifier: "held-out-runner@v1",
          taskId: opts?.taskId ?? "paraphrase-1",
        };
      },
    };
    const block = createBlock(SAMPLE_INPUT);
    const result = await myVerifier.verify(block, { taskId: "some-task" });
    expect(result.status).toBe("verified");
    expect(result.verifier).toBe("held-out-runner@v1");
    expect(result.taskId).toBe("some-task");
  });

  it("allows returning 'disproved'", async () => {
    const myVerifier: Verifier = {
      name: "strict",
      async verify() {
        return {
          status: "disproved",
          verifier: "strict",
          reason: "agent tried the unlock and regressed",
        };
      },
    };
    const block = createBlock(SAMPLE_INPUT);
    const r = await myVerifier.verify(block);
    expect(r.status).toBe("disproved");
  });
});
