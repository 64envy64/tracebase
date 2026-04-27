import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  DistillationPipeline,
  type DistillationResult,
} from "../../src/distillation/pipeline.js";
import {
  MockDistiller,
  DistillerError,
  type DistillerOutput,
} from "../../src/distillation/llm-distiller.js";
import type { Verifier, VerificationResult } from "../../src/distillation/verifier.js";
import type { ReasoningTrace, SolutionStep } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

function traceOf(
  steps: SolutionStep[],
  over: Partial<ReasoningTrace["problem"]> = {},
  outcome: "success" | "failure" | "partial" = "success",
): ReasoningTrace {
  return {
    id: "trace-" + Math.random().toString(36).slice(2, 8),
    createdAt: 1000,
    updatedAt: 1000,
    problem: {
      description: "Metaclass iterates members with inspect.isfunction; misses properties.",
      language: "python",
      framework: "astropy",
      errorType: "MissingDocstring",
      tags: [],
      fingerprint: "fp-" + Math.random().toString(36).slice(2, 8),
      ...over,
    },
    solution: {
      summary: "Used inspect.isdatadescriptor to cover properties.",
      steps,
      outcome,
    },
    metadata: { agent: "test-agent", model: "test-model" },
    quality: { recallCount: 0, helpfulCount: 0, score: 0.5 },
    provenance: { origin: "local", appliedCount: 0 },
  };
}

const GOOD_STEPS: SolutionStep[] = [
  { type: "analysis", description: "first hypothesis: add a property-specific branch" },
  { type: "action", description: "edit metaclass" },
  { type: "analysis", description: "that didn't work because descriptors are different" },
  {
    type: "analysis",
    description: "property objects are descriptors, not functions; use inspect.isdatadescriptor",
  },
  { type: "action", description: "edit to use isdatadescriptor" },
  { type: "verification", description: "tests pass" },
];

