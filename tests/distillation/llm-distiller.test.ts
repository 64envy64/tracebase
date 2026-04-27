import { describe, it, expect } from "vitest";
import {
  AnthropicDistiller,
  MockDistiller,
  DistillerError,
  parseDistillerJson,
  DEFAULT_DISTILL_MODEL,
  QUALITY_DISTILL_MODEL,
  type AnthropicMessagesLike,
  type DistillerInput,
  type DistillerOutput,
} from "../../src/distillation/llm-distiller.js";
import { DISTILL_SYSTEM_PROMPT, buildDistillUserMessage } from "../../src/distillation/prompts.js";

const SAMPLE_INPUT: DistillerInput = {
  problemDescription: "Metaclass missing docstring for properties in astropy.",
  solutionSummary: "Switched inspect.isfunction → inspect.isdatadescriptor.",
  unlockStep: "property objects are descriptors, not functions",
  deadEnds: ["add property-specific branch", "iterate descriptor internals"],
  invariants: { language: "python", framework: "astropy" },
};

const SAMPLE_RESPONSE_JSON = `{
  "trigger": {
    "situation": "Metaclass iterates members via inspect.isfunction, missing properties",
    "invariants": {
      "language": "python",
      "framework": "astropy",
      "apiSurface": ["inspect.isfunction"]
    }
  },
  "body": {
    "mechanism": "property objects are descriptors not functions",
    "deadEnds": ["add property-specific branch"],
    "unlock": "use inspect.isdatadescriptor to cover both",
    "verification": "class with method and property inherits docstrings"
  },
  "distillationConfidence": 0.82
}`;

// ---------------------------------------------------------------------------
// parseDistillerJson
// ---------------------------------------------------------------------------

describe("parseDistillerJson — happy path", () => {
  it("parses a well-formed response", () => {
    const out = parseDistillerJson(SAMPLE_RESPONSE_JSON);
    expect(out.trigger.situation).toContain("Metaclass");
    expect(out.trigger.invariants.language).toBe("python");
    expect(out.trigger.invariants.apiSurface).toEqual(["inspect.isfunction"]);
    expect(out.body.mechanism).toContain("descriptors");
    expect(out.body.deadEnds.length).toBe(1);
    expect(out.distillationConfidence).toBeCloseTo(0.82);
  });

  it("tolerates leading and trailing prose around the JSON", () => {
    const wrapped = "Here you go:\n" + SAMPLE_RESPONSE_JSON + "\nHope that helps!";
    const out = parseDistillerJson(wrapped);
    expect(out.trigger.situation).toContain("Metaclass");
  });

  it("tolerates nested braces inside strings", () => {
    const raw = `{
      "trigger": { "situation": "a {literal} brace", "invariants": {} },
      "body": {
        "mechanism": "m", "deadEnds": [],
        "unlock": "u", "verification": "v"
      },
      "distillationConfidence": 0.5
    }`;
    const out = parseDistillerJson(raw);
    expect(out.trigger.situation).toContain("{literal}");
  });
});

