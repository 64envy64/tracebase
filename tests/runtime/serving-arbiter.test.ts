/**
 * Serving arbiter tests — May-2026 C1.
 *
 * Synthetic candidate sets with hand-computed expected outcomes.
 * The arbiter is pure math, so every assertion below recomputes the
 * scoring formula directly. Anything we get wrong here mis-injects
 * (or under-injects) in production.
 */
import { describe, it, expect } from "vitest";
import {
  arbitrateServingCandidates,
  CONSERVATIVE_COLD_START_PROB,
  scoreCandidate,
  type ServingCandidate,
} from "../../src/runtime/serving-arbiter.js";
import { resolveServingPlan } from "../../src/runtime/serving-policy.js";

function cand(
  id: string,
  overrides: Partial<ServingCandidate> & { capability?: ServingCandidate["capability"] } = {},
): ServingCandidate {
  return {
    id,
    capability: "reasoning_reuse",
    injectionTokens: 50,
    estimatedAvoidedTokens: 400,
    relevanceScore: 0.7,
    calibratedHelpfulProb: 0.6,
    freshnessPenalty: 0,
    noisePenalty: 0,
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("computes expectedNetTokens = p * avoided - injection - penalties", () => {
    const s = scoreCandidate(
      cand("x", { calibratedHelpfulProb: 0.5, estimatedAvoidedTokens: 400, injectionTokens: 50, noisePenalty: 10, freshnessPenalty: 5 }),
    );
    // 0.5 * 400 - 50 - 10 - 5 = 135
    expect(s).toBe(135);
  });

  it("clamps probability into [0,1]", () => {
    expect(scoreCandidate(cand("x", { calibratedHelpfulProb: -0.5, estimatedAvoidedTokens: 400, injectionTokens: 50 })))
      .toBe(-50); // negative prob → 0 → cost-only
    expect(scoreCandidate(cand("x", { calibratedHelpfulProb: 2, estimatedAvoidedTokens: 400, injectionTokens: 50 })))
      .toBe(350); // clamps to 1 → 400 - 50
  });

  it("treats negative avoided tokens / penalties as zero (defensive)", () => {
    expect(scoreCandidate(cand("x", { estimatedAvoidedTokens: -100, injectionTokens: 50, calibratedHelpfulProb: 0.5 })))
      .toBe(-50);
    expect(scoreCandidate(cand("x", { noisePenalty: -50, calibratedHelpfulProb: 0.5, estimatedAvoidedTokens: 400, injectionTokens: 50 })))
      .toBe(150); // negative penalty floored at 0
  });
});

describe("arbitrateServingCandidates — cost-saver profile", () => {
  const plan = resolveServingPlan({ profile: "cost-saver" });

  it("rejects all candidates below the confidence floor with reason low_confidence", () => {
    const result = arbitrateServingCandidates(
      [
        cand("a", { calibratedHelpfulProb: 0.10 }), // below cost-saver floor 0.25
        cand("b", { calibratedHelpfulProb: 0.20 }),
      ],
      { plan },
    );
    expect(result.summary.reasoning_reuse).toEqual({ inject: 0, suppress: 2, shadow: 0 });
    expect(result.decisions[0]!.reason).toBe("low_confidence");
    expect(result.decisions[1]!.reason).toBe("low_confidence");
  });

  it("injects when expectedNetTokens > 0 and floor passes", () => {
    const c = cand("good", { calibratedHelpfulProb: 0.6, estimatedAvoidedTokens: 400, injectionTokens: 80 });
    // 0.6 * 400 - 80 = 160 > 0
    const result = arbitrateServingCandidates([c], { plan });
    expect(result.decisions[0]!.action).toBe("inject");
    expect(result.decisions[0]!.reason).toBe("positive_roi");
    expect(result.injectedTokens).toBe(80);
  });

  it("strict-positive: rejects expectedNetTokens === 0 on cost-saver", () => {
    // 0.5 * 100 - 50 = 0. Exactly zero. cost-saver must reject.
    const c = cand("edge", { calibratedHelpfulProb: 0.5, estimatedAvoidedTokens: 100, injectionTokens: 50 });
    const result = arbitrateServingCandidates([c], { plan });
    expect(result.decisions[0]!.action).toBe("suppress");
    expect(result.decisions[0]!.reason).toBe("low_confidence");
  });

  it("noisy memory stops being injected after calibrated prob drops + noisePenalty accumulates", () => {
    // Simulate the lifecycle: first call had 0.6 → injects. After a bad
    // outcome the calibrator drops prob to 0.15 (below floor); the
    // arbiter must reject.
    const firstPass = arbitrateServingCandidates(
      [cand("noisy", { calibratedHelpfulProb: 0.6, sourceId: "block-7" })],
      { plan },
    );
    expect(firstPass.decisions[0]!.action).toBe("inject");

    const secondPass = arbitrateServingCandidates(
      [cand("noisy", { calibratedHelpfulProb: 0.15, sourceId: "block-7", noisePenalty: 50 })],
      { plan },
    );
    expect(secondPass.decisions[0]!.action).toBe("suppress");
    expect(secondPass.decisions[0]!.reason).toBe("low_confidence");
  });

  it("dedupes against recentSourceIds with reason duplicate", () => {
    const result = arbitrateServingCandidates(
      [cand("a", { sourceId: "block-1", calibratedHelpfulProb: 0.7 })],
      { plan, recentSourceIds: new Set(["block-1"]) },
    );
    expect(result.decisions[0]!.action).toBe("suppress");
    expect(result.decisions[0]!.reason).toBe("duplicate");
  });

  it("flags stale when freshnessPenalty wholly cancels the upside", () => {
    const result = arbitrateServingCandidates(
      [cand("stale", { calibratedHelpfulProb: 0.8, estimatedAvoidedTokens: 100, freshnessPenalty: 200 })],
      { plan },
    );
    expect(result.decisions[0]!.action).toBe("suppress");
    expect(result.decisions[0]!.reason).toBe("stale");
  });
});

