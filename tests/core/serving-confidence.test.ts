/**
 * Serving-confidence decision layer + canonical tokenizer.
 *
 * Covers the conservative-precision policy and its negative controls:
 * generic one-token overlap, verbose-irrelevant-body overlap, ambiguous
 * sibling patterns, exact structured (API/error/symbol/path) matches, strong
 * multi-token matches, and empty/singleton corpora. All deterministic — no
 * DB, no network, no fixtures on disk.
 */
import { describe, it, expect } from "vitest";
import {
  tokenizeInformative,
  meaningfulTokens,
  isGenericToken,
  queryHash,
  STOP_WORDS,
  GENERIC_CODE_TOKENS,
} from "../../src/core/serving-tokenizer.js";
import {
  computeFeatures,
  decideServing,
  computeEvidenceConfidence,
  resolveServingPolicy,
  explainDecision,
  DEFAULT_SERVING_POLICY,
  SERVING_FEATURE_VERSION,
  type ServingCandidate,
  type ServingPolicy,
  type EvidenceCalibrator,
} from "../../src/core/serving-confidence.js";
import type { ReasoningBlock, BlockInvariants } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkBlock(
  id: string,
  situation: string,
  keywords: string[] = [],
  invariants: BlockInvariants = {},
): ReasoningBlock {
  return {
    id,
    trigger: { situation, keywords, invariants, fingerprint: `fp-${id}` },
  } as unknown as ReasoningBlock;
}

const cand = (block: ReasoningBlock, rankScore = 1): ServingCandidate => ({ block, rankScore });
const POLICY: ServingPolicy = DEFAULT_SERVING_POLICY;

// ---------------------------------------------------------------------------
// Canonical tokenizer
// ---------------------------------------------------------------------------

describe("serving-tokenizer", () => {
  it("drops stop-words, tool names, single-char, and numeric tokens; dedupes", () => {
    const toks = tokenizeInformative("Read the file and fix the metaclass 3 a metaclass");
    expect(toks).not.toContain("read"); // tool name
    expect(toks).not.toContain("the"); // stop word
    expect(toks).not.toContain("and");
    expect(toks).not.toContain("3"); // numeric
    expect(toks).not.toContain("a"); // single char
    expect(toks).toContain("metaclass");
    expect(toks).toContain("fix");
    // de-duplicated
    expect(toks.filter((t) => t === "metaclass")).toHaveLength(1);
  });

  it("splits dotted/slash paths into segments and keeps underscores", () => {
    expect(tokenizeInformative("src/core/recall.ts")).toEqual(["src", "core", "recall", "ts"]);
    expect(tokenizeInformative("rel_path")).toEqual(["rel_path"]);
  });

  it("meaningfulTokens removes generic vocabulary but keeps discriminative terms", () => {
    const toks = tokenizeInformative("metaclass function value registration");
    expect(meaningfulTokens(toks).sort()).toEqual(["metaclass", "registration"]);
    expect(isGenericToken("function")).toBe(true);
    expect(isGenericToken("metaclass")).toBe(false);
  });

  it("STOP_WORDS and GENERIC_CODE_TOKENS are disjoint roles (no overlap)", () => {
    const overlap = [...STOP_WORDS].filter((w) => GENERIC_CODE_TOKENS.has(w));
    expect(overlap).toEqual([]);
  });

  it("queryHash is deterministic, prefixed, and never embeds the raw text", () => {
    const a = queryHash("fix the metaclass conflict");
    const b = queryHash("fix the metaclass conflict");
    const c = queryHash("a different prompt");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("q_")).toBe(true);
    expect(a).not.toContain("metaclass");
  });
});

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

