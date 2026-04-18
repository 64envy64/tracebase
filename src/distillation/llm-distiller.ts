/**
 * LLM distiller — the single LLM-calling step of the distillation
 * pipeline. Isolated behind a small interface so the pipeline is
 * testable end-to-end without ever touching the network.
 *
 * Three implementations ship:
 *   • LlmDistiller           — interface every concrete distiller implements.
 *   • AnthropicDistiller     — real Claude-backed distiller. Takes a
 *     pre-constructed `@anthropic-ai/sdk` client (peer dependency) so
 *     the library doesn't hard-depend on the SDK for consumers that
 *     use a mock or a different provider.
 *   • MockDistiller          — returns a canned response; used by
 *     pipeline tests so they never need an API key.
 *
 * Default model: Haiku 4.5 (cheap, fast — see design doc §Open q. 1).
 * Quality override: Sonnet 4.6. Users set `useQualityModel: true` or
 * pass `modelOverride` per-call when they want higher quality.
 */
import type { BlockBody, BlockInvariants } from "../types.js";

// ---------------------------------------------------------------------------
// Default model choices (decided 2026-04-18 per design doc §Open questions)
// ---------------------------------------------------------------------------

/** Default distillation model — Haiku 4.5, optimized for cost. */
export const DEFAULT_DISTILL_MODEL = "claude-haiku-4-5-20251001";

/** Quality override — Sonnet 4.6, used when caller flags need for higher quality. */
export const QUALITY_DISTILL_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface DistillerInput {
  /** Problem statement (truncated to ≤ ~800 chars inside the prompt). */
  problemDescription: string;
  /** Agent's one-line summary of the fix (truncated). */
  solutionSummary: string;
  /** Pivotal reasoning step text from the unlock-detection heuristic. */
  unlockStep: string;
  /** Dead ends from the mining heuristic (may be empty). */
  deadEnds: string[];
  /** Hints for invariants extraction; the distiller MAY override. */
  invariants?: BlockInvariants;
  /**
   * Optional per-call model override. If unset the distiller uses its
   * default (AnthropicDistiller: Haiku unless `useQualityModel` is on).
   */
  modelOverride?: string;
}

export interface DistillerOutput {
  trigger: {
    situation: string;
    invariants: BlockInvariants;
  };
  body: BlockBody;
  /** Model's self-reported 0..1 confidence that the pattern is reusable. */
  distillationConfidence: number;
  /** Model actually used (for provenance.distilledWithModel). */
  model: string;
}

export interface LlmDistiller {
  /** Human-readable name; goes into provenance.distilledWithModel. */
  readonly name: string;
  distill(input: DistillerInput): Promise<DistillerOutput>;
}

export class DistillerError extends Error {
  constructor(
    message: string,
    public readonly kind: "llm-error" | "parse-error" | "schema-error",
  ) {
    super(message);
    this.name = "DistillerError";
  }
}

// ---------------------------------------------------------------------------
// Anthropic distiller
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the `@anthropic-ai/sdk` Messages API. Defining it
 * locally avoids a hard import so the SDK stays an optional peer dep.
 * Any client matching this contract works — including a test shim.
 */
export interface AnthropicMessagesLike {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      temperature?: number;
      system?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface AnthropicDistillerOptions {
  /** Pre-constructed Anthropic SDK client (or compatible shim). */
  client: AnthropicMessagesLike;
  /** Default model. Defaults to Haiku 4.5. */
  defaultModel?: string;
  /** Quality override model used when `useQualityModel` is true. */
  qualityModel?: string;
  /** When true, all calls (without modelOverride) use the quality model. */
  useQualityModel?: boolean;
  /** Hard cap on model output tokens. Default 800 — fits the schema. */
  maxOutputTokens?: number;
  /** Temperature. Default 0 — distillation is supposed to be deterministic. */
  temperature?: number;
}

export class AnthropicDistiller implements LlmDistiller {
  readonly name = "anthropic-distiller";
  private readonly client: AnthropicMessagesLike;
  private readonly defaultModel: string;
  private readonly qualityModel: string;
  private readonly useQualityModel: boolean;
  private readonly maxOutputTokens: number;
  private readonly temperature: number;

  constructor(opts: AnthropicDistillerOptions) {
    this.client = opts.client;
    this.defaultModel = opts.defaultModel ?? DEFAULT_DISTILL_MODEL;
    this.qualityModel = opts.qualityModel ?? QUALITY_DISTILL_MODEL;
    this.useQualityModel = opts.useQualityModel ?? false;
    this.maxOutputTokens = opts.maxOutputTokens ?? 800;
    this.temperature = opts.temperature ?? 0;
  }

