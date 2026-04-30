/**
 * Pre-storage gate for reasoning patterns.
 *
 * Refuses the two dominant junk classes observed in our own dogfood
 * capture (`scripts/junk-rate-diagnostic.ts` against the live
 * `.tracebase/memory.db` showed ~30% release-noise and ~12.5%
 * template-verify boilerplate, together accounting for over three
 * quarters of measured junk):
 *
 *   - release-noise: situation/mechanism/unlock dominated by
 *     release-announcement language ("tracebase-ai@N", "git pushed",
 *     "N tests pass", commit-sha pushes). These come from auto-capture
 *     of release-progress chat messages and are not reusable patterns.
 *   - template-verify: body_verification is the canned "Re-run the
 *     failing step or relevant tests…" boilerplate the distiller
 *     occasionally emits when no real verification step exists.
 *
 * Length-only thinness is intentionally NOT gated here — short fields
 * are already caught by the MIN_FIELD_LEN check in
 * `mcp-v2-helpers.storeReasoningPattern`, and a stricter length floor
 * would false-positive on genuinely concise fixes ("add the missing
 * await", "wrap in useMemo"). The two patterns above are
 * structurally distinct from real fixes and can be matched without
 * length proxies.
 *
 * Pure function on purpose — independently testable, importable from
 * runtime and CLI both, and the same heuristic powers the
 * "would-be-rejected" simulation in the diagnostic for
 * before/after measurement on existing stores.
 */

export interface CaptureGateInput {
  situation: string;
  mechanism: string;
  unlock: string;
  verification: string;
}

export type CaptureGateReason = "release-noise" | "template-verify";

export interface CaptureGateAccept {
  kind: "accept";
}

export interface CaptureGateReject {
  kind: "reject";
  reason: CaptureGateReason;
  detail: string;
}

export type CaptureGateOutcome = CaptureGateAccept | CaptureGateReject;

/** Patterns sourced from the junk-rate diagnostic; kept identical so
 *  the capture-time gate and the post-hoc audit see the same signal. */
const RELEASE_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /tracebase-ai@\d/i,
  /\bgit pushed\b/i,
  /\d+\s+tests?\s+pass/i,
  /pushed\s+`[a-f0-9]{6,}/i,
];

const TEMPLATE_VERIFY = /^\s*re-run the failing step or relevant tests/i;

export function classifyForCapture(input: CaptureGateInput): CaptureGateOutcome {
  const haystack = `${input.situation}\n${input.mechanism}\n${input.unlock}`;
  for (const re of RELEASE_NOISE_PATTERNS) {
    if (re.test(haystack)) {
      return {
        kind: "reject",
        reason: "release-noise",
        detail: `matched ${re.source}`,
      };
    }
  }
  if (TEMPLATE_VERIFY.test(input.verification.trim())) {
    return {
      kind: "reject",
      reason: "template-verify",
      detail: 'verification is the canned "Re-run the failing step…" boilerplate',
    };
  }
  return { kind: "accept" };
}
