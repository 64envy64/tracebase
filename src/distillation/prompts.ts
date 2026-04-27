/**
 * Canonical distillation prompt templates.
 *
 * The distiller calls the model with one of two prompt pairs, selected
 * by its `DistillationMode`:
 *   • success mode  — DISTILL_SYSTEM_PROMPT + buildDistillUserMessage
 *   • failure mode  — DISTILL_FAILURE_SYSTEM_PROMPT + buildFailureUserMessage
 *
 * Intentionally kept as plain strings (not template functions scattered
 * across files) so the prompts are auditable in one place. Changes to
 * either prompt are schema changes — document the "why" in the commit.
 *
 * The failure prompt deliberately does NOT ask the model to set `kind`
 * — the pipeline's failure branch stamps `kind: "pitfall"` itself — and
 * does NOT invite the model to nominate related success blocks for
 * demotion. Raw failure distillation staying mechanically scoped to
 * "produce a pitfall block from this failed trajectory" is the explicit
 * design constraint that prevents noisy traces from silently demoting
 * healthy active blocks.
 */
import type { DistillerInput } from "./llm-distiller.js";

/**
 * Model JSON contract. The distiller enforces this shape by
 * parsing + validating the model's output. Mirrors the StoreBlockInput
 * shape minus provenance.
 */
export const DISTILL_SYSTEM_PROMPT = `You are a reasoning-pattern distiller.

Your job: given a SOLVED bug-fix trajectory, extract a single minimal, reusable reasoning block as JSON. The block must describe the mechanism in terms general enough to apply to future tasks that share the same pattern.

HARD RULES — violating any of these discards your output:
1. Output ONLY a valid JSON object matching the schema below. No prose, no markdown, no code fences.
2. NEVER include: diff hunks (--- +++), patch lines (@@ ... @@), absolute file paths (/testbed/..., /repo/...), pytest identifiers (file.py::test_name), commit hashes, or test names.
3. The reasoning MUST be task-general: describe the PATTERN, not the concrete file or function of this specific case.
4. deadEnds are plausible-looking approaches that DID NOT work. Up to 5 items. Each ≤ 20 words.
5. distillationConfidence ∈ [0,1]: your best estimate of how reusable this pattern is. Lower it if the case is too specific to generalize.

FIELD LENGTH CAPS:
  trigger.situation      ≤ 40 words  (the recognizable pattern signature)
  body.mechanism         ≤ 40 words  (root cause structure)
  body.unlock            ≤ 30 words  (the key insight that solved it)
  body.verification      ≤ 30 words  (how to confirm the fix holds)

JSON SCHEMA:
{
  "trigger": {
    "situation": "<string>",
    "invariants": {
      "language":    "<string or omit>",
      "framework":   "<string or omit>",
      "errorType":   "<string or omit>",
      "apiSurface":  ["<string>", ...]
    }
  },
  "body": {
    "mechanism":    "<string>",
    "deadEnds":     ["<string>", ...],
    "unlock":       "<string>",
    "verification": "<string>"
  },
  "distillationConfidence": <number between 0 and 1>
}`;