describe("computeFeatures", () => {
  it("strong multi-token match: high coverage, all meaningful, versioned", () => {
    const b = mkBlock("b1", "metaclass registration conflict in abstract base", [
      "metaclass",
      "registration",
      "abstract",
    ]);
    const { features, meaningfulMatchCount } = computeFeatures(
      { text: "metaclass registration conflict abstract" },
      cand(b),
    );
    expect(features.featureVersion).toBe(SERVING_FEATURE_VERSION);
    expect(features.informativeQueryTokenCount).toBe(4);
    expect(features.matchedInformativeTokenCount).toBe(4);
    expect(features.queryCoverage).toBe(1);
    expect(meaningfulMatchCount).toBe(4);
    expect(features.genericOnly).toBe(false);
    expect(features.evidenceConfidence).toBeGreaterThan(0.8);
  });

  it("generic-only overlap is flagged genericOnly with low confidence", () => {
    const b = mkBlock("b2", "function value handling", ["function", "value"]);
    const { features, meaningfulMatchCount } = computeFeatures(
      { text: "fix the function value" },
      cand(b),
    );
    expect(features.matchedInformativeTokenCount).toBeGreaterThan(0);
    expect(meaningfulMatchCount).toBe(0);
    expect(features.genericOnly).toBe(true);
    expect(features.evidenceConfidence).toBeLessThanOrEqual(0.2);
  });

  it("structured invariant matches: apiSurface, errorType", () => {
    const b = mkBlock("b3", "numpy ufunc dispatch override", ["ufunc"], {
      apiSurface: ["numpy.ndarray.__array_ufunc__"],
      errorType: "TypeError",
    });
    const f = computeFeatures(
      {
        text: "ufunc override",
        invariants: { apiSurface: ["numpy.ndarray.__array_ufunc__"], errorType: "TypeError" },
      },
      cand(b),
    ).features;
    expect(f.apiSurfaceExactMatch).toBe(true);
    expect(f.errorTypeExactMatch).toBe(true);
    expect(f.evidenceConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it("symbolExactMatch on an identifier-like curated keyword; pathTokenMatch on a path query", () => {
    const b = mkBlock("b4", "normalize ledger row amount", ["rel_path", "normalize_ledger_row"]);
    const sym = computeFeatures({ text: "bug in normalize_ledger_row" }, cand(b)).features;
    expect(sym.symbolExactMatch).toBe(true);

    const pathBlock = mkBlock("b5", "recall ranking path", ["recall"]);
    const path = computeFeatures({ text: "edit src/core/recall.ts ranking" }, cand(pathBlock)).features;
    expect(path.pathTokenMatch).toBe(true);
  });

  it("verbose irrelevant trigger does not manufacture evidence (body is never read)", () => {
    const b = mkBlock(
      "b6",
      "kubernetes pod scheduling affinity taints tolerations node selector",
      ["kubernetes", "scheduling"],
    );
    const f = computeFeatures({ text: "metaclass registration conflict" }, cand(b)).features;
    expect(f.matchedInformativeTokenCount).toBe(0);
    expect(f.evidenceConfidence).toBe(0);
  });
});

describe("computeEvidenceConfidence", () => {
  it("is coverage-dominant, floored by structured matches, capped for generic-only", () => {
    expect(
      computeEvidenceConfidence({
        queryCoverage: 0.1,
        triggerCoverage: 0.1,
        apiSurfaceExactMatch: true,
        errorTypeExactMatch: false,
        symbolExactMatch: false,
        genericOnly: false,
      }),
    ).toBeGreaterThanOrEqual(0.8);
    expect(
      computeEvidenceConfidence({
        queryCoverage: 0.9,
        triggerCoverage: 0.9,
        apiSurfaceExactMatch: false,
        errorTypeExactMatch: false,
        symbolExactMatch: false,
        genericOnly: true,
      }),
    ).toBeLessThanOrEqual(0.2);
  });
});

// ---------------------------------------------------------------------------
// Decision — negative controls + positive cases
// ---------------------------------------------------------------------------

describe("decideServing — abstention controls", () => {
  it("empty corpus → abstain no_candidates", () => {
    const { decision } = decideServing({ text: "anything" }, [], POLICY);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("no_candidates");
  });

  it("generic one-token overlap → abstain generic_only", () => {
    const b = mkBlock("g1", "function value handling", ["function", "value"]);
    const { decision } = decideServing({ text: "fix the function value" }, [cand(b)], POLICY);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("generic_only");
  });

  it("single short non-generic token, no structured match → abstain weak_evidence", () => {
    const b = mkBlock("w1", "color theme palette", ["color"]);
    const { decision } = decideServing({ text: "color stuff" }, [cand(b)], POLICY);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("weak_evidence");
  });

  it("verbose irrelevant body overlap → abstain weak_evidence (no trigger overlap)", () => {
    const b = mkBlock("v1", "kubernetes pod scheduling affinity", ["kubernetes"]);
    const { decision } = decideServing({ text: "metaclass registration conflict" }, [cand(b)], POLICY);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("weak_evidence");
  });

  it("ambiguous sibling patterns (equal confidence) → abstain ambiguous_margin", () => {
    const a = mkBlock("s1", "color theme dark mode", ["color", "theme"]);
    const b = mkBlock("s2", "color theme dark mode", ["color", "theme"]);
    const { decision } = decideServing({ text: "color theme" }, [cand(a, 1.0), cand(b, 0.99)], POLICY);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("ambiguous_margin");
    expect(decision.features?.margin).toBeLessThan(POLICY.marginThreshold);
  });

  it("calibrator vetoes a lexically-strong hit → abstain below_calibrated_threshold", () => {
    const b = mkBlock("c1", "metaclass registration conflict abstract", [
      "metaclass",
      "registration",
      "abstract",
    ]);
    const lowCalibrator: EvidenceCalibrator = () => 0.1;
    const { decision } = decideServing(
      { text: "metaclass registration conflict abstract" },
      [cand(b)],
      POLICY,
      lowCalibrator,
    );
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("below_calibrated_threshold");
    expect(decision.calibratedProb).toBe(0.1);
  });
});

describe("decideServing — injection cases", () => {
  it("strong meaningful multi-token match → inject", () => {
    const b = mkBlock("i1", "metaclass registration conflict in abstract base", [
      "metaclass",
      "registration",
      "abstract",
    ]);
    const { decision } = decideServing(
      { text: "metaclass registration conflict abstract" },
      [cand(b)],
      POLICY,
    );
    expect(decision.action).toBe("inject");
    expect(decision.reason).toBe("injected");
    expect(decision.calibratedProb).toBeGreaterThanOrEqual(POLICY.gateThreshold);
  });

  it("exact structured (apiSurface) match licenses a one-token pass → inject", () => {
    const b = mkBlock("i2", "numpy ufunc dispatch", ["ufunc"], {
      apiSurface: ["numpy.ndarray.__array_ufunc__"],
    });
    const { decision } = decideServing(
      { text: "ufunc", invariants: { apiSurface: ["numpy.ndarray.__array_ufunc__"] } },
      [cand(b)],
      POLICY,
    );
    expect(decision.action).toBe("inject");
    expect(decision.features?.apiSurfaceExactMatch).toBe(true);
  });

  it("lone strong candidate injects (no runner-up ⇒ no margin abstain)", () => {
    const b = mkBlock("i3", "isotonic calibrator regression fitting", [
      "isotonic",
      "calibrator",
      "regression",
    ]);
    const { decision } = decideServing(
      { text: "isotonic calibrator regression" },
      [cand(b)],
      POLICY,
    );
    expect(decision.action).toBe("inject");
  });

  it("clear winner over a weak sibling injects (margin satisfied)", () => {
    const strong = mkBlock("i4", "isotonic calibrator regression fitting curve", [
      "isotonic",
      "calibrator",
      "regression",
    ]);
    // Sibling shares "calibrator" only via situation text (NOT a curated
    // keyword), so it does not earn a symbolExactMatch floor and stays a
    // genuinely weak runner-up — the margin to the strong winner is wide.
    const weak = mkBlock("i5", "calibrator unrelated note", []);
    const { decision } = decideServing(
      { text: "isotonic calibrator regression" },
      [cand(strong, 1.0), cand(weak, 0.4)],
      POLICY,
    );
    expect(decision.action).toBe("inject");
    expect(decision.features?.margin).toBeGreaterThanOrEqual(POLICY.marginThreshold);
  });
});

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

describe("resolveServingPolicy", () => {
  it("returns defaults with no diagnostics when env is clean", () => {
    const { policy, diagnostics } = resolveServingPolicy({}, {});
    expect(policy).toEqual(DEFAULT_SERVING_POLICY);
    expect(diagnostics).toEqual([]);
  });

  it("applies valid env overrides and records a diagnostic for each", () => {
    const { policy, diagnostics } = resolveServingPolicy(
      {},
      { TRACEBASE_GATE_THRESHOLD: "0.6", TRACEBASE_SERVING_MARGIN: "0.25" },
    );
    expect(policy.gateThreshold).toBe(0.6);
    expect(policy.marginThreshold).toBe(0.25);
    expect(diagnostics.some((d) => d.includes("gateThreshold=0.6"))).toBe(true);
    expect(diagnostics.some((d) => d.includes("marginThreshold=0.25"))).toBe(true);
  });

  it("ignores out-of-range env values (never a silent disable) and notes it", () => {
    const { policy, diagnostics } = resolveServingPolicy(
      {},
      { TRACEBASE_GATE_THRESHOLD: "5", TRACEBASE_SERVING_MIN_MATCHES: "1.5" },
    );
    expect(policy.gateThreshold).toBe(DEFAULT_SERVING_POLICY.gateThreshold);
    expect(policy.minMeaningfulMatches).toBe(DEFAULT_SERVING_POLICY.minMeaningfulMatches);
    expect(diagnostics.some((d) => d.includes("ignored"))).toBe(true);
  });
});

describe("explainDecision", () => {
  it("renders a readable INJECT / ABSTAIN line", () => {
    const b = mkBlock("e1", "metaclass registration conflict abstract", [
      "metaclass",
      "registration",
      "abstract",
    ]);
    const { decision } = decideServing(
      { text: "metaclass registration conflict abstract" },
      [cand(b)],
      POLICY,
    );
    const line = explainDecision(decision);
    expect(line).toMatch(/^INJECT:/);
    expect(line).toContain("conf=");
  });
});
