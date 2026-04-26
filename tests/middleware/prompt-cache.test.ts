/**
 * Provider-side prompt cache (PLAN-0.7 §rc.7) — tests.
 *
 * The wrappers must:
 *   1. Attach Anthropic `cache_control: { type: "ephemeral" }` to
 *      the last system block on supported models.
 *   2. Read provider-reported cached-token counts off the response
 *      usage and emit `cache.prompt_hit` events.
 *   3. Honor `.tracebase/config.json` `{ promptCache: { enabled:
 *      false } }` — no attachment, no events.
 *   4. Never estimate cache savings from message length or model
 *      name (provider-reported only).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ReasoningLayer } from "../../src/core/engine.js";
import { wrapAnthropic } from "../../src/middleware/anthropic.js";
import { wrapOpenAI } from "../../src/middleware/openai.js";
import { BlockStore } from "../../src/core/block-store.js";
import {
  attachAnthropicCacheControl,
  extractAnthropicCachedTokens,
  extractOpenAICachedTokens,
  isAnthropicCacheSupported,
  isPromptCacheEnabled,
} from "../../src/middleware/prompt-cache.js";

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(path + suffix); } catch { /* ok */ }
  }
}

function readPromptHits(dbPath: string): Array<{ surface: string; tokensSaved: number }> {
  // Open writable so migrations can create analytics_events when
  // no event was ever written (negative-path tests). Migrations
  // are idempotent and a no-op once the schema is current.
  const db = new Database(dbPath);
  try {
    const store = new BlockStore(db);
    const events = store.readEvents({ eventType: "cache.prompt_hit", limit: 1000 });
    const hits: Array<{ surface: string; tokensSaved: number }> = [];
    for (const ev of events) {
      if (ev.event !== "cache.prompt_hit") continue;
      hits.push({ surface: ev.surface, tokensSaved: ev.tokensSaved });
    }
    store.close();
    return hits;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isAnthropicCacheSupported", () => {
  it("matches Sonnet+ prefixes (case-insensitive)", () => {
    expect(isAnthropicCacheSupported("claude-3-5-sonnet-20241022")).toBe(true);
    expect(isAnthropicCacheSupported("claude-3-7-sonnet-20250219")).toBe(true);
    expect(isAnthropicCacheSupported("claude-sonnet-4-5-20251022")).toBe(true);
    expect(isAnthropicCacheSupported("claude-opus-4-7")).toBe(true);
    expect(isAnthropicCacheSupported("claude-3-opus-20240229")).toBe(true);
    expect(isAnthropicCacheSupported("CLAUDE-SONNET-4-5")).toBe(true);
  });

  it("rejects pre-Sonnet / unsupported models", () => {
    expect(isAnthropicCacheSupported("claude-2.1")).toBe(false);
    expect(isAnthropicCacheSupported("gpt-4o-mini")).toBe(false);
    expect(isAnthropicCacheSupported(undefined)).toBe(false);
    expect(isAnthropicCacheSupported("")).toBe(false);
  });
});

