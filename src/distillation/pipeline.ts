/**
 * DistillationPipeline — orchestrates the full trace → block pipeline.
 *
 * Flow (design doc §L2):
 *   1. Gate: accept only trajectories with outcome === "success".
 *   2. Heuristics: locate unlock step + mine dead ends.
 *   3. LLM distill: produce candidate trigger/body + confidence.
 *   4. Validate: leakage + schema checks → ValidationReport.
 *   5. Dedupe: if trigger fingerprint exists, attach a supporting case
 *      ref to the existing block (merge semantics — new evidence, no
 *      new block row).
 *   6. Store: insert as candidate, attach origin ref, promote to active.
 *   7. Verify: run the configured verifier (noop by default), record
 *      the result on block.verification, persist via replaceBlock.
 *
 * All rejection paths return a typed `DistillationResult` instead of
 * throwing. The caller decides whether to log, retry, or escalate.
 *
 * Phase 4 ships all seven steps. Phase 4.5 will swap `noopVerifier`
 * for a real held-out-task runner; no pipeline code changes needed.
 */
import { createBlock } from "../core/block.js";
import type { BlockStore } from "../core/block-store.js";
import {
  extractTrajectory,
  findUnlockStep,
  mineDeadEnds,
} from "./heuristics.js";
import { validateCandidate, failedChecks } from "./validator.js";
import type { LlmDistiller } from "./llm-distiller.js";
import { DistillerError } from "./llm-distiller.js";
import { noopVerifier, type Verifier, type VerificationResult } from "./verifier.js";
import type {
  ReasoningTrace,
  ReasoningBlock,
  ValidationReport,
  EvidenceQuality,
  BlockInvariants,
} from "../types.js";

// ---------------------------------------------------------------------------
// Options + result types
// ---------------------------------------------------------------------------

export interface DistillationPipelineOptions {
  /** Block store to persist into. */
  store: BlockStore;
  /** LLM distiller (Anthropic, mock, etc.). */
  distiller: LlmDistiller;
  /** Verifier; defaults to noopVerifier. Phase 4.5 supplies the real one. */
  verifier?: Verifier;
  /**
   * Minimum distillation confidence to store. Below this the pipeline
   * rejects with `low-confidence`. Default 0.5.
   */
  minConfidence?: number;
  /**
   * Evidence quality stamped on the origin case ref. Default "moderate"
   * — raise to "strong" for high-trust trajectories, lower to "weak"
   * if the trajectory came from a noisy source.
   */
  originEvidenceQuality?: EvidenceQuality;
  /** Deterministic clock override for tests. */
  now?: () => number;
}

export type DistillationResult =
  | {
      status: "stored";
      /** The freshly-stored, promoted-to-active block. */
      block: ReasoningBlock;
      /** Id of the origin BlockCaseRef linking trace → block. */
      caseRefId: string;
      /** Full validation report (also persisted on block.provenance). */
      validationReport: ValidationReport;
      /** Verifier's verdict. noopVerifier returns "inconclusive". */
      verification: VerificationResult;
    }
  | {
      status: "merged";
      /** The existing block whose fingerprint matched our candidate. */
      existingBlockId: string;
      /** Id of the newly-attached `supporting` case ref. */
      caseRefId: string;
      /** Validation report of the duplicate (still computed + returned). */
      validationReport: ValidationReport;
    }
  | {
      status: "rejected";
      reason: RejectionReason;
      /** Present when the rejection happened after validation ran. */
      validationReport?: ValidationReport;
    };

