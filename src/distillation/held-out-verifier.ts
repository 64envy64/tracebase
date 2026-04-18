/**
 * HeldOutVerifier — Phase 4.5 self-verify runner.
 *
 * Takes a freshly-distilled (or demoted / stale) block, picks a held-out
 * task from a task bank, and runs an external agent on that task with
 * ONLY the block's reasoning injected. Three verdicts come out:
 *
 *   • `verified`    — agent actually used the block AND the task
 *                     resolved. The block's mechanism is real and
 *                     transfers beyond its origin trace.
 *   • `disproved`   — agent used the block but the task did NOT
 *                     resolve. The block's mechanism is wrong (or too
 *                     specific). Repair loop (§5.1) demotes.
 *   • `inconclusive`— either no held-out task matched, or the agent
 *                     did not reuse the block, or the runner errored.
 *                     Nothing can be said about the block from this run.
 *
 * The verifier is deliberately DI-shaped:
 *
 *   HeldOutVerifier({ runner, picker })
 *
 * The runner and picker are the plug points. For tests we ship
 * `MockAgentRunner` and `StaticTaskPicker`; production deployments
 * supply their own (Anthropic-SDK-backed agent, SWE-bench task
 * registry, etc.).
 *
 * Held-out discipline (important):
 *   A task is valid for a block only if:
 *     - task.id          ≠ block.provenance.sourceTaskId
 *     - task.sourceTraceId ≠ block.provenance.parentTraceId (if set)
 *     - task.invariants   are compatible with block.trigger.invariants
 *   Without the first two checks the verifier would re-prove the
 *   block against its own origin trace, which is circular. The third
 *   keeps us from running Python blocks against TS tasks.
 */
import type {
  BlockInvariants,
  ReasoningBlock,
} from "../types.js";
import type { BlockStore } from "../core/block-store.js";
import type {
  VerifyOptions,
  VerificationResult,
  Verifier,
} from "./verifier.js";

// ---------------------------------------------------------------------------
// Task + runner contracts
// ---------------------------------------------------------------------------

export interface VerificationTask {
  /** Stable unique id. Persisted on BlockVerification.taskId on verdict. */
  id: string;
  /** Problem statement for the agent. */
  problemDescription: string;
  /** Invariants used by TaskPicker to match tasks to blocks. */
  invariants: BlockInvariants;
  /**
   * Optional: if the task was derived from a recorded trace, its id.
   * Used for held-out discipline (don't pick the origin trace).
   */
  sourceTraceId?: string;
  /**
   * Arbitrary runner-side metadata (test command, grader hints,
   * expected behavior flags, etc.). Opaque to the verifier.
   */
  metadata?: Record<string, unknown>;
}

export interface AgentRunArgs {
  task: VerificationTask;
  /**
   * Pre-formatted hypothesis block. Agent runners SHOULD treat this as
   * the ONLY prior-reasoning context presented to the agent — mixing
   * in other blocks invalidates the held-out measurement.
   */
  injection: string;
  /** Wall-clock budget. Runners may ignore or coerce as appropriate. */
  timeoutMs?: number;
}

export interface AgentRunResult {
  /** Agent's final output (patch text, commit diff, etc.). */
  output: string;
  /**
   * Whether the grader (language server, test harness, LLM judge,
   * etc.) decided the task resolved. The runner is responsible for
   * grading; the verifier treats this as ground truth.
   */
  resolved: boolean;
  /**
   * Whether the agent's work shows observable evidence of using the
   * injected block (Jaccard ≥ τ on unlock tokens, explicit citation,
   * etc.). The runner decides the signal; the verifier only consumes.
   */
  agentReusedBlock: boolean;
  tokensUsed?: number;
  stepsUsed?: number;
  /** Free-text diagnostic attached to the verdict's `reason`. */
  details?: string;
}

export interface AgentRunner {
  /** Stable name; surfaces on BlockVerification.verifier. */
  readonly name: string;
  runOnTask(args: AgentRunArgs): Promise<AgentRunResult>;
}

export interface TaskPicker {
  /**
   * Pick a held-out task suitable for verifying this block. Return
   * null when nothing matches — the verifier will emit `inconclusive`.
   */
  pickTaskFor(block: ReasoningBlock): VerificationTask | null;
  /** Optional lookup by id (for VerifyOptions.taskId overrides). */
  getTaskById?(id: string): VerificationTask | null;
}

// ---------------------------------------------------------------------------
// Static task picker — for tests + simple configurations
// ---------------------------------------------------------------------------

export class StaticTaskPicker implements TaskPicker {
  constructor(public readonly tasks: ReadonlyArray<VerificationTask>) {}

  pickTaskFor(block: ReasoningBlock): VerificationTask | null {
    for (const t of this.tasks) {
      if (validateTaskForBlock(t, block).ok) return t;
    }
    return null;
  }

