/**
 * Provider-side prompt cache integration (PLAN-0.7 §rc.7).
 *
 * The wrappers `wrapAnthropic` / `wrapOpenAI` already prepend a
 * stable TraceBase prefix (TB MEMORY / TB CONTEXT facts + chunks)
 * to the system prompt before each call. That prefix is exactly
 * what providers' prompt caches were built for — long, repeated,
 * deterministic context that the model would otherwise re-tokenise
 * on every turn.
 *
 * This module:
 *   1. Attaches Anthropic `cache_control: { type: "ephemeral" }` to
 *      the last system content block on supported models. The API
 *      silently no-ops below the per-model minimum cacheable size,
 *      so attachment is safe even when the prefix is short.
 *   2. Reads provider-reported cached-token counts off the response
 *      usage and emits a `cache.prompt_hit` analytics event. This
 *      number flows into `computeMechanismSavings.promptCacheSaved`
 *      and the `tracebase impact` mechanism block.
 *
 * Strict honesty contract (§rc.7):
 *   - We only emit `cache.prompt_hit` when the provider's API
 *     actually reported `cache_read_input_tokens` (Anthropic) or
 *     `prompt_tokens_details.cached_tokens` (OpenAI). We NEVER
 *     estimate cache savings from message length or model name —
 *     a missing usage field is reported as zero, period.
 *   - The `cache_control` attachment adds zero new content to the
 *     request beyond what would have been sent anyway: it is a
 *     metadata-only flag on an existing block.
 *   - Attachment is gated by `.tracebase/config.json`'s
 *     `promptCache.enabled` — defaults to true, set false to
 *     disable both attachment and event emission.
 *
 * Provider allowlist (Anthropic only — OpenAI auto-caches without
 * an explicit attribute on supported models): Sonnet family and
 * above. Below this list the API may reject `cache_control` or
 * silently ignore it; we keep the attachment off rather than
 * surfacing a per-call warning.
 */
import Database from "better-sqlite3";
import { BlockStore } from "../core/block-store.js";
import type { ReasoningLayer } from "../core/engine.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PromptCacheConfig {
  /**
   * Master switch. Default: true.
   *
   * Setting to false:
   *   - skips the `cache_control` attachment in `wrapAnthropic`
   *   - skips the `cache.prompt_hit` event emission in both wrappers
   *
   * Useful for tests, air-gapped runs, or for diffing token usage
   * with-vs-without caching during onboarding.
   */
  enabled?: boolean;
}

export type PromptCacheSurface = "anthropic" | "openai";

// ---------------------------------------------------------------------------
// Provider allowlist (Anthropic)
// ---------------------------------------------------------------------------

/**
 * Anthropic models that support `cache_control` per the Sonnet+
 * allowlist in the §rc.7 plan. The API ignores attachments on
 * older / smaller models with no error, but ignoring keeps us
 * from churning telemetry on requests that never benefit.
 *
 * Match is prefix-based and case-insensitive — a versioned id
 * like "claude-sonnet-4-5-20251022" matches "claude-sonnet-4".
 */
const ANTHROPIC_CACHE_PREFIXES = [
  "claude-3-5-sonnet",
  "claude-3-7-sonnet",
  "claude-sonnet-4",
  "claude-3-opus",
  "claude-opus-4",
];