describe("parseDistillerJson — guardrails", () => {
  it("picks up guardrails when present", () => {
    const raw = `{
      "trigger": { "situation": "s", "invariants": {} },
      "body": {
        "mechanism": "m",
        "deadEnds": ["x"],
        "unlock": "u",
        "verification": "v",
        "guardrails": ["stop-if-x", "stop-if-y"]
      },
      "distillationConfidence": 0.5
    }`;
    const out = parseDistillerJson(raw);
    expect(out.body.guardrails).toEqual(["stop-if-x", "stop-if-y"]);
  });

  it("leaves guardrails undefined when missing", () => {
    const out = parseDistillerJson(SAMPLE_RESPONSE_JSON);
    expect(out.body.guardrails).toBeUndefined();
  });

  it("drops non-string guardrail entries silently", () => {
    const raw = `{
      "trigger": { "situation": "s", "invariants": {} },
      "body": {
        "mechanism": "m",
        "deadEnds": ["x"],
        "unlock": "u",
        "verification": "v",
        "guardrails": ["ok", 42, null]
      },
      "distillationConfidence": 0.5
    }`;
    const out = parseDistillerJson(raw);
    expect(out.body.guardrails).toEqual(["ok"]);
  });

  it("never parses a kind field from the model (parser ignores it)", () => {
    const raw = `{
      "kind": "pitfall",
      "trigger": { "situation": "s", "invariants": {} },
      "body": {
        "mechanism": "m",
        "deadEnds": ["x"],
        "unlock": "u",
        "verification": "v"
      },
      "distillationConfidence": 0.5
    }`;
    const out = parseDistillerJson(raw);
    // Parser output shape has no `kind`: the pipeline stamps it.
    expect((out as unknown as { kind?: string }).kind).toBeUndefined();
  });
});

