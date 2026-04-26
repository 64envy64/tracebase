/**
 * `resolveLoopRedirect` — semantic loop redirect resolver
 * (PLAN-0.7 §rc.5).
 *
 * Runs AFTER `detectToolPattern` returns a non-`none` signal.
 * Queries existing recall surfaces for an anchor the agent can
 * jump to instead of repeating the loop:
 *
 *   1. `BlockServer.recall` against the joined window argSummaries
 *      → block hit ranked by `calibratedProb`. Threshold 0.72.
 *   2. `recallFiles` against the same query → file hit.
 *
 * Picks the best anchor across the two pools. Block ≥ 0.72 wins
 * outright; otherwise the top file hit (any non-empty result)
 * surfaces. Both empty → static fallback.
 *
 * Privacy invariants:
 *   - Reads ONLY argSummary (already sanitised at PostToolBatch).
 *     Never raw `tool_input`.
 *   - Anchor hint is the first sentence of `block.body.unlock` for
 *     blocks, the rel_path for files. Both already passed the
 *     leakage + injection scanners at write time.
 *   - The composed redirect text passes a second leakage +
 *     prompt-injection scan; rejection collapses to static
 *     fallback (the resolver never emits a string that fails
 *     either scanner).
 *   - Anti-self-loop: same anchor for same arg_key in same session
 *     fires once via `loop_redirect_dedupe`.
 */
import type { BlockServer, BlockRecallQuery, RecallV2Result } from "./block-serving.js";
import type { BlockStore } from "./block-store.js";
import type { ToolPatternSignal } from "./tool-loop-detect.js";
import type { ToolObservation } from "../types.js";
import { detectLeakageExtended, detectPromptInjectionPatterns } from "./guard.js";
import { recallFiles, type FileHit } from "./file-indexer.js";
import { intentKeyTokens } from "./intent-key.js";

export interface ResolveLoopRedirectOptions {
  store: BlockStore;
  server: BlockServer;
  signal: ToolPatternSignal;
  observations: ToolObservation[];
  sessionId: string;
  basePath: string;
  confidenceThreshold?: number;
  now?: () => number;
}

export type LoopRedirectKind = "matched" | "fallback";

export interface LoopRedirectResult {
  kind: LoopRedirectKind;
  label: string;
  anchorId?: string;
  anchorKind?: "block" | "file";
  confidence?: number;
  fallbackReason?: "no-hit" | "low-confidence" | "anti-self-loop";
}

export const REDIRECT_LABEL_MAX_CHARS = 100;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.72;

/**
 * Fixed phrase set the resolver may add to the redirect label.
 * The content-derivation audit asserts the redirect contains
 * nothing outside (argSummary tokens ∪ anchor tokens ∪ this set).
 */
export const REDIRECT_FIXED_PHRASES = new Set<string>([
  "▣",
  "tb",
  "loop",
  "matched",
  "repeated",
  "widen",
  "scope",
  "·",
  "#",
  "duplicate",
  "straight",
  "pingpong",
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "with",
]);

export function resolveLoopRedirect(
  opts: ResolveLoopRedirectOptions,
): LoopRedirectResult {
  const threshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const queryText = opts.observations
    .map((o) => o.argSummary ?? "")
    .filter((s) => s.length > 0)
    .join(" ");

  const lastObs = opts.observations[opts.observations.length - 1];
  const argKey = lastObs?.argKey ?? "";
  if (!argKey) return staticFallback(opts.signal, "no-hit");

  // Block / fact recall
  let blockAnchor: { id: string; hint: string; confidence: number } | null = null;
  let blockResult: RecallV2Result | null = null;
  try {
    const recallQuery: BlockRecallQuery = {
      text: queryText,
      invariants: {},
      shadow: true,
    };
    blockResult = opts.server.recall(recallQuery);
    const ranked = [...blockResult.blocks].sort(
      (a, b) => b.calibratedProb - a.calibratedProb,
    );
    const top = ranked[0];
    if (top && top.calibratedProb >= threshold) {
      const hint = blockHint(top.block.body.unlock);
      if (hint.length > 0) {
        blockAnchor = {
          id: top.block.id,
          hint,
          confidence: top.calibratedProb,
        };
      }
    }
  } catch {
    // best-effort
  }

  // File recall
  let fileAnchor: { id: string; hint: string; confidence: number } | null = null;
  try {
    const hits: FileHit[] = recallFiles(opts.store, { prompt: queryText, k: 1 });
    const top = hits[0];
    if (top) {
      fileAnchor = {
        id: top.relPath,
        hint: top.relPath,
        confidence: 0.5,
      };
    }
  } catch {
    // best-effort
  }

  const anchor =
    blockAnchor !== null
      ? { ...blockAnchor, kind: "block" as const }
      : fileAnchor !== null
        ? { ...fileAnchor, kind: "file" as const }
        : null;

  if (!anchor) {
    const reason: "no-hit" | "low-confidence" =
      blockResult !== null && blockResult.blocks.length > 0
        ? "low-confidence"
        : "no-hit";
    return staticFallback(opts.signal, reason);
  }

  if (isAlreadyShown(opts.store, opts.sessionId, anchor.id, argKey)) {
    return staticFallback(opts.signal, "anti-self-loop");
  }

  const label = composeMatchedLabel(anchor.id, anchor.hint);
  if (!isLabelClean(label)) {
    return staticFallback(opts.signal, "no-hit");
  }
  if (!isLabelDerivable(label, queryText, anchor.hint)) {
    return staticFallback(opts.signal, "no-hit");
  }

  recordDedupe(opts.store, opts.sessionId, anchor.id, argKey, opts.now ?? Date.now);

  return {
    kind: "matched",
    label,
    anchorId: anchor.id,
    anchorKind: anchor.kind,
    confidence: anchor.confidence,
  };
}