describe("attachAnthropicCacheControl", () => {
  it("converts a string system to a single-block array with cache_control", () => {
    const out = attachAnthropicCacheControl({
      system: "Be concise.",
    });
    expect(Array.isArray(out.system)).toBe(true);
    const blocks = out.system as Array<{ type: string; text?: string; cache_control?: unknown }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("Be concise.");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("tags the LAST block when system is an array (caches everything before+including)", () => {
    const out = attachAnthropicCacheControl({
      system: [
        { type: "text", text: "Base prompt" },
        { type: "text", text: "TraceBase prefix (the last block)" },
      ],
    });
    const blocks = out.system as Array<{ type: string; text?: string; cache_control?: unknown }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.cache_control).toBeUndefined();
    expect(blocks[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("is idempotent (already-tagged input is returned unchanged)", () => {
    const tagged = {
      system: [
        { type: "text", text: "First" },
        { type: "text", text: "Last", cache_control: { type: "ephemeral" as const } },
      ],
    };
    const out = attachAnthropicCacheControl(tagged);
    expect(out).toBe(tagged);
  });

  it("leaves params unchanged when system is undefined or empty", () => {
    const noSystem = { model: "claude-sonnet-4-5" };
    expect(attachAnthropicCacheControl(noSystem)).toBe(noSystem);

    const emptyString = { system: "" };
    expect(attachAnthropicCacheControl(emptyString)).toBe(emptyString);

    const emptyArray = { system: [] as Array<{ type: string }> };
    expect(attachAnthropicCacheControl(emptyArray)).toBe(emptyArray);
  });

  it("does not mutate the caller's params object or system array", () => {
    const original = {
      system: [
        { type: "text", text: "A" },
        { type: "text", text: "B" },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    attachAnthropicCacheControl(original);
    expect(original).toEqual(snapshot);
  });
});

describe("extractAnthropicCachedTokens", () => {
  it("reads cache_read_input_tokens", () => {
    expect(extractAnthropicCachedTokens({ cache_read_input_tokens: 1500 })).toBe(1500);
  });
  it("returns 0 when missing or non-positive", () => {
    expect(extractAnthropicCachedTokens(undefined)).toBe(0);
    expect(extractAnthropicCachedTokens(null)).toBe(0);
    expect(extractAnthropicCachedTokens({})).toBe(0);
    expect(extractAnthropicCachedTokens({ cache_read_input_tokens: 0 })).toBe(0);
    expect(extractAnthropicCachedTokens({ cache_read_input_tokens: -10 })).toBe(0);
  });
  it("ignores cache_creation_input_tokens (those are NOT savings — they cost extra)", () => {
    // We only count the read side. A response with creation tokens but
    // zero read tokens should produce zero savings.
    const usage = {
      cache_read_input_tokens: 0,
      // @ts-expect-error — extra field beyond the minimal interface
      cache_creation_input_tokens: 5000,
    };
    expect(extractAnthropicCachedTokens(usage)).toBe(0);
  });
});

describe("extractOpenAICachedTokens", () => {
  it("reads prompt_tokens_details.cached_tokens (canonical shape)", () => {
    expect(
      extractOpenAICachedTokens({ prompt_tokens_details: { cached_tokens: 800 } }),
    ).toBe(800);
  });
  it("falls back to top-level cached_tokens (older SDK shape)", () => {
    expect(extractOpenAICachedTokens({ cached_tokens: 600 })).toBe(600);
  });
  it("prefers nested over flat when both present", () => {
    expect(
      extractOpenAICachedTokens({
        cached_tokens: 100,
        prompt_tokens_details: { cached_tokens: 700 },
      }),
    ).toBe(700);
  });
  it("returns 0 when missing or zero", () => {
    expect(extractOpenAICachedTokens(undefined)).toBe(0);
    expect(extractOpenAICachedTokens(null)).toBe(0);
    expect(extractOpenAICachedTokens({})).toBe(0);
    expect(extractOpenAICachedTokens({ prompt_tokens_details: { cached_tokens: 0 } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic wrapper integration
// ---------------------------------------------------------------------------

describe("wrapAnthropic — prompt cache", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-mw-pc-anthropic-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("attaches cache_control to the system block on a supported model", async () => {
    let seenParams: { system?: unknown } | null = null;
    const mockClient = {
      messages: {
        create: async (params: { system?: unknown }) => {
          seenParams = params;
          return {
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    const wrapped = wrapAnthropic(mockClient, layer);
    await wrapped.messages.create({
      model: "claude-sonnet-4-5-20251022",
      system: "Be helpful.",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(seenParams).not.toBeNull();
    const sys = (seenParams! as { system: unknown }).system as Array<{
      type: string;
      cache_control?: unknown;
    }>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[sys.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT attach cache_control on an unsupported model", async () => {
    let seenParams: { system?: unknown } | null = null;
    const mockClient = {
      messages: {
        create: async (params: { system?: unknown }) => {
          seenParams = params;
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    };
    const wrapped = wrapAnthropic(mockClient, layer);
    await wrapped.messages.create({
      model: "claude-2.1", // pre-cache vintage
      system: "Be helpful.",
      messages: [{ role: "user", content: "Hi" }],
    });

    // System should be the original string, untouched.
    expect((seenParams! as { system: unknown }).system).toBe("Be helpful.");
  });

  it("emits cache.prompt_hit when the response reports cache_read_input_tokens", async () => {
    const mockClient = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 1234,
          },
        }),
      },
    };
    const wrapped = wrapAnthropic(mockClient, layer);
    await wrapped.messages.create({
      model: "claude-sonnet-4-5",
      system: "Sys",
      messages: [{ role: "user", content: "Q" }],
    });

    layer.close(); // flush the SQLite handle the wrapper opened
    const hits = readPromptHits(dbPath);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ surface: "anthropic", tokensSaved: 1234 });
  });

  it("does NOT emit cache.prompt_hit when usage is silent on cached tokens", async () => {
    const mockClient = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 100, output_tokens: 20 }, // no cache_read_input_tokens
        }),
      },
    };
    const wrapped = wrapAnthropic(mockClient, layer);
    await wrapped.messages.create({
      model: "claude-sonnet-4-5",
      system: "Sys",
      messages: [{ role: "user", content: "Q" }],
    });

    layer.close();
    const hits = readPromptHits(dbPath);
    expect(hits).toHaveLength(0);
  });

  it("respects promptCache.enabled=false (no attachment, no event)", async () => {
    layer.close();
    layer = new ReasoningLayer({ storagePath: dbPath, promptCache: { enabled: false } });
    expect(isPromptCacheEnabled(layer)).toBe(false);

    let seenParams: { system?: unknown } | null = null;
    const mockClient = {
      messages: {
        create: async (params: { system?: unknown }) => {
          seenParams = params;
          return {
            content: [{ type: "text", text: "ok" }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 5000, // would normally be a hit
            },
          };
        },
      },
    };
    const wrapped = wrapAnthropic(mockClient, layer);
    await wrapped.messages.create({
      model: "claude-sonnet-4-5",
      system: "Sys",
      messages: [{ role: "user", content: "Q" }],
    });

    // System untouched (no cache_control).
    expect((seenParams! as { system: unknown }).system).toBe("Sys");
    layer.close();
    const hits = readPromptHits(dbPath);
    // The aggregator must see zero — this is the spec's "honest" path.
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAI wrapper integration
// ---------------------------------------------------------------------------

describe("wrapOpenAI — prompt cache", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-mw-pc-openai-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  it("emits cache.prompt_hit from prompt_tokens_details.cached_tokens", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              total_tokens: 200,
              prompt_tokens: 150,
              completion_tokens: 50,
              prompt_tokens_details: { cached_tokens: 900 },
            },
          }),
        },
      },
    };
    const wrapped = wrapOpenAI(mockClient, layer);
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Q" }],
    });

    layer.close();
    const hits = readPromptHits(dbPath);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ surface: "openai", tokensSaved: 900 });
  });

  it("does NOT emit when cached_tokens is missing or zero (no estimate)", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { total_tokens: 200, prompt_tokens: 150, completion_tokens: 50 },
          }),
        },
      },
    };
    const wrapped = wrapOpenAI(mockClient, layer);
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Q" }],
    });

    layer.close();
    const hits = readPromptHits(dbPath);
    expect(hits).toHaveLength(0);
  });

  it("respects promptCache.enabled=false (no event even when usage reported)", async () => {
    layer.close();
    layer = new ReasoningLayer({ storagePath: dbPath, promptCache: { enabled: false } });

    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              total_tokens: 200,
              prompt_tokens_details: { cached_tokens: 700 },
            },
          }),
        },
      },
    };
    const wrapped = wrapOpenAI(mockClient, layer);
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Q" }],
    });

    layer.close();
    const hits = readPromptHits(dbPath);
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Privacy invariant — the emitted event payload carries ONLY the
// documented fields. A regression here means a future refactor leaked
// model name / system text / message content into telemetry.
// ---------------------------------------------------------------------------

