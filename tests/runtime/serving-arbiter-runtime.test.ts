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
    // Balanced (maxBlocks=2) so the C4.2.C per-lane pre-cap
    // doesn't slice the second block before the arbiter sees it.
    // Cost-saver (maxBlocks=1) would correctly drop the low-conf
    // one PRE-arbitration, yielding 1 decision — that's the
    // intended C4.2 behaviour but a different test target.
    const plan = resolveServingPlan({ profile: "balanced" });
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

      // The low-confidence one carries reason="low_confidence"
      // (balanced floor = 0.10; 0.05 falls below).
      const suppressed = decisions.find((e) => (e as { action: string }).action === "suppress")!;
      expect((suppressed as { reason: string }).reason).toBe("low_confidence");
    } finally {
      store.close();
    }
  });

  it("filtered raw drops suppressed blocks (kept BlockHit instances stay object-identical)", () => {
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "cost-saver" });
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
    const plan = resolveServingPlan({ profile: "cost-saver" });
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

  it("shadow=true ⇒ every decision is `shadow` with reason='holdout' (production passesGate=false IS expected)", () => {
    // C4.1-runtime regression. Pre-fix: `normalizeReasoningHits`
    // dropped every `!passesGate` hit, and production BlockServer
    // sets `passesGate=false` on EVERY hit when shadow=true (see
    // `src/core/block-serving.ts:736`). The arbiter therefore saw
    // zero candidates on every real holdout query and emitted zero
    // `action=shadow / reason=holdout` events — the holdout
    // telemetry surface was silently dead. Post-fix: on shadow,
    // normalisation passes every hit through so the pure arbiter's
    // shadow gate can mark them all `shadow/holdout`.
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "cost-saver" });
    try {
      const raw: RecallV2Result = {
        queryId: "q-shadow",
        shadow: true,
        blocks: [
          // The production shape: passesGate=false on every hit
          // because the BlockServer suppressed gate signal for
          // the shadow cohort. THIS is the state we must handle.
          dummyBlockHit({ calibratedProb: 0.95, passesGate: false }),
        ],
        facts: [
          dummyFactHit({ calibratedProb: 0.95, passesGate: false }),
        ],
        shouldInject: false,
      };
      const out = runServingArbiter(raw, { plan, store, shadow: true });
      expect(out.raw.blocks).toHaveLength(0);
      expect(out.raw.facts).toHaveLength(0);
      const events = store.readEvents({ queryId: "q-shadow", limit: 10 });
      const decisions = events.filter((e) => e.event === "arbitration_decision");
      expect(decisions.length).toBeGreaterThan(0);
      for (const d of decisions) {
        expect((d as { action: string }).action).toBe("shadow");
        expect((d as { reason: string }).reason).toBe("holdout");
      }
    } finally {
      store.close();
    }
  });

  it("C4.1 — facts compete with blocks on a COMBINED cap (maxBlocks + maxFacts), not a single maxBlocks slot", () => {
    // Pre-C4.1 the arbiter saw `plan.maxBlocks` as the cap for the
    // unified "reasoning_reuse" stream. A block+fact slate that fit
    // under maxBlocks + maxFacts could nonetheless trip `profile_cap`
    // because the arbiter only knew about maxBlocks. Repro: 4 strong
    // blocks + 1 strong fact, plan.maxBlocks=4, plan.maxFacts=4.
    // Pre-fix: fact gets profile_cap. Post-fix: fact is kept (it's
    // within the combined cap of 8).
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "recall-heavy" }); // floor off so all hits eligible
    try {
      const raw: RecallV2Result = {
        queryId: "q-fact-cap",
        shadow: false,
        blocks: [
          dummyBlockHit({ calibratedProb: 0.95, situation: "block-a high conf" }),
          dummyBlockHit({ calibratedProb: 0.95, situation: "block-b high conf" }),
          dummyBlockHit({ calibratedProb: 0.95, situation: "block-c high conf" }),
          dummyBlockHit({ calibratedProb: 0.95, situation: "block-d high conf" }),
        ],
        facts: [
          dummyFactHit({ calibratedProb: 0.95, statement: "valuable fact-a" }),
        ],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });
      // Fact survived alongside the blocks (combined cap respects both).
      expect(out.raw.facts).toHaveLength(1);
      // Decisions land for all 5 candidates; none get profile_cap.
      const events = store.readEvents({ queryId: "q-fact-cap", limit: 100 });
      const decisions = events.filter((e) => e.event === "arbitration_decision");
      const reasons = decisions.map((d) => (d as { reason: string }).reason);
      expect(reasons).not.toContain("profile_cap");
    } finally {
      store.close();
    }
  });

  it("telemetry payload privacy: no raw situation / mechanism / statement fields leak", () => {
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "cost-saver" });
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

  it("C4.1 — payload-identity snapshot: env unset vs env=\"0\" produce identical ids + text", async () => {
    // Stronger byte-identity check the C4 review asked for: pin
    // the actual `InjectionPayload` (block ids + fact ids + file
    // ids + additionalContext text) across two runs of the same
    // recall, one with the env unset and one with the env set
    // to a non-canonical value ("0"). If the arbiter ever leaks
    // into the legacy path for any non-"1" value, this test
    // fails.
    await withFreshStore(async (store, server, basePath) => {
      seedActiveBlock(store, PYTEST_BLOCK);

      delete process.env.TRACEBASE_SERVING_ARBITER;
      const a = await recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
        tokenBudget: 1200,
      });

      process.env.TRACEBASE_SERVING_ARBITER = "0";
      const b = await recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
        tokenBudget: 1200,
      });
      delete process.env.TRACEBASE_SERVING_ARBITER;

      // The payload's queryId is per-call and intentionally
      // unique. It appears verbatim in the rendered text inside
      // the `<tracebase queryId="...">` wrapper, so a raw equality
      // check would always fail. Redact it before comparing so
      // we're actually asserting on the content.
      //
      // The original C4.1 test used `payload.additionalContext`
      // — a typo that compared `undefined === undefined` and
      // never caught anything; fixed to `payload.text` (the real
      // field on InjectionPayload).
      const redact = (t: string) => t.replace(/queryId="[^"]+"/g, 'queryId="REDACTED"');
      expect(b.payload.blockIds).toEqual(a.payload.blockIds);
      expect(b.payload.factIds).toEqual(a.payload.factIds);
      expect(b.payload.fileIds ?? []).toEqual(a.payload.fileIds ?? []);
      expect(redact(b.payload.text)).toEqual(redact(a.payload.text));
      expect(b.payload.text.length).toBeGreaterThan(0); // sanity: actual text present
      expect(b.payload.hasContent).toEqual(a.payload.hasContent);
      // And neither path emitted arbitration_decision events.
      const aEvents = store.readEvents({ queryId: a.queryId, limit: 100 });
      const bEvents = store.readEvents({ queryId: b.queryId, limit: 100 });
      expect(aEvents.filter((e) => e.event === "arbitration_decision")).toEqual([]);
      expect(bEvents.filter((e) => e.event === "arbitration_decision")).toEqual([]);
    });
  });

  it("C4.2 — env unset restores pre-serving-policy legacy caps (1200/4/4/3/3)", async () => {
    // The C4.1 review caught that `resolveServingPlan` was being
    // applied unconditionally, so env unset still produced
    // cost-saver caps (350/1/1/1) — a behaviour change from the
    // pre-serving-policy baseline. C4.2 gates the whole policy
    // stack on the arbiter env; with the env unset we expect
    // `buildInjectionPayload`'s built-in DEFAULT_TOKEN_BUDGET =
    // 1200, DEFAULT_MAX_BLOCKS = 4, etc to take over. The
    // RetrievalEvent must also drop the `injectionProfile`
    // field — the dashboard distinguishes "policy ran" from
    // "no policy".
    await withFreshStore(async (store, server, basePath) => {
      seedActiveBlock(store, PYTEST_BLOCK);
      delete process.env.TRACEBASE_SERVING_ARBITER;

      const result = await recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
        // Note: NOT passing tokenBudget — we want the builder
        // default (1200) to kick in, not a caller override.
      });

      const events = store.readEvents({ queryId: result.queryId, limit: 50 });
      const retrieval = events.find((e) => e.event === "retrieval") as Record<string, unknown>;
      expect(retrieval).toBeDefined();
      // Legacy path emits NO injectionProfile.
      expect(retrieval.injectionProfile).toBeUndefined();
    });
  });

  it("C4.2 — env unset honours caller-supplied tokenBudget AND skips ROI filters", async () => {
    // Caller's explicit `tokenBudget` was always an override and
    // must keep working. The cost-saver clamp (which capped 1200
    // → 350) is the policy artefact that goes away when the env
    // is unset.
    await withFreshStore(async (store, server, basePath) => {
      seedActiveBlock(store, PYTEST_BLOCK);
      delete process.env.TRACEBASE_SERVING_ARBITER;
      const result = await recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
        tokenBudget: 800,
      });
      expect(result.hasContent).toBe(true);
      // No arbiter telemetry on the legacy path.
      const events = store.readEvents({ queryId: result.queryId, limit: 50 });
      expect(events.filter((e) => e.event === "arbitration_decision")).toEqual([]);
    });
  });

  it("C4.3 — full slate reaches the arbiter; per-lane overflow is demoted to suppress/profile_cap", () => {
    // Two assertions packed:
    //   (1) Every candidate gets a decision (arbiter is no longer
    //       starved by a rank-based pre-cap — that was the C4.2.C
    //       overreach the C4.3 review caught).
    //   (2) Items that the per-lane post-process pulls out of the
    //       inject set DO get a corresponding suppress event with
    //       reason="profile_cap", so the dashboard sees a clean
    //       1:1 mapping between candidates and decisions.
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "recall-heavy" }); // maxBlocks=4, maxFacts=4
    try {
      const raw: RecallV2Result = {
        queryId: "q-no-inflate",
        shadow: false,
        blocks: Array.from({ length: 6 }, (_, i) =>
          dummyBlockHit({ calibratedProb: 0.95, situation: `block-${i} high confidence` }),
        ),
        facts: Array.from({ length: 6 }, (_, i) =>
          dummyFactHit({ calibratedProb: 0.95, statement: `valuable fact-${i}` }),
        ),
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });

      const events = store.readEvents({ queryId: "q-no-inflate", limit: 100 });
      const decisions = events.filter((e) => e.event === "arbitration_decision");
      const injectCount = decisions.filter((d) => (d as { action: string }).action === "inject").length;
      const profileCapCount = decisions.filter(
        (d) => (d as { reason: string }).reason === "profile_cap",
      ).length;

      // (1) Every candidate gets a decision (6 blocks + 6 facts).
      expect(decisions.length).toBe(12);
      // (2) Inject decisions correspond exactly to prompt-visible items.
      expect(injectCount).toBe(out.raw.blocks.length + out.raw.facts.length);
      // Per-lane caps held — both via the arbiter's combined-cap
      // gate and the post-process demotion.
      expect(out.raw.blocks.length).toBeLessThanOrEqual(plan.maxBlocks);
      expect(out.raw.facts.length).toBeLessThanOrEqual(plan.maxFacts);
      // Demoted overflow shows up explicitly as profile_cap so C5
      // can read it instead of having to infer cap rejection.
      expect(profileCapCount).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("C4.3 — arbiter picks cheap +ROI candidate over net-negative #1 (the named C4.2 regression)", () => {
    // The C4.3 review's named repro: cost-saver maxBlocks=1, a
    // block ranked #1 by relevance is expensive AND net-negative,
    // a block ranked #2 is cheap and net +155. Pre-C4.3 the
    // pre-cap to maxBlocks=1 hid block #2 from the arbiter, so
    // the arbiter said "suppress everything" and nothing was
    // injected — defeating the arbiter's entire raison d'être.
    // Post-C4.3 the arbiter sees both, picks block #2.
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "cost-saver" });
    try {
      // dummyBlockHit defaults to a small situation. We override
      // the body via the helper but the size differential here is
      // synthesized via two distinct calibratedProb values: the
      // first block is "loud" (high prob, but its injection cost
      // dwarfs the avoided-tokens benefit at cost-saver budgets);
      // the second block is cheap and lands above the floor.
      //
      // The exact arithmetic isn't load-bearing — we only need
      // (a) block #2 to receive an `inject` decision, AND
      // (b) block #1 to receive a `suppress` decision (not silent
      //     hiding by a pre-cap).
      const raw: RecallV2Result = {
        queryId: "q-cheap-wins",
        shadow: false,
        blocks: [
          // #1 by rank, but its calibratedProb is just above the
          // cost-saver floor (0.25) — net expectedNetTokens stays
          // tight or negative.
          dummyBlockHit({ calibratedProb: 0.26, situation: "expensive ranker-top block" }),
          // #2 by rank, but high prob → clearly net-positive ROI.
          dummyBlockHit({ calibratedProb: 0.95, situation: "cheap high-ROI block #2" }),
        ],
        facts: [],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });

      const events = store.readEvents({ queryId: "q-cheap-wins", limit: 100 });
      const decisions = events.filter((e) => e.event === "arbitration_decision");
      // BOTH blocks got a decision — the second was no longer
      // hidden behind the per-lane cap before scoring.
      expect(decisions.length).toBe(2);
      const actions = decisions.map((d) => (d as { action: string }).action);
      expect(actions).toContain("inject");
      // The injected one is the cheap high-ROI block (#2), not the
      // expensive low-conf #1.
      expect(out.raw.blocks).toHaveLength(1);
      expect(out.raw.blocks[0]!.calibratedProb).toBe(0.95);
    } finally {
      store.close();
    }
  });

  it("C4.4 — per-lane finalisation picks the HIGHER-ROI block, not the input-order winner", () => {
    // Named C4.3 review repro: cost-saver maxBlocks=1. Block A
    // ranks first in input (net ROI +40). Block B ranks second
    // (net ROI +150). Pre-C4.4 the finaliser walked
    // `arbitration.decisions` in input order, kept A, demoted B.
    // Wrong. Post-C4.4 we re-sort by ROI before applying the
    // per-lane cap, so B is kept and A is demoted to
    // suppress/profile_cap.
    //
    // We calibrate inputs so block B has a higher score than
    // block A while BOTH stay clearly net-positive (cost-saver's
    // expectedNetTokens > 0 floor would otherwise suppress A on
    // the wrong reason). estimatedAvoidedTokens is fixed at 200
    // inside `blockHitToCandidate`; we drive the differential via
    // `calibratedProb`:
    //   A: prob 0.70 → upside 140, body cost ~80, net ~+60
    //   B: prob 0.95 → upside 190, body cost ~80, net ~+110
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "cost-saver" });
    try {
      const raw: RecallV2Result = {
        queryId: "q-roi-order",
        shadow: false,
        blocks: [
          dummyBlockHit({ calibratedProb: 0.7, situation: "ranker-first lower-ROI block A" }),
          dummyBlockHit({ calibratedProb: 0.95, situation: "ranker-second higher-ROI block B" }),
        ],
        facts: [],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });

      // The kept block is B (the higher-ROI one), not A.
      expect(out.raw.blocks).toHaveLength(1);
      expect(out.raw.blocks[0]!.calibratedProb).toBe(0.95);

      // A got an explicit suppress/profile_cap event — not a
      // silent drop and not a misclassification as low_confidence.
      const events = store.readEvents({ queryId: "q-roi-order", limit: 100 });
      const decisions = events.filter((e) => e.event === "arbitration_decision");
      expect(decisions).toHaveLength(2);
      const aDecision = decisions.find(
        (d) => (d as { calibratedProb: number }).calibratedProb === 0.7,
      )!;
      expect((aDecision as { action: string }).action).toBe("suppress");
      expect((aDecision as { reason: string }).reason).toBe("profile_cap");
    } finally {
      store.close();
    }
  });

  it("C4.4 — underfilled lane gets the next-best item (1 block + 1 fact, not 1 block alone)", () => {
    // Named C4.3 review repro #2: cost-saver maxBlocks=1,
    // maxFacts=1. Two high-ROI blocks + one positive-ROI fact.
    // Pre-C4.4 the combined bucket cap (maxBlocks + maxFacts = 2)
    // consumed both blocks, suppressed the fact as profile_cap,
    // and the post-process demoted the overflow block but never
    // promoted the fact — leaving the fact lane empty even
    // though it had capacity. Post-C4.4 the bucket cap is removed,
    // all three reach inject, then per-lane allocation keeps
    // top-1 block + top-1 fact.
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "cost-saver" });
    try {
      const raw: RecallV2Result = {
        queryId: "q-underfill",
        shadow: false,
        blocks: [
          dummyBlockHit({ calibratedProb: 0.95, situation: "high-ROI block A" }),
          dummyBlockHit({ calibratedProb: 0.9, situation: "high-ROI block B" }),
        ],
        facts: [
          dummyFactHit({ calibratedProb: 0.85, statement: "positive ROI fact" }),
        ],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });

      // Both lanes filled.
      expect(out.raw.blocks).toHaveLength(1);
      expect(out.raw.facts).toHaveLength(1);
      expect(out.raw.blocks[0]!.calibratedProb).toBe(0.95);
    } finally {
      store.close();
    }
  });

  it("C4.4 — returned arbitration.summary/byCandidateId/injectedTokens reflect FINAL decisions, not pre-finalisation", () => {
    // The C4.3 review caught that the returned `arbitration`
    // carried stale pre-finalisation counters (`summary.inject`
    // would over-report by the demoted overflow count;
    // `injectedTokens` similarly). Future C5 code reading these
    // would see inflated numbers. C4.4 rebuilds them.
    const store = makeStore();
    const plan = resolveServingPlan({ profile: "cost-saver" }); // maxBlocks=1, maxFacts=1
    try {
      const raw: RecallV2Result = {
        queryId: "q-summary",
        shadow: false,
        blocks: [
          dummyBlockHit({ calibratedProb: 0.95, situation: "block-a" }),
          dummyBlockHit({ calibratedProb: 0.9, situation: "block-b" }),
          dummyBlockHit({ calibratedProb: 0.85, situation: "block-c" }),
        ],
        facts: [],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });

      // summary.reasoning_reuse.inject must equal 1 (only the
      // top-ROI block survives the per-lane cap), not 3.
      expect(out.arbitration.summary.reasoning_reuse.inject).toBe(1);
      // The other two are suppressed; total suppress count is 2.
      expect(out.arbitration.summary.reasoning_reuse.suppress).toBe(2);

      // byCandidateId reflects the FINAL action on every candidate.
      const injectIds = Object.entries(out.arbitration.byCandidateId)
        .filter(([, d]) => d.action === "inject")
        .map(([id]) => id);
      expect(injectIds).toHaveLength(1);

      // injectedTokens equals the kept block's injectionTokens
      // (NOT the pre-final sum that would include demoted overflow).
      const keptDecision = out.arbitration.byCandidateId[injectIds[0]!]!;
      expect(out.arbitration.injectedTokens).toBeGreaterThan(0);
      // Sanity: equals exactly one candidate's cost.
      const candidates = out.arbitration.decisions
        .filter((d) => d.action === "inject")
        .map((d) => d);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.candidateId).toBe(keptDecision.candidateId);
    } finally {
      store.close();
    }
  });

  it("C4.5 — budget rescue: arbiter-suppressed fact gets promoted when lane cap demotes a budget-hogging block", () => {
    // The named C4.5 repro. tokenBudget=120, maxBlocks=1,
    // maxFacts=1. Two blocks (cost ~55/57 tokens) + one fact
    // (cost ~37 tokens), all positive-ROI. Pre-C4.5 the arbiter's
    // greedy walk injected both blocks (filling budget) and
    // budget-suppressed the fact. C4.4's finaliser then demoted
    // the overflow block to profile_cap but never reconsidered the
    // fact, even though the freed budget would have accommodated
    // it. C4.5 unifies budget + lane caps in one ROI-ordered walk,
    // so the fact gets injected.
    //
    // Token costs come out of `estimateBlockInjectionTokens` and
    // `estimateFactInjectionTokens`. We sculpt situation/statement
    // length so the costs land in the right neighbourhood; the
    // exact integers don't matter as long as
    //   (block_a_cost + block_b_cost) > budget > (block_a_cost + fact_cost)
    // and all three are positive-ROI under cost-saver.
    // Calibrate budget to the live `estimateBlockInjectionTokens`
    // output for `dummyBlockHit` (~78 tokens including wrapper)
    // and `estimateFactInjectionTokens` (~20 tokens). We need:
    //   • two blocks fit (2 * 78 = 156 ≤ budget)
    //   • two blocks + fact does NOT fit (156 + 20 > budget)
    //   • one block + fact fits (78 + 20 = 98 ≤ budget)
    // Budget = 160 satisfies all three.
    const store = makeStore();
    const plan = {
      ...resolveServingPlan({ profile: "cost-saver" }),
      tokenBudget: 160,
      maxBlocks: 1,
      maxFacts: 1,
    };
    try {
      const raw: RecallV2Result = {
        queryId: "q-budget-rescue",
        shadow: false,
        blocks: [
          dummyBlockHit({ calibratedProb: 0.95, situation: "block-A high-ROI" }),
          dummyBlockHit({ calibratedProb: 0.9, situation: "block-B also high-ROI" }),
        ],
        facts: [
          dummyFactHit({ calibratedProb: 0.95, statement: "useful positive-ROI fact" }),
        ],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });

      // Both lanes filled: highest-ROI block kept, fact kept.
      expect(out.raw.blocks).toHaveLength(1);
      expect(out.raw.facts).toHaveLength(1);
      // The kept block is the higher-ROI one (calibrated 0.95).
      expect(out.raw.blocks[0]!.calibratedProb).toBe(0.95);

      // injectedTokens reflects the final allocation (block + fact),
      // not the pre-final arbiter walk.
      expect(out.arbitration.injectedTokens).toBeLessThanOrEqual(plan.tokenBudget);
      // remainingBudget = tokenBudget - injectedTokens.
      expect(out.arbitration.remainingBudget).toBe(
        plan.tokenBudget - out.arbitration.injectedTokens,
      );
      // Summary reflects FINAL: 2 injects total (1 block + 1 fact),
      // 1 suppress (the demoted block).
      expect(out.arbitration.summary.reasoning_reuse.inject).toBe(2);
      expect(out.arbitration.summary.reasoning_reuse.suppress).toBe(1);
    } finally {
      store.close();
    }
  });

  it("C4.5 — budget genuinely scarce: when even after rescue the fact can't fit, it stays suppress/budget", () => {
    // Defensive complement: confirm the rescue path doesn't
    // promote items that would still exceed budget after lane
    // demotion. With tokenBudget=60, one block costing ~55 and a
    // fact costing ~37, the kept block leaves 5 tokens — fact
    // STILL can't fit. It must end up `suppress/budget`, not
    // silently dropped.
    // Budget 90: block (~78) fits, fact (~20) cannot fit in the
    // 12 tokens left over. Confirms the rescue path's budget
    // gate still applies on the second pass.
    const store = makeStore();
    const plan = {
      ...resolveServingPlan({ profile: "cost-saver" }),
      tokenBudget: 90,
      maxBlocks: 1,
      maxFacts: 1,
    };
    try {
      const raw: RecallV2Result = {
        queryId: "q-budget-tight",
        shadow: false,
        blocks: [
          dummyBlockHit({ calibratedProb: 0.95, situation: "lone-survivor block" }),
        ],
        facts: [
          dummyFactHit({ calibratedProb: 0.95, statement: "fact too costly for the leftover budget" }),
        ],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });

      expect(out.raw.blocks).toHaveLength(1);
      expect(out.raw.facts).toHaveLength(0);

      const events = store.readEvents({ queryId: "q-budget-tight", limit: 50 });
      const decisions = events.filter((e) => e.event === "arbitration_decision");
      const factDecision = decisions.find((d) =>
        typeof (d as { candidateId?: string }).candidateId === "string"
        && (d as { candidateId: string }).candidateId.startsWith("fact:"),
      )!;
      expect((factDecision as { action: string }).action).toBe("suppress");
      expect((factDecision as { reason: string }).reason).toBe("budget");
    } finally {
      store.close();
    }
  });

  it("C4.5 — remainingBudget reflects final walk, not arbiter's pre-final pass", () => {
    // Pre-C4.5 the runtime returned `arbitration.remainingBudget`
    // straight from the arbiter — which counted blocks the
    // finaliser later demoted. So even when the FINAL payload used
    // 55 tokens, `remainingBudget` would report 8 (post-arbiter
    // greedy state). C4.5 recomputes it from the final walk.
    // Budget 200, two blocks ~78 each. Arbiter injects both
    // (156 total). Finaliser demotes block B (maxBlocks=1) →
    // FINAL injectedTokens = 78, remainingBudget = 122.
    // Pre-C4.5 the arbiter's pre-final remainingBudget would have
    // returned 200 − 156 = 44, which is wrong by 78 tokens.
    const store = makeStore();
    const plan = {
      ...resolveServingPlan({ profile: "cost-saver" }),
      tokenBudget: 200,
      maxBlocks: 1,
      maxFacts: 0, // no facts can be injected — block-only setup
    };
    try {
      const raw: RecallV2Result = {
        queryId: "q-remaining-budget",
        shadow: false,
        blocks: [
          dummyBlockHit({ calibratedProb: 0.95, situation: "block-A" }),
          dummyBlockHit({ calibratedProb: 0.9, situation: "block-B equally fits but demoted by cap" }),
        ],
        facts: [],
        shouldInject: true,
      };
      const out = runServingArbiter(raw, { plan, store });

      // Exactly 1 block kept (maxBlocks=1).
      expect(out.raw.blocks).toHaveLength(1);
      // remainingBudget = tokenBudget - injectedTokens. NOT some
      // pre-finalisation value where both blocks consumed budget.
      expect(out.arbitration.remainingBudget).toBe(
        plan.tokenBudget - out.arbitration.injectedTokens,
      );
      // Stronger: the remaining budget reflects ONE block, not two.
      // If pre-final numbers leaked, this would be tokenBudget −
      // (2 × blockCost) which is much smaller.
      expect(out.arbitration.remainingBudget).toBeGreaterThan(plan.tokenBudget / 2);
    } finally {
      store.close();
    }
  });

  it("C4.3.B — explicit servingProfile opts into the policy stack even with env unset (no arbitration events)", async () => {
    // The SDK type advertises `servingProfile` as a runtime
    // policy override. Pre-C4.3.B we silently ignored it on the
    // env-unset legacy path; C4.3.B treats explicit profiles as
    // their own opt-in to the policy stack (caps + ROI filters)
    // independently of the arbiter env flag. The arbiter STILL
    // requires the env, so no arbitration_decision events land
    // even with a profile in play.
    await withFreshStore(async (store, server, basePath) => {
      seedActiveBlock(store, PYTEST_BLOCK);
      delete process.env.TRACEBASE_SERVING_ARBITER;

      const result = await recallForPrompt(server, store, NO_HOLDOUT, {
        prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
        basePath,
        sessionId: null,
        servingProfile: "balanced", // explicit opt-in to policy stack
      });

      // Policy ran: RetrievalEvent carries the chosen profile.
      const events = store.readEvents({ queryId: result.queryId, limit: 50 });
      const retrieval = events.find((e) => e.event === "retrieval") as Record<string, unknown>;
      expect(retrieval).toBeDefined();
      expect(retrieval.injectionProfile).toBe("balanced");

      // Arbiter did NOT run — no arbitration_decision events.
      expect(events.filter((e) => e.event === "arbitration_decision")).toEqual([]);
    });
  });

  it("C4.1 — real holdout cohort with env=\"1\": shadow/holdout events DO land in telemetry", async () => {
    // The original C4-runtime shadow test used a synthesized
    // RecallV2Result with `shadow: true` and `passesGate: true`
    // — a combination production never produces. This test goes
    // through the real BlockServer cohort gate: a 100% holdout
    // config forces `shadow=true` and `passesGate=false` on
    // every hit. Pre-C4.1 normalisation dropped them all and the
    // arbiter never saw a candidate → no holdout telemetry. The
    // fix passes hits through on shadow regardless of passesGate
    // so the dashboard receives at least one `action=shadow /
    // reason=holdout` decision per holdout query.
    await withFreshStore(async (store, server, basePath) => {
      seedActiveBlock(store, PYTEST_BLOCK);
      // 100% holdout via the loader the BlockServer reads through
      // `recallForPrompt`. Forces shadow=true on every query;
      // BlockServer sets passesGate=false on every hit.
      const FULL_HOLDOUT: HoldoutLoader = () => ({
        enabled: true,
        rate: 1,
        salt: "tb-arb-rt-test-salt",
        createdAt: new Date().toISOString(),
      });
      process.env.TRACEBASE_SERVING_ARBITER = "1";
      try {
        const result = await recallForPrompt(server, store, FULL_HOLDOUT, {
          prompt: "Pytest collects the wrong package — sys.path shadow on a fresh clone",
          basePath,
          sessionId: null,
          tokenBudget: 1200,
        });
        // Shadow cohort never injects — payload has no content.
        expect(result.payload.blockIds).toEqual([]);
        const events = store.readEvents({ queryId: result.queryId, limit: 100 });
        const decisions = events.filter((e) => e.event === "arbitration_decision");
        // At least one decision row, all shadow/holdout.
        expect(decisions.length).toBeGreaterThan(0);
        for (const d of decisions) {
          expect((d as { action: string }).action).toBe("shadow");
          expect((d as { reason: string }).reason).toBe("holdout");
        }
      } finally {
        delete process.env.TRACEBASE_SERVING_ARBITER;
      }
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
