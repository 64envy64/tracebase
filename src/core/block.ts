/**
 * ReasoningBlock primitives (v2 schema).
 *
 * Small, deterministic, testable helpers for constructing and hashing
 * blocks. No storage, no recall, no LLM calls here — those live in
 * other modules. Keep this file dependency-free so unit tests run fast.
 *
 * See docs/DESIGN_v2.md Pillar 1 for the semantics behind each field.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  ReasoningBlock,
  BlockInvariants,
  BlockTrigger,
  StoreBlockInput,
} from "../types.js";
import { detectLeakageExtended } from "./guard.js";

/** Current schema version of ReasoningBlock. Bump on breaking changes. */
export const BLOCK_SCHEMA_VERSION = 1;

/**
 * Prior confidence for a new, un-calibrated block.
 * 0.5 encodes "no evidence either way". The isotonic calibrator in
 * Pillar 3 overwrites this once ≥ 200 feedback events exist.
 */
export const DEFAULT_BLOCK_CONFIDENCE = 0.5;

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * Stop-word list for keyword extraction from situation/invariants.
 * Deliberately small: stop-word removal is cheap precision; aggressive
 * removal hurts recall on rare technical terms.
 */
const STOP = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "not", "if", "then", "else", "when", "while",
  "of", "in", "on", "at", "by", "for", "with", "to", "from", "as",
  "this", "that", "these", "those", "it", "its", "they", "them",
  "what", "which", "who", "how", "why", "where",
  "i", "we", "you", "he", "she",
]);

/**
 * Extract keywords for BM25 from a free-text situation + structured invariants.
 *
 * Determinism: output is sorted and de-duplicated. Same input always
 * produces same output; safe to use as part of a fingerprint.
 */