export type RejectionReason =
  | { kind: "not-success-outcome"; outcome: string }
  | { kind: "no-unlock-step" }
  | { kind: "llm-error"; message: string; distillerKind: "llm-error" | "parse-error" | "schema-error" }
  | { kind: "low-confidence"; confidence: number; threshold: number }
  | { kind: "validation-failed"; failures: string[] };

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class DistillationPipeline {
  private readonly store: BlockStore;
  private readonly distiller: LlmDistiller;
  private readonly verifier: Verifier;
  private readonly minConfidence: number;
  private readonly originEvidenceQuality: EvidenceQuality;
  private readonly now: () => number;

  constructor(opts: DistillationPipelineOptions) {
    this.store = opts.store;
    this.distiller = opts.distiller;
    this.verifier = opts.verifier ?? noopVerifier;
    this.minConfidence = opts.minConfidence ?? 0.5;
    this.originEvidenceQuality = opts.originEvidenceQuality ?? "moderate";
    this.now = opts.now ?? Date.now;
  }

  /**
   * Run the full pipeline against a single trace. See module header for
   * the seven-step flow. Never throws — all failure modes come back as
   * `{status:"rejected", reason}`.
   */
  async distillTrace(trace: ReasoningTrace): Promise<DistillationResult> {
    // Step 1: gate on outcome.
    if (trace.solution.outcome !== "success") {
      return {
        status: "rejected",
        reason: { kind: "not-success-outcome", outcome: trace.solution.outcome },
      };
    }

    // Step 2: heuristics.
    const extracted = extractTrajectory(trace);
    const unlock = findUnlockStep(extracted);
    if (!unlock) {
      return { status: "rejected", reason: { kind: "no-unlock-step" } };
    }
    const deadEnds = mineDeadEnds(extracted);

    // Step 3: LLM distill.
    const invariantHints = hintsFromTrace(trace);
    let distillerOut;
    try {
      distillerOut = await this.distiller.distill({
        problemDescription: trace.problem.description,
        solutionSummary: trace.solution.summary,
        unlockStep: unlock.description,
        deadEnds,
        invariants: invariantHints,
      });
    } catch (err) {
      const kind = err instanceof DistillerError ? err.kind : "llm-error";
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "rejected",
        reason: { kind: "llm-error", message, distillerKind: kind },
      };
    }

    // Step 4: validate. We validate BEFORE the confidence gate so the
    // report is always returned to the caller, regardless of which
    // rejection path fires.
    const candidate = {
      trigger: {
        situation: distillerOut.trigger.situation,
        invariants: distillerOut.trigger.invariants,
        keywords: [], // createBlock fills these in
        fingerprint: "", // createBlock fills this in
      },
      body: distillerOut.body,
    } satisfies Pick<ReasoningBlock, "trigger" | "body">;
    const report = validateCandidate(candidate, { now: this.now() });

    // Step 5: confidence gate (runs AFTER validation so report is kept).
    if (distillerOut.distillationConfidence < this.minConfidence) {
      return {
        status: "rejected",
        reason: {
          kind: "low-confidence",
          confidence: distillerOut.distillationConfidence,
          threshold: this.minConfidence,
        },
        validationReport: report,
      };
    }

    // Step 6: validation gate.
    if (!report.passed) {
      return {
        status: "rejected",
        reason: { kind: "validation-failed", failures: failedChecks(report) },
        validationReport: report,
      };
    }

    // Step 7: build the full block with Phase 4 hook fields populated.
    const block = createBlock(
      {
        trigger: {
          situation: distillerOut.trigger.situation,
          invariants: distillerOut.trigger.invariants,
        },
        body: distillerOut.body,
        provenance: {
          sourceTaskId: trace.id,
          sourceAgent: trace.metadata.agent,
          sourceModel: trace.metadata.model,
          extractedFrom: "trajectory",
          distilledBy: "llm",
          distilledWithModel: distillerOut.model,
          parentTraceId: trace.id,
          distillationConfidence: distillerOut.distillationConfidence,
          validationReport: report,
        },
      },
      { now: this.now() },
    );
    block.status = "candidate";
    block.verification = { status: "unverified" };

    // Step 8: dedupe by fingerprint. Existing block wins; we attach a
    // `supporting` case ref instead of inserting a duplicate.
    const existing = this.store.findBlockByFingerprint(block.trigger.fingerprint);
    if (existing) {
      const ref = this.store.attachCaseRef({
        blockId: existing.id,
        traceId: trace.id,
        role: "supporting",
        evidenceQuality: this.originEvidenceQuality,
        locator: `unlock-step=${unlock.index}`,
      });
      return {
        status: "merged",
        existingBlockId: existing.id,
        caseRefId: ref.id,
        validationReport: report,
      };
    }

    // Step 9: store + attach origin ref + promote to active.
    this.store.storeBlock(block);
    const originRef = this.store.attachCaseRef({
      blockId: block.id,
      traceId: trace.id,
      role: "origin",
      evidenceQuality: this.originEvidenceQuality,
      locator: `unlock-step=${unlock.index}`,
    });
    const promoted = this.store.updateBlockStatus(block.id, "active")!;

    // Step 10: run the verifier. Never let verifier errors tank the
    // pipeline — catch and record as inconclusive.
    let verification: VerificationResult;
    try {
      verification = await this.verifier.verify(promoted);
    } catch (err) {
      verification = {
        status: "inconclusive",
        verifier: this.verifier.name,
        reason: `verifier threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const mappedStatus =
      verification.status === "inconclusive" ? "unverified" : verification.status;
    const updated: ReasoningBlock = {
      ...promoted,
      verification: {
        status: mappedStatus,
        verifier: verification.verifier,
        verifiedAt: this.now(),
        ...(verification.taskId !== undefined ? { taskId: verification.taskId } : {}),
        ...(verification.reason !== undefined ? { reason: verification.reason } : {}),
      },
    };
    this.store.replaceBlock(updated);

    return {
      status: "stored",
      block: this.store.getBlock(updated.id)!,
      caseRefId: originRef.id,
      validationReport: report,
      verification,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hintsFromTrace(trace: ReasoningTrace): BlockInvariants {
  const hints: BlockInvariants = {};
  if (trace.problem.language) hints.language = trace.problem.language;
  if (trace.problem.framework) hints.framework = trace.problem.framework;
  if (trace.problem.errorType) hints.errorType = trace.problem.errorType;
  return hints;
}

