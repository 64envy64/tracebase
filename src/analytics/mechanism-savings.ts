/**
 * Estimated mechanism savings aggregator (PLAN-0.7 §rc.7).
 *
 * Pure window-aggregator over `analytics_events`. Computes the
 * four mechanism components the spec names — context compression,
 * file memory avoided, tool supervision avoided, prompt cache —
 * each from its own dedicated event kind. Returns honest per-
 * component values + a single total.
 *
 * Strict vocabulary contract (§rc.7):
 *   - These are ESTIMATED MECHANISM SAVINGS — deterministic, no
 *     causal claim. They never sum into a "verified savings"
 *     number. The dashboard + `tracebase impact` render them
 *     under their own labels, never conflated with the holdout-
 *     based causal block.
 *   - `prompt_cache_saved` is provider-reported. The aggregator
 *     never estimates cache savings from model name or message
 *     length — only counts what `cache.prompt_hit` events
 *     actually carry, which is what the provider's API reported.
 *
 * Privacy invariants:
 *   - Reads only the documented fields per event kind. Never
 *     touches retrieval/injection/outcome event bodies.
 *   - Output is primitive numbers + a closed-shape per-component
 *     map. The cloud allowlist drops every other field by spec
 *     (USAGE_MECHANISMS_SPEC in src/cli/cloud-allowlist.ts).
 */
import type { BlockStore } from "../core/block-store.js";
import { toolFamilyOf, type ToolFamily } from "../runtime/tool-family.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MechanismSavingsWindow {
  afterTs?: number;
  beforeTs?: number;
}

export interface MechanismSavings {
  /** Σ (tokens_before - tokens_after) over `context.folded` events. */
  contextCompressionSaved: number;
  /**
   * Σ (size_bytes/4 - tokensInjected) over `file_memory.recalled`
   * events. Negative-clamped at 0 — a chunk whose injection
   * happened to cost more than the file's full content (rare,
   * but possible on tiny files that get a wordy summary) does
   * NOT get reported as negative savings; it's clamped to 0.
   */
  fileMemoryAvoided: number;
  /**
   * Σ (per-family token estimate × suppressed_count) over
   * `tool_supervision.suppressed` events, using a fixed lookup
   * table keyed by tool family. The per-family estimates are
   * deterministic constants the dashboard renders verbatim in a
   * tooltip so the user understands what the number represents.
   */
  toolSupervisionAvoided: number;
  /**
   * Σ tokensSaved over `cache.prompt_hit` events. Provider-
   * reported. Equals 0 when no cache.prompt_hit events landed
   * in the window — and that's the honest answer; we never
   * estimate cache savings from message length or model name.
   */
  promptCacheSaved: number;
  /**
   * Sum of the four components. The CLI / dashboard renders this
   * under "Total estimated mechanism saved" and NEVER conflates
   * it with verified causal savings.
   */
  total: number;
}

// ---------------------------------------------------------------------------
// Tunables — per-family token-cost estimates for tool supervision.
// ---------------------------------------------------------------------------

/**
 * Per-family token-cost estimates used by `toolSupervisionAvoided`.
 * Each ACTUALLY-BLOCKED duplicate tool call saves roughly this many
 * tokens because the agent didn't have to consume the duplicate
 * tool's output. The values are intentionally conservative: a
 * typical Read returns 1-3k tokens of file content; we estimate
 * 1500 to land mid-distribution.
 *
 * Keyed by the canonical eight-family `ToolFamily` union from
 * `src/runtime/tool-family.ts` — same vocabulary the cloud
 * allowlist permits. Adding a new family there is a TypeScript
 * compile error here until an explicit per-family estimate is
 * declared. (Pre-rc.7-hardening this map was a free-form
 * `Record<string, number>` mirror that drifted to `fetch` while
 * the canonical was `web`; keying off `ToolFamily` prevents that
 * drift class.)
 *
 * Exposed for the dashboard's tooltip. Keep this map in sync with
 * the rendered help text in `tracebase impact` and any docs.
 */
