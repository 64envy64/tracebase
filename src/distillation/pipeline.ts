/**
 * DistillationPipeline — orchestrates the full trace → block pipeline.
 *
 * `distillTrace` is a dispatcher keyed on `trace.solution.outcome`:
 *
 *   • outcome === "success"  → the success lane (seven-step flow below).
 *   • outcome === "failure"  → the failure / pitfall lane (six-step
 *       flow in `distillFailureTrace`).
 *   • outcome === "partial"  → rejected (the partial lane is
 *       intentionally out of scope for the current change — partial
 *       trajectories have ambiguous signal and would need a separate
 *       policy before we start distilling from them).
 *
 * Success lane (design doc §L2):
 *   1. Heuristics: locate unlock step + mine dead ends.
 *   2. LLM distill (success prompt): produce candidate trigger/body +
 *      confidence.
 *   3. Validate: leakage + schema checks → ValidationReport.
 *   4. Dedupe (fingerprint, kind="success"): if a matching active
 *      success block exists, attach a `supporting` case ref to it
 *      (merge semantics — new evidence, no new block row).
 *   5. Store: insert as candidate, attach origin ref, promote to active.
 *   6. Verify: run the configured verifier (noop by default), record
 *      the result on block.verification, persist via replaceBlock.
 *
 * Failure lane (see `distillFailureTrace`):
 *   1. Heuristics: locate the pivotal failing step + mine negative-
 *      signal hypotheses.
 *   2. LLM distill (failure prompt): produce candidate pitfall
 *      trigger/body + confidence. `kind` is stamped by the pipeline,
 *      never parsed from the model output.
 *   3. Validate: same leakage + schema machinery, with pitfall-mode
 *      rules (deadEnds ≥ 1, guardrails 0..3 with per-item caps).
 *   4. Dedupe (fingerprint, kind="pitfall"): if a matching pitfall
 *      block exists, attach a `supporting` ref to it.
 *   5. Store as `status: "candidate"`, attach origin ref.
 *   6. NO auto-promote to active, NO auto-counter evidence against
 *      related success blocks, NO verifier invocation. A pitfall block
 *      becomes servable only once a held-out verifier confirms it —
 *      that wiring is deferred to a later change.
 *
 * All rejection paths return a typed `DistillationResult` instead of
 * throwing. The caller decides whether to log, retry, or escalate.
 */