  async distill(input: DistillerInput): Promise<DistillerOutput> {
    const { DISTILL_SYSTEM_PROMPT, buildDistillUserMessage } = await import("./prompts.js");
    const model =
      input.modelOverride ??
      (this.useQualityModel ? this.qualityModel : this.defaultModel);

    let response;
    try {
      response = await this.client.messages.create({
        model,
        max_tokens: this.maxOutputTokens,
        temperature: this.temperature,
        system: DISTILL_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: buildDistillUserMessage(input) },
        ],
      });
    } catch (err) {
      throw new DistillerError(
        `Anthropic API error: ${err instanceof Error ? err.message : String(err)}`,
        "llm-error",
      );
    }

    const text = extractText(response.content);
    if (!text) {
      throw new DistillerError(
        "Anthropic response contained no text content",
        "parse-error",
      );
    }

    const parsed = parseDistillerJson(text);
    return { ...parsed, model };
  }
}

// ---------------------------------------------------------------------------
// Mock distiller — for tests
// ---------------------------------------------------------------------------

export class MockDistiller implements LlmDistiller {
  readonly name = "mock-distiller";
  private responseOrFn:
    | DistillerOutput
    | ((input: DistillerInput) => DistillerOutput | Promise<DistillerOutput>);

  constructor(
    responseOrFn:
      | DistillerOutput
      | ((input: DistillerInput) => DistillerOutput | Promise<DistillerOutput>),
  ) {
    this.responseOrFn = responseOrFn;
  }

  async distill(input: DistillerInput): Promise<DistillerOutput> {
    if (typeof this.responseOrFn === "function") {
      return await this.responseOrFn(input);
    }
    return this.responseOrFn;
  }
}

// ---------------------------------------------------------------------------
// JSON parsing / schema validation
// ---------------------------------------------------------------------------

function extractText(content: Array<{ type: string; text?: string }>): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

/**
 * Parse and validate the model's JSON output against the DistillerOutput
 * schema. Throws DistillerError on any structural problem. The caller
 * (pipeline) converts the thrown error into a RejectionReason — the
 * distiller never stores an invalid result.
 */
export function parseDistillerJson(raw: string): Omit<DistillerOutput, "model"> {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new DistillerError("no JSON object found in model output", "parse-error");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (err) {
    throw new DistillerError(
      `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      "parse-error",
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new DistillerError("distiller output is not an object", "schema-error");
  }
  const o = obj as Record<string, unknown>;

  // trigger
  const trigger = o.trigger;
  if (!trigger || typeof trigger !== "object") {
    throw new DistillerError("missing trigger", "schema-error");
  }
  const tg = trigger as Record<string, unknown>;
  if (typeof tg.situation !== "string" || tg.situation.trim().length === 0) {
    throw new DistillerError("trigger.situation must be a non-empty string", "schema-error");
  }
  const inv = tg.invariants;
  const invariants: BlockInvariants = {};
  if (inv && typeof inv === "object") {
    const iv = inv as Record<string, unknown>;
    if (typeof iv.language === "string") invariants.language = iv.language;
    if (typeof iv.framework === "string") invariants.framework = iv.framework;
    if (typeof iv.errorType === "string") invariants.errorType = iv.errorType;
    if (Array.isArray(iv.apiSurface)) {
      const api = iv.apiSurface.filter((s): s is string => typeof s === "string");
      if (api.length > 0) invariants.apiSurface = api;
    }
  }

  // body
  const body = o.body;
  if (!body || typeof body !== "object") {
    throw new DistillerError("missing body", "schema-error");
  }
  const bd = body as Record<string, unknown>;
  const requiredBodyFields = ["mechanism", "unlock", "verification"] as const;
  for (const field of requiredBodyFields) {
    if (typeof bd[field] !== "string" || (bd[field] as string).trim().length === 0) {
      throw new DistillerError(`body.${field} must be a non-empty string`, "schema-error");
    }
  }
  let deadEnds: string[] = [];
  if (Array.isArray(bd.deadEnds)) {
    deadEnds = bd.deadEnds.filter((s): s is string => typeof s === "string");
  }

  // distillationConfidence
  const conf = o.distillationConfidence;
  if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 0 || conf > 1) {
    throw new DistillerError(
      "distillationConfidence must be a finite number in [0,1]",
      "schema-error",
    );
  }

  return {
    trigger: {
      situation: (tg.situation as string).trim(),
      invariants,
    },
    body: {
      mechanism: (bd.mechanism as string).trim(),
      deadEnds,
      unlock: (bd.unlock as string).trim(),
      verification: (bd.verification as string).trim(),
    },
    distillationConfidence: conf,
  };
}

/**
 * Extract the first balanced JSON object from a string, tolerating
 * leading / trailing model prose. Returns null if nothing parseable is
 * found. We use balanced-brace scanning rather than regex because the
 * model occasionally emits nested objects (invariants, arrays).
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