  getTaskById(id: string): VerificationTask | null {
    return this.tasks.find((t) => t.id === id) ?? null;
  }
}

/**
 * Invariants compatibility: a task matches a block when every invariant
 * the block sets is either unset on the task OR equal. apiSurface
 * requires non-empty intersection when both sides set it.
 *
 * Same semantics as the §L5 hard-invariant prefilter on serving, so a
 * block served to agents under invariants X is only verified against
 * tasks that share X.
 */
export function invariantsMatch(
  taskInv: BlockInvariants,
  blockInv: BlockInvariants,
): boolean {
  if (blockInv.language && taskInv.language && blockInv.language !== taskInv.language) return false;
  if (blockInv.framework && taskInv.framework && blockInv.framework !== taskInv.framework) return false;
  if (blockInv.errorType && taskInv.errorType && blockInv.errorType !== taskInv.errorType) return false;
  const blockApi = blockInv.apiSurface ?? [];
  const taskApi = taskInv.apiSurface ?? [];
  if (blockApi.length > 0 && taskApi.length > 0) {
    const overlap = blockApi.some((api) => taskApi.includes(api));
    if (!overlap) return false;
  }
  return true;
}

/**
 * Held-out check: a task is valid for verifying a block only if the
 * task is NOT the block's origin (by task id or parent trace id).
 * Without this the verifier re-proves the block against its own
 * distillation source — always "resolved", signal is meaningless.
 */
export function isHeldOutFrom(
  task: VerificationTask,
  block: ReasoningBlock,
): boolean {
  if (task.id === block.provenance.sourceTaskId) return false;
  if (task.sourceTraceId && task.sourceTraceId === block.provenance.parentTraceId) return false;
  if (task.sourceTraceId && task.sourceTraceId === block.provenance.sourceTaskId) return false;
  return true;
}

/**
 * Full validity check: both `isHeldOutFrom` and `invariantsMatch` must
 * pass. Returned `{ ok, reason? }` shape so the verifier can surface
 * the specific failure mode in the `inconclusive` verdict's reason.
 *
 * Both the automatic (picker.pickTaskFor) and the explicit
 * (VerifyOptions.taskId) paths route through this predicate — they
 * must, otherwise a caller-supplied taskId could bypass the
 * invariants check and let a Python block be verified against a
 * TypeScript task, producing a bogus "disproved" / "verified" verdict.
 */