import { createBlock } from "../core/block.js";
import type { BlockStore } from "../core/block-store.js";
import {
  extractTrajectory,
  findUnlockStep,
  findFailureStep,
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
      /**
       * The freshly-stored block. For the success lane this is an
       * `active` block; for the failure lane it is a `candidate`
       * pitfall block (never auto-promoted).
       */
      block: ReasoningBlock;
      /** Id of the origin BlockCaseRef linking trace → block. */
      caseRefId: string;
      /** Full validation report (also persisted on block.provenance). */
      validationReport: ValidationReport;
      /**
       * Verifier's verdict. Only populated for the success lane (where
       * the configured verifier runs on the freshly-promoted block).
       * Undefined on the failure lane — pitfall candidates are not
       * exercised by the default verifier and must wait for a
       * held-out runner that hasn't been wired yet.
       */
      verification?: VerificationResult;
    }
  | {
      status: "merged";
      /** The existing block whose (fingerprint, kind) matched our candidate. */
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
  | { kind: "unsupported-outcome"; outcome: string }
  | { kind: "no-unlock-step" }
  | { kind: "no-failure-step" }
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
   * Run the pipeline against a single trace. Dispatches to the success
   * or failure lane based on `trace.solution.outcome`. Never throws —
   * all failure modes come back as `{status:"rejected", reason}`.
   */
  async distillTrace(trace: ReasoningTrace): Promise<DistillationResult> {
    switch (trace.solution.outcome) {
      case "success":
        return this.distillSuccessTrace(trace);
      case "failure":
        return this.distillFailureTrace(trace);
      case "partial":
      default:
        return {
          status: "rejected",
          reason: {
            kind: "unsupported-outcome",
            outcome: trace.solution.outcome,
          },
        };
    }
  }

  // -------------------------------------------------------------------------
  // Success lane
  // -------------------------------------------------------------------------

  /**
   * Distill a success trajectory into an active, verifier-exercised
   * block. Behaviour matches the pre-failure-lane pipeline one-for-one;
   * the extraction into its own method is purely structural so the
   * failure lane can live alongside it without branching in the middle
   * of a long function.
   */
  private async distillSuccessTrace(trace: ReasoningTrace): Promise<DistillationResult> {
    // Step 1: heuristics.
    const extracted = extractTrajectory(trace);
    const unlock = findUnlockStep(extracted);
    if (!unlock) {
      return { status: "rejected", reason: { kind: "no-unlock-step" } };
    }
    const deadEnds = mineDeadEnds(extracted);

    // Step 2: LLM distill (success prompt).
    const invariantHints = hintsFromTrace(trace);
    let distillerOut;
    try {
      distillerOut = await this.distiller.distill(
        {
          problemDescription: trace.problem.description,
          solutionSummary: trace.solution.summary,
          unlockStep: unlock.description,
          deadEnds,
          invariants: invariantHints,
        },
        "success",
      );
    } catch (err) {
      const kind = err instanceof DistillerError ? err.kind : "llm-error";
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "rejected",
        reason: { kind: "llm-error", message, distillerKind: kind },
      };
    }

    // Step 3: validate. We validate BEFORE the confidence gate so the
    // report is always returned to the caller, regardless of which
    // rejection path fires.
    const candidate = {
      kind: "success" as const,
      trigger: {
        situation: distillerOut.trigger.situation,
        invariants: distillerOut.trigger.invariants,
        keywords: [], // createBlock fills these in
        fingerprint: "", // createBlock fills this in
      },
      body: distillerOut.body,
    } satisfies Pick<ReasoningBlock, "trigger" | "body" | "kind">;
    const report = validateCandidate(candidate, { now: this.now() });

    // Step 4: confidence gate (runs AFTER validation so report is kept).
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

    // Step 5: validation gate.
    if (!report.passed) {
      return {
        status: "rejected",
        reason: { kind: "validation-failed", failures: failedChecks(report) },
        validationReport: report,
      };
    }

    // Step 6: build the full block with Phase 4 hook fields populated.
    const block = createBlock(
      {
        kind: "success",
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

    // Step 7: dedupe by (fingerprint, kind="success"). Existing block
    // wins; we attach a `supporting` case ref instead of inserting a
    // duplicate.
    const existing = this.store.findBlockByFingerprintAndKind(
      block.trigger.fingerprint,
      "success",
    );
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

    // Step 8: store + attach origin ref + promote to active.
    this.store.storeBlock(block);
    const originRef = this.store.attachCaseRef({
      blockId: block.id,
      traceId: trace.id,
      role: "origin",
      evidenceQuality: this.originEvidenceQuality,
      locator: `unlock-step=${unlock.index}`,
    });
    const promoted = this.store.updateBlockStatus(block.id, "active")!;

    // Step 9: run the verifier. Never let verifier errors tank the
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

  // -------------------------------------------------------------------------
  // Failure lane
  // -------------------------------------------------------------------------

  /**
   * Distill a failed trajectory into a PITFALL candidate block.
   *
   * What this method deliberately does NOT do:
   *   • It never promotes the block to `active`. A pitfall block is
   *     a hypothesis about a recurring trap; until a held-out verifier
   *     exercises it, we keep it out of the serving path.
   *   • It never attaches a `counter` case ref to a related success
   *     block. Raw failure-distillation is too noisy to be allowed to
   *     demote healthy active blocks; counter evidence is gathered by
   *     separate, verifier-gated flows outside this lane.
   *   • It never calls the configured verifier. The default verifier is
   *     noop, but even a real verifier shouldn't run on a pitfall
   *     candidate before the pitfall-specific verification story is
   *     wired up; running it now would either lie (inconclusive/noop)
   *     or silently couple the pitfall lane to a contract that hasn't
   *     been agreed on yet.
   *
   * The block's `kind` is stamped here (never parsed from the model);
   * the failure prompt is selected by passing `"failure"` to the
   * distiller's `distill` entry point.
   */
  private async distillFailureTrace(trace: ReasoningTrace): Promise<DistillationResult> {
    // Step 1: heuristics.
    const extracted = extractTrajectory(trace);
    const pivotal = findFailureStep(extracted);
    if (!pivotal) {
      return { status: "rejected", reason: { kind: "no-failure-step" } };
    }
    const deadEnds = mineDeadEnds(extracted);

    // Step 2: LLM distill (failure prompt).
    const invariantHints = hintsFromTrace(trace);
    let distillerOut;
    try {
      distillerOut = await this.distiller.distill(
        {
          problemDescription: trace.problem.description,
          solutionSummary: trace.solution.summary,
          unlockStep: pivotal.description,
          deadEnds,
          invariants: invariantHints,
        },
        "failure",
      );
    } catch (err) {
      const kind = err instanceof DistillerError ? err.kind : "llm-error";
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "rejected",
        reason: { kind: "llm-error", message, distillerKind: kind },
      };
    }

    // Step 3: validate. Same machinery as the success lane, with
    // pitfall-mode conditional checks (deadEnds ≥ 1, guardrails bounds).
    const candidate = {
      kind: "pitfall" as const,
      trigger: {
        situation: distillerOut.trigger.situation,
        invariants: distillerOut.trigger.invariants,
        keywords: [],
        fingerprint: "",
      },
      body: distillerOut.body,
    } satisfies Pick<ReasoningBlock, "trigger" | "body" | "kind">;
    const report = validateCandidate(candidate, { now: this.now() });

    // Step 4: confidence gate (pre-validation return to keep report honest).
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

    // Step 5: validation gate.
    if (!report.passed) {
      return {
        status: "rejected",
        reason: { kind: "validation-failed", failures: failedChecks(report) },
        validationReport: report,
      };
    }

    // Step 6: build the pitfall block.
    const block = createBlock(
      {
        kind: "pitfall",
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

    // Step 7: dedupe by (fingerprint, kind="pitfall"). Existing
    // pitfall wins; we attach a `supporting` ref (never `counter`).
    const existing = this.store.findBlockByFingerprintAndKind(
      block.trigger.fingerprint,
      "pitfall",
    );
    if (existing) {
      const ref = this.store.attachCaseRef({
        blockId: existing.id,
        traceId: trace.id,
        role: "supporting",
        evidenceQuality: this.originEvidenceQuality,
        locator: `failure-step=${pivotal.index}`,
      });
      return {
        status: "merged",
        existingBlockId: existing.id,
        caseRefId: ref.id,
        validationReport: report,
      };
    }

    // Step 8: store + attach origin ref. Deliberately stay at
    // `candidate` — no updateBlockStatus("active"), no verifier call.
    this.store.storeBlock(block);
    const originRef = this.store.attachCaseRef({
      blockId: block.id,
      traceId: trace.id,
      role: "origin",
      evidenceQuality: this.originEvidenceQuality,
      locator: `failure-step=${pivotal.index}`,
    });

    return {
      status: "stored",
      block: this.store.getBlock(block.id)!,
      caseRefId: originRef.id,
      validationReport: report,
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

