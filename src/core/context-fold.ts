/**
 * `foldTurns` — chunk-based context compression core
 * (PLAN-0.7 §rc.6).
 *
 * Pure function: given a list of session turns + an existing
 * watermark + a sessionId, produces a list of new chunks ready
 * for `BlockStore.recordSessionChunks` to persist. Walks turns
 * past the watermark; emits a chunk whenever the rolling buffer
 * hits 8 turns OR ≥ 4k character-derived "tokens" — whichever
 * comes first. Re-folding the same content with the same watermark
 * is a no-op (same `turn_hash`, same chunk).
 *
 * Privacy invariants:
 *   - The summary is bounded at SUMMARY_MAX_CHARS (1200) and
 *     produced by a heuristic that selects header / first non-
 *     empty user prompt / last assistant snippet — never the raw
 *     window concatenated.
 *   - Every produced summary is scanned by `detectLeakageExtended`
 *     and `detectPromptInjectionPatterns`. On match the chunk is
 *     SKIPPED (returned in the `skipped` list with a typed
 *     reason); the row never lands in `session_chunks`.
 *   - `tokens_before` / `tokens_after` are honest character/4
 *     estimates — same heuristic the rest of TraceBase uses.
 *     Cloud allowlist drops every column from session_chunks; only
 *     aggregate counts ship.
 */
import { createHash } from "node:crypto";
import { detectLeakageExtended, detectPromptInjectionPatterns } from "./guard.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FoldSummarizer = "heuristic" | "embedding" | "llm";

export interface FoldTurn {
  role: "user" | "assistant";
  content: string;
}

export interface FoldTurnsInput {
  sessionId: string;
  turns: ReadonlyArray<FoldTurn>;
  /**
   * Highest `chunk_end_turn` already persisted for this session,
   * or -1 when the session has no chunks yet. Walking starts at
   * `existingWatermark + 1`.
   */
  existingWatermark: number;
  /** Default: "heuristic". Reserved hooks for embedding / llm in later rcs. */
  summarizer?: FoldSummarizer;
  /** Wall-clock ms; defaults to Date.now. Test override. */
  now?: () => number;
  /** TTL for `expires_at`. Default 14 days per spec. */
  ttlMs?: number;
}

export interface FoldedChunk {
  sessionId: string;
  chunkStartTurn: number;
  chunkEndTurn: number;
  turnHash: string;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  summarizer: FoldSummarizer;
  expiresAt: number;
}

export interface SkippedChunk {
  sessionId: string;
  chunkStartTurn: number;
  chunkEndTurn: number;
  reason: "leakage" | "injection" | "below-threshold";
}

