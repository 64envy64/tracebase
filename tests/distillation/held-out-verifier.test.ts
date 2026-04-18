import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { BlockStore } from "../../src/core/block-store.js";
import { createBlock } from "../../src/core/block.js";
import {
  HeldOutVerifier,
  StaticTaskPicker,
  MockAgentRunner,
  invariantsMatch,
  isHeldOutFrom,
  formatBlockForVerification,
  reverifyBlock,
  type VerificationTask,
  type AgentRunResult,
  type AgentRunArgs,
} from "../../src/distillation/held-out-verifier.js";
import type { ReasoningBlock, StoreBlockInput } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore(): BlockStore {
  return new BlockStore(new Database(":memory:"));
}

const SAMPLE: StoreBlockInput = {
  trigger: {
    situation: "metaclass iterates members via inspect.isfunction, missing properties",
    invariants: {
      language: "python",
      framework: "astropy",
      errorType: "MissingDocstring",
      apiSurface: ["inspect.isfunction"],
    },
  },
  body: {
    mechanism: "property objects are descriptors not functions",
    deadEnds: ["add property-specific branch"],
    unlock: "use inspect.isdatadescriptor to cover both",
    verification: "class inherits docstrings from parent",
  },
  provenance: {
    sourceTaskId: "astropy-7166",
    extractedFrom: "trajectory",
    distilledBy: "llm",
    parentTraceId: "trace-astropy-7166",
  },
};

function makeBlock(): ReasoningBlock {
  return createBlock(SAMPLE);
}

const HELD_OUT_TASK: VerificationTask = {
  id: "astropy-8891",
  problemDescription: "A different astropy metaclass bug, same invariants.",
  invariants: {
    language: "python",
    framework: "astropy",
    errorType: "MissingDocstring",
    apiSurface: ["inspect.isfunction"],
  },
  sourceTraceId: "trace-astropy-8891",
};

const UNRELATED_TASK: VerificationTask = {
  id: "react-1",
  problemDescription: "A React useEffect bug.",
  invariants: { language: "typescript", framework: "react" },
};

const ORIGIN_TASK: VerificationTask = {
  id: "astropy-7166", // SAME as block.provenance.sourceTaskId
  problemDescription: "The block's origin task.",
  invariants: { language: "python", framework: "astropy" },
  sourceTraceId: "trace-astropy-7166",
};

// ---------------------------------------------------------------------------
// invariantsMatch + isHeldOutFrom
// ---------------------------------------------------------------------------

describe("invariantsMatch", () => {
  it("returns true when task invariants cover the block's", () => {
    expect(invariantsMatch(
      { language: "python", framework: "astropy" },
      { language: "python", framework: "astropy" },
    )).toBe(true);
  });

  it("returns false on language mismatch", () => {
    expect(invariantsMatch(
      { language: "typescript" },
      { language: "python" },
    )).toBe(false);
  });

  it("returns true when the task has no invariants at all", () => {
    expect(invariantsMatch({}, { language: "python" })).toBe(true);
  });

  it("returns true when the block has no invariants at all", () => {
    expect(invariantsMatch({ language: "python" }, {})).toBe(true);
  });

  it("requires apiSurface overlap when both sides are non-empty", () => {
    expect(invariantsMatch(
      { apiSurface: ["inspect.isfunction"] },
      { apiSurface: ["numpy.array"] },
    )).toBe(false);
    expect(invariantsMatch(
      { apiSurface: ["inspect.isfunction", "inspect.isclass"] },
      { apiSurface: ["inspect.isfunction"] },
    )).toBe(true);
  });
});

