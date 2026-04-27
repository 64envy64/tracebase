import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import {
  DistillationPipeline,
} from "../../src/distillation/pipeline.js";
import {
  MockDistiller,
  type DistillationMode,
  type DistillerInput,
  type DistillerOutput,
} from "../../src/distillation/llm-distiller.js";
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
  outcome: "success" | "failure" | "partial" = "failure",
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
      summary: "Agent gave up after trying to special-case property descriptors.",
      steps,
      outcome,
    },
    metadata: { agent: "test-agent", model: "test-model" },
    quality: { recallCount: 0, helpfulCount: 0, score: 0.5 },
    provenance: { origin: "local", appliedCount: 0 },
  };
}

const FAILURE_STEPS: SolutionStep[] = [
  { type: "analysis", description: "first hypothesis: add a property-specific branch" },
  { type: "action", description: "edit metaclass" },
  {
    type: "analysis",
    description:
      "that didn't work — properties still skipped; maybe iterate descriptor internals",
  },
  { type: "action", description: "edit to iterate __dict__" },
  {
    type: "analysis",
    description:
      "still wrong; the metaclass must be dispatching on a non-generic type test",
  },
];

function pitfallMockOutput(): DistillerOutput {
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
      mechanism:
        "agent assumed descriptor handling could be special-cased by name; actually the type test itself is wrong",
      deadEnds: [
        "add a property-specific branch to the metaclass",
        "iterate descriptor internals via __dict__",
      ],
      unlock:
        "replace the isfunction gate with inspect.isdatadescriptor which covers both functions and properties",
      verification:
        "if the approach still needs to special-case individual descriptor kinds, you are on the false path",
      guardrails: [
        "stop if you start special-casing by member name",
        "stop if you touch __dict__ directly to discover descriptors",
      ],
    },
    distillationConfidence: 0.8,
    model: "mock",
  };
}

// ---------------------------------------------------------------------------
// Failure lane — happy path
// ---------------------------------------------------------------------------