describe("appendPromptCacheHit — privacy invariant", () => {
  let layer: ReasoningLayer;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `tracebase-mw-pc-priv-${randomUUID()}.db`);
    layer = new ReasoningLayer({ storagePath: dbPath });
  });

  afterEach(() => {
    layer.close();
    cleanupDb(dbPath);
  });

  /**
   * Read the raw payload JSON for the cache.prompt_hit row so the
   * test sees exactly what the wire / cloud aggregator would.
   */
  function readRawHitPayloads(): Array<Record<string, unknown>> {
    const db = new Database(dbPath);
    try {
      const rows = db
        .prepare("SELECT payload FROM analytics_events WHERE event_type = 'cache.prompt_hit'")
        .all() as Array<{ payload: string }>;
      return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    } finally {
      db.close();
    }
  }

  it("emitted payload contains ONLY {ts, queryId, event, surface, tokensSaved} — no model / system / messages", async () => {
    const mockClient = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 1500,
          },
        }),
      },
    };
    const wrapped = wrapAnthropic(mockClient, layer);
    await wrapped.messages.create({
      model: "claude-sonnet-4-5",
      // Plant a system prefix that, if leaked, would be obvious.
      system: "EYECATCHER_SYSTEM_PROMPT_DO_NOT_LEAK",
      messages: [
        { role: "user", content: "EYECATCHER_USER_TEXT_DO_NOT_LEAK" },
      ],
    });

    layer.close();
    const payloads = readRawHitPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;

    // Allowed keys: the five documented fields. No more, no less.
    const expectedKeys = new Set([
      "ts",
      "queryId",
      "event",
      "surface",
      "tokensSaved",
    ]);
    const actualKeys = new Set(Object.keys(p));
    for (const key of actualKeys) {
      expect(expectedKeys.has(key), `unexpected key in payload: ${key}`).toBe(true);
    }

    // Every value: either a primitive or the closed-enum surface.
    expect(typeof p.ts).toBe("number");
    expect(typeof p.queryId).toBe("string");
    expect(p.event).toBe("cache.prompt_hit");
    expect(p.surface).toBe("anthropic");
    expect(typeof p.tokensSaved).toBe("number");

    // Eye-catchers MUST NOT appear anywhere in the serialized payload.
    const json = JSON.stringify(p);
    expect(json).not.toContain("EYECATCHER_SYSTEM_PROMPT");
    expect(json).not.toContain("EYECATCHER_USER_TEXT");
    // Model name MUST NOT leak — the spec is explicit that the cloud
    // never sees model identity per cache event.
    expect(json).not.toContain("claude-sonnet-4-5");
  });
});