describe("isHeldOutFrom", () => {
  it("rejects a task whose id matches the block's sourceTaskId", () => {
    const block = makeBlock();
    expect(isHeldOutFrom(ORIGIN_TASK, block)).toBe(false);
  });

  it("rejects a task whose sourceTraceId matches block.parentTraceId", () => {
    const block = makeBlock();
    const t: VerificationTask = {
      id: "different-id",
      problemDescription: "x",
      invariants: {},
      sourceTraceId: "trace-astropy-7166", // same as parentTraceId
    };
    expect(isHeldOutFrom(t, block)).toBe(false);
  });

  it("accepts a task with a different id and trace", () => {
    const block = makeBlock();
    expect(isHeldOutFrom(HELD_OUT_TASK, block)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StaticTaskPicker
// ---------------------------------------------------------------------------

describe("StaticTaskPicker", () => {
  it("picks the first held-out task with matching invariants", () => {
    const picker = new StaticTaskPicker([UNRELATED_TASK, HELD_OUT_TASK]);
    const block = makeBlock();
    const task = picker.pickTaskFor(block);
    expect(task?.id).toBe(HELD_OUT_TASK.id);
  });

  it("skips the origin task even if invariants match", () => {
    const picker = new StaticTaskPicker([ORIGIN_TASK, HELD_OUT_TASK]);
    const block = makeBlock();
    const task = picker.pickTaskFor(block);
    expect(task?.id).toBe(HELD_OUT_TASK.id);
  });

  it("returns null when nothing matches", () => {
    const picker = new StaticTaskPicker([UNRELATED_TASK]);
    const block = makeBlock();
    expect(picker.pickTaskFor(block)).toBeNull();
  });

  it("getTaskById returns the task even if it'd be skipped by pickTaskFor", () => {
    const picker = new StaticTaskPicker([ORIGIN_TASK, HELD_OUT_TASK]);
    expect(picker.getTaskById("astropy-7166")?.id).toBe("astropy-7166");
  });
});

// ---------------------------------------------------------------------------
// formatBlockForVerification
// ---------------------------------------------------------------------------

describe("formatBlockForVerification", () => {
  it("emits a hypothesis-framed markdown blob with all block sections", () => {
    const block = makeBlock();
    const md = formatBlockForVerification(block);
    expect(md).toContain("Prior reasoning hypothesis");
    expect(md).toContain(block.trigger.situation);
    expect(md).toContain(block.body.mechanism);
    expect(md).toContain(block.body.unlock);
    expect(md).toContain(block.body.verification);
    expect(md).toContain("add property-specific branch"); // dead end
  });

  it("framing is declarative, not imperative", () => {
    const block = makeBlock();
    const md = formatBlockForVerification(block).toLowerCase();
    expect(md).toContain("hypothesis");
    expect(md).not.toMatch(/\bdo this\b|\bapply this fix\b|\byou must\b/);
  });

  it("omits dead-ends section when none are present", () => {
    const b = createBlock({ ...SAMPLE, body: { ...SAMPLE.body, deadEnds: [] } });
    const md = formatBlockForVerification(b);
    expect(md).not.toContain("Known dead ends");
  });
});

// ---------------------------------------------------------------------------
// HeldOutVerifier — verdict paths
// ---------------------------------------------------------------------------

describe("HeldOutVerifier", () => {
  const pickerWithMatch = (): StaticTaskPicker =>
    new StaticTaskPicker([HELD_OUT_TASK, UNRELATED_TASK]);

  it("returns inconclusive when the picker has no match", () => {
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({
        output: "", resolved: true, agentReusedBlock: true,
      }),
      picker: new StaticTaskPicker([UNRELATED_TASK]),
    });
    return verifier.verify(makeBlock()).then((r) => {
      expect(r.status).toBe("inconclusive");
      expect(r.reason).toContain("no held-out task");
    });
  });

  it("returns verified when agent uses the block AND task resolves", async () => {
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({
        output: "patched correctly",
        resolved: true,
        agentReusedBlock: true,
        details: "agent applied isdatadescriptor",
      }),
      picker: pickerWithMatch(),
    });
    const r = await verifier.verify(makeBlock());
    expect(r.status).toBe("verified");
    expect(r.taskId).toBe(HELD_OUT_TASK.id);
    expect(r.reason).toContain("isdatadescriptor");
  });

  it("returns disproved when agent uses the block but task fails", async () => {
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({
        output: "patched wrongly",
        resolved: false,
        agentReusedBlock: true,
      }),
      picker: pickerWithMatch(),
    });
    const r = await verifier.verify(makeBlock());
    expect(r.status).toBe("disproved");
    expect(r.taskId).toBe(HELD_OUT_TASK.id);
    expect(r.reason).toBeTruthy();
  });

  it("returns inconclusive when the agent ignores the block", async () => {
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({
        output: "patched without using injection",
        resolved: true,            // task happened to resolve
        agentReusedBlock: false,   // but agent didn't use the block
      }),
      picker: pickerWithMatch(),
    });
    const r = await verifier.verify(makeBlock());
    expect(r.status).toBe("inconclusive");
    expect(r.reason?.toLowerCase()).toContain("did not reuse");
  });

  it("returns inconclusive when the runner throws", async () => {
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner(() => { throw new Error("runner exploded"); }),
      picker: pickerWithMatch(),
    });
    const r = await verifier.verify(makeBlock());
    expect(r.status).toBe("inconclusive");
    expect(r.reason).toContain("runner exploded");
  });

  it("respects caller-supplied taskId via VerifyOptions", async () => {
    let seenTask: VerificationTask | null = null;
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner((args: AgentRunArgs) => {
        seenTask = args.task;
        return { output: "", resolved: true, agentReusedBlock: true };
      }),
      picker: pickerWithMatch(),
    });
    const r = await verifier.verify(makeBlock(), { taskId: HELD_OUT_TASK.id });
    expect(r.status).toBe("verified");
    expect(seenTask).not.toBeNull();
    expect(seenTask!.id).toBe(HELD_OUT_TASK.id);
  });

  it("rejects a caller-supplied taskId that would be circular", async () => {
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({ output: "", resolved: true, agentReusedBlock: true }),
      picker: new StaticTaskPicker([ORIGIN_TASK, HELD_OUT_TASK]),
    });
    const r = await verifier.verify(makeBlock(), { taskId: ORIGIN_TASK.id });
    expect(r.status).toBe("inconclusive");
    expect(r.reason?.toLowerCase()).toContain("circular");
  });

  it("names the verifier so verdicts correlate with runner version", () => {
    const v = new HeldOutVerifier({
      runner: new MockAgentRunner({ output: "", resolved: true, agentReusedBlock: true }, { name: "my-runner@v2" }),
      picker: pickerWithMatch(),
    });
    expect(v.name).toBe("held-out:my-runner@v2");
  });

  it("uses a custom injection formatter when provided", async () => {
    let receivedInjection = "";
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner((args) => {
        receivedInjection = args.injection;
        return { output: "", resolved: true, agentReusedBlock: true };
      }),
      picker: pickerWithMatch(),
      formatBlock: (b) => `custom format: ${b.trigger.situation}`,
    });
    await verifier.verify(makeBlock());
    expect(receivedInjection.startsWith("custom format:")).toBe(true);
  });

  it("passes timeoutMs from VerifyOptions through to the runner", async () => {
    let seenTimeout: number | undefined;
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner((args) => {
        seenTimeout = args.timeoutMs;
        return { output: "", resolved: true, agentReusedBlock: true };
      }),
      picker: pickerWithMatch(),
    });
    await verifier.verify(makeBlock(), { timeoutMs: 5000 });
    expect(seenTimeout).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// reverifyBlock — persistence path
