import type { DistillateSeed } from "./types.js";

/**
 * Compressed Directive Injection — research-grade format.
 *
 * Key principles (from literature):
 *
 * 1. COMPRESS to under 60 tokens (C3oT, arxiv 2412.11664):
 *    Shorter chains are up to 34.5% more likely correct.
 *
 * 2. IMPERATIVE framing, not informational (TALE, arxiv 2412.18547):
 *    "Fix: X" not "A similar problem was solved with X"
 *
 * 3. POSITIVE constraints, not negative (RGFL, arxiv 2601.18044):
 *    "The bug is in the comparator" not "Do NOT try sorting twice"
 *
 * 4. Single-shot in first user message, NOT in system prompt
 *    (Context Rot, Chroma 2025): prevents token multiplication across steps.
 *
 * 5. Skip-to-fix strategy override (Plan-and-Act, arxiv 2503.09572):
 *    When injection fires, agent skips diagnosis and goes straight to edit.
 */

/**
 * Format a compressed directive from a 3-field distillate.
 * Target: under 60 tokens. One imperative sentence per field.
 *
 * @param seed The 3-field distillate
 * @param score Recall confidence score (0-1)
 * @returns Compressed injection string, or null if score too low
 */
export function formatCompressedDirective(
  seed: DistillateSeed,
  score: number,
): string | null {
  // Tiered confidence gating (RAGBench, arxiv 2407.11005):
  // >= 0.85: full directive
  // >= 0.72: hint only (unlock line)
  // < 0.72: no injection (noise hurts more than helps)
  if (score < 0.72) return null;

  const confidence = (score * 100).toFixed(0);

  if (score >= 0.85) {
    // High confidence: full compressed directive
    return (
      `<prior_fix confidence="${confidence}%" verified="true">\n` +
      `Bug: ${seed.situation.split('.')[0]?.trim() ?? seed.situation}.\n` +
      `Fix: ${seed.unlock}\n` +
      `Constraint: ${compressDeadEnds(seed.deadEnds)}\n` +
      `</prior_fix>\n` +
      `Apply this fix directly. Skip diagnosis. Read source, edit, run tests.`
    );
  }

  // Medium confidence: hint only
  return (
    `<hint confidence="${confidence}%">${seed.unlock}</hint>\n` +
    `Consider this approach. Read source first, then decide.`
  );
}

/**
 * Compress dead ends into a single positive constraint.
 * "Tried X, tried Y, tried Z" → "Ensure [key constraint]"
 */
function compressDeadEnds(deadEnds: string | string[]): string {
  // Handle both string and array formats
  const text = Array.isArray(deadEnds) ? deadEnds.join(". ") : deadEnds;
  const sentences = text.split(/\.\s+/).filter(Boolean);
  if (sentences.length === 0) return text;
  // Take the last sentence (usually the most specific constraint)
  const last = sentences[sentences.length - 1]!.trim().replace(/\.$/, '');
  return last.length > 120 ? last.slice(0, 117) + '...' : last;
}

/**
 * Build the augmented system prompt for skip-to-fix strategy.
 *
 * When prior knowledge is available, the agent skips the exploration loop
 * and goes directly to: read source → apply fix → run tests.
 *
 * Ref: Kimi-Dev (arxiv 2509.23045) — structured skill priors enable
 * agents to skip exploration, achieving 60.4% on SWE-bench Verified.
 */
export const AUGMENTED_SYSTEM = `You are an expert software engineer debugging a codebase.
You have access to tools: readFile, editFile, runTests.

Your goal: make all tests pass.

You have institutional memory of a prior fix for a SIMILAR bug pattern.
The prior fix describes an approach — apply the same LOGIC to the actual code here.
IMPORTANT: Do NOT use file paths from the prior fix. The files here are: source.ts and source.test.ts.

Strategy:
1. Read source.ts to understand the current code
2. Apply the fix approach from institutional memory to this code
3. Run tests to verify

Be precise. Apply the known approach in the fewest steps possible.`;