export interface FoldTurnsResult {
  chunks: FoldedChunk[];
  skipped: SkippedChunk[];
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard char cap on `summary`. Same value the schema column carries. */
export const SUMMARY_MAX_CHARS = 1200;
/** Rolling window: emit a chunk every N turns or T tokens, whichever first. */
export const CHUNK_TURN_LIMIT = 8;
export const CHUNK_TOKEN_LIMIT = 4_000;
/** char/4 token estimate, the same heuristic used elsewhere. */
const CHARS_PER_TOKEN = 4;
/** Default TTL — spec says ~14 days. */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Below this many character-derived tokens, the chunk isn't worth
 * folding — recall would be noisier than skipping. The detector
 * still emits a `below-threshold` skip event so the doctor can
 * surface short-session activity.
 */
const MIN_CHUNK_TOKENS = 50;

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function foldTurns(input: FoldTurnsInput): FoldTurnsResult {
  const summarizer: FoldSummarizer = input.summarizer ?? "heuristic";
  const now = (input.now ?? Date.now)();
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;

  const turns = input.turns ?? [];
  const watermark = Math.max(-1, input.existingWatermark);

  const chunks: FoldedChunk[] = [];
  const skipped: SkippedChunk[] = [];

  // Buffer grows turn-by-turn until a boundary fires; flushes a chunk
  // and resets. After the loop, the residual buffer is flushed iff
  // it carries enough tokens (MIN_CHUNK_TOKENS) — small tails get
  // dropped via `below-threshold`.
  let bufferStart = watermark + 1;
  let bufferTurns: FoldTurn[] = [];
  let bufferTokens = 0;

  const flush = (endTurn: number, residual: boolean) => {
    if (bufferTurns.length === 0) return;
    if (residual && bufferTokens < MIN_CHUNK_TOKENS) {
      skipped.push({
        sessionId: input.sessionId,
        chunkStartTurn: bufferStart,
        chunkEndTurn: endTurn,
        reason: "below-threshold",
      });
      bufferStart = endTurn + 1;
      bufferTurns = [];
      bufferTokens = 0;
      return;
    }
    const summary = composeSummary(bufferTurns);
    const corpus = summary;
    const leak = detectLeakageExtended(corpus);
    if (leak) {
      skipped.push({
        sessionId: input.sessionId,
        chunkStartTurn: bufferStart,
        chunkEndTurn: endTurn,
        reason: "leakage",
      });
    } else if (detectPromptInjectionPatterns(corpus)) {
      skipped.push({
        sessionId: input.sessionId,
        chunkStartTurn: bufferStart,
        chunkEndTurn: endTurn,
        reason: "injection",
      });
    } else {
      const turnHash = hashTurns(bufferTurns);
      chunks.push({
        sessionId: input.sessionId,
        chunkStartTurn: bufferStart,
        chunkEndTurn: endTurn,
        turnHash,
        summary,
        tokensBefore: bufferTokens,
        tokensAfter: estimateTokens(summary),
        summarizer,
        expiresAt: now + ttl,
      });
    }
    bufferStart = endTurn + 1;
    bufferTurns = [];
    bufferTokens = 0;
  };

  for (let i = 0; i < turns.length; i++) {
    const turnIdx = i;
    if (turnIdx <= watermark) continue;
    const turn = turns[i]!;
    const turnTokens = estimateTokens(turn.content ?? "");
    bufferTurns.push(turn);
    bufferTokens += turnTokens;
    const reachedTurnLimit = bufferTurns.length >= CHUNK_TURN_LIMIT;
    const reachedTokenLimit = bufferTokens >= CHUNK_TOKEN_LIMIT;
    if (reachedTurnLimit || reachedTokenLimit) {
      flush(turnIdx, false);
    }
  }
  // Residual flush — last partial chunk gets folded only if it's
  // worth the budget.
  flush(turns.length - 1, true);

  return { chunks, skipped };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Heuristic summary: picks the first non-empty user turn (the
 * latest user "ask" for the chunk window) and the last assistant
 * turn (the latest "answer"), bounded at SUMMARY_MAX_CHARS. The
 * separator stays a single newline so the leakage / injection
 * scanners see a single concatenated corpus.
 */
function composeSummary(turns: FoldTurn[]): string {
  const firstUser = turns.find((t) => t.role === "user" && t.content?.trim().length > 0);
  const lastAssistant = [...turns]
    .reverse()
    .find((t) => t.role === "assistant" && t.content?.trim().length > 0);
  const parts: string[] = [];
  if (firstUser) parts.push(`User asked: ${firstUser.content.trim()}`);
  if (lastAssistant) parts.push(`Assistant: ${lastAssistant.content.trim()}`);
  if (parts.length === 0) {
    // Fallback: bound the first turn's content to the cap.
    const first = turns[0];
    if (first) parts.push(first.content?.trim() ?? "");
  }
  return clamp(parts.join("\n"), SUMMARY_MAX_CHARS);
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > max - 80) return slice.slice(0, lastSpace) + "…";
  return slice + "…";
}

function estimateTokens(s: string): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function hashTurns(turns: FoldTurn[]): string {
  const canon = turns.map((t) => `${t.role}:${t.content ?? ""}`).join("\n");
  return createHash("sha256").update(canon).digest("hex");
}