function goodMockOutput(): DistillerOutput {
  return {
    trigger: {
      situation:
        "Metaclass iterates members via inspect.isfunction and misses property descriptors",
      invariants: {
        language: "python",
        framework: "astropy",
        errorType: "MissingDocstring",
        apiSurface: ["inspect.isfunction"],
      },
    },
    body: {
      mechanism: "property objects are descriptors not functions",
      deadEnds: ["add property-specific branch to the metaclass"],
      unlock: "use inspect.isdatadescriptor to cover both methods and properties",
      verification: "class with method and property inherits docstrings from parent",
    },
    distillationConfidence: 0.8,
    model: "mock",
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("DistillationPipeline — happy path", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("distills a success trace into a stored+active block with origin ref + verification hook", async () => {
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(goodMockOutput()),
    });
    const res = await pipeline.distillTrace(traceOf(GOOD_STEPS));

    expect(res.status).toBe("stored");
    if (res.status !== "stored") throw new Error("unreachable");

    // Block is active, has the mock's situation + invariants.
    expect(res.block.status).toBe("active");
    expect(res.block.trigger.situation).toContain("Metaclass");
    expect(res.block.trigger.invariants.apiSurface).toContain("inspect.isfunction");

    // Provenance captures distillation metadata.
    expect(res.block.provenance.distilledBy).toBe("llm");
    expect(res.block.provenance.distilledWithModel).toBe("mock");
    expect(res.block.provenance.distillationConfidence).toBeCloseTo(0.8);
    expect(res.block.provenance.validationReport?.passed).toBe(true);

    // Origin ref was attached.
    const refs = store.listCaseRefs(res.block.id);
    expect(refs.length).toBe(1);
    expect(refs[0].role).toBe("origin");
    expect(refs[0].id).toBe(res.caseRefId);

    // Phase 4 noop verifier: status mapped to "unverified" but
    // verifier + verifiedAt + reason recorded.
    expect(res.block.verification?.status).toBe("unverified");
    expect(res.block.verification?.verifier).toBe("noop");
    expect(res.block.verification?.verifiedAt).toBeDefined();
    expect(res.block.verification?.reason).toBeTruthy();

    // Verification field on the returned result reflects the verifier
    // call's raw verdict (inconclusive for noop).
    expect(res.verification.status).toBe("inconclusive");
  });

  it("forwards invariant hints from the trace problem to the distiller", async () => {
    let seenInvariants: unknown = null;
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller((input) => {
        seenInvariants = input.invariants;
        return goodMockOutput();
      }),
    });
    await pipeline.distillTrace(traceOf(GOOD_STEPS));
    expect(seenInvariants).toMatchObject({
      language: "python",
      framework: "astropy",
      errorType: "MissingDocstring",
    });
  });

  it("passes the unlock step and mined dead ends to the distiller", async () => {
    let seenUnlock = "";
    let seenDeadEnds: string[] = [];
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller((input) => {
        seenUnlock = input.unlockStep;
        seenDeadEnds = input.deadEnds;
        return goodMockOutput();
      }),
    });
    await pipeline.distillTrace(traceOf(GOOD_STEPS));

    // Unlock heuristic picks the last analysis before the verification step.
    expect(seenUnlock).toContain("isdatadescriptor");
    // Dead-end miner picks the abandoned first hypothesis.
    expect(seenDeadEnds.length).toBeGreaterThan(0);
    expect(seenDeadEnds[0]).toContain("property-specific branch");
  });

  it("dedupes by trigger fingerprint and attaches a supporting ref", async () => {
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(goodMockOutput()),
    });
    const first = await pipeline.distillTrace(traceOf(GOOD_STEPS));
    expect(first.status).toBe("stored");

    // Second trace with a different id but the distiller returns the
    // same trigger (identical fingerprint) — must merge, not re-insert.
    const secondTrace = traceOf(GOOD_STEPS);
    const second = await pipeline.distillTrace(secondTrace);

    expect(second.status).toBe("merged");
    if (second.status !== "merged") throw new Error("unreachable");
    if (first.status !== "stored") throw new Error("unreachable");
    expect(second.existingBlockId).toBe(first.block.id);

    // Only one block row exists; two refs (origin + supporting) attached.
    expect(store.countBlocks("active")).toBe(1);
    const refs = store.listCaseRefs(first.block.id);
    expect(refs.length).toBe(2);
    expect(refs.map((r) => r.role).sort()).toEqual(["origin", "supporting"]);
  });
});

// ---------------------------------------------------------------------------
// Rejection paths
// ---------------------------------------------------------------------------