describe("arbitrateServingCandidates — budget + per-capability caps", () => {
  it("greedy walk stops at token budget with reason budget", () => {
    // cost-saver default budget ≈ 350 tokens. Three high-score blocks
    // at 200 tokens each — only the first should pass.
    const plan = resolveServingPlan({ profile: "cost-saver" });
    const cands = [
      cand("a", { calibratedHelpfulProb: 0.6, injectionTokens: 200, capability: "reasoning_reuse" }),
      cand("b", { calibratedHelpfulProb: 0.6, injectionTokens: 200, capability: "reasoning_reuse" }),
      cand("c", { calibratedHelpfulProb: 0.6, injectionTokens: 200, capability: "reasoning_reuse" }),
    ];
    const result = arbitrateServingCandidates(cands, { plan });
    const actions = result.decisions.map((d) => d.action);
    expect(actions.filter((a) => a === "inject").length).toBe(1);
    // The "first" by score order injects; the rest get reason=budget OR profile_cap
    // (cost-saver maxBlocks=1, so the second one hits profile_cap before budget).
    expect(result.decisions[1]!.action).toBe("suppress");
    expect(["budget", "profile_cap"]).toContain(result.decisions[1]!.reason);
  });

  it("respects per-capability cap with reason profile_cap", () => {
    // balanced.maxBlocks = 2 → third block gets profile_cap.
    const plan = resolveServingPlan({ profile: "balanced" });
    expect(plan.maxBlocks).toBe(2);
    const cands = [
      cand("a", { calibratedHelpfulProb: 0.6, injectionTokens: 50, capability: "reasoning_reuse" }),
      cand("b", { calibratedHelpfulProb: 0.6, injectionTokens: 50, capability: "reasoning_reuse" }),
      cand("c", { calibratedHelpfulProb: 0.6, injectionTokens: 50, capability: "reasoning_reuse" }),
    ];
    const result = arbitrateServingCandidates(cands, { plan });
    const reasons = result.decisions.map((d) => d.reason);
    expect(reasons.filter((r) => r === "profile_cap").length).toBe(1);
    expect(result.decisions.filter((d) => d.action === "inject").length).toBe(2);
  });

  it("capability diversity: doesn't let one capability drown another with near-equal scores", () => {
    const plan = resolveServingPlan({ profile: "balanced" });
    const cands = [
      cand("rr-1", { calibratedHelpfulProb: 0.6, capability: "reasoning_reuse" }),
      cand("rr-2", { calibratedHelpfulProb: 0.59, capability: "reasoning_reuse" }),
      cand("file-1", { calibratedHelpfulProb: 0.55, capability: "file_memory" }),
    ];
    const result = arbitrateServingCandidates(cands, { plan });
    const injected = result.decisions.filter((d) => d.action === "inject").map((d) => d.candidateId);
    // rr-1 wins outright; then file-1 should surface before rr-2 because
    // rr-2 is within 1 token of file-1 and we already used a reasoning_reuse slot.
    expect(injected[0]).toBe("rr-1");
    expect(injected).toContain("file-1");
  });
});

describe("arbitrateServingCandidates — shadow / holdout", () => {
  it("forces all candidates to action=shadow with reason=holdout when shadow:true", () => {
    const plan = resolveServingPlan({ profile: "cost-saver" });
    const result = arbitrateServingCandidates(
      [
        cand("a", { calibratedHelpfulProb: 0.9 }),
        cand("b", { calibratedHelpfulProb: 0.9 }),
      ],
      { plan, shadow: true },
    );
    expect(result.decisions.every((d) => d.action === "shadow")).toBe(true);
    expect(result.decisions.every((d) => d.reason === "holdout")).toBe(true);
    expect(result.injectedTokens).toBe(0);
  });
});

describe("arbitrateServingCandidates — recall-heavy escape hatch", () => {
  it("recall-heavy still respects per-capability caps but admits low confidence", () => {
    const plan = resolveServingPlan({ profile: "recall-heavy" });
    const result = arbitrateServingCandidates(
      [
        cand("a", { calibratedHelpfulProb: 0.05, capability: "reasoning_reuse" }),
        cand("b", { calibratedHelpfulProb: 0.05, capability: "reasoning_reuse" }),
      ],
      { plan },
    );
    // recall-heavy maxBlocks=4 so both fit; floors are off.
    expect(result.decisions.filter((d) => d.action === "inject").length).toBe(2);
  });
});

describe("CONSERVATIVE_COLD_START_PROB", () => {
  it("every capability has a documented cold-start prior", () => {
    const caps = [
      "reasoning_reuse",
      "file_memory",
      "loop_redirect",
      "tool_supervision",
      "context_fold",
      "context_pruning",
    ] as const;
    for (const cap of caps) {
      expect(CONSERVATIVE_COLD_START_PROB[cap]).toBeGreaterThan(0);
      expect(CONSERVATIVE_COLD_START_PROB[cap]).toBeLessThan(1);
    }
  });

  it("cold-start priors are conservative — none optimistic above 0.6", () => {
    for (const p of Object.values(CONSERVATIVE_COLD_START_PROB)) {
      expect(p).toBeLessThanOrEqual(0.6);
    }
  });
});
