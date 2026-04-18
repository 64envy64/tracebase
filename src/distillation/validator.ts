/**
 * Candidate-block validator — runs every structural check the
 * distillation pipeline must enforce before storing a block.
 *
 * Two goals:
 *   1. Prevent gold-truth leakage (reuses `detectLeakage` from core/block).
 *   2. Enforce the schema constraints that §L2 binds on the body:
 *      situation ≤ 40 words, mechanism ≤ 40, unlock ≤ 30,
 *      verification ≤ 30, deadEnds 0..5 items each ≤ 20 words,
 *      all required fields non-empty.
 *
 * Output is a `ValidationReport` (defined in types.ts) — a list of
 * per-check outcomes, persisted on the block via
 * `provenance.validationReport`. Even a passing block stores its
 * report so later audits can see the exact checks that passed.
 */
import type {
  ReasoningBlock,
  ValidationReport,
  ValidationCheck,
} from "../types.js";
import { detectLeakage } from "../core/block.js";

/**
 * Words-per-field limits from design doc §L2. Adjusting these is a
 * schema change — document the rationale if you touch them.
 */
export const SCHEMA_LIMITS = {
  situationMaxWords: 40,
  mechanismMaxWords: 40,
  unlockMaxWords: 30,
  verificationMaxWords: 30,
  deadEndMaxWords: 20,
  deadEndsMin: 0,
  deadEndsMax: 5,
} as const;

export interface ValidateOptions {
  now?: number;
  /** Override schema limits for testing. Production always uses defaults. */
  limits?: Partial<typeof SCHEMA_LIMITS>;
}

/**
 * Run every structural check against a candidate block. Returns a
 * ValidationReport (passed=false if any check failed).
 *
 * This function never throws and never mutates the input block; the
 * caller decides what to do with a failed report (reject, store as
 * `candidate` pending human review, etc.).
 */
export function validateCandidate(
  block: Pick<ReasoningBlock, "trigger" | "body">,
  opts: ValidateOptions = {},
): ValidationReport {
  const now = opts.now ?? Date.now();
  const limits = { ...SCHEMA_LIMITS, ...opts.limits };
  const checks: ValidationCheck[] = [];

  // ------------------------------------------------------------------
  // Leakage guards — hard rejection of gold-truth material
  // ------------------------------------------------------------------
  const leak = detectLeakage(block);
  checks.push({
    name: `leakage${leak ? `:${leak}` : ""}`,
    passed: leak === null,
    reason: leak ? `block body contains leaked pattern: ${leak}` : undefined,
  });

  // ------------------------------------------------------------------
  // Required non-empty fields
  // ------------------------------------------------------------------
  checks.push(nonEmpty("schema:situation-nonempty", block.trigger.situation));
  checks.push(nonEmpty("schema:mechanism-nonempty", block.body.mechanism));
  checks.push(nonEmpty("schema:unlock-nonempty", block.body.unlock));
  checks.push(nonEmpty("schema:verification-nonempty", block.body.verification));

  // ------------------------------------------------------------------
  // Word-count caps
  // ------------------------------------------------------------------
  checks.push(maxWords("schema:situation-length", block.trigger.situation, limits.situationMaxWords));
  checks.push(maxWords("schema:mechanism-length", block.body.mechanism, limits.mechanismMaxWords));
  checks.push(maxWords("schema:unlock-length", block.body.unlock, limits.unlockMaxWords));
  checks.push(maxWords("schema:verification-length", block.body.verification, limits.verificationMaxWords));

  // ------------------------------------------------------------------
  // Dead ends — count + per-item length
  // ------------------------------------------------------------------
  const deadEndsCount = block.body.deadEnds.length;
  checks.push({
    name: "schema:dead-ends-count",
    passed: deadEndsCount >= limits.deadEndsMin && deadEndsCount <= limits.deadEndsMax,
    reason: deadEndsCount > limits.deadEndsMax
      ? `${deadEndsCount} dead ends > ${limits.deadEndsMax}`
      : undefined,
  });
  for (let i = 0; i < block.body.deadEnds.length; i++) {
    const de = block.body.deadEnds[i];
    if (de === undefined) continue;
    checks.push(maxWords(`schema:dead-end-${i}-length`, de, limits.deadEndMaxWords));
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
    checkedAt: now,
  };
}

/** Returns only the failed check names — useful for rejection reasons. */
export function failedChecks(report: ValidationReport): string[] {
  return report.checks.filter((c) => !c.passed).map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(name: string, text: string): ValidationCheck {
  const ok = text.trim().length > 0;
  return ok
    ? { name, passed: true }
    : { name, passed: false, reason: "empty or whitespace-only field" };
}

function maxWords(name: string, text: string, limit: number): ValidationCheck {
  const count = text.trim().split(/\s+/).filter(Boolean).length;
  return count <= limit
    ? { name, passed: true }
    : { name, passed: false, reason: `${count} words > ${limit} limit` };
}
