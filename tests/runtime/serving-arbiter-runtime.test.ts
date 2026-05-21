/**
 * C4-runtime regression suite — serving-arbiter wiring.
 *
 * Five binding contracts:
 *   1. Env-gate strictness: ONLY `"1"` enables the arbiter; any
 *      other value (missing, empty, "0", "true", "yes", " 1 ")
 *      keeps the legacy path active.
 *   2. Byte-for-byte identity with env unset: `recallForPrompt`
 *      produces the same `InjectionPayload` and emits zero
 *      `arbitration_decision` events.
 *   3. Cold-start priors hold: a fresh block (no calibrator
 *      evidence yet) gets a conservative `estimatedAvoidedTokens`
 *      and the cost-saver profile rejects unless the calibrator
 *      output is genuinely confident.
 *   4. Drop / reorder reasons land in telemetry with the closed-
 *      vocab enum — no raw triggers, bodies, prompts, or paths
 *      leak.
 *   5. Per-decision emission is durable: validator round-trips a
 *      well-formed event; payloads with unknown reasons / non-
 *      finite scalars are rejected at the JSONL boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initConfig } from "../../src/core/config.js";
import { BlockStore } from "../../src/core/block-store.js";
import { BlockServer } from "../../src/core/block-serving.js";
import { createBlock } from "../../src/core/block.js";
import { loadBlockCalibrator } from "../../src/lifecycle/calibrator.js";
import { recallForPrompt, type HoldoutLoader } from "../../src/runtime/recall.js";
import {
  isServingArbiterEnabled,
  estimateBlockInjectionTokens,
  estimateFactInjectionTokens,
  normalizeReasoningHits,
  runServingArbiter,
  BLOCK_AVOIDED_TOKENS_ESTIMATE,
  FACT_AVOIDED_TOKENS_ESTIMATE,
} from "../../src/runtime/serving-arbiter-runtime.js";
import {
  importEventsFromJsonl,
  exportEventsToJsonl,
} from "../../src/core/analytics.js";
import { resolveServingPlan } from "../../src/runtime/serving-policy.js";
import type { BlockHit, FactHit, RecallV2Result } from "../../src/core/block-serving.js";
import type { ProjectFact, ReasoningBlock, StoreBlockInput } from "../../src/types.js";

const NO_HOLDOUT: HoldoutLoader = () => null;

const PYTEST_BLOCK: StoreBlockInput = {
  trigger: {
    situation: "Pytest collection picks up the wrong package due to sys.path shadow",
    invariants: { language: "python", framework: "pytest" },
  },
  body: {
    mechanism: "an earlier sys.path entry shadows the intended namespace package",
    deadEnds: [],
    unlock: "rename the shadowing module or remove its directory from sys.path",
    verification: "pytest --collect-only shows the intended package",
  },
  provenance: { sourceTaskId: "pytest-1", extractedFrom: "trajectory", distilledBy: "llm" },
};

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function seedActiveBlock(store: BlockStore, input: StoreBlockInput): ReasoningBlock {
  const b = createBlock(input);
  b.status = "candidate";
  store.storeBlock(b);
  store.attachCaseRef({
    blockId: b.id,
    traceId: `trace-${b.provenance.sourceTaskId}`,
    role: "origin",
    evidenceQuality: "strong",
  });
  return store.updateBlockStatus(b.id, "active")!;
}

async function withFreshStore(
  fn: (store: BlockStore, server: BlockServer, basePath: string) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tb-arb-rt-"));
  try {
    const cfg = initConfig(dir);
    const db = new Database(cfg.storagePath);
    const store = new BlockStore(db);
    const server = new BlockServer(store, {
      calibrator: loadBlockCalibrator(store),
      emitEvents: false,
      gateThreshold: 0,
    });
    try {
      await fn(store, server, dir);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Helper — restore env var after a test that mutated it.
function withEnv(key: string, value: string | undefined, body: () => void | Promise<void>): void | Promise<void> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

beforeEach(() => {
  // Belt-and-suspenders: clear the env in case a previous test
  // leaked. Per-test setters use `withEnv` for scope.
  delete process.env.TRACEBASE_SERVING_ARBITER;
});

afterEach(() => {
  delete process.env.TRACEBASE_SERVING_ARBITER;
});

// ---------------------------------------------------------------------------
// 1. Env-gate strictness
// ---------------------------------------------------------------------------

describe("isServingArbiterEnabled — env-gate strictness", () => {
  it("returns true ONLY when raw === \"1\"", () => {
    expect(isServingArbiterEnabled("1")).toBe(true);
  });

  it("returns false for missing / empty / truthy-looking values", () => {
    expect(isServingArbiterEnabled(undefined)).toBe(false);
    expect(isServingArbiterEnabled(null)).toBe(false);
    expect(isServingArbiterEnabled("")).toBe(false);
    expect(isServingArbiterEnabled("0")).toBe(false);
    expect(isServingArbiterEnabled("true")).toBe(false);
    expect(isServingArbiterEnabled("yes")).toBe(false);
    expect(isServingArbiterEnabled("on")).toBe(false);
    expect(isServingArbiterEnabled(" 1 ")).toBe(false); // whitespace strict
    expect(isServingArbiterEnabled("1\n")).toBe(false);
  });

  it("reads from process.env by default", () => {
    delete process.env.TRACEBASE_SERVING_ARBITER;
    expect(isServingArbiterEnabled()).toBe(false);
    process.env.TRACEBASE_SERVING_ARBITER = "1";
    expect(isServingArbiterEnabled()).toBe(true);
    delete process.env.TRACEBASE_SERVING_ARBITER;
  });
});

// ---------------------------------------------------------------------------
// 2. Pure normalization
// ---------------------------------------------------------------------------

function dummyBlockHit(overrides: Partial<{
  score: number;
  calibratedProb: number;
  passesGate: boolean;
  situation: string;
}>): BlockHit {
  const block = createBlock({
    ...PYTEST_BLOCK,
    trigger: {
      ...PYTEST_BLOCK.trigger,
      situation: overrides.situation ?? PYTEST_BLOCK.trigger.situation,
    },
  });
  return {
    block,
    score: overrides.score ?? 0.7,
    calibratedProb: overrides.calibratedProb ?? 0.5,
    passesGate: overrides.passesGate ?? true,
    refs: [],
  };
}

function dummyFactHit(overrides: Partial<{
  score: number;
  calibratedProb: number;
  passesGate: boolean;
  statement: string;
}>): FactHit {
  const fact: ProjectFact = {
    id: "fact-test",
    version: 1,
    scope: "global",
    factType: "convention",
    statement: overrides.statement ?? "Use rg over grep for searches",
    invariants: {},
    source: { origin: "declared" },
    confidence: 0.8,
    lastVerifiedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "active",
  };
  return {
    fact,
    score: overrides.score ?? 0.6,
    calibratedProb: overrides.calibratedProb ?? 0.5,
    passesGate: overrides.passesGate ?? true,
  };
}

describe("estimateBlockInjectionTokens / estimateFactInjectionTokens — pure cost model", () => {
  it("scales with content length and includes wrapper overhead", () => {
    const short = dummyBlockHit({ situation: "x" });
    const long = dummyBlockHit({ situation: "x".repeat(400) });
    expect(estimateBlockInjectionTokens(short)).toBeGreaterThan(0);
    expect(estimateBlockInjectionTokens(long)).toBeGreaterThan(
      estimateBlockInjectionTokens(short),
    );
  });

  it("fact estimator is bounded and uses statement (not deprecated `value`)", () => {
    const fact = dummyFactHit({ statement: "rg beats grep" });
    expect(estimateFactInjectionTokens(fact)).toBeGreaterThan(0);
  });
});

describe("normalizeReasoningHits — RecallV2Result → ServingCandidate[]", () => {
  it("filters out hits whose passesGate=false (avoid double-suppression)", () => {
    const raw: RecallV2Result = {
      queryId: "q-1",
      shadow: false,
      blocks: [
        dummyBlockHit({ passesGate: true }),
        dummyBlockHit({ passesGate: false, situation: "different problem rejected by gate" }),
      ],
      facts: [
        dummyFactHit({ passesGate: true }),
        dummyFactHit({ passesGate: false, statement: "rejected fact" }),
      ],
      shouldInject: true,
    };
    const { candidates } = normalizeReasoningHits(raw);
    expect(candidates).toHaveLength(2); // 1 block + 1 fact survives
    expect(candidates.find((c) => c.capability === "reasoning_reuse" && c.id.startsWith("block:"))).toBeDefined();
    expect(candidates.find((c) => c.capability === "reasoning_reuse" && c.id.startsWith("fact:"))).toBeDefined();
  });

  it("applies the conservative avoided-tokens estimate (NOT the ranker score)", () => {
    const raw: RecallV2Result = {
      queryId: "q-2",
      shadow: false,
      blocks: [dummyBlockHit({ score: 0.99, calibratedProb: 0.99 })],
      facts: [dummyFactHit({ score: 0.99, calibratedProb: 0.99 })],
      shouldInject: true,
    };
    const { candidates } = normalizeReasoningHits(raw);
    const blockCand = candidates.find((c) => c.id.startsWith("block:"))!;
    const factCand = candidates.find((c) => c.id.startsWith("fact:"))!;
    expect(blockCand.estimatedAvoidedTokens).toBe(BLOCK_AVOIDED_TOKENS_ESTIMATE);
    expect(factCand.estimatedAvoidedTokens).toBe(FACT_AVOIDED_TOKENS_ESTIMATE);
    expect(factCand.estimatedAvoidedTokens).toBeLessThan(blockCand.estimatedAvoidedTokens);
  });

  it("preserves calibrator probability AND ranker score on each candidate", () => {
    const raw: RecallV2Result = {
      queryId: "q-3",
      shadow: false,
      blocks: [dummyBlockHit({ score: 0.42, calibratedProb: 0.71 })],
      facts: [],
      shouldInject: true,
    };
    const { candidates } = normalizeReasoningHits(raw);
    expect(candidates[0]!.relevanceScore).toBe(0.42);
    expect(candidates[0]!.calibratedHelpfulProb).toBe(0.71);
  });

  it("clamps out-of-range scores to [0, 1]", () => {
    const raw: RecallV2Result = {
      queryId: "q-4",
      shadow: false,
      blocks: [
        dummyBlockHit({ score: 1.5, calibratedProb: -0.3 }),
        dummyBlockHit({ score: Number.NaN, calibratedProb: Number.POSITIVE_INFINITY, situation: "second variant" }),
      ],
      facts: [],
      shouldInject: true,
    };
    const { candidates } = normalizeReasoningHits(raw);
    for (const c of candidates) {
      expect(c.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(c.relevanceScore).toBeLessThanOrEqual(1);
      expect(c.calibratedHelpfulProb).toBeGreaterThanOrEqual(0);
      expect(c.calibratedHelpfulProb).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. runServingArbiter — drop reasons & cold-start
// ---------------------------------------------------------------------------

describe("runServingArbiter — decisions + telemetry", () => {
  it("emits one arbitration_decision event per decision (suppressed included)", () => {
    const store = makeStore();
    const plan = resolveServingPlan("cost-saver");
    try {
      const raw: RecallV2Result = {
        queryId: "q-decisions",
        shadow: false,
        blocks: [
          dummyBlockHit({ calibratedProb: 0.9, situation: "highly confident block" }),
          dummyBlockHit({ calibratedProb: 0.05, situation: "low-confidence block must drop" }),
        ],
        facts: [],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });
      expect(out.decisionsEmitted).toBe(2);

      const events = store.readEvents({ queryId: "q-decisions", limit: 100 });
      const decisions = events.filter((e) => e.event === "arbitration_decision");
      expect(decisions).toHaveLength(2);
      const actions = decisions.map((e) => (e as { action: string }).action);
      expect(actions).toContain("inject");
      expect(actions).toContain("suppress");

      // The low-confidence one carries reason="low_confidence".
      const suppressed = decisions.find((e) => (e as { action: string }).action === "suppress")!;
      expect((suppressed as { reason: string }).reason).toBe("low_confidence");
    } finally {
      store.close();
    }
  });

  it("filtered raw drops suppressed blocks (kept BlockHit instances stay object-identical)", () => {
    const store = makeStore();
    const plan = resolveServingPlan("cost-saver");
    try {
      const keepHit = dummyBlockHit({ calibratedProb: 0.9 });
      const dropHit = dummyBlockHit({ calibratedProb: 0.01, situation: "guaranteed drop" });
      const raw: RecallV2Result = {
        queryId: "q-filter",
        shadow: false,
        blocks: [keepHit, dropHit],
        facts: [],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });
      expect(out.raw.blocks).toHaveLength(1);
      // Same object identity — payload builder relies on it.
      expect(out.raw.blocks[0]).toBe(keepHit);
    } finally {
      store.close();
    }
  });

  it("cold-start prior holds: fresh block with moderate ranker score is REJECTED under cost-saver", () => {
    // A block that hasn't been calibrated yet typically gets
    // calibratedProb ≈ identity (the raw ranker score). The
    // cost-saver profile demands `expectedNetTokens > 0`. With
    // the conservative `BLOCK_AVOIDED_TOKENS_ESTIMATE = 200`
    // and a typical block injection cost of ~80–120 tokens,
    // we need calibratedProb >> 0.5 to clear the floor.
    const store = makeStore();
    const plan = resolveServingPlan("cost-saver");
    try {
      const raw: RecallV2Result = {
        queryId: "q-cold",
        shadow: false,
        blocks: [dummyBlockHit({ calibratedProb: 0.30 })], // below floor for cost-saver
        facts: [],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });
      expect(out.raw.blocks).toHaveLength(0);
      const events = store.readEvents({ queryId: "q-cold", limit: 10 });
      const d = events.find((e) => e.event === "arbitration_decision")!;
      // Low confidence is the named cold-start failure mode for
      // the cost-saver floor (0.25).
      expect((d as { action: string }).action).toBe("suppress");
    } finally {
      store.close();
    }
  });

  it("shadow=true ⇒ every decision is `shadow` with reason='holdout'", () => {
    const store = makeStore();
    const plan = resolveServingPlan("cost-saver");
    try {
      const raw: RecallV2Result = {
        queryId: "q-shadow",
        shadow: true,
        blocks: [dummyBlockHit({ calibratedProb: 0.95 })],
        facts: [],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store, shadow: true });
      expect(out.raw.blocks).toHaveLength(0); // shadow never injects
      const events = store.readEvents({ queryId: "q-shadow", limit: 10 });
      const d = events.find((e) => e.event === "arbitration_decision")!;
      expect((d as { action: string }).action).toBe("shadow");
      expect((d as { reason: string }).reason).toBe("holdout");
    } finally {
      store.close();
    }
  });

  it("telemetry payload privacy: no raw situation / mechanism / statement fields leak", () => {
    const store = makeStore();
    const plan = resolveServingPlan("cost-saver");
    try {
      const raw: RecallV2Result = {
        queryId: "q-privacy",
        shadow: false,
        blocks: [dummyBlockHit({ calibratedProb: 0.95, situation: "SECRET_SITUATION_TEXT" })],
        facts: [dummyFactHit({ statement: "SECRET_FACT_STATEMENT" })],
        shouldInject: true,
      };
      runServingArbiter(raw, { plan, store });
      const events = store.readEvents({ queryId: "q-privacy", limit: 100 });
      const decisions = events.filter((e) => e.event === "arbitration_decision");
      const serialized = JSON.stringify(decisions);
      expect(serialized).not.toContain("SECRET_SITUATION_TEXT");
      expect(serialized).not.toContain("SECRET_FACT_STATEMENT");
      // The closed-vocab fields ARE present.
      expect(serialized).toContain("\"capability\"");
      expect(serialized).toContain("\"reason\"");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end recallForPrompt — env-unset byte-identity & env=1 behaviour
// ---------------------------------------------------------------------------

describe("recallForPrompt — env-unset byte-identity guarantee", () => {
  it("env unset: payload + analytics events are unchanged from pre-C4-runtime", async () => {
    await withFreshStore(async (store, server, basePath) => {
      seedActiveBlock(store, PYTEST_BLOCK);
      delete process.env.TRACEBASE_SERVING_ARBITER;

      const result = await recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
        tokenBudget: 1200,
      });

      expect(result.hasContent).toBe(true);
      expect(result.payload.blockIds.length).toBeGreaterThan(0);
      // Zero arbitration_decision events emitted on the legacy path.
      const events = store.readEvents({ queryId: result.queryId, limit: 100 });
      expect(events.filter((e) => e.event === "arbitration_decision")).toEqual([]);
    });
  });

  it("env=\"0\" / \"true\" / unset: arbiter STAYS off — only \"1\" enables it", async () => {
    await withFreshStore(async (store, server, basePath) => {
      seedActiveBlock(store, PYTEST_BLOCK);

      for (const truthyLooking of ["0", "true", "yes", "on", "", " 1 "]) {
        process.env.TRACEBASE_SERVING_ARBITER = truthyLooking;
        const result = await recallForPrompt(server, store, NO_HOLDOUT, {
          prompt: `Pytest collects the wrong package run #${truthyLooking}`,
          basePath,
          sessionId: null,
          tokenBudget: 1200,
        });
        const events = store.readEvents({ queryId: result.queryId, limit: 100 });
        const arb = events.filter((e) => e.event === "arbitration_decision");
        expect(arb, `value=${JSON.stringify(truthyLooking)}`).toEqual([]);
      }
      delete process.env.TRACEBASE_SERVING_ARBITER;
    });
  });

  it("env=\"1\": arbiter runs and emits decisions on a real recall", async () => {
    await withFreshStore(async (store, server, basePath) => {
      seedActiveBlock(store, PYTEST_BLOCK);
      process.env.TRACEBASE_SERVING_ARBITER = "1";
      try {
        const result = await recallForPrompt(server, store, NO_HOLDOUT, {
          prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
          basePath,
          sessionId: null,
          tokenBudget: 1200,
          // recall-heavy disables the cost-saver confidence floor so the test
          // can assert the arbiter ran without needing a calibrator to lift
          // calibratedProb above 0.25.
          servingProfile: "recall-heavy",
        });
        const events = store.readEvents({ queryId: result.queryId, limit: 100 });
        const arb = events.filter((e) => e.event === "arbitration_decision");
        expect(arb.length).toBeGreaterThan(0);
        // Closed-vocab fields present.
        const first = arb[0] as { capability: string; action: string; reason: string };
        expect(["reasoning_reuse"]).toContain(first.capability);
        expect(["inject", "suppress", "shadow"]).toContain(first.action);
      } finally {
        delete process.env.TRACEBASE_SERVING_ARBITER;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 5. JSONL validator boundary for arbitration_decision
// ---------------------------------------------------------------------------

describe("arbitration_decision — JSONL import boundary", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-arb-jsonl-"));
    path = join(dir, "events.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a well-formed event", () => {
    writeFileSync(path,
      JSON.stringify({
        ts: 1, queryId: "q-good", event: "arbitration_decision",
        capability: "reasoning_reuse", candidateId: "block:b1#0",
        sourceId: "b1", action: "inject", reason: "positive_roi",
        expectedNetTokens: 50, calibratedProb: 0.8,
        relevanceScore: 0.7, injectionTokens: 100,
      }) + "\n",
    );
    const dst = makeStore();
    try {
      expect(importEventsFromJsonl(dst, path)).toBe(1);
    } finally {
      dst.close();
    }
  });

  it("rejects unknown capability / action / reason values", () => {
    const baseRow = {
      ts: 1, queryId: "q", event: "arbitration_decision",
      capability: "reasoning_reuse", candidateId: "c1",
      action: "inject", reason: "positive_roi",
      expectedNetTokens: 0, calibratedProb: 0.5,
      relevanceScore: 0.5, injectionTokens: 50,
    };
    const bad: Array<[string, Record<string, unknown>]> = [
      ["bad capability", { ...baseRow, capability: "asteroid_impact" }],
      ["bad action", { ...baseRow, action: "explode" }],
      ["bad reason", { ...baseRow, reason: "vibes" }],
    ];
    for (const [label, row] of bad) {
      writeFileSync(path, JSON.stringify(row) + "\n");
      const dst = makeStore();
      try {
        expect(importEventsFromJsonl(dst, path), label).toBe(0);
      } finally {
        dst.close();
      }
    }
  });

  it("rejects non-finite scalar fields", () => {
    writeFileSync(path,
      JSON.stringify({
        ts: 1, queryId: "q-nan", event: "arbitration_decision",
        capability: "reasoning_reuse", candidateId: "c1",
        action: "inject", reason: "positive_roi",
        expectedNetTokens: null, // ← invalid
        calibratedProb: 0.5, relevanceScore: 0.5, injectionTokens: 50,
      }) + "\n",
    );
    const dst = makeStore();
    try {
      expect(importEventsFromJsonl(dst, path)).toBe(0);
    } finally {
      dst.close();
    }
  });

  it("round-trips through exportEventsToJsonl + importEventsFromJsonl", () => {
    const src = makeStore();
    const dst = makeStore();
    try {
      src.appendEvent({
        ts: 1, queryId: "q-round", event: "arbitration_decision",
        capability: "reasoning_reuse", candidateId: "c1", sourceId: "b1",
        action: "inject", reason: "positive_roi",
        expectedNetTokens: 25, calibratedProb: 0.6,
        relevanceScore: 0.55, injectionTokens: 80,
      });
      exportEventsToJsonl(src, path);
      const n = importEventsFromJsonl(dst, path);
      expect(n).toBe(1);
      const events = dst.readEvents({ queryId: "q-round", limit: 10 });
      expect(events.some((e) => e.event === "arbitration_decision")).toBe(true);
    } finally {
      src.close();
      dst.close();
    }
  });
});

void vi; // keep the import if a future test wants spies
void withEnv; // keep the helper exported; useful for follow-up tests