export function extractKeywords(situation: string, invariants: BlockInvariants): string[] {
  const tokens = new Set<string>();

  // Free-text tokens from situation.
  for (const raw of situation.toLowerCase().split(/[^a-z0-9_.]+/)) {
    if (!raw) continue;
    if (raw.length < 2) continue;
    if (STOP.has(raw)) continue;
    tokens.add(raw);
  }

  // Structured invariant tokens — always preserved even if in stop list,
  // because they are high-signal.
  if (invariants.language) tokens.add(`lang:${invariants.language.toLowerCase()}`);
  if (invariants.framework) tokens.add(`fw:${invariants.framework.toLowerCase()}`);
  if (invariants.errorType) tokens.add(`err:${invariants.errorType.toLowerCase()}`);
  for (const api of invariants.apiSurface ?? []) {
    tokens.add(`api:${api.toLowerCase()}`);
  }

  return [...tokens].sort();
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Canonical string for a trigger: stable across whitespace, case,
 * and keyword ordering. The SHA-256 of this is the dedupe key.
 *
 * Policy: fingerprint covers invariants + keywords but NOT body.
 * Two blocks with identical triggers but different bodies are *still*
 * duplicates by this definition — they should be merged (or the
 * distiller should have produced the same body).
 */
export function canonicalTrigger(invariants: BlockInvariants, keywords: string[]): string {
  const parts: string[] = [];
  // Invariants in fixed order for stability.
  parts.push(`lang=${(invariants.language ?? "").toLowerCase()}`);
  parts.push(`fw=${(invariants.framework ?? "").toLowerCase()}`);
  parts.push(`err=${(invariants.errorType ?? "").toLowerCase()}`);
  const apis = [...(invariants.apiSurface ?? [])].map((a) => a.toLowerCase()).sort();
  parts.push(`api=${apis.join(",")}`);
  const kws = [...keywords].map((k) => k.toLowerCase()).sort();
  parts.push(`kw=${kws.join(",")}`);
  return parts.join("|");
}

export function fingerprintTrigger(invariants: BlockInvariants, keywords: string[]): string {
  const canonical = canonicalTrigger(invariants, keywords);
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Block construction
// ---------------------------------------------------------------------------

/**
 * Build a complete ReasoningBlock from a StoreBlockInput.
 * Fills in computed fields (keywords, fingerprint, stats priors, quality,
 * timestamps, id). Does NOT write to storage — that's the caller's job.
 *
 * Why separate from storage: makes this function pure and testable, and
 * lets the distillation pipeline assemble blocks in-memory and validate
 * them before deciding whether to commit.
 */
export function createBlock(input: StoreBlockInput, opts?: { now?: number; id?: string }): ReasoningBlock {
  const now = opts?.now ?? Date.now();

  const keywords = extractKeywords(input.trigger.situation, input.trigger.invariants);
  const fingerprint = fingerprintTrigger(input.trigger.invariants, keywords);

  const trigger: BlockTrigger = {
    situation: input.trigger.situation,
    invariants: { ...input.trigger.invariants },
    keywords,
    fingerprint,
  };

  // Default kind to "success" so pre-failure-lane call sites that still
  // pass StoreBlockInput without `kind` produce success blocks byte-
  // identically to before this change.
  const kind = input.kind ?? "success";

  return {
    id: opts?.id ?? randomUUID(),
    version: BLOCK_SCHEMA_VERSION,
    kind,
    trigger,
    body: {
      mechanism: input.body.mechanism,
      deadEnds: [...input.body.deadEnds],
      unlock: input.body.unlock,
      verification: input.body.verification,
      ...(input.body.guardrails !== undefined
        ? { guardrails: [...input.body.guardrails] }
        : {}),
    },
    provenance: {
      ...input.provenance,
      distilledAt: now,
    },
    stats: {
      timesRetrieved: 0,
      timesInjected: 0,
      timesAgentUsed: 0,
      timesHelpful: 0,
      timesCounterproductive: 0,
      cumulativeTokensSaved: 0,
      cumulativeStepsSaved: 0,
    },
    quality: {
      confidence: DEFAULT_BLOCK_CONFIDENCE,
      wilsonLowerBound: 0,
    },
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
}

// ---------------------------------------------------------------------------
// Leakage guards (Pillar 2: distillation anti-leakage checks)
// ---------------------------------------------------------------------------

/**
 * Regex patterns that should NEVER appear in a distilled block body.
 * These are the *legacy* gold-truth / distillation-specific patterns
 * kept in the Pillar 2 anti-leakage net. General host-level shapes
 * (absolute paths, API keys, .env lines) live in
 * `src/core/guard.ts#LEAKAGE_PATTERNS_EXTENDED` so the hook-side
 * extractors (capture-turn fact extraction, future capture-context
 * digest) can reuse them without dragging the full ReasoningBlock
 * shape along.
 */
const LEAKAGE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "diff-header", re: /^---\s|^\+\+\+\s/m },
  { name: "patch-hunk", re: /^@@\s/m },
  // Pytest / unittest identifiers (strong signal of gold test leak).
  { name: "pytest-id", re: /::test_[a-z_0-9]+/i },
  // File paths that look like absolute gold file references.
  { name: "abs-path", re: /\/testbed\/[a-z0-9_\/.-]+\.(py|ts|js|rs|go|java)/i },
];

/**
 * Check whether a candidate block leaks gold-truth or secret-shaped
 * material. Returns the first leaked pattern name if leakage is
 * detected, otherwise null.
 *
 * Runs the legacy gold-truth pattern set AND the extended host-level
 * pattern set (API keys, absolute paths outside `/testbed`, `.env`-
 * line shapes). The distiller and every hook-side write path rejects
 * any block for which this is non-null.
 */
export function detectLeakage(block: Pick<ReasoningBlock, "trigger" | "body">): string | null {
  const corpus = [
    block.trigger.situation,
    block.body.mechanism,
    block.body.unlock,
    block.body.verification,
    ...block.body.deadEnds,
    ...(block.body.guardrails ?? []),
  ].join("\n");

  for (const { name, re } of LEAKAGE_PATTERNS) {
    if (re.test(corpus)) return name;
  }
  // Layered: if gold-truth check passes, run the general host shapes.
  return detectLeakageExtended(corpus);
}

// ---------------------------------------------------------------------------
// Stats updaters (pure — do not mutate, return new object)
// ---------------------------------------------------------------------------

/**
 * Increment a named counter on a block's stats. Pure — returns a new
 * block; caller is responsible for persisting it. Used by the analytics
 * pipeline (Pillar 4) when consuming events.
 */
export function bumpStat(
  block: ReasoningBlock,
  field: keyof ReasoningBlock["stats"],
  delta: number = 1,
  now: number = Date.now(),
): ReasoningBlock {
  const current = block.stats[field];
  if (typeof current !== "number") return block;
  return {
    ...block,
    stats: {
      ...block.stats,
      [field]: current + delta,
      ...(field === "timesInjected" || field === "timesHelpful"
        ? { lastUsedAt: now }
        : {}),
    },
    updatedAt: now,
  };
}

/**
 * Wilson score interval lower bound for a Bernoulli proportion.
 * Ref: Wilson (1927). Used to rank blocks while accounting for sample size.
 *
 * n = trials, k = successes, z = z-score (1.96 for 95% CI).
 * Returns 0 for n == 0 (no evidence).
 */
export function wilsonLowerBound(successes: number, trials: number, z: number = 1.96): number {
  if (trials === 0) return 0;
  const phat = successes / trials;
  const z2 = z * z;
  const numerator = phat + z2 / (2 * trials) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * trials)) / trials);
  const denom = 1 + z2 / trials;
  return Math.max(0, numerator / denom);
}

/**
 * Re-compute `quality.wilsonLowerBound` from stats. Called after each
 * stats update. Does NOT touch `quality.confidence` — that is owned by
 * the calibrator (Pillar 3).
 */
export function refreshWilson(block: ReasoningBlock): ReasoningBlock {
  const trials = block.stats.timesInjected;
  const successes = block.stats.timesHelpful;
  const lb = wilsonLowerBound(successes, trials);
  if (lb === block.quality.wilsonLowerBound) return block;
  return {
    ...block,
    quality: { ...block.quality, wilsonLowerBound: lb },
  };
}
