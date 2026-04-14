import type { DistillateSeed } from "./types.js";

/**
 * Format D injection — 3-field distillate.
 *
 * Based on ReasonBlocks methodology:
 * - SITUATION: What the problem pattern looks like
 * - DEAD ENDS: Approaches that fail (steers model away from wasted tokens)
 * - UNLOCK: The key insight (minimal, actionable)
 *
 * Research basis:
 * - "Token-Budget-Aware LLM Reasoning" (arxiv 2412.18547) — TALE framework
 * - "Optimizing Token Consumption in LLM Code Reasoning" (arxiv 2504.15989)
 * - Dead-end avoidance prevents token waste on failed approaches
 */
export function formatDistillate(seed: DistillateSeed, score: number): string {
  const confidence = (score * 100).toFixed(0);
  return (
    `<prior_pattern confidence="${confidence}%" source="institutional_memory">\n` +
    `SITUATION: ${seed.situation}\n` +
    `DEAD ENDS: ${seed.deadEnds}\n` +
    `UNLOCK: ${seed.unlock}\n` +
    `</prior_pattern>\n` +
    `Apply insights from the pattern above. Do not re-derive known dead ends.`
  );
}
