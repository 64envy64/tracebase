import { describe, expect, it } from "vitest";
import {
  COST_SAVER_TOKEN_BUDGET,
  estimateFileNetTokens,
  filterFileHitsForRoi,
  resolveServingPlan,
  resolveServingProfile,
} from "../../src/runtime/serving-policy.js";
import type { FileHit } from "../../src/core/file-indexer.js";

function fileHit(relPath: string, sizeBytes: number): FileHit {
  return {
    relPath,
    summary: "Exports the payment ledger normalizer and related helpers.",
    symbols: "{}",
    language: "typescript",
    sizeBytes,
    score: 0,
  };
}

describe("serving-policy", () => {
  it("defaults to the compact cost-saver profile", () => {
    expect(resolveServingProfile(undefined)).toBe("cost-saver");
    const plan = resolveServingPlan({ tokenBudget: 1200, hasSession: true });
    expect(plan.profile).toBe("cost-saver");
    expect(plan.tokenBudget).toBe(COST_SAVER_TOKEN_BUDGET);
    expect(plan.maxBlocks).toBe(1);
    expect(plan.maxFacts).toBe(1);
    expect(plan.maxFiles).toBe(1);
    expect(plan.maxChunks).toBe(1);
  });

  it("widens cautiously when the loop detector is recovering a stuck agent", () => {
    const plan = resolveServingPlan({
      tokenBudget: 1200,
      hasSession: true,
      signalKind: "straight",
    });
    expect(plan.profile).toBe("cost-saver");
    expect(plan.tokenBudget).toBeGreaterThan(COST_SAVER_TOKEN_BUDGET);
    expect(plan.maxBlocks).toBe(2);
  });

  it("keeps recall-heavy as an escape hatch for broad/debug recall", () => {
    const plan = resolveServingPlan({
      profile: "recall-heavy",
      tokenBudget: 1200,
      hasSession: true,
    });
    expect(plan.profile).toBe("recall-heavy");
    expect(plan.tokenBudget).toBe(1200);
    expect(plan.maxBlocks).toBe(4);
    expect(plan.maxFacts).toBe(4);
    expect(plan.maxFiles).toBe(3);
    expect(plan.maxChunks).toBe(3);
    expect(plan.minFileNetTokens).toBe(0);
  });

  it("filters file-memory hits whose summary would cost more than it saves", () => {
    const tiny = fileHit("src/tiny.ts", 48);
    const large = fileHit("src/ledger-normalizer.ts", 4096);
    const plan = resolveServingPlan({ profile: "cost-saver" });

    expect(estimateFileNetTokens(tiny)).toBeLessThan(plan.minFileNetTokens);
    expect(estimateFileNetTokens(large)).toBeGreaterThan(plan.minFileNetTokens);
    expect(filterFileHitsForRoi([tiny, large], plan).map((h) => h.relPath)).toEqual([
      "src/ledger-normalizer.ts",
    ]);
  });
});
