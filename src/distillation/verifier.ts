/**
 * Verifier interface — the hook for Phase 4.5 self-verification.
 *
 * Phase 4 ships the interface + a noop default implementation. The
 * DistillationPipeline accepts any Verifier via its options; by
 * default it uses `noopVerifier`, which records `status: "unverified"`
 * without running anything.
 *
 * Phase 4.5 will introduce a real verifier that takes a newly-distilled
 * block, runs a fresh agent on a held-out task with ONLY this block
 * injected, and advances the verification state to "verified" or
 * "disproved" depending on whether the agent reused the block and the
 * task resolved.
 *
 * Contract points Phase 4.5 must honor:
 *   • `name` is persisted on BlockVerification.verifier so we can
 *     correlate verdicts to verifier versions.
 *   • Errors from verify() must not crash the pipeline; the pipeline
 *     catches and records a "pending" state with the error in reason.
 *   • Verify is allowed to return "inconclusive" (e.g. no held-out
 *     task available for this pattern).
 */
import type { ReasoningBlock } from "../types.js";

/**
 * Verdict from a single verifier run. Distinct from BlockVerification
 * .status, which is the persisted lifecycle state of the block:
 *   • "verified"    — verifier exercised the block and confirmed it.
 *   • "disproved"   — verifier exercised it and it failed.
 *   • "inconclusive"— verifier could not reach a verdict (e.g. no
 *     held-out task available, timeout, transient error). Pipeline
 *     maps this back to BlockVerification.status = "unverified" so
 *     the block can be re-verified later.
 */
export type VerdictStatus = "verified" | "disproved" | "inconclusive";

export interface VerifyOptions {
  /** Specific held-out task id; verifier may pick one if omitted. */
  taskId?: string;
  /** Max wall-clock budget for this verification attempt, in ms. */
  timeoutMs?: number;
}

export interface VerificationResult {
  status: VerdictStatus;
  verifier: string;
  /** Task id the verifier exercised the block against, if any. */
  taskId?: string;
  /** Free-text explanation — mandatory for `disproved` and `inconclusive`. */
  reason?: string;
}

export interface Verifier {
  /**
   * Stable name string stored on BlockVerification.verifier so
   * verdicts remain correlated to a specific verifier version.
   */
  readonly name: string;
  /**
   * Run verification against `block`. MUST NOT mutate the block.
   * Returns a VerificationResult. May reject with an Error only on
   * genuinely unrecoverable conditions; the pipeline catches and
   * records "inconclusive" in such cases.
   */
  verify(
    block: ReasoningBlock,
    opts?: VerifyOptions,
  ): Promise<VerificationResult>;
}

/**
 * Phase 4 default: records `inconclusive` without doing any work.
 * The DistillationPipeline, after storing a block, will invoke the
 * configured verifier; with the noop, every new block ends up with
 * `verification: { status: "unverified", verifier: "noop", ... }`.
 * Phase 4.5 swaps this out at configuration time.
 */
export const noopVerifier: Verifier = {
  name: "noop",
  async verify(): Promise<VerificationResult> {
    return {
      status: "inconclusive",
      verifier: "noop",
      reason:
        "phase-4 placeholder: real held-out-task verifier arrives in phase 4.5",
    };
  },
};