// ---------------------------------------------------------------------------

describe("reverifyBlock", () => {
  let store: BlockStore;
  beforeEach(() => { store = makeStore(); });

  function storeActive(sample: StoreBlockInput = SAMPLE): ReasoningBlock {
    const b = createBlock(sample); b.status = "candidate";
    store.storeBlock(b);
    store.attachCaseRef({
      blockId: b.id, traceId: `trace-${b.id}`, role: "origin", evidenceQuality: "strong",
    });
    return store.updateBlockStatus(b.id, "active")!;
  }

  it("persists a 'verified' verdict onto the block", async () => {
    const block = storeActive();
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({ output: "", resolved: true, agentReusedBlock: true }),
      picker: new StaticTaskPicker([HELD_OUT_TASK]),
    });
    await reverifyBlock(store, verifier, block.id);
    const got = store.getBlock(block.id)!;
    expect(got.verification?.status).toBe("verified");
    expect(got.verification?.taskId).toBe(HELD_OUT_TASK.id);
    expect(got.verification?.verifiedAt).toBeGreaterThan(0);
  });

  it("persists a 'disproved' verdict — LifecycleRepair will demote it", async () => {
    const block = storeActive();
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({ output: "", resolved: false, agentReusedBlock: true }),
      picker: new StaticTaskPicker([HELD_OUT_TASK]),
    });
    await reverifyBlock(store, verifier, block.id);
    expect(store.getBlock(block.id)!.verification?.status).toBe("disproved");
  });

  it("maps 'inconclusive' to BlockVerification.status = 'unverified'", async () => {
    const block = storeActive();
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({ output: "", resolved: true, agentReusedBlock: false }),
      picker: new StaticTaskPicker([HELD_OUT_TASK]),
    });
    const r = await reverifyBlock(store, verifier, block.id);
    expect(r.status).toBe("inconclusive");
    expect(store.getBlock(block.id)!.verification?.status).toBe("unverified");
  });

  it("throws if the block id is unknown", async () => {
    const verifier = new HeldOutVerifier({
      runner: new MockAgentRunner({ output: "", resolved: true, agentReusedBlock: true }),
      picker: new StaticTaskPicker([HELD_OUT_TASK]),
    });
    await expect(reverifyBlock(store, verifier, "no-such-block"))
      .rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration: distill → verify (disproved) → repair demotes
// ---------------------------------------------------------------------------

describe("HeldOutVerifier — lifecycle integration", () => {
  it("disproved verdict propagates through the repair loop into demotion", async () => {
    const { DistillationPipeline } = await import("../../src/distillation/pipeline.js");
    const { MockDistiller } = await import("../../src/distillation/llm-distiller.js");
    const { LifecycleRepair } = await import("../../src/lifecycle/repair.js");
    const { BlockServer } = await import("../../src/core/block-serving.js");

    const store = makeStore();

    const distiller = new MockDistiller({
      trigger: {
        situation: "metaclass iterates via inspect.isfunction and misses properties",
        invariants: {
          language: "python", framework: "astropy", errorType: "MissingDocstring",
          apiSurface: ["inspect.isfunction"],
        },
      },
      body: {
        mechanism: "property objects are descriptors not functions",
        deadEnds: [],
        unlock: "use inspect.isdatadescriptor",
        verification: "class inherits docstrings",
      },
      distillationConfidence: 0.8,
      model: "mock",
    });

    const runner = new MockAgentRunner({
      output: "agent tried the block but the task failed",
      resolved: false,
      agentReusedBlock: true,
      details: "held-out task did not resolve even with the injection",
    });

    const verifier = new HeldOutVerifier({
      runner,
      picker: new StaticTaskPicker([HELD_OUT_TASK]),
    });

    const pipeline = new DistillationPipeline({
      store,
      distiller,
      verifier,
    });

    // Synthesize a grader-verified trace so the pipeline accepts it.
    const trace = {
      id: "astropy-7166",
      createdAt: 1, updatedAt: 1,
      problem: {
        description: "metaclass missing docstrings for properties",
        language: "python", framework: "astropy", errorType: "MissingDocstring",
        tags: [], fingerprint: "fp-1",
      },
      solution: {
        summary: "swapped isfunction → isdatadescriptor",
        steps: [
          { type: "analysis" as const, description: "first hypothesis: add branch" },
          { type: "analysis" as const, description: "that didn't work" },
          { type: "analysis" as const, description: "use isdatadescriptor to cover both" },
          { type: "action" as const, description: "edit" },
          { type: "verification" as const, description: "tests pass" },
        ],
        outcome: "success" as const,
      },
      metadata: { agent: "a", model: "m" },
      quality: { recallCount: 0, helpfulCount: 0, score: 0.5 },
      provenance: { origin: "local" as const, appliedCount: 0 },
    };

    const res = await pipeline.distillTrace(trace);
    expect(res.status).toBe("stored");
    if (res.status !== "stored") throw new Error("unreachable");
    const blockId = res.block.id;

    // Pipeline persisted the disproved verdict on the block.
    expect(store.getBlock(blockId)!.verification?.status).toBe("disproved");

    // Before demotion pass: block is still active.
    expect(store.getBlock(blockId)!.status).toBe("active");

    // LifecycleRepair must demote the disproved block.
    const repair = new LifecycleRepair({ store });
    const report = repair.applyDemotionRules();
    expect(report.demoted.map((d) => d.reason)).toContain("verification:disproved");
    expect(store.getBlock(blockId)!.status).toBe("demoted");

    // Serving integration: the demoted block no longer surfaces.
    const server = new BlockServer(store, { emitEvents: false });
    const out = server.recall({ text: "metaclass inspect" });
    expect(out.blocks.length).toBe(0);
  });
});