export function isAnthropicCacheSupported(model: string | undefined): boolean {
  if (!model || typeof model !== "string") return false;
  const lower = model.toLowerCase();
  for (const prefix of ANTHROPIC_CACHE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Config gate
// ---------------------------------------------------------------------------

export function isPromptCacheEnabled(layer: ReasoningLayer): boolean {
  const cfg = (layer.config as { promptCache?: PromptCacheConfig }).promptCache;
  if (!cfg) return true;
  return cfg.enabled !== false;
}

// ---------------------------------------------------------------------------
// Anthropic attachment
// ---------------------------------------------------------------------------

/**
 * Anthropic system block shape — string OR array of `{ type, text }`.
 * `cache_control` is a metadata-only attribute the API understands;
 * adding it changes nothing about the content.
 */
interface AnthropicSystemBlock {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicMessageParams {
  model?: string;
  system?: string | AnthropicSystemBlock[];
}

/**
 * Attach `cache_control: { type: "ephemeral" }` to the last system
 * content block. Idempotent — if the last block already has a
 * cache_control, returns the params unchanged. Never mutates the
 * caller's object: produces a shallow clone with a new system
 * array when needed.
 *
 * Caching contract: marking the last block caches everything BEFORE
 * AND INCLUDING it. The TraceBase injection lands at the END of the
 * system array (`injectIntoAnthropicSystem`), so caching the last
 * block caches the entire system prefix, which is exactly the
 * stable bit we want re-used across calls in the same session.
 */
export function attachAnthropicCacheControl<T extends AnthropicMessageParams>(
  params: T,
): T {
  const system = params.system;
  if (system === undefined || system === null) return params;

  // String form → convert to single-block array with cache_control.
  if (typeof system === "string") {
    if (system.length === 0) return params;
    const block: AnthropicSystemBlock = {
      type: "text",
      text: system,
      cache_control: { type: "ephemeral" },
    };
    return { ...params, system: [block] };
  }

  // Array form → tag the last block (idempotent).
  if (!Array.isArray(system) || system.length === 0) return params;
  const last = system[system.length - 1]!;
  if (last.cache_control) return params;
  const newSystem = system.slice(0, -1);
  newSystem.push({ ...last, cache_control: { type: "ephemeral" } });
  return { ...params, system: newSystem };
}

// ---------------------------------------------------------------------------
// Usage extraction (provider-reported only)
// ---------------------------------------------------------------------------

/**
 * Read `cache_read_input_tokens` off an Anthropic response usage
 * object. Anthropic also reports `cache_creation_input_tokens` for
 * the call that builds the cache — those are NOT savings (they cost
 * 1.25× input tokens), so we count only the read side.
 */
export function extractAnthropicCachedTokens(
  usage: { cache_read_input_tokens?: number } | undefined | null,
): number {
  if (!usage || typeof usage !== "object") return 0;
  const v = usage.cache_read_input_tokens;
  return typeof v === "number" && v > 0 ? v : 0;
}

/**
 * Read `prompt_tokens_details.cached_tokens` off an OpenAI response
 * usage object. Newer SDK shapes carry this nested under
 * `prompt_tokens_details`; older SDKs may surface it as a top-level
 * `cached_tokens` field — we accept both for forward/backward
 * compatibility, but the canonical shape is the nested one.
 */
export function extractOpenAICachedTokens(
  usage:
    | {
        cached_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined
    | null,
): number {
  if (!usage || typeof usage !== "object") return 0;
  const nested = usage.prompt_tokens_details?.cached_tokens;
  if (typeof nested === "number" && nested > 0) return nested;
  const flat = usage.cached_tokens;
  return typeof flat === "number" && flat > 0 ? flat : 0;
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

/**
 * Append a `cache.prompt_hit` event to the project's BlockStore.
 *
 * Fire-and-forget: any failure swallowed (analytics emission must
 * never break a wrapped LLM call). Opens its own SQLite handle to
 * avoid coupling the wrappers to a runtime instance — middleware
 * call sites don't always have a runtime, but they always know
 * the storage path via `layer.config.storagePath`.
 *
 * `tokensSaved <= 0` → no-op. The aggregator already
 * floor-clamps, but suppressing zero-events keeps the events
 * table tidy for the dashboard.
 */
export function appendPromptCacheHit(
  layer: ReasoningLayer,
  surface: PromptCacheSurface,
  tokensSaved: number,
  queryId?: string,
): void {
  if (!isPromptCacheEnabled(layer)) return;
  if (typeof tokensSaved !== "number" || tokensSaved <= 0) return;

  let db: Database.Database | null = null;
  let store: BlockStore | null = null;
  try {
    db = new Database(layer.config.storagePath);
    // Run migrations on first emit — the database may have been
    // created by `new ReasoningLayer()` (TraceStore-managed schema
    // only) and not yet seen any BlockStore call. Migrations are
    // idempotent + no-op when current, so amortised cost is near
    // zero on subsequent emits.
    store = new BlockStore(db);
    store.appendEvent({
      ts: Date.now(),
      queryId: queryId ?? `prompt-cache-${surface}-${Date.now()}`,
      event: "cache.prompt_hit",
      surface,
      tokensSaved,
    });
  } catch {
    // best-effort
  } finally {
    try {
      store?.close();
    } catch {
      // best-effort
    }
    try {
      db?.close();
    } catch {
      // best-effort
    }
  }
}