describe("DistillationPipeline — rejections", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("rejects 'partial' outcomes without calling the distiller", async () => {
    // Partial trajectories are explicitly out of scope for the
    // dispatcher; they fall through to `unsupported-outcome`.
    let called = false;
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(() => {
        called = true;
        return goodMockOutput();
      }),
    });
    const res = await pipeline.distillTrace(traceOf(GOOD_STEPS, {}, "partial"));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("unsupported-outcome");
    if (res.reason.kind !== "unsupported-outcome") throw new Error("unreachable");
    expect(res.reason.outcome).toBe("partial");
    expect(called).toBe(false);
    expect(store.countBlocks()).toBe(0);
  });

  it("rejects when the trajectory lacks any analysis step", async () => {
    const steps: SolutionStep[] = [
      { type: "action", description: "edit" },
      { type: "verification", description: "pass" },
    ];
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(goodMockOutput()),
    });
    const res = await pipeline.distillTrace(traceOf(steps));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("no-unlock-step");
    expect(store.countBlocks()).toBe(0);
  });

  it("rejects with llm-error when the distiller throws", async () => {
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(() => {
        throw new DistillerError("rate limited", "llm-error");
      }),
    });
    const res = await pipeline.distillTrace(traceOf(GOOD_STEPS));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("llm-error");
    if (res.reason.kind !== "llm-error") throw new Error("unreachable");
    expect(res.reason.distillerKind).toBe("llm-error");
    expect(res.reason.message).toContain("rate limited");
    expect(store.countBlocks()).toBe(0);
  });

  it("rejects below the confidence threshold, but retains validation report", async () => {
    const low: DistillerOutput = { ...goodMockOutput(), distillationConfidence: 0.2 };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(low),
      minConfidence: 0.5,
    });
    const res = await pipeline.distillTrace(traceOf(GOOD_STEPS));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("low-confidence");
    if (res.reason.kind !== "low-confidence") throw new Error("unreachable");
    expect(res.reason.confidence).toBeCloseTo(0.2);
    expect(res.reason.threshold).toBeCloseTo(0.5);
    expect(res.validationReport?.passed).toBe(true);
    expect(store.countBlocks()).toBe(0);
  });

  it("rejects on validation failure with a list of failed check names", async () => {
    // Make the distiller return a body that fails leakage — pytest id.
    const leaky: DistillerOutput = {
      ...goodMockOutput(),
      body: {
        mechanism: "mechanism text",
        deadEnds: [],
        unlock: "unlock text",
        verification: "run pytest ::test_specific_case_name",
      },
    };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(leaky),
    });
    const res = await pipeline.distillTrace(traceOf(GOOD_STEPS));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("validation-failed");
    if (res.reason.kind !== "validation-failed") throw new Error("unreachable");
    expect(res.reason.failures.some((f) => f.startsWith("leakage"))).toBe(true);
    expect(res.validationReport?.passed).toBe(false);
    expect(store.countBlocks()).toBe(0);
  });

  it("does not leak a partial block on rejection (no storeBlock call)", async () => {
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(() => {
        throw new DistillerError("bad", "schema-error");
      }),
    });
    await pipeline.distillTrace(traceOf(GOOD_STEPS));
    expect(store.countBlocks()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Verifier wiring
// ---------------------------------------------------------------------------

describe("DistillationPipeline — verifier hook", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("a custom verifier returning 'verified' advances BlockVerification.status", async () => {
    const verifier: Verifier = {
      name: "stub-verified",
      async verify(): Promise<VerificationResult> {
        return { status: "verified", verifier: "stub-verified", taskId: "held-out-001" };
      },
    };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(goodMockOutput()),
      verifier,
    });
    const res = await pipeline.distillTrace(traceOf(GOOD_STEPS));
    if (res.status !== "stored") throw new Error("unreachable");
    expect(res.block.verification?.status).toBe("verified");
    expect(res.block.verification?.verifier).toBe("stub-verified");
    expect(res.block.verification?.taskId).toBe("held-out-001");
  });

  it("a verifier returning 'disproved' records it and keeps block active for audit", async () => {
    const verifier: Verifier = {
      name: "strict",
      async verify(): Promise<VerificationResult> {
        return { status: "disproved", verifier: "strict", reason: "held-out run failed" };
      },
    };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(goodMockOutput()),
      verifier,
    });
    const res = await pipeline.distillTrace(traceOf(GOOD_STEPS));
    if (res.status !== "stored") throw new Error("unreachable");
    expect(res.block.verification?.status).toBe("disproved");
    expect(res.block.verification?.reason).toContain("failed");
    // status (lifecycle) stays active — demotion is a separate L6 decision.
    expect(res.block.status).toBe("active");
  });

  it("verifier exceptions are swallowed and recorded as inconclusive", async () => {
    const verifier: Verifier = {
      name: "broken",
      async verify(): Promise<VerificationResult> {
        throw new Error("network down");
      },
    };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(goodMockOutput()),
      verifier,
    });
    const res = await pipeline.distillTrace(traceOf(GOOD_STEPS));
    if (res.status !== "stored") throw new Error("unreachable");
    expect(res.verification.status).toBe("inconclusive");
    expect(res.verification.verifier).toBe("broken");
    expect(res.verification.reason).toContain("network down");
    // BlockVerification.status persists as "unverified".
    expect(res.block.verification?.status).toBe("unverified");
  });
});