export function validateTaskForBlock(
  task: VerificationTask,
  block: ReasoningBlock,
): { ok: true } | { ok: false; reason: string } {
  if (!isHeldOutFrom(task, block)) {
    return {
      ok: false,
      reason: `task ${task.id} is the block's origin — would be circular`,
    };
  }
  if (!invariantsMatch(task.invariants, block.trigger.invariants)) {
    return {
      ok: false,
      reason: `task ${task.id} invariants do not match the block's trigger`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Mock agent runner — for tests + offline pipelines
// ---------------------------------------------------------------------------

export class MockAgentRunner implements AgentRunner {
  readonly name: string;
  private readonly respond: (args: AgentRunArgs) => Promise<AgentRunResult> | AgentRunResult;

  constructor(
    respond:
      | AgentRunResult
      | ((args: AgentRunArgs) => AgentRunResult | Promise<AgentRunResult>),
    opts?: { name?: string },
  ) {
    this.name = opts?.name ?? "mock-agent-runner";
    this.respond = typeof respond === "function" ? respond : () => respond;
  }

  async runOnTask(args: AgentRunArgs): Promise<AgentRunResult> {
    return await this.respond(args);
  }
}

// ---------------------------------------------------------------------------
// HeldOutVerifier
// ---------------------------------------------------------------------------

export interface HeldOutVerifierOptions {
  runner: AgentRunner;
  picker: TaskPicker;
  /**
   * Override the `name` recorded on BlockVerification.verifier. Default
   * is `held-out:<runner.name>` so each runner version stays
   * correlated with its verdicts.
   */
  name?: string;
  /**
   * Override the injection formatter. Default is a minimal hypothesis
   * framing suitable for any agent. Replace if you need custom XML,
   * JSON, or system-prompt shaping for your runner.
   */
  formatBlock?: (block: ReasoningBlock) => string;
}

export class HeldOutVerifier implements Verifier {
  readonly name: string;
  private readonly runner: AgentRunner;
  private readonly picker: TaskPicker;
  private readonly formatBlock: (block: ReasoningBlock) => string;

  constructor(opts: HeldOutVerifierOptions) {
    this.runner = opts.runner;
    this.picker = opts.picker;
    this.name = opts.name ?? `held-out:${opts.runner.name}`;
    this.formatBlock = opts.formatBlock ?? formatBlockForVerification;
  }

  async verify(
    block: ReasoningBlock,
    opts?: VerifyOptions,
  ): Promise<VerificationResult> {
    // Task selection:
    //   (1) caller-supplied id wins — but it must still pass the
    //       FULL validity check (held-out + invariants), not just
    //       held-out. Otherwise a Python block could be verified
    //       against a TypeScript task, producing a bogus verdict.
    //   (2) else picker.pickTaskFor picks a validated match,
    //   (3) else inconclusive.
    let task: VerificationTask | null = null;
    if (opts?.taskId) {
      task = this.picker.getTaskById?.(opts.taskId) ?? null;
      if (!task) {
        return {
          status: "inconclusive",
          verifier: this.name,
          reason: `task ${opts.taskId} not found in picker`,
        };
      }
      const check = validateTaskForBlock(task, block);
      if (!check.ok) {
        return {
          status: "inconclusive",
          verifier: this.name,
          taskId: task.id,
          reason: check.reason,
        };
      }
    } else {
      task = this.picker.pickTaskFor(block);
    }

    if (!task) {
      return {
        status: "inconclusive",
        verifier: this.name,
        reason: "no held-out task matches this block's trigger",
      };
    }

    const injection = this.formatBlock(block);

    let run: AgentRunResult;
    try {
      run = await this.runner.runOnTask({
        task,
        injection,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "inconclusive",
        verifier: this.name,
        taskId: task.id,
        reason: `agent runner threw: ${message}`,
      };
    }

    // Verdict logic:
    //   • agent ignored the block → inconclusive (no signal about the
    //     block's correctness — the run neither proves nor disproves).
    //   • agent used the block AND task resolved → verified.
    //   • agent used the block AND task did NOT resolve → disproved.
    if (!run.agentReusedBlock) {
      return {
        status: "inconclusive",
        verifier: this.name,
        taskId: task.id,
        reason: run.details ?? "agent did not reuse the injected block — no signal about the block",
      };
    }

    if (run.resolved) {
      return {
        status: "verified",
        verifier: this.name,
        taskId: task.id,
        ...(run.details !== undefined ? { reason: run.details } : {}),
      };
    }

    return {
      status: "disproved",
      verifier: this.name,
      taskId: task.id,
      reason: run.details ?? "agent used the block but the task did not resolve",
    };
  }
}

// ---------------------------------------------------------------------------
// Default injection formatter
// ---------------------------------------------------------------------------

/**
 * Format a single block as a hypothesis-framed markdown blob suitable
 * for injecting into the verifier's agent run. Mirrors the §L5
 * "hypothesis, not imperative" framing used by serving's
 * formatInjection, but operates on one block and omits retrieval
 * audit metadata — the agent only needs the reasoning content.
 */
export function formatBlockForVerification(block: ReasoningBlock): string {
  const lines: string[] = [];
  lines.push("## Prior reasoning hypothesis");
  lines.push("");
  lines.push(
    "_A prior case suggests this task may share the following pattern. Treat it as a hypothesis to verify, not an instruction to follow._",
  );
  lines.push("");
  lines.push(`**Situation:** ${block.trigger.situation}`);
  lines.push("");
  lines.push(`**Proposed mechanism:** ${block.body.mechanism}`);
  if (block.body.deadEnds.length > 0) {
    lines.push("");
    lines.push("**Known dead ends (avoid):**");
    for (const de of block.body.deadEnds) lines.push(`- ${de}`);
  }
  lines.push("");
  lines.push(`**Unlock:** ${block.body.unlock}`);
  lines.push("");
  lines.push(`**How to verify:** ${block.body.verification}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// reverifyBlock — convenience for rerunning verification on an existing
// block and persisting the new verdict to the store.
// ---------------------------------------------------------------------------

/**
 * Run `verifier.verify(block)` against a block already in the store,
 * then persist the new verdict onto `block.verification`. Mirrors the
 * pipeline's verification-write logic so the lifecycle invariants
 * (inconclusive → "unverified", disproved → downstream demote in
 * LifecycleRepair) stay consistent across paths.
 *
 * Returns the raw VerificationResult for inspection / logging; the
 * persisted BlockVerification can be read back via store.getBlock().
 */
export async function reverifyBlock(
  store: BlockStore,
  verifier: Verifier,
  blockId: string,
  opts?: VerifyOptions,
): Promise<VerificationResult> {
  const block = store.getBlock(blockId);
  if (!block) {
    throw new Error(`block ${blockId} not found`);
  }
  const result = await verifier.verify(block, opts);
  const persistedStatus =
    result.status === "inconclusive" ? "unverified" : result.status;
  store.replaceBlock({
    ...block,
    verification: {
      status: persistedStatus,
      verifier: result.verifier,
      verifiedAt: Date.now(),
      ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    },
  });
  return result;
}