/** Compose the user message body from distiller input. */
export function buildDistillUserMessage(input: DistillerInput): string {
  const parts: string[] = [];
  parts.push(`Problem: ${truncate(input.problemDescription, 800)}`);
  parts.push(`Agent summary: ${truncate(input.solutionSummary, 400)}`);
  parts.push(`Unlock step (pivotal reasoning): ${truncate(input.unlockStep, 600)}`);

  if (input.deadEnds.length > 0) {
    parts.push(
      `Abandoned hypotheses during the trajectory:\n${input.deadEnds.map((d, i) => `  ${i + 1}. ${d}`).join("\n")}`,
    );
  } else {
    parts.push("Abandoned hypotheses during the trajectory: (none detected)");
  }

  if (input.invariants) {
    const parts2: string[] = [];
    if (input.invariants.language) parts2.push(`language=${input.invariants.language}`);
    if (input.invariants.framework) parts2.push(`framework=${input.invariants.framework}`);
    if (input.invariants.errorType) parts2.push(`errorType=${input.invariants.errorType}`);
    if (input.invariants.apiSurface && input.invariants.apiSurface.length > 0) {
      parts2.push(`apiSurface=${input.invariants.apiSurface.join(", ")}`);
    }
    if (parts2.length > 0) parts.push(`Hints (may override): ${parts2.join("; ")}`);
  }

  parts.push("Extract the reusable pattern as JSON matching the schema. Output ONLY JSON.");
  return parts.join("\n\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// ---------------------------------------------------------------------------
// Failure-distillation prompt (pitfall blocks)
// ---------------------------------------------------------------------------

/**
 * Failure-mode system prompt. Structurally mirrors DISTILL_SYSTEM_PROMPT
 * so the JSON contract and leakage rules are identical — only the
 * semantics of each body field shift to describe the failure lane.
 *
 * Note: the prompt does NOT ask the model to return a `kind` field
 * (the pipeline sets it) and does NOT ask for any field that could be
 * used to auto-demote a related success block. Keep it that way.
 */
export const DISTILL_FAILURE_SYSTEM_PROMPT = `You are a reasoning-pattern distiller operating in FAILURE mode.

Your job: given a FAILED trajectory, extract a single minimal, reusable "pitfall" block as JSON. A pitfall block captures a recurring trap — a plausible-looking path that does not actually solve the problem — so future agents can recognize the trap early and steer away.

HARD RULES — violating any of these discards your output:
1. Output ONLY a valid JSON object matching the schema below. No prose, no markdown, no code fences.
2. NEVER include: diff hunks (--- +++), patch lines (@@ ... @@), absolute file paths (/testbed/..., /repo/...), pytest identifiers (file.py::test_name), commit hashes, or test names.
3. The reasoning MUST be task-general: describe the RECURRING trap, not the concrete file or function of this specific case.
4. deadEnds MUST contain at least one concrete trap manifestation (≤ 20 words each, up to 5). A pitfall block without a concrete dead-end carries no signal.
5. guardrails are early "if you see X, stop" signals. 0 to 3 items, each ≤ 20 words. Use them for signals that would fire BEFORE the agent commits to the wrong direction.
6. distillationConfidence ∈ [0,1]: your best estimate of how reusable this pitfall is. Lower it if the case is too specific to generalize.

FIELD SEMANTICS (failure mode):
  trigger.situation      the recognizable pattern signature (same shape as in success mode)
  body.mechanism         the misleading intuition the agent followed — why the false path LOOKED plausible
  body.deadEnds          concrete traps / misleading approaches that this pattern produces (≥ 1)
  body.unlock            the corrective redirect — what to do INSTEAD to leave the false path
  body.verification      the falsification check — how to recognize that the current approach is on the false path and must be abandoned
  body.guardrails        early "stop-and-check" signals (0..3)

FIELD LENGTH CAPS:
  trigger.situation      ≤ 40 words
  body.mechanism         ≤ 40 words
  body.unlock            ≤ 30 words
  body.verification      ≤ 30 words
  body.deadEnds          each ≤ 20 words, up to 5
  body.guardrails        each ≤ 20 words, up to 3

JSON SCHEMA:
{
  "trigger": {
    "situation": "<string>",
    "invariants": {
      "language":    "<string or omit>",
      "framework":   "<string or omit>",
      "errorType":   "<string or omit>",
      "apiSurface":  ["<string>", ...]
    }
  },
  "body": {
    "mechanism":    "<string>",
    "deadEnds":     ["<string>", ...],
    "unlock":       "<string>",
    "verification": "<string>",
    "guardrails":   ["<string>", ...]
  },
  "distillationConfidence": <number between 0 and 1>
}`;

/**
 * Compose the user message body for failure-mode distillation.
 *
 * Reuses the same {@link DistillerInput} shape as success mode so
 * upstream plumbing (the pipeline, the heuristics that feed it) stays
 * symmetric. Field relabelling happens only in the prompt text:
 *   • `problemDescription`  — the failed task.
 *   • `solutionSummary`     — the agent's recorded terminal belief or
 *     give-up summary on the failure trajectory.
 *   • `unlockStep`          — the pivotal step surfaced by
 *     `findFailureStep` (the agent's last analysis before giving up).
 *   • `deadEnds`            — negative-signal hypotheses mined from
 *     the trajectory (seed for the pitfall's `body.deadEnds`, the
 *     model may replace or extend them).
 */
export function buildFailureUserMessage(input: DistillerInput): string {
  const parts: string[] = [];
  parts.push(`Problem (failed trajectory): ${truncate(input.problemDescription, 800)}`);
  parts.push(`Agent's terminal summary / give-up note: ${truncate(input.solutionSummary, 400)}`);
  parts.push(
    `Pivotal failing step (agent's last analysis before giving up): ${truncate(input.unlockStep, 600)}`,
  );

  if (input.deadEnds.length > 0) {
    parts.push(
      `Candidate trap signatures observed in the trajectory:\n${input.deadEnds.map((d, i) => `  ${i + 1}. ${d}`).join("\n")}`,
    );
  } else {
    parts.push("Candidate trap signatures observed in the trajectory: (none detected)");
  }

  if (input.invariants) {
    const parts2: string[] = [];
    if (input.invariants.language) parts2.push(`language=${input.invariants.language}`);
    if (input.invariants.framework) parts2.push(`framework=${input.invariants.framework}`);
    if (input.invariants.errorType) parts2.push(`errorType=${input.invariants.errorType}`);
    if (input.invariants.apiSurface && input.invariants.apiSurface.length > 0) {
      parts2.push(`apiSurface=${input.invariants.apiSurface.join(", ")}`);
    }
    if (parts2.length > 0) parts.push(`Hints (may override): ${parts2.join("; ")}`);
  }

  parts.push(
    "Extract the reusable pitfall as JSON matching the schema. Output ONLY JSON.",
  );
  return parts.join("\n\n");
}