function blockHint(unlock: string): string {
  if (typeof unlock !== "string" || unlock.length === 0) return "";
  const first = unlock.split(/[.!?\n]/)[0]?.trim() ?? "";
  return first;
}

function composeMatchedLabel(anchorId: string, hint: string): string {
  const idShort = shortId(anchorId);
  const prefix = `▣ TB LOOP  matched #${idShort} · `;
  const room = REDIRECT_LABEL_MAX_CHARS - prefix.length;
  if (room <= 0) return prefix.slice(0, REDIRECT_LABEL_MAX_CHARS);
  const trimmedHint = hint.length <= room ? hint : hint.slice(0, room - 1) + "…";
  return prefix + trimmedHint;
}

function staticFallback(
  signal: ToolPatternSignal,
  reason: "no-hit" | "low-confidence" | "anti-self-loop",
): LoopRedirectResult {
  const label = `▣ TB LOOP  repeated ${signal.kind} · widen scope`;
  const clamped =
    label.length <= REDIRECT_LABEL_MAX_CHARS
      ? label
      : label.slice(0, REDIRECT_LABEL_MAX_CHARS);
  return { kind: "fallback", label: clamped, fallbackReason: reason };
}

function shortId(id: string): string {
  if (id.length <= 8) return id;
  if (id.includes("/")) {
    const parts = id.split("/");
    const tail = parts[parts.length - 1] ?? id;
    return tail.length <= 16 ? tail : tail.slice(0, 13) + "...";
  }
  return id.slice(0, 8);
}

function isLabelClean(label: string): boolean {
  if (detectLeakageExtended(label)) return false;
  if (detectPromptInjectionPatterns(label)) return false;
  return true;
}

function isLabelDerivable(label: string, argText: string, hintText: string): boolean {
  const allowed = new Set<string>(REDIRECT_FIXED_PHRASES);
  for (const t of intentKeyTokens(argText)) allowed.add(t);
  for (const t of intentKeyTokens(hintText)) allowed.add(t);

  // 0.7.0-rc.5 — same strip set as `intentKeyTokens` so the audit
  // tokenises the label exactly the way the inputs were tokenised.
  // Critical for `src/auth.ts` (slash) and `#a5a12778` (hash
  // prefix) — without these, the audit would mark them as
  // out-of-vocab and the label would be rejected.
  const tokens = label
    .toLowerCase()
    .replace(/[*?[\]()\\^$+|.{}/#'"`]/g, " ")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  for (const tok of tokens) {
    if (allowed.has(tok)) continue;
    if (/^[a-f0-9]{4,16}$/.test(tok)) continue;
    if (/^\d+$/.test(tok)) continue;
    if (/…/.test(tok)) continue;
    return false;
  }
  return true;
}

function isAlreadyShown(
  store: BlockStore,
  sessionId: string,
  anchorId: string,
  argKey: string,
): boolean {
  try {
    const row = store.rawDb
      .prepare(
        "SELECT 1 FROM loop_redirect_dedupe WHERE session_id = ? AND anchor_id = ? AND arg_key = ?",
      )
      .get(sessionId, anchorId, argKey);
    return row !== undefined;
  } catch {
    return false;
  }
}

function recordDedupe(
  store: BlockStore,
  sessionId: string,
  anchorId: string,
  argKey: string,
  now: () => number,
): void {
  try {
    store.rawDb
      .prepare(
        `INSERT OR IGNORE INTO loop_redirect_dedupe(session_id, anchor_id, arg_key, ts)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, anchorId, argKey, now());
  } catch {
    // best-effort
  }
}
