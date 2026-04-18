/**
 * Canonical distillation prompt templates.
 *
 * The distiller calls the model with:
 *   • DISTILL_SYSTEM_PROMPT  — schema, leakage rules, output format
 *   • buildDistillUserMessage(input)  — case-specific context
 *
 * Intentionally kept as plain strings (not template functions scattered
 * across files) so the prompt is auditable in one place. Changes to the
 * prompt are schema changes — document the "why" in the commit.
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