describe("parseDistillerJson — failure modes", () => {
  it("throws parse-error on malformed JSON", () => {
    expect(() => parseDistillerJson("not json")).toThrow(DistillerError);
  });

  it("throws schema-error when trigger is missing", () => {
    try {
      parseDistillerJson(`{
        "body": { "mechanism": "m", "deadEnds": [], "unlock": "u", "verification": "v" },
        "distillationConfidence": 0.5
      }`);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DistillerError);
      expect((e as DistillerError).kind).toBe("schema-error");
    }
  });

  it("throws schema-error when distillationConfidence is out of [0,1]", () => {
    const raw = `{
      "trigger": { "situation": "s", "invariants": {} },
      "body": { "mechanism": "m", "deadEnds": [], "unlock": "u", "verification": "v" },
      "distillationConfidence": 2.5
    }`;
    expect(() => parseDistillerJson(raw)).toThrow(/distillationConfidence/);
  });

  it("throws schema-error when required body field is empty", () => {
    const raw = `{
      "trigger": { "situation": "s", "invariants": {} },
      "body": { "mechanism": "", "deadEnds": [], "unlock": "u", "verification": "v" },
      "distillationConfidence": 0.5
    }`;
    expect(() => parseDistillerJson(raw)).toThrow(/mechanism/);
  });

  it("drops non-string apiSurface entries silently", () => {
    const raw = `{
      "trigger": { "situation": "s", "invariants": { "apiSurface": ["ok", 42, null] } },
      "body": { "mechanism": "m", "deadEnds": [], "unlock": "u", "verification": "v" },
      "distillationConfidence": 0.5
    }`;
    const out = parseDistillerJson(raw);
    expect(out.trigger.invariants.apiSurface).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// MockDistiller
// ---------------------------------------------------------------------------

describe("MockDistiller", () => {
  it("returns the static response provided", async () => {
    const expected: DistillerOutput = {
      trigger: { situation: "x", invariants: {} },
      body: { mechanism: "m", deadEnds: [], unlock: "u", verification: "v" },
      distillationConfidence: 0.5,
      model: "mock",
    };
    const d = new MockDistiller(expected);
    const out = await d.distill(SAMPLE_INPUT);
    expect(out).toEqual(expected);
  });

  it("invokes a function response with the input", async () => {
    const d = new MockDistiller((input) => ({
      trigger: { situation: input.problemDescription, invariants: {} },
      body: { mechanism: "m", deadEnds: [], unlock: "u", verification: "v" },
      distillationConfidence: 0.5,
      model: "mock-fn",
    }));
    const out = await d.distill(SAMPLE_INPUT);
    expect(out.trigger.situation).toContain("docstring");
    expect(out.model).toBe("mock-fn");
  });
});

// ---------------------------------------------------------------------------
// AnthropicDistiller via a minimal client shim
// ---------------------------------------------------------------------------

function shimClient(
  respond: (params: Parameters<AnthropicMessagesLike["messages"]["create"]>[0]) => ReturnType<AnthropicMessagesLike["messages"]["create"]>,
): AnthropicMessagesLike {
  return { messages: { create: respond } };
}

describe("AnthropicDistiller", () => {
  it("uses DEFAULT_DISTILL_MODEL by default", async () => {
    let seenModel = "";
    const client = shimClient(async (p) => {
      seenModel = p.model;
      return { content: [{ type: "text", text: SAMPLE_RESPONSE_JSON }] };
    });
    const d = new AnthropicDistiller({ client });
    await d.distill(SAMPLE_INPUT);
    expect(seenModel).toBe(DEFAULT_DISTILL_MODEL);
  });

  it("uses QUALITY_DISTILL_MODEL when useQualityModel=true", async () => {
    let seenModel = "";
    const client = shimClient(async (p) => {
      seenModel = p.model;
      return { content: [{ type: "text", text: SAMPLE_RESPONSE_JSON }] };
    });
    const d = new AnthropicDistiller({ client, useQualityModel: true });
    await d.distill(SAMPLE_INPUT);
    expect(seenModel).toBe(QUALITY_DISTILL_MODEL);
  });

  it("per-call modelOverride wins over both defaults and quality flag", async () => {
    let seenModel = "";
    const client = shimClient(async (p) => {
      seenModel = p.model;
      return { content: [{ type: "text", text: SAMPLE_RESPONSE_JSON }] };
    });
    const d = new AnthropicDistiller({ client, useQualityModel: true });
    await d.distill({ ...SAMPLE_INPUT, modelOverride: "claude-opus-custom" });
    expect(seenModel).toBe("claude-opus-custom");
  });

  it("populates the model name in the output", async () => {
    const client = shimClient(async () => ({
      content: [{ type: "text", text: SAMPLE_RESPONSE_JSON }],
    }));
    const d = new AnthropicDistiller({ client });
    const out = await d.distill(SAMPLE_INPUT);
    expect(out.model).toBe(DEFAULT_DISTILL_MODEL);
  });

  it("passes the canonical system prompt and a well-formed user message", async () => {
    let seen: Parameters<AnthropicMessagesLike["messages"]["create"]>[0] | null = null;
    const client = shimClient(async (p) => {
      seen = p;
      return { content: [{ type: "text", text: SAMPLE_RESPONSE_JSON }] };
    });
    const d = new AnthropicDistiller({ client });
    await d.distill(SAMPLE_INPUT);
    expect(seen).not.toBeNull();
    expect(seen!.system).toBe(DISTILL_SYSTEM_PROMPT);
    expect(seen!.messages[0].content).toBe(buildDistillUserMessage(SAMPLE_INPUT));
    expect(seen!.temperature).toBe(0);
  });

  it("wraps SDK errors as DistillerError(kind='llm-error')", async () => {
    const client = shimClient(async () => { throw new Error("rate limited"); });
    const d = new AnthropicDistiller({ client });
    try {
      await d.distill(SAMPLE_INPUT);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DistillerError);
      expect((e as DistillerError).kind).toBe("llm-error");
      expect((e as DistillerError).message).toContain("rate limited");
    }
  });

  it("throws parse-error when the model response contains no text", async () => {
    const client = shimClient(async () => ({ content: [{ type: "tool_use" }] }));
    const d = new AnthropicDistiller({ client });
    try {
      await d.distill(SAMPLE_INPUT);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DistillerError);
      expect((e as DistillerError).kind).toBe("parse-error");
    }
  });

  it("surfaces schema errors from malformed model JSON", async () => {
    const client = shimClient(async () => ({
      content: [{ type: "text", text: `{ "trigger": { "situation": "x" } }` }],
    }));
    const d = new AnthropicDistiller({ client });
    try {
      await d.distill(SAMPLE_INPUT);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DistillerError);
      expect((e as DistillerError).kind).toBe("schema-error");
    }
  });
});