describe("DistillationPipeline — failure lane", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  it("stores a failure trace as a candidate PITFALL block with an origin ref", async () => {
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(pitfallMockOutput()),
    });
    const res = await pipeline.distillTrace(traceOf(FAILURE_STEPS));

    expect(res.status).toBe("stored");
    if (res.status !== "stored") throw new Error("unreachable");

    // Pitfall block, candidate status — never active on the failure lane.
    expect(res.block.kind).toBe("pitfall");
    expect(res.block.status).toBe("candidate");
    expect(res.block.body.guardrails).toBeDefined();
    expect(res.block.body.guardrails!.length).toBe(2);

    // Origin ref attached; no supporting / counter refs produced by
    // the failure lane itself.
    const refs = store.listCaseRefs(res.block.id);
    expect(refs.length).toBe(1);
    expect(refs[0].role).toBe("origin");
    expect(refs[0].id).toBe(res.caseRefId);

    // Provenance captures distillation metadata same as success.
    expect(res.block.provenance.distilledBy).toBe("llm");
    expect(res.block.provenance.validationReport?.passed).toBe(true);

    // No verifier ran; block.verification is the sentinel { unverified }.
    expect(res.block.verification?.status).toBe("unverified");

    // Verification result is NOT populated on the failure-lane stored result.
    expect(res.verification).toBeUndefined();
  });

  it("passes failure mode to the distiller so the failure prompt is used", async () => {
    let seenMode: DistillationMode | null = null;
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller((_input: DistillerInput, mode) => {
        seenMode = mode;
        return pitfallMockOutput();
      }),
    });
    await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    expect(seenMode).toBe("failure");
  });

  it("rejects a failure trace with no analysis step at all", async () => {
    const steps: SolutionStep[] = [
      { type: "action", description: "edit something" },
      { type: "action", description: "edit again" },
    ];
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(pitfallMockOutput()),
    });
    const res = await pipeline.distillTrace(traceOf(steps));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("no-failure-step");
    expect(store.countBlocks()).toBe(0);
  });

  it("deduplicates failure traces by (fingerprint, kind) and attaches a supporting ref", async () => {
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(pitfallMockOutput()),
    });
    const first = await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    if (first.status !== "stored") throw new Error("unreachable");

    // Second failure producing the same trigger fingerprint must merge
    // against the existing pitfall, not insert a new row.
    const second = await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    expect(second.status).toBe("merged");
    if (second.status !== "merged") throw new Error("unreachable");
    expect(second.existingBlockId).toBe(first.block.id);

    // Still exactly one pitfall block row; two refs (origin + supporting).
    expect(store.countBlocks("candidate")).toBe(1);
    const refs = store.listCaseRefs(first.block.id);
    expect(refs.length).toBe(2);
    expect(refs.map((r) => r.role).sort()).toEqual(["origin", "supporting"]);
  });

  it("does NOT auto-demote active success blocks when a failure trace hits the same trigger", async () => {
    // Seed a success block with the same trigger fingerprint.
    const successMock: DistillerOutput = {
      trigger: {
        situation: pitfallMockOutput().trigger.situation,
        invariants: pitfallMockOutput().trigger.invariants,
      },
      body: {
        mechanism: "property objects are descriptors not functions",
        deadEnds: ["add property-specific branch"],
        unlock: "use inspect.isdatadescriptor to cover both methods and properties",
        verification: "class with method and property inherits docstrings from parent",
      },
      distillationConfidence: 0.8,
      model: "mock",
    };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller((_input, mode) =>
        mode === "failure" ? pitfallMockOutput() : successMock,
      ),
    });
    const successSteps: SolutionStep[] = [
      { type: "analysis", description: "first idea" },
      { type: "analysis", description: "actual unlock: descriptors are not functions" },
      { type: "action", description: "edit" },
      { type: "verification", description: "tests pass" },
    ];
    const s = await pipeline.distillTrace(traceOf(successSteps, {}, "success"));
    if (s.status !== "stored") throw new Error("unreachable");
    expect(s.block.status).toBe("active");
    expect(s.block.kind).toBe("success");

    // Now run a failure trace with the same invariants / fingerprint.
    const f = await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    if (f.status !== "stored") throw new Error("unreachable");
    expect(f.block.kind).toBe("pitfall");
    expect(f.block.status).toBe("candidate");

    // The active success block is untouched: still active, no counter refs.
    const stillActive = store.getBlock(s.block.id);
    expect(stillActive?.status).toBe("active");
    const sRefs = store.listCaseRefs(s.block.id);
    expect(sRefs.filter((r) => r.role === "counter").length).toBe(0);

    // Both blocks coexist under the same fingerprint.
    expect(s.block.trigger.fingerprint).toBe(f.block.trigger.fingerprint);
    expect(store.countBlocks("active")).toBe(1);
    expect(store.countBlocks("candidate")).toBe(1);
  });

  it("rejects a pitfall with zero deadEnds via the validator", async () => {
    const noDeadEnds: DistillerOutput = {
      ...pitfallMockOutput(),
      body: { ...pitfallMockOutput().body, deadEnds: [] },
    };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(noDeadEnds),
    });
    const res = await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("validation-failed");
    if (res.reason.kind !== "validation-failed") throw new Error("unreachable");
    expect(res.reason.failures).toContain("schema:dead-ends-count");
    expect(store.countBlocks()).toBe(0);
  });

  it("rejects a pitfall whose guardrails exceed the cap", async () => {
    const tooManyGuardrails: DistillerOutput = {
      ...pitfallMockOutput(),
      body: {
        ...pitfallMockOutput().body,
        guardrails: ["g1", "g2", "g3", "g4"],
      },
    };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(tooManyGuardrails),
    });
    const res = await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("validation-failed");
    if (res.reason.kind !== "validation-failed") throw new Error("unreachable");
    expect(res.reason.failures).toContain("schema:guardrails-count");
  });

  it("rejects a pitfall whose guardrails leak gold-truth material", async () => {
    const leaky: DistillerOutput = {
      ...pitfallMockOutput(),
      body: {
        ...pitfallMockOutput().body,
        guardrails: ["stop if you touch tests.py::test_specific_case_name before reading the docs"],
      },
    };
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(leaky),
    });
    const res = await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") throw new Error("unreachable");
    expect(res.reason.kind).toBe("validation-failed");
    if (res.reason.kind !== "validation-failed") throw new Error("unreachable");
    expect(res.reason.failures.some((f) => f.startsWith("leakage"))).toBe(true);
  });

  it("pitfall block round-trips through storage preserving kind + guardrails", async () => {
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(pitfallMockOutput()),
    });
    const res = await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    if (res.status !== "stored") throw new Error("unreachable");

    const reread = store.getBlock(res.block.id);
    expect(reread).not.toBeNull();
    expect(reread!.kind).toBe("pitfall");
    expect(reread!.body.guardrails).toEqual(pitfallMockOutput().body.guardrails);
    expect(reread!.body.deadEnds.length).toBeGreaterThan(0);
    expect(reread!.status).toBe("candidate");
  });

  it("pitfall candidates never appear in the active listing", async () => {
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(pitfallMockOutput()),
    });
    await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    const active = store.listBlocks({ status: "active" });
    expect(active.length).toBe(0);
    const candidate = store.listBlocks({ status: "candidate" });
    expect(candidate.length).toBe(1);
    expect(candidate[0].kind).toBe("pitfall");
  });

  it("does not invoke the verifier on the failure lane", async () => {
    let verifierCalls = 0;
    const pipeline = new DistillationPipeline({
      store,
      distiller: new MockDistiller(pitfallMockOutput()),
      verifier: {
        name: "counting",
        async verify() {
          verifierCalls++;
          return { status: "verified", verifier: "counting" };
        },
      },
    });
    await pipeline.distillTrace(traceOf(FAILURE_STEPS));
    expect(verifierCalls).toBe(0);
  });
});