export const TOOL_FAMILY_TOKEN_ESTIMATE: Record<ToolFamily, number> = {
  read: 1500,
  search: 800,
  web: 2000,
  shell: 300,
  edit: 500,
  write: 400,
  task: 200,
  other: 100,
};

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function computeMechanismSavings(
  store: BlockStore,
  window: MechanismSavingsWindow = {},
): MechanismSavings {
  let contextCompressionSaved = 0;
  let fileMemoryAvoided = 0;
  let toolSupervisionAvoided = 0;
  let promptCacheSaved = 0;

  // ---- context.folded ----
  try {
    const events = store.readEvents({
      eventType: "context.folded",
      ...(window.afterTs !== undefined ? { afterTs: window.afterTs } : {}),
      ...(window.beforeTs !== undefined ? { beforeTs: window.beforeTs } : {}),
      limit: 10_000,
    });
    for (const ev of events) {
      if (ev.event !== "context.folded") continue;
      const before = typeof ev.tokensBefore === "number" ? ev.tokensBefore : 0;
      const after = typeof ev.tokensAfter === "number" ? ev.tokensAfter : 0;
      const delta = before - after;
      if (delta > 0) contextCompressionSaved += delta;
    }
  } catch {
    // best-effort
  }

  // ---- file_memory.recalled ----
  // The event carries (fileIds, tokensInjected, bytesAvoided).
  // bytesAvoided is sum of size_bytes for every file the recall
  // surfaced; we approximate the full-file token cost as
  // bytesAvoided/4 (same char/4 heuristic everywhere).
  try {
    const events = store.readEvents({
      eventType: "file_memory.recalled",
      ...(window.afterTs !== undefined ? { afterTs: window.afterTs } : {}),
      ...(window.beforeTs !== undefined ? { beforeTs: window.beforeTs } : {}),
      limit: 10_000,
    });
    for (const ev of events) {
      if (ev.event !== "file_memory.recalled") continue;
      const bytesAvoided =
        typeof ev.bytesAvoided === "number" ? ev.bytesAvoided : 0;
      const tokensInjected =
        typeof ev.tokensInjected === "number" ? ev.tokensInjected : 0;
      const fullFileTokens = Math.ceil(bytesAvoided / 4);
      const delta = fullFileTokens - tokensInjected;
      if (delta > 0) fileMemoryAvoided += delta;
    }
  } catch {
    // best-effort
  }

  // ---- tool_supervision.* (block-mode only) ----
  //
  // 0.7.0-rc.7 hardening — count ONLY actual blocks, never the
  // dedupe of warn-mode badges. The supervisor's two events:
  //   - `tool_supervision.warned { mode: "warn" | "block" }`:
  //     Counts only when `mode === "block"`. In warn mode the
  //     duplicate Read still runs, so credit-as-saved would
  //     overstate token savings for zero-config users.
  //   - `tool_supervision.suppressed { blocked: boolean }`:
  //     Counts only when `blocked === true`. The suppressed
  //     event by itself just says "we already showed the badge
  //     for this arg-key" — without the blocked decision the
  //     tool ran. Pre-hardening events without a `blocked`
  //     field are read as `undefined` → not counted.
  //
  // Each counted event weights its per-family token-cost
  // estimate. Family resolution shares `toolFamilyOf` with the
  // rest of the codebase, so the eight-family vocabulary lives
  // in exactly one place and adding a new family is a
  // TypeScript compile error in `TOOL_FAMILY_TOKEN_ESTIMATE`.
  try {
    const warned = store.readEvents({
      eventType: "tool_supervision.warned",
      ...(window.afterTs !== undefined ? { afterTs: window.afterTs } : {}),
      ...(window.beforeTs !== undefined ? { beforeTs: window.beforeTs } : {}),
      limit: 10_000,
    });
    for (const ev of warned) {
      if (ev.event !== "tool_supervision.warned") continue;
      if (ev.mode !== "block") continue; // warn-mode = duplicate still ran
      const family = toolFamilyOf(ev.toolName);
      toolSupervisionAvoided += TOOL_FAMILY_TOKEN_ESTIMATE[family];
    }
  } catch {
    // best-effort
  }
  try {
    const suppressed = store.readEvents({
      eventType: "tool_supervision.suppressed",
      ...(window.afterTs !== undefined ? { afterTs: window.afterTs } : {}),
      ...(window.beforeTs !== undefined ? { beforeTs: window.beforeTs } : {}),
      limit: 10_000,
    });
    for (const ev of suppressed) {
      if (ev.event !== "tool_supervision.suppressed") continue;
      if (ev.blocked !== true) continue; // warn-mode dedupe = no avoided work
      const family = toolFamilyOf(ev.toolName);
      toolSupervisionAvoided += TOOL_FAMILY_TOKEN_ESTIMATE[family];
    }
  } catch {
    // best-effort
  }

  // ---- cache.prompt_hit ----
  try {
    const events = store.readEvents({
      eventType: "cache.prompt_hit",
      ...(window.afterTs !== undefined ? { afterTs: window.afterTs } : {}),
      ...(window.beforeTs !== undefined ? { beforeTs: window.beforeTs } : {}),
      limit: 10_000,
    });
    for (const ev of events) {
      if (ev.event !== "cache.prompt_hit") continue;
      const tokens =
        typeof ev.tokensSaved === "number" ? ev.tokensSaved : 0;
      if (tokens > 0) promptCacheSaved += tokens;
    }
  } catch {
    // best-effort
  }

  const total =
    contextCompressionSaved +
    fileMemoryAvoided +
    toolSupervisionAvoided +
    promptCacheSaved;

  return {
    contextCompressionSaved,
    fileMemoryAvoided,
    toolSupervisionAvoided,
    promptCacheSaved,
    total,
  };
}
