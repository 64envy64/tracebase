/**
 * Naive trajectory-cache baseline for the agentic counterfactual.
 *
 * The point of this module is to give the eval harness a retrieval
 * strategy that captures the absolute minimum a "memory layer" could
 * do: take the cached prior cases, score each by literal token overlap
 * against the new problem description, return the highest scorer.
 *
 * What it intentionally lacks (this is the comparison surface):
 *   - mechanism / fix / verify schema (everything is bag-of-words)
 *   - confidence gate (any non-zero overlap is injected)
 *   - outcome calibration (every cached case is treated equal)
 *   - language / framework / error-type context filtering
 *
 * Lift in the agentic harness above this baseline is the lift
 * attributable to TraceBase's retrieval / weighting / outcome feedback
 * — not to "we have memory at all".
 */

import type { DistillateSeed, FixtureMeta } from "./types.js";

export interface NaiveCorpusEntry {
  meta: FixtureMeta;
  seed: DistillateSeed;
}

export interface NaiveResult {
  meta: FixtureMeta;
  seed: DistillateSeed;
  /** Jaccard token overlap of (situation + unlock) against the query. 0..1. */
  score: number;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function candidateText(seed: DistillateSeed): string {
  const dead = Array.isArray(seed.deadEnds) ? seed.deadEnds.join(" ") : seed.deadEnds;
  return [seed.situation, seed.unlock, dead].join(" ");
}

/**
 * Naive retrieval. Returns the corpus entry with the highest Jaccard
 * overlap to the query, or null if no candidate has any token overlap.
 *
 * No threshold, no gate, no second-place tracking — a real naive cache
 * just hands back its best string match.
 */
export function naiveRecall(query: string, corpus: NaiveCorpusEntry[]): NaiveResult | null {
  if (corpus.length === 0) return null;
  const queryTokens = tokenize(query);
  let best: NaiveResult | null = null;
  for (const entry of corpus) {
    const score = jaccard(queryTokens, tokenize(candidateText(entry.seed)));
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { meta: entry.meta, seed: entry.seed, score };
    }
  }
  return best;
}

/**
 * Inject the naive match verbatim. No confidence framing, no skip-to-fix
 * directive — the cache is dumb on purpose and just hands the prior case
 * back in raw form for the agent to read.
 */
export function formatNaiveInjection(result: NaiveResult): string {
  return (
    `<prior_match score="${result.score.toFixed(2)}">\n` +
    `Situation: ${result.seed.situation}\n` +
    `Solution: ${result.seed.unlock}\n` +
    `</prior_match>`
  );
}
