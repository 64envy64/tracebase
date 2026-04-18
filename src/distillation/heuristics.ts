/**
 * Distillation heuristics — pure, deterministic, LLM-free.
 *
 * Two jobs:
 *   1. `findUnlockStep`  — locate the step in a solved trajectory that
 *      captures the *reasoning* behind the fix. Input to the distiller.
 *   2. `mineDeadEnds`    — find hypotheses the agent proposed but then
 *      abandoned. These become `body.deadEnds` — future agents on the
 *      same pattern skip the dead ends and save steps/tokens.
 *
 * Both functions operate on a small in-memory `ExtractedTrajectory`
 * shape built from a `ReasoningTrace`. Keeping the trajectory view
 * separate from the storage type (a) avoids coupling distillation to
 * storage mutations, (b) makes the heuristics testable with fixtures.
 *
 * Design constraints (docs/DESIGN_v2.md §L2 "Pillar 2"):
 *   • No LLM calls here. The distiller does the LLM call after heuristics.
 *   • Deterministic output — same trace always produces the same
 *     (unlock, deadEnds) pair.
 *   • Dead ends are text snippets, ≤ 20 words, deduped, max 5.
 */
import type { ReasoningTrace, ToolCallRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Trajectory view
// ---------------------------------------------------------------------------

export interface TrajectoryStep {
  index: number;
  type: "analysis" | "action" | "verification";
  description: string;
  toolCall?: ToolCallRecord;
}

export interface ExtractedTrajectory {
  steps: TrajectoryStep[];
  outcome: "success" | "failure" | "partial";
  summary: string;
  problemDescription: string;
}

/**
 * Convert a v1 ReasoningTrace into a distiller-friendly trajectory view.
 * Never mutates the source trace.
 */
export function extractTrajectory(trace: ReasoningTrace): ExtractedTrajectory {
  const steps: TrajectoryStep[] = trace.solution.steps.map((s, i) => ({
    index: i,
    type: s.type,
    description: s.description,
    toolCall: s.toolCall,
  }));
  return {
    steps,
    outcome: trace.solution.outcome,
    summary: trace.solution.summary,
    problemDescription: trace.problem.description,
  };
}

// ---------------------------------------------------------------------------
// Unlock step detection
// ---------------------------------------------------------------------------

/**
 * Heuristic: on a successful trajectory, the last `analysis` step
 * immediately preceding the final verification is the pivotal reasoning
 * step — the one that finally identified the correct mechanism.
 *
 * Rule, in order:
 *   1. Only successful trajectories produce an unlock.
 *   2. Prefer the last `analysis` step that precedes a `verification`
 *      step (i.e. the last reasoning before the agent ran a final test
 *      that passed).
 *   3. Fallback: the last `analysis` step in the trajectory, if any.
 *   4. If there is no `analysis` step at all, return null — the
 *      distiller will either reject (heuristic-gate) or use the summary
 *      as a weak fallback depending on configuration.
 */
export function findUnlockStep(t: ExtractedTrajectory): TrajectoryStep | null {
  if (t.outcome !== "success") return null;

  // Rule 2: last analysis that precedes a verification step.
  for (let i = t.steps.length - 1; i >= 0; i--) {
    const step = t.steps[i];
    if (!step || step.type !== "analysis") continue;
    // Does a verification step exist later in the trajectory?
    for (let j = i + 1; j < t.steps.length; j++) {
      const later = t.steps[j];
      if (later && later.type === "verification") return step;
    }
  }

  // Rule 3: fallback — last analysis anywhere.
  for (let i = t.steps.length - 1; i >= 0; i--) {
    const step = t.steps[i];
    if (step && step.type === "analysis") return step;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dead-end mining
// ---------------------------------------------------------------------------

/**
 * Text patterns that indicate the agent is backing out of a previous
 * hypothesis. We use these as a proxy for "abandoned": if analysis step
 * k is followed by analysis step k+1 containing one of these signals,
 * then step k was likely a dead end.
 *
 * Kept deliberately narrow. False positives (marking a real unlock as a
 * dead end) are worse than false negatives (missing a dead end) — the
 * former pollutes `deadEnds` with correct reasoning.
 */
const NEGATIVE_SIGNALS: RegExp[] = [
  /doesn'?t\s+(work|solve|help|fix|match)/i,
  /didn'?t\s+(work|solve|help|fix|match)/i,
  /\bnot\s+(the\s+right|correct|working)\b/i,
  /\brevert(ing)?\b/i,
  /\bundo(ing)?\b/i,
  /\b(hmm|wait),?\s*(that'?s\s+)?(not|no|wrong)\b/i,
  /\btry\s+(something\s+)?(else|different|another)\b/i,
  /\bwrong\s+(approach|path|direction|hypothesis)\b/i,
  /\bthat'?s\s+not\s+(it|right|the\s+cause)\b/i,
];

function hasNegativeSignal(text: string): boolean {
  return NEGATIVE_SIGNALS.some((re) => re.test(text));
}

/**
 * Truncate to ≤ `maxWords` words, stripped and trimmed. Dead ends
 * must fit the ≤ 20-word schema constraint from the validator.
 */
export function summarizeDeadEnd(text: string, maxWords: number = 20): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, maxWords);
  return words.join(" ");
}

/**
 * Mine dead ends from a trajectory. Output:
 *   - deterministic (same trajectory → same list),
 *   - deduplicated,
 *   - capped at 5 entries,
 *   - each entry ≤ 20 words.
 *
 * Note: returns an empty array if the trajectory lacks enough reasoning
 * steps to identify a dead end — this is OK. Blocks with `deadEnds: []`
 * are still useful; the distiller will accept them as long as the rest
 * of the body is non-empty.
 */
export function mineDeadEnds(t: ExtractedTrajectory, max: number = 5): string[] {
  const analyses = t.steps.filter((s) => s.type === "analysis");
  const seen = new Set<string>();
  const deadEnds: string[] = [];

  // Rule: analysis at i is a dead end if analysis at i+1 shows a
  // negative signal. We walk pairs in order.
  for (let i = 0; i < analyses.length - 1; i++) {
    const cur = analyses[i];
    const next = analyses[i + 1];
    if (!cur || !next) continue;
    if (!hasNegativeSignal(next.description)) continue;
    const summary = summarizeDeadEnd(cur.description);
    const key = summary.toLowerCase();
    if (summary && !seen.has(key)) {
      seen.add(key);
      deadEnds.push(summary);
      if (deadEnds.length >= max) break;
    }
  }

  return deadEnds;
}
