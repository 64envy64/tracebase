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

/** Max characters kept in a tool output string after normalization (UTF-16 code units). */
const MAX_TOOL_OUTPUT_CHARS = 4096;

// ---------------------------------------------------------------------------
// Tool output normalization (distiller input only — no LLM)
// ---------------------------------------------------------------------------

/**
 * Strip common terminal escape sequences (CSI/SGR, OSC, simple 2-byte ESC).
 * Covers more than SGR-only (`\x1b[…m`): BEL-terminated OSC, ST-terminated OSC,
 * C1 CSI (0x9B), and ISO 2022 two-byte sequences.
 */
export function stripTerminalEscapes(input: string): string {
  let s = input;
  // BEL-terminated OSC first — otherwise an ST regex can span across a BEL
  // and swallow plaintext between two OSC sequences.
  s = s.replace(/\u001b\][^\u0007]*\u0007/g, "");
  // OSC with ST terminator (ESC \)
  s = s.replace(/\u001b\][\s\S]*?\u001b\\/g, "");
  // CSI / SGR: ESC [ … final byte @–~
  s = s.replace(/\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "");
  // C1 CSI introducer (0x9B) — same parameter + final-byte shape
  s = s.replace(/\u009b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "");
  // ISO 2022 locking shifts and similar 2-byte ESC sequences
  s = s.replace(/\u001b[\x20-\x2f][\x30-\x7e]/g, "");
  // Legacy single-final-byte control (ESC + 0x30–0x7F)
  s = s.replace(/\u001b[\x30-\x7f]/g, "");
  return s;
}

/**
 * Collapse runs of identical *consecutive* lines; keep one copy plus an explicit marker.
 * Line breaks normalized to `\n` in the output (no `\r` left in line bodies).
 */
export function dedupeSequentialLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let run = 1;
    while (i + run < lines.length && lines[i + run] === line) run++;
    out.push(line);
    if (run > 1) {
      out.push(`... [repeated ${run - 1} lines by tracebase]`);
    }
    i += run;
  }
  return out.join("\n");
}

function truncateNormalizedToolOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const kept = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
  const fullLines = text.split(/\r?\n/).length;
  const keptLines = kept.split(/\r?\n/).length;
  const droppedLines = Math.max(0, fullLines - keptLines);
  const marker =
    droppedLines > 0
      ? `\n... [${droppedLines} lines truncated by tracebase]`
      : `\n... [truncated by tracebase: ${text.length - MAX_TOOL_OUTPUT_CHARS} chars omitted]`;
  return kept + marker;
}

/**
 * Normalize tool stdout/stderr for distillation: strip escapes, dedupe repeated
 * consecutive lines, then cap size. Deterministic and lossy only at the final cap
 * (explicit marker).
 */
export function normalizeToolOutputString(raw: string): string {
  const stripped = stripTerminalEscapes(raw);
  const deduped = dedupeSequentialLines(stripped);
  return truncateNormalizedToolOutput(deduped);
}

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
 * Apply {@link normalizeToolOutputString} to `step.toolCall.output` only.
 * Does not touch `description`, `summary`, `problemDescription`, or `toolCall.input`.
 */
export function normalizeStepOutput(step: TrajectoryStep): TrajectoryStep {
  const tc = step.toolCall;
  if (!tc?.output) return step;
  const nextOut = normalizeToolOutputString(tc.output);
  if (nextOut === tc.output) return step;
  return { ...step, toolCall: { ...tc, output: nextOut } };
}

/**
 * Convert a v1 ReasoningTrace into a distiller-friendly trajectory view.
 * Never mutates the source trace.
 */
export function extractTrajectory(trace: ReasoningTrace): ExtractedTrajectory {
  const steps: TrajectoryStep[] = trace.solution.steps.map((s, i) =>
    normalizeStepOutput({
      index: i,
      type: s.type,
      description: s.description,
      toolCall: s.toolCall,
    }),
  );
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
// Failure step detection
// ---------------------------------------------------------------------------

/**
 * Heuristic: on a FAILED trajectory, the pivotal step is the final
 * analysis — the agent's last recorded explanation of what it believed
 * was going on before it gave up. That step is what a pitfall prompt
 * will distill into "the misleading intuition" (`body.mechanism` on a
 * `kind: "pitfall"` block).
 *
 * Rules, in order:
 *   1. Only failure trajectories produce a failure step. Success and
 *      partial outcomes return null (partial lanes are out of scope
 *      for this change).
 *   2. Prefer the last `analysis` step in the trajectory (the agent's
 *      terminal belief).
 *   3. If there are no `analysis` steps at all, return null — the
 *      pipeline rejects the trace as unusable (no reasoning to
 *      distill from).
 *
 * Deliberately simple. False positives (treating a recovery step as
 * the trap) are bounded by the LLM prompt, which is given the entire
 * step list for context; this heuristic only picks the anchor for
 * seeding the prompt.
 */
export function findFailureStep(t: ExtractedTrajectory): TrajectoryStep | null {
  if (t.outcome !== "failure") return null;
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
